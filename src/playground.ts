import * as vscode from "vscode";
import { listModels, completeStream, ChatMessage, healthCheck } from "./lmclient";

let panel: vscode.WebviewPanel | undefined;
let conversationHistory: ChatMessage[] = [];

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

  panel.webview.html = getPlaygroundHTML();

  // Send initial status
  sendStatus();

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      switch (msg.type) {
        case "send":
          await handleChat(msg.text, msg.systemPrompt);
          break;
        case "clear":
          conversationHistory = [];
          panel?.webview.postMessage({ type: "cleared" });
          break;
        case "refresh":
          await sendStatus();
          break;
        case "setSystem":
          // System prompt stored in conversation on next send
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });
}

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
  panel?.webview.postMessage({
    type: "status",
    alive,
    endpoint,
    model: cfg.get<string>("model", "") || models[0] || "default",
    models,
  });
}

async function handleChat(userText: string, systemPrompt?: string) {
  // Build messages
  const messages: ChatMessage[] = [];
  if (systemPrompt?.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }
  conversationHistory.push({ role: "user", content: userText });
  messages.push(...conversationHistory);

  // Signal streaming start
  panel?.webview.postMessage({ type: "streamStart" });

  const source = new vscode.CancellationTokenSource();

  try {
    const full = await completeStream(
      { messages },
      (token) => {
        panel?.webview.postMessage({ type: "streamToken", token });
      },
      source.token
    );
    conversationHistory.push({ role: "assistant", content: full });
    panel?.webview.postMessage({ type: "streamEnd" });
  } catch (err: any) {
    panel?.webview.postMessage({
      type: "streamError",
      error: err.message ?? "Unknown error",
    });
  } finally {
    source.dispose();
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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); height: 100vh; display: flex; flex-direction: column; }

  /* Status bar */
  #status-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px; flex-shrink: 0; }
  #status-bar .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.online { background: #4ec9b0; }
  .dot.offline { background: #f44747; }
  #status-bar .model-name { color: var(--accent); font-weight: 600; }
  #status-bar .endpoint { opacity: 0.6; }
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
  .msg.error { color: #f44747; border: 1px solid #f44747; align-self: center; font-size: 12px; }
  .msg code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  .msg pre { background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 6px 0; }
  .msg pre code { background: none; padding: 0; }

  /* Streaming cursor */
  .streaming::after { content: "▊"; animation: blink 0.8s infinite; color: var(--accent); }
  @keyframes blink { 50% { opacity: 0; } }

  /* Input area */
  #input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); flex-shrink: 0; align-items: flex-end; }
  #user-input { flex: 1; padding: 8px 12px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 13px; resize: none; min-height: 38px; max-height: 150px; }
  #input-area button { padding: 8px 16px; background: var(--button-bg); color: var(--button-fg); border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; white-space: nowrap; }
  #input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  #clear-btn { background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 8px 12px; }
</style>
</head>
<body>
  <div id="status-bar">
    <span class="dot" id="status-dot"></span>
    <span class="model-name" id="model-name">—</span>
    <span class="endpoint" id="endpoint-label"></span>
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
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById("chat");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const clearBtn = document.getElementById("clear-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const systemPrompt = document.getElementById("system-prompt");
  const statusDot = document.getElementById("status-dot");
  const modelName = document.getElementById("model-name");
  const endpointLabel = document.getElementById("endpoint-label");

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
  clearBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clear" });
    chat.innerHTML = "";
  });
  refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));

  function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    addMessage("user", text);
    vscode.postMessage({ type: "send", text, systemPrompt: systemPrompt.value });
    input.value = "";
    input.style.height = "auto";
    sendBtn.disabled = true;
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  // Message handler
  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "status":
        statusDot.className = "dot " + (msg.alive ? "online" : "offline");
        modelName.textContent = msg.model || "no model";
        endpointLabel.textContent = msg.endpoint;
        break;
      case "streamStart":
        streaming = true;
        currentText = "";
        currentAssistantEl = addMessage("assistant", "");
        currentAssistantEl.classList.add("streaming");
        break;
      case "streamToken":
        currentText += msg.token;
        if (currentAssistantEl) currentAssistantEl.textContent = currentText;
        chat.scrollTop = chat.scrollHeight;
        break;
      case "streamEnd":
        streaming = false;
        sendBtn.disabled = false;
        if (currentAssistantEl) currentAssistantEl.classList.remove("streaming");
        currentAssistantEl = null;
        break;
      case "streamError":
        streaming = false;
        sendBtn.disabled = false;
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("streaming");
          currentAssistantEl.classList.add("error");
          currentAssistantEl.textContent = "Error: " + msg.error;
        } else {
          addMessage("error", "Error: " + msg.error);
        }
        currentAssistantEl = null;
        break;
      case "cleared":
        // Already cleared DOM above
        break;
    }
  });
</script>
</body>
</html>`;
}
