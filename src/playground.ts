import * as vscode from "vscode";
import { listModels, completeStream, ChatMessage, StreamResult, healthCheck } from "./lmclient";
import { parseToolCalls, hasPartialToolCall } from "./toolparser";
import { executeTool, ToolResult } from "./toolexecutor";
import { harnessSystemPrompt } from "./prompts";

let panel: vscode.WebviewPanel | undefined;
let conversationHistory: ChatMessage[] = [];
let activeCancellation: vscode.CancellationTokenSource | undefined;
let abortLoop = false;
let sessionAutoApprove = false;

/** Track how many times each file has been read in the current conversation */
let readFileCounter: Record<string, number> = {};
/** Track consecutive read-only iterations (no writes/commands) */
let consecutiveReadOnlyIterations = 0;

/** Rough token estimate: ~3.5 chars per token for English/code */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Strip <think>...</think> blocks from text to save context window */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

export function openPlayground(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "localaiPlayground",
    "LocalAI Playground",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  sessionAutoApprove = vscode.workspace
    .getConfiguration("localai.harness")
    .get<boolean>("autoApproveAll", false);

  panel.webview.html = getPlaygroundHTML();
  sendStatus();

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      switch (msg.type) {
        case "send":
          await handleChat(msg.text, msg.systemPrompt);
          break;
        case "clear":
          conversationHistory = [];
          readFileCounter = {};
          consecutiveReadOnlyIterations = 0;
          panel?.webview.postMessage({ type: "cleared" });
          break;
        case "refresh":
          await sendStatus();
          break;
        case "cancelStream":
          abortLoop = true;
          activeCancellation?.cancel();
          break;
        case "toggleAutoApprove":
          sessionAutoApprove = msg.enabled;
          vscode.workspace.getConfiguration("localai.harness").update("autoApproveAll", msg.enabled, vscode.ConfigurationTarget.Workspace);
          break;
        case "insertCode": {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit((eb) => eb.insert(editor.selection.active, msg.code));
          }
          break;
        }
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(() => {
    panel = undefined;
    conversationHistory = [];
    readFileCounter = {};
    consecutiveReadOnlyIterations = 0;
    abortLoop = true;
    activeCancellation?.cancel();
  });
}

// ────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────

async function sendStatus() {
  const cfg = vscode.workspace.getConfiguration("localai");
  const endpoint = cfg.get<string>("endpoint", "http://localhost:1234");
  const alive = await healthCheck();
  let models: string[] = [];
  if (alive) {
    try {
      const list = await listModels();
      models = list.map((m) => m.id);
    } catch { /* ignore */ }
  }

  const harnessEnabled = vscode.workspace
    .getConfiguration("localai.harness")
    .get<boolean>("enabled", true);

  const ext = vscode.extensions.getExtension("webfacemedia.localai-toolkit");
  const version = ext?.packageJSON?.version ?? "dev";

  panel?.webview.postMessage({
    type: "status",
    alive,
    endpoint,
    model: cfg.get<string>("model", "") || models[0] || "default",
    models,
    harnessEnabled,
    autoApproveAll: sessionAutoApprove,
    version,
  });
}

// ────────────────────────────────────────────────────────────────
// Chat handler — agentic loop with tool use
// ────────────────────────────────────────────────────────────────

async function handleChat(userText: string, systemPrompt?: string) {
  const cfg = vscode.workspace.getConfiguration("localai.harness");
  const harnessEnabled = cfg.get<boolean>("enabled", true);
  const maxIterations = cfg.get<number>("maxIterations", 10);
  const rawMaxTokens = cfg.get<number>("maxTokens", 32768);
  // Enforce minimum — stale workspace settings may have old default (4096)
  const harnessMaxTokens = Math.max(rawMaxTokens, 16384);
  const autoApproveReads = cfg.get<boolean>("autoApproveReads", true);
  const autoApproveAll = sessionAutoApprove || cfg.get<boolean>("autoApproveAll", false);

  abortLoop = false;
  conversationHistory.push({ role: "user", content: userText });

  // Build the system prompt
  let systemContent = "";
  if (harnessEnabled) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "unknown";
    const openFiles = vscode.window.visibleTextEditors
      .map((e) => vscode.workspace.asRelativePath(e.document.uri))
      .filter((p) => !p.startsWith("extension-output"));
    systemContent = harnessSystemPrompt(root, openFiles);
    if (systemPrompt?.trim()) {
      systemContent += `\n\nAdditional instructions from user:\n${systemPrompt.trim()}`;
    }
  } else if (systemPrompt?.trim()) {
    systemContent = systemPrompt.trim();
  }

  let consecutiveFailures = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (abortLoop) break;

    // Build messages — adaptive trimming based on estimated token count.
    // Local models often have small context windows (4K-16K tokens).
    // We aggressively trim to keep prompt tokens under budget.
    const MAX_PROMPT_TOKENS = 6000; // Conservative for local models
    const MSG_TRUNCATE_LEN = 4000; // Max chars per message when trimming

    let trimmedHistory = [...conversationHistory];

    const messages: ChatMessage[] = [];
    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    // First pass: build messages with truncation
    const buildMessages = (history: ChatMessage[], truncateLen: number): ChatMessage[] => {
      const msgs: ChatMessage[] = [];
      for (const msg of history) {
        if (msg.role === "assistant") {
          const stripped = stripThinkBlocks(msg.content);
          const content = stripped.length > truncateLen
            ? stripped.slice(0, truncateLen) + "\n... [truncated]"
            : stripped;
          msgs.push({ role: "assistant", content });
        } else {
          const content = msg.content.length > truncateLen
            ? msg.content.slice(0, truncateLen) + "\n... [truncated]"
            : msg.content;
          msgs.push({ role: msg.role, content });
        }
      }
      return msgs;
    };

    // Adaptive trimming: drop oldest messages until under token budget
    let historyMessages = buildMessages(trimmedHistory, MSG_TRUNCATE_LEN);
    let allMessages = [...messages, ...historyMessages];
    let estimatedTotal = estimateTokens(allMessages.map(m => m.content).join(""));

    while (estimatedTotal > MAX_PROMPT_TOKENS && trimmedHistory.length > 4) {
      // Drop the 2 oldest messages (usually a user+assistant pair)
      trimmedHistory = trimmedHistory.slice(2);
      historyMessages = buildMessages(trimmedHistory, MSG_TRUNCATE_LEN);
      allMessages = [...messages, ...historyMessages];
      estimatedTotal = estimateTokens(allMessages.map(m => m.content).join(""));
    }

    // Replace messages array with final trimmed set
    messages.push(...historyMessages);

    // Send context pressure indicator to webview
    const pressureLevel = estimatedTotal > MAX_PROMPT_TOKENS * 0.8 ? "high"
      : estimatedTotal > MAX_PROMPT_TOKENS * 0.5 ? "medium" : "low";
    panel?.webview.postMessage({
      type: "contextPressure",
      level: pressureLevel,
      estimatedTokens: estimatedTotal,
    });

    // Signal streaming start
    panel?.webview.postMessage({
      type: "streamStart",
      iteration: iteration + 1,
      maxIterations,
    });

    activeCancellation = new vscode.CancellationTokenSource();

    let fullResponse = "";
    let finishReason = "stop";
    try {
      const result = await completeStream(
        {
          messages,
          maxTokens: harnessEnabled ? harnessMaxTokens : undefined,
        },
        (token) => {
          panel?.webview.postMessage({ type: "streamToken", token });
        },
        activeCancellation.token
      );
      fullResponse = result.text;
      finishReason = result.finishReason;
    } catch (err: any) {
      if (err.message === "Cancelled") {
        panel?.webview.postMessage({ type: "streamEnd", cancelled: true });
      } else {
        panel?.webview.postMessage({
          type: "streamError",
          error: err.message ?? "Unknown error",
        });
      }
      activeCancellation.dispose();
      activeCancellation = undefined;
      return;
    } finally {
      activeCancellation?.dispose();
      activeCancellation = undefined;
    }

    // Auto-continue if there's a partial (unclosed) tool_call.
    // LM Studio may return "stop" even when truncated (reasoning models),
    // so we trigger on hasPartialToolCall regardless of finish_reason.
    const MAX_CONTINUATIONS = 2;
    let continuationCount = 0;
    while (
      continuationCount < MAX_CONTINUATIONS &&
      !abortLoop &&
      hasPartialToolCall(fullResponse)
    ) {
      continuationCount++;
      panel?.webview.postMessage({
        type: "streamToken",
        token: "\n\n... [auto-continuing truncated response] ...\n\n",
      });

      const contMessages: ChatMessage[] = [...messages];
      contMessages.push({ role: "assistant", content: fullResponse });
      contMessages.push({
        role: "user",
        content: "Continue exactly from where you stopped. Do not repeat prior text.",
      });

      activeCancellation = new vscode.CancellationTokenSource();
      try {
        const contResult = await completeStream(
          { messages: contMessages, maxTokens: harnessMaxTokens },
          (token) => {
            panel?.webview.postMessage({ type: "streamToken", token });
          },
          activeCancellation.token
        );
        fullResponse += contResult.text;
        finishReason = contResult.finishReason;
        // Break if continuation was empty/near-empty
        if (contResult.text.length < 10) break;
        // Break if continuation didn't progress the tool call
        // (model is generating summaries instead of continuing code)
        const progressedToolCall = contResult.text.includes("</tool_call>")
          || contResult.text.includes("</content>");
        if (!progressedToolCall) break;
      } catch (err: any) {
        if (err.message !== "Cancelled") {
          panel?.webview.postMessage({
            type: "streamToken",
            token: "\n[continuation failed, proceeding with partial response]\n",
          });
        }
        break;
      } finally {
        activeCancellation?.dispose();
        activeCancellation = undefined;
      }
    }

    conversationHistory.push({ role: "assistant", content: fullResponse });

    // If harness is disabled or no tool calls, we're done
    if (!harnessEnabled) {
      panel?.webview.postMessage({ type: "streamEnd" });
      return;
    }

    // Guard against empty/whitespace-only responses — the model may have
    // stalled after receiving tool results.  Nudge it once before giving up.
    if (!fullResponse.trim()) {
      if (iteration > 0) {
        // This is a follow-up iteration where the model returned nothing.
        // Nudge it by appending a hint and retry ONE more time.
        conversationHistory.pop(); // remove the empty assistant message
        conversationHistory.push({
          role: "user",
          content: "[System: Your previous response was empty. You MUST respond with text. Summarize what you did, report the results, and tell the user what to do next. Do NOT make tool calls — just provide your final report.]",
        });
        panel?.webview.postMessage({ type: "streamEnd" });
        continue; // retry this iteration
      }
      panel?.webview.postMessage({ type: "streamEnd" });
      return;
    }

    let toolCalls = parseToolCalls(fullResponse);

    // Salvage: if no tool calls were parsed but there's a partial write_file,
    // close the tag artificially and re-parse
    if (toolCalls.length === 0 && hasPartialToolCall(fullResponse)) {
      const writeMatch = fullResponse.match(/<tool_call>\s*<name>write_file<\/name>\s*<path>([^<]+)<\/path>\s*<content>([\s\S]+)$/);
      if (writeMatch) {
        const partialPath = writeMatch[1].trim();
        const partialContent = writeMatch[2].replace(/\n*$/, "");
        fullResponse = fullResponse.replace(
          /<tool_call>\s*<name>write_file<\/name>\s*<path>[^<]+<\/path>\s*<content>[\s\S]+$/,
          `<tool_call><name>write_file</name><path>${partialPath}</path><content>${partialContent}</content></tool_call>`
        );
        // Update the assistant message in history with the fixed version
        conversationHistory[conversationHistory.length - 1].content = fullResponse;
        toolCalls = parseToolCalls(fullResponse);
        if (toolCalls.length > 0) {
          panel?.webview.postMessage({
            type: "streamToken",
            token: "\n[File was truncated — saving what was generated. The model can fix it in the next iteration.]\n",
          });
        }
      }
    }
    if (toolCalls.length === 0) {
      // If the model dumped a large code block without using write_file, nudge it
      const hasLargeCodeBlock = fullResponse.includes("```") && fullResponse.length > 500;
      if (hasLargeCodeBlock && iteration === 0) {
        conversationHistory.push({
          role: "user",
          content: "[System: You wrote code in the chat instead of using a tool. Use write_file to create the file, or replace_lines/edit_file to modify an existing file. Do NOT output code directly — use the tools.]",
        });
        panel?.webview.postMessage({ type: "streamEnd" });
        continue;
      }
      panel?.webview.postMessage({ type: "streamEnd" });
      return;
    }

    // Execute tool calls
    panel?.webview.postMessage({ type: "streamEnd" });

    const toolResults: string[] = [];

    for (const call of toolCalls) {
      if (abortLoop) break;

      // Notify webview about tool execution
      const callId = `${call.type}_${Date.now()}`;
      panel?.webview.postMessage({ type: "toolCallDetected", id: callId, tool: call });

      let result: ToolResult;

      if (autoApproveAll || (call.type === "read_file" && autoApproveReads)) {
        result = await executeTool(call, async () => true);
      } else {
        result = await executeTool(call, async (message, detail) => {
          const choice = await vscode.window.showInformationMessage(
            `${message}`,
            { detail, modal: true },
            "Allow",
            "Allow All",
            "Deny"
          );
          if (choice === "Allow All") {
            sessionAutoApprove = true;
            panel?.webview.postMessage({ type: "autoApproveChanged", enabled: true });
            return true;
          }
          return choice === "Allow";
        });
      }

      panel?.webview.postMessage({
        type: "toolCallResult",
        id: callId,
        success: result.success,
        output: result.output.slice(0, 2000), // Truncate for webview display
      });

      const label = call.type === "read_file" ? `read_file(${call.path}${call.startLine ? `:${call.startLine}-${call.endLine || 'end'}` : ''})`
        : call.type === "write_file" ? `write_file(${call.path})`
        : call.type === "edit_file" ? `edit_file(${call.path})`
        : call.type === "replace_lines" ? `replace_lines(${call.path}:${call.startLine}-${call.endLine})`
        : call.type === "fetch_url" ? `fetch_url(${call.url})`
        : call.type === "invalid" ? `invalid(${call.name})`
        : `run_command(${call.command})`;

      toolResults.push(`[Tool Result: ${label}]\n${result.success ? "Success" : "Failed"}: ${result.output}`);
    }

    if (abortLoop) break;

    // Track read_file usage for verification loop detection
    let hasWriteOrCommand = false;
    for (const call of toolCalls) {
      if (call.type === "read_file") {
        readFileCounter[call.path] = (readFileCounter[call.path] || 0) + 1;
      }
      if (call.type === "write_file" || call.type === "edit_file" || call.type === "replace_lines" || call.type === "run_command") {
        hasWriteOrCommand = true;
      }
    }
    if (!hasWriteOrCommand && toolCalls.every(c => c.type === "read_file")) {
      consecutiveReadOnlyIterations++;
    } else {
      consecutiveReadOnlyIterations = 0;
    }

    // Track consecutive all-fail iterations
    const failedCount = toolResults.filter(r => r.includes("\nFailed:")).length;
    const successCount = toolResults.length - failedCount;
    const hasEditFailure = toolResults.some(r =>
      (r.includes("replace_lines") || r.includes("edit_file")) && r.includes("\nFailed:")
    );

    if (successCount === 0 && failedCount > 0) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
    }

    // After 3 consecutive all-fail iterations, force the model to stop using tools
    if (consecutiveFailures >= 3) {
      conversationHistory.push({
        role: "user",
        content: toolResults.join("\n\n") + "\n\n[System: STOP. Tools have failed 3 times in a row. "
          + "Do NOT make any more tool calls. Instead, explain to the user what you were trying to do, "
          + "what went wrong, and suggest how they can fix it manually. Provide your final answer now.]",
      });
      continue;
    }

    // Feed tool results back as a user message for the next iteration
    const remaining = maxIterations - iteration - 1;
    let resultsContent = toolResults.join("\n\n");

    // Add failure context
    if (failedCount > 0) {
      resultsContent += `\n\n[${failedCount} of ${toolResults.length} tool call(s) failed this iteration.]`;
    }
    if (hasEditFailure) {
      resultsContent += `\n[Hint: read the file first with read_file to see current line numbers and content before attempting edits.]`;
    }
    if (consecutiveFailures >= 2) {
      resultsContent += `\n\n[System: Tools have failed ${consecutiveFailures} times in a row. STOP retrying the same approach. `
        + `Try: 1) read_file first to see current line numbers, 2) use a completely different tool or strategy, `
        + `or 3) explain what you're trying to do and provide your final answer.]`;
    }

    // Verification loop detection — stop model from re-reading files endlessly
    const overReadFiles = Object.entries(readFileCounter).filter(([, count]) => count >= 3);
    if (overReadFiles.length > 0) {
      resultsContent += `\n\n[System: You've read ${overReadFiles.map(([f, c]) => `"${f}" ${c} times`).join(", ")}. STOP re-reading files you've already verified. Proceed with your answer or next action.]`;
    }
    if (consecutiveReadOnlyIterations >= 3) {
      resultsContent += `\n\n[System: STOP. You've spent ${consecutiveReadOnlyIterations} iterations only reading files. Do NOT read any more files. Provide your final answer NOW.]`;
    }

    resultsContent += "\n\nRespond with what you did and what to do next, or make more tool calls. ";
    if (remaining <= 3) {
      resultsContent += `[${remaining} iteration(s) left — wrap up now, summarize what you did.]`;
    } else {
      resultsContent += `[${remaining} iteration(s) left.]`;
    }
    conversationHistory.push({
      role: "user",
      content: resultsContent,
    });
  }

  // If we hit max iterations
  if (!abortLoop) {
    panel?.webview.postMessage({
      type: "streamEnd",
      maxReached: true,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Webview HTML
// ────────────────────────────────────────────────────────────────

function getPlaygroundHTML(): string {
  return /*html*/ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #333);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --button-bg: var(--vscode-button-background);
    --button-fg: var(--vscode-button-foreground);
    --accent: var(--vscode-textLink-foreground, #4fc1ff);
    --user-bg: var(--vscode-textBlockQuote-background, #1e1e2e);
    --ai-bg: transparent;
    --danger: #f44747;
    --success: #4ec9b0;
    --warning: #cca700;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); height: 100vh; display: flex; flex-direction: column; }

  /* Status bar */
  #status-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; flex-shrink: 0; }
  #status-bar .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.online { background: var(--success); }
  .dot.offline { background: var(--danger); }
  #status-bar .model-name { color: var(--accent); font-weight: 600; }
  #status-bar .endpoint { opacity: 0.6; }
  #status-bar .harness-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--accent); color: var(--bg); font-weight: 600; }
  #status-bar .version { margin-left: auto; font-size: 10px; opacity: 0.5; }
  #status-bar button { background: none; border: 1px solid var(--border); color: var(--fg); padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; }

  /* System prompt */
  #system-bar { padding: 6px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  #system-bar summary { cursor: pointer; font-size: 12px; opacity: 0.7; user-select: none; }
  #system-prompt { width: 100%; margin-top: 6px; padding: 6px 8px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 4px; font-family: inherit; font-size: 12px; resize: vertical; min-height: 40px; }

  /* Chat area */
  #chat { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 90%; padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { background: var(--user-bg); align-self: flex-end; border-bottom-right-radius: 2px; }
  .msg.assistant { background: var(--ai-bg); align-self: flex-start; border-bottom-left-radius: 2px; border: 1px solid var(--border); }
  .msg.error { color: var(--danger); border: 1px solid var(--danger); align-self: center; font-size: 12px; }
  .msg.system-info { color: var(--warning); font-size: 11px; align-self: center; opacity: 0.8; font-style: italic; }

  /* Markdown in assistant messages */
  .msg.assistant .md-content h1, .msg.assistant .md-content h2, .msg.assistant .md-content h3 { margin: 8px 0 4px; }
  .msg.assistant .md-content h1 { font-size: 16px; }
  .msg.assistant .md-content h2 { font-size: 14px; }
  .msg.assistant .md-content h3 { font-size: 13px; }
  .msg.assistant .md-content p { margin: 4px 0; }
  .msg.assistant .md-content ul, .msg.assistant .md-content ol { padding-left: 20px; margin: 4px 0; }
  .msg.assistant .md-content strong { font-weight: 700; }
  .msg.assistant .md-content em { font-style: italic; }

  /* Inline code */
  .msg code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }

  /* Code blocks */
  .code-block-wrapper { position: relative; margin: 6px 0; }
  .code-block-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px 4px 0 0; border: 1px solid var(--border); border-bottom: none; font-size: 11px; opacity: 0.7; }
  .code-block-actions { display: flex; gap: 4px; }
  .code-block-actions button { padding: 2px 8px; font-size: 10px; border: 1px solid var(--border); background: rgba(255,255,255,0.05); color: var(--fg); border-radius: 3px; cursor: pointer; }
  .code-block-actions button:hover { background: rgba(255,255,255,0.15); }
  .msg pre { background: rgba(0,0,0,0.3); padding: 8px; border-radius: 0 0 4px 4px; overflow-x: auto; margin: 0; border: 1px solid var(--border); border-top: none; }
  .msg pre code { background: none; padding: 0; }

  /* Tool call cards */
  .tool-card { margin: 6px 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: rgba(255,255,255,0.03); }
  .tool-card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .tool-card-icon { font-size: 14px; }
  .tool-card-name { font-weight: 600; color: var(--accent); }
  .tool-card-path { opacity: 0.7; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .tool-card-status { margin-left: auto; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
  .tool-card-status.pending { color: var(--warning); border: 1px solid var(--warning); }
  .tool-card-status.success { color: var(--success); border: 1px solid var(--success); }
  .tool-card-status.failed { color: var(--danger); border: 1px solid var(--danger); }
  .tool-card-output { margin-top: 6px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; }

  /* Streaming cursor */
  .streaming::after { content: "\\2588"; animation: blink 0.8s infinite; color: var(--accent); font-size: 11px; }
  @keyframes blink { 50% { opacity: 0; } }

  /* Iteration badge */
  .iteration-badge { font-size: 10px; padding: 2px 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 10px; align-self: center; color: var(--accent); }

  /* Context pressure indicator */
  #context-pressure { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 4px; display: none; }
  #context-pressure.low { display: none; }
  #context-pressure.medium { display: inline; color: var(--warning); border: 1px solid var(--warning); }
  #context-pressure.high { display: inline; color: var(--danger); border: 1px solid var(--danger); }

  /* Input area */
  #input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); flex-shrink: 0; align-items: flex-end; }
  #user-input { flex: 1; padding: 8px 12px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 13px; resize: none; min-height: 38px; max-height: 150px; }
  #input-area button { padding: 8px 16px; background: var(--button-bg); color: var(--button-fg); border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; white-space: nowrap; }
  #input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  #clear-btn { background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 8px 12px; }
  #stop-btn { background: var(--danger); display: none; }
</style>
</head>
<body>
  <div id="status-bar">
    <span class="dot" id="status-dot"></span>
    <span class="model-name" id="model-name">—</span>
    <span class="endpoint" id="endpoint-label"></span>
    <span class="harness-badge" id="harness-badge" style="display:none">HARNESS</span>
    <span id="context-pressure"></span>
    <span class="version" id="version-label">v—</span>
    <label id="auto-approve-toggle" title="Auto-approve all tool calls (no confirmation popups)" style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin-left:4px;">
      <input type="checkbox" id="auto-approve-cb" style="cursor:pointer;">
      <span>Auto-approve</span>
    </label>
    <button id="refresh-btn" title="Refresh connection">↻</button>
  </div>
  <div id="system-bar">
    <details>
      <summary>System Prompt (optional)</summary>
      <textarea id="system-prompt" rows="2" placeholder="e.g. You are a helpful coding assistant specializing in TypeScript..."></textarea>
    </details>
  </div>
  <div id="chat"></div>
  <div id="input-area">
    <button id="clear-btn" title="Clear conversation">✕</button>
    <textarea id="user-input" rows="1" placeholder="Ask your local model anything..."></textarea>
    <button id="send-btn">Send</button>
    <button id="stop-btn">Stop</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById("chat");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const clearBtn = document.getElementById("clear-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const systemPrompt = document.getElementById("system-prompt");
  const statusDot = document.getElementById("status-dot");
  const modelName = document.getElementById("model-name");
  const endpointLabel = document.getElementById("endpoint-label");
  const harnessBadge = document.getElementById("harness-badge");
  const versionLabel = document.getElementById("version-label");

  let streaming = false;
  let currentAssistantEl = null;
  let currentText = "";

  // Auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  });

  // Send on Enter (Shift+Enter for newline)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "cancelStream" });
  });
  clearBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clear" });
    chat.innerHTML = "";
  });
  refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  const autoApproveCb = document.getElementById("auto-approve-cb");
  autoApproveCb.addEventListener("change", () => {
    vscode.postMessage({ type: "toggleAutoApprove", enabled: autoApproveCb.checked });
  });

  function setStreaming(active) {
    streaming = active;
    sendBtn.style.display = active ? "none" : "";
    stopBtn.style.display = active ? "" : "none";
    sendBtn.disabled = active;
  }

  function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    addMessage("user", text);
    vscode.postMessage({ type: "send", text, systemPrompt: systemPrompt.value });
    input.value = "";
    input.style.height = "auto";
  }

  function addMessage(role, content) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    if (role === "assistant") {
      el.innerHTML = '<div class="md-content">' + renderMarkdown(content) + '</div>';
    } else {
      el.textContent = content;
    }
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  function addSystemInfo(text) {
    const el = document.createElement("div");
    el.className = "msg system-info";
    el.textContent = text;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  // ── Simple markdown renderer ──────────────────────────────────

  var codeBlockRe = new RegExp("" + String.fromCharCode(96,96,96) + "(\\\\w*)\\\\n([\\\\s\\\\S]*?)" + String.fromCharCode(96,96,96), "g");
  var inlineCodeRe = new RegExp(String.fromCharCode(96) + "([^" + String.fromCharCode(96) + "]+)" + String.fromCharCode(96), "g");

  function renderMarkdown(text) {
    if (!text) return "";
    // Escape HTML first
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Code blocks with language and action buttons
    html = html.replace(codeBlockRe, function(_, lang, code) {
      var langLabel = lang || "text";
      var escapedCode = code.replace(/\\n$/, "");
      var id = "cb_" + Math.random().toString(36).slice(2, 8);
      return '<div class="code-block-wrapper">' +
        '<div class="code-block-header">' +
          '<span>' + langLabel + '</span>' +
          '<div class="code-block-actions">' +
            "<button onclick=\\"copyCode('" + id + "')\\">Copy</button>" +
            "<button onclick=\\"insertCode('" + id + "')\\">Insert</button>" +
          '</div>' +
        '</div>' +
        '<pre><code id="' + id + '">' + escapedCode + '</code></pre>' +
      '</div>';
    });

    // Inline code
    html = html.replace(inlineCodeRe, "<code>$1</code>");

    // Headers
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold and italic
    html = html.replace(/[*][*](.+?)[*][*]/g, "<strong>$1</strong>");
    html = html.replace(/[*](.+?)[*]/g, "<em>$1</em>");

    // Unordered list items
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");

    // Paragraphs (double newline)
    html = html.replace(/\\n\\n/g, "</p><p>");

    return "<p>" + html + "</p>";
  }

  function copyCode(id) {
    const el = document.getElementById(id);
    if (el) navigator.clipboard.writeText(el.textContent || "");
  }

  function insertCode(id) {
    const el = document.getElementById(id);
    if (el) vscode.postMessage({ type: "insertCode", code: el.textContent || "" });
  }

  // ── Tool call card rendering ──────────────────────────────────

  function addToolCard(tool) {
    const el = document.createElement("div");
    el.className = "tool-card";
    el.id = "tool_" + tool.id;

    let icon, detail;
    switch (tool.tool.type) {
      case "read_file":
        icon = "📖"; detail = tool.tool.path; break;
      case "write_file":
        icon = "📝"; detail = tool.tool.path; break;
      case "edit_file":
        icon = "✏️"; detail = tool.tool.path; break;
      case "replace_lines":
        icon = "✏️"; detail = tool.tool.path + ":" + tool.tool.startLine + "-" + tool.tool.endLine; break;
      case "run_command":
        icon = "⚡"; detail = tool.tool.command; break;
      case "fetch_url":
        icon = "🌐"; detail = tool.tool.url; break;
      case "invalid":
        icon = "❌"; detail = tool.tool.name + ": " + (tool.tool.error || "unknown tool"); break;
      default:
        icon = "🔧"; detail = "";
    }

    el.innerHTML =
      '<div class="tool-card-header">' +
        '<span class="tool-card-icon">' + icon + '</span>' +
        '<span class="tool-card-name">' + tool.tool.type + '</span>' +
        '<span class="tool-card-path">' + escapeHtml(detail) + '</span>' +
        '<span class="tool-card-status pending" id="ts_' + tool.id + '">pending</span>' +
      '</div>';

    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function updateToolCard(id, success, output) {
    const statusEl = document.getElementById("ts_" + id);
    if (statusEl) {
      statusEl.className = "tool-card-status " + (success ? "success" : "failed");
      statusEl.textContent = success ? "done" : "failed";
    }
    const cardEl = document.getElementById("tool_" + id);
    if (cardEl && output) {
      const outEl = document.createElement("div");
      outEl.className = "tool-card-output";
      outEl.textContent = output.slice(0, 1000);
      cardEl.appendChild(outEl);
      chat.scrollTop = chat.scrollHeight;
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Message handler ───────────────────────────────────────────

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "status":
        statusDot.className = "dot " + (msg.alive ? "online" : "offline");
        modelName.textContent = msg.model || "no model";
        endpointLabel.textContent = msg.endpoint;
        harnessBadge.style.display = msg.harnessEnabled ? "" : "none";
        versionLabel.textContent = "v" + (msg.version || "?");
        if (msg.autoApproveAll !== undefined) autoApproveCb.checked = msg.autoApproveAll;
        break;
      case "autoApproveChanged":
        autoApproveCb.checked = msg.enabled;
        break;
      case "streamStart":
        setStreaming(true);
        currentText = "";
        currentAssistantEl = addMessage("assistant", "");
        currentAssistantEl.classList.add("streaming");
        if (msg.iteration > 1) {
          addSystemInfo("Step " + msg.iteration + "/" + msg.maxIterations);
        }
        break;
      case "streamToken":
        currentText += msg.token;
        if (currentAssistantEl) {
          const mdContent = currentAssistantEl.querySelector(".md-content");
          if (mdContent) {
            mdContent.textContent = currentText;
          } else {
            currentAssistantEl.textContent = currentText;
          }
        }
        chat.scrollTop = chat.scrollHeight;
        break;
      case "streamEnd":
        setStreaming(false);
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("streaming");
          // Re-render with markdown now that streaming is done
          const mdContent = currentAssistantEl.querySelector(".md-content");
          if (mdContent) {
            mdContent.innerHTML = renderMarkdown(currentText);
          }
        }
        if (msg.cancelled) {
          addSystemInfo("Cancelled by user");
        }
        if (msg.maxReached) {
          addSystemInfo("Max tool iterations reached");
        }
        currentAssistantEl = null;
        break;
      case "streamError":
        setStreaming(false);
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("streaming");
          currentAssistantEl.classList.add("error");
          currentAssistantEl.textContent = "Error: " + msg.error;
        } else {
          addMessage("error", "Error: " + msg.error);
        }
        currentAssistantEl = null;
        break;
      case "toolCallDetected":
        addToolCard(msg);
        break;
      case "toolCallResult":
        updateToolCard(msg.id, msg.success, msg.output);
        break;
      case "contextPressure": {
        const cpEl = document.getElementById("context-pressure");
        if (cpEl) {
          cpEl.className = msg.level === "high" ? "high" : msg.level === "medium" ? "medium" : "low";
          cpEl.textContent = msg.level === "high" ? "CTX HIGH" : msg.level === "medium" ? "CTX ~" + msg.estimatedTokens + "t" : "";
          cpEl.title = "Estimated prompt tokens: " + msg.estimatedTokens;
        }
        break;
      }
      case "cleared":
        break;
    }
  });
</script>
</body>
</html>`;
}
