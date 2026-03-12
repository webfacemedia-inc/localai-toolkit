import * as vscode from "vscode";
import * as cp from "child_process";
import { complete, healthCheck, listModels, completeStream } from "./lmclient";
import {
  commitMessagePrompt,
  explainPrompt,
  refactorPrompt,
  addCommentsPrompt,
  writeTestsPrompt,
  translatePrompt,
  customPrompt,
} from "./prompts";
import { openPlayground } from "./playground";
import { SidebarViewProvider } from "./sidebar";

// ────────────────────────────────────────────────────────────────
// Activation
// ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log("LocalAI Toolkit activated");

  // Sidebar view
  const sidebarProvider = new SidebarViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      sidebarProvider
    )
  );

  // Refresh sidebar when config changes
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("localai")) sidebarProvider.refresh();
  });

  // Status bar item showing connection state
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusItem.command = "localai.openPlayground";
  context.subscriptions.push(statusItem);
  updateStatus(statusItem);

  // Refresh status when config changes
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("localai")) updateStatus(statusItem);
  });

  // ── Commands ────────────────────────────────────────────────
  const cmds: [string, (...args: any[]) => any][] = [
    ["localai.generateCommitMessage", (arg?: any) => generateCommitMessage(arg)],
    ["localai.explainSelection", () => runSelectionTool("explain")],
    ["localai.refactorSelection", () => runSelectionTool("refactor")],
    ["localai.addComments", () => runSelectionTool("comments")],
    ["localai.writeTests", () => runSelectionTool("tests")],
    ["localai.translateText", () => runSelectionTool("translate")],
    ["localai.customPrompt", () => runSelectionTool("custom")],
    ["localai.openPlayground", () => openPlayground(context)],
    ["localai.listModels", () => showModels()],
    ["localai.switchModel", () => switchModel()],
  ];

  for (const [id, handler] of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export function deactivate() {}

// ────────────────────────────────────────────────────────────────
// Status bar
// ────────────────────────────────────────────────────────────────

async function updateStatus(item: vscode.StatusBarItem) {
  const alive = await healthCheck();
  const cfg = vscode.workspace.getConfiguration("localai");
  const model = cfg.get<string>("model", "");
  if (alive) {
    item.text = `$(zap) LocalAI${model ? ": " + truncate(model, 20) : ""}`;
    item.tooltip = `Connected to ${cfg.get("endpoint")}`;
    item.backgroundColor = undefined;
  } else {
    item.text = "$(alert) LocalAI: Offline";
    item.tooltip = `Cannot reach ${cfg.get("endpoint")}`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
  item.show();
}

// ────────────────────────────────────────────────────────────────
// Commit message generation
// ────────────────────────────────────────────────────────────────

async function generateCommitMessage(sourceControlOrUri?: any) {
  const gitExt = vscode.extensions.getExtension("vscode.git")?.exports;
  const api = gitExt?.getAPI(1);
  if (!api || api.repositories.length === 0) {
    vscode.window.showErrorMessage("No Git repository found.");
    return;
  }

  // Resolve which repo — from context menu arg, or pick if multiple
  let repo: any;
  if (sourceControlOrUri) {
    // Could be a SourceControl, URI, or resource state passed from SCM menu
    const uri =
      sourceControlOrUri?.rootUri ??
      sourceControlOrUri?.resourceUri ??
      sourceControlOrUri;
    if (uri?.fsPath) {
      repo = api.repositories.find(
        (r: any) => uri.fsPath.startsWith(r.rootUri.fsPath)
      );
    }
  }
  if (!repo) {
    if (api.repositories.length === 1) {
      repo = api.repositories[0];
    } else {
      const pick = await vscode.window.showQuickPick(
        api.repositories.map((r: any) => ({
          label: r.rootUri.fsPath.split("/").pop(),
          description: r.rootUri.fsPath,
          repo: r,
        })),
        { placeHolder: "Which repository?" }
      );
      if (!pick) return;
      repo = (pick as any).repo;
    }
  }

  const workingDir = repo.rootUri.fsPath;

  // Get staged diff, fall back to unstaged
  let diff = await gitDiff(workingDir, true);
  if (!diff.trim()) {
    diff = await gitDiff(workingDir, false);
  }
  if (!diff.trim()) {
    vscode.window.showWarningMessage("No changes to commit.");
    return;
  }

  // Truncate massive diffs to ~4k chars to fit context
  if (diff.length > 4000) {
    diff = diff.slice(0, 4000) + "\n\n... (diff truncated)";
  }

  const prompt = commitMessagePrompt(diff);

  // Show generating state in the input box itself
  const previousValue = repo.inputBox.value;
  repo.inputBox.value = "✨ Generating commit message...";

  try {
    let message = await complete({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.3,
      maxTokens: 512,
    });

    // Clean up: remove markdown fences if model wraps them
    message = message
      .replace(/^```[\s\S]*?\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();

    // Set in SCM input box
    repo.inputBox.value = message;
  } catch (err: any) {
    // Restore previous value on error
    repo.inputBox.value = previousValue;
    vscode.window.showErrorMessage(
      `LocalAI error: ${err.message ?? err}`
    );
  }
}

function gitDiff(cwd: string, staged: boolean): Promise<string> {
  return new Promise((resolve) => {
    const args = staged ? ["diff", "--staged"] : ["diff"];
    cp.exec(`git ${args.join(" ")}`, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

// ────────────────────────────────────────────────────────────────
// Selection-based tools
// ────────────────────────────────────────────────────────────────

type ToolKind = "explain" | "refactor" | "comments" | "tests" | "translate" | "custom";

async function runSelectionTool(kind: ToolKind) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const selection = editor.selection;
  const text = editor.document.getText(selection);
  if (!text.trim()) {
    vscode.window.showWarningMessage("Select some text first.");
    return;
  }

  const language = editor.document.languageId;
  let prompt: { system: string; user: string };

  switch (kind) {
    case "explain":
      prompt = explainPrompt(text, language);
      break;
    case "refactor":
      prompt = refactorPrompt(text, language);
      break;
    case "comments":
      prompt = addCommentsPrompt(text, language);
      break;
    case "tests":
      prompt = writeTestsPrompt(text, language);
      break;
    case "translate": {
      const langs = vscode.workspace
        .getConfiguration("localai")
        .get<string[]>("languages", ["English", "French", "Spanish"]);
      const target = await vscode.window.showQuickPick(langs, {
        placeHolder: "Translate to...",
      });
      if (!target) return;
      prompt = translatePrompt(text, target);
      break;
    }
    case "custom": {
      const instruction = await vscode.window.showInputBox({
        prompt: "What should the model do with this code?",
        placeHolder: "e.g. Convert to async/await, Add error handling, Optimize...",
      });
      if (!instruction) return;
      prompt = customPrompt(text, language, instruction);
      break;
    }
  }

  // For explain: show in output panel with streaming
  // For code transforms: show diff / replace
  if (kind === "explain") {
    await showStreamingOutput(prompt, `Explain: ${language}`);
  } else {
    await applyCodeResult(editor, selection, prompt, kind);
  }
}

async function showStreamingOutput(
  prompt: { system: string; user: string },
  title: string
) {
  const outputChannel = vscode.window.createOutputChannel(
    `LocalAI — ${title}`
  );
  outputChannel.show(true);
  outputChannel.clear();

  const source = new vscode.CancellationTokenSource();

  try {
    await completeStream(
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      },
      (token) => outputChannel.append(token),
      source.token
    );
  } catch (err: any) {
    outputChannel.appendLine(`\n\n--- Error: ${err.message} ---`);
  } finally {
    source.dispose();
  }
}

async function applyCodeResult(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  prompt: { system: string; user: string },
  kind: ToolKind
) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `LocalAI: Running ${kind}...`,
      cancellable: false,
    },
    async () => {
      try {
        let result = await complete({
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        });

        // Strip markdown code fences
        const fenceMatch = result.match(/```[\w]*\n([\s\S]*?)```/);
        if (fenceMatch) result = fenceMatch[1];

        // For tests: open in new doc. For everything else: offer replace
        if (kind === "tests") {
          const doc = await vscode.workspace.openTextDocument({
            content: result.trim(),
            language: editor.document.languageId,
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        } else {
          const action = await vscode.window.showInformationMessage(
            `LocalAI: ${kind} complete. Apply changes?`,
            "Replace Selection",
            "Open Beside",
            "Copy to Clipboard"
          );
          if (action === "Replace Selection") {
            await editor.edit((eb) => eb.replace(selection, result.trim()));
          } else if (action === "Open Beside") {
            const doc = await vscode.workspace.openTextDocument({
              content: result.trim(),
              language: editor.document.languageId,
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
          } else if (action === "Copy to Clipboard") {
            await vscode.env.clipboard.writeText(result.trim());
            vscode.window.showInformationMessage("Copied to clipboard.");
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`LocalAI error: ${err.message ?? err}`);
      }
    }
  );
}

// ────────────────────────────────────────────────────────────────
// Model management
// ────────────────────────────────────────────────────────────────

async function showModels() {
  try {
    const models = await listModels();
    if (models.length === 0) {
      vscode.window.showInformationMessage(
        "No models loaded. Load a model in LM Studio first."
      );
      return;
    }
    const items = models.map((m) => `${m.id} (${m.owned_by ?? "local"})`);
    vscode.window.showQuickPick(items, { placeHolder: "Available models" });
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Cannot reach LM Studio: ${err.message ?? err}`
    );
  }
}

async function switchModel() {
  try {
    const models = await listModels();
    if (models.length === 0) {
      vscode.window.showInformationMessage("No models loaded in LM Studio.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      models.map((m) => m.id),
      { placeHolder: "Select model" }
    );
    if (pick) {
      await vscode.workspace
        .getConfiguration("localai")
        .update("model", pick, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Switched to ${pick}`);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Error: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────

function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}
