import * as vscode from "vscode";
import { healthCheck, listModels } from "./lmclient";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "localai.sidebarView";
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "refresh":
          await this._sendStatus();
          break;
        case "command":
          vscode.commands.executeCommand(msg.command);
          break;
        case "switchModel":
          vscode.commands.executeCommand("localai.switchModel");
          break;
      }
    });

    this._sendStatus();
  }

  public async refresh() {
    if (this._view) {
      await this._sendStatus();
    }
  }

  private async _sendStatus() {
    if (!this._view) return;
    const alive = await healthCheck();
    const cfg = vscode.workspace.getConfiguration("localai");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:1234");
    const model = cfg.get<string>("model", "");
    let models: string[] = [];
    if (alive) {
      try {
        const list = await listModels();
        models = list.map((m) => m.id);
      } catch {}
    }
    const ext = vscode.extensions.getExtension("webfacemedia.localai-toolkit");
    const version = ext?.packageJSON?.version ?? "dev";

    this._view.webview.postMessage({
      type: "status",
      alive,
      endpoint,
      model,
      models,
      version,
    });
  }

  private _getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .status-badge.online {
    background: var(--vscode-testing-iconPassed);
    color: var(--vscode-editor-background);
  }
  .status-badge.offline {
    background: var(--vscode-testing-iconFailed);
    color: var(--vscode-editor-background);
  }
  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  .info {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 14px;
    word-break: break-all;
  }
  .info strong { color: var(--vscode-foreground); }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin: 16px 0 8px;
  }

  button {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 10px;
    margin-bottom: 4px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .refresh-btn {
    width: auto;
    padding: 4px 8px;
    font-size: 11px;
    margin-left: 8px;
  }

  .top-row {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
  }
</style>
</head>
<body>
  <div class="top-row">
    <span class="status-badge offline" id="badge">
      <span class="status-dot"></span>
      <span id="badge-text">Checking...</span>
    </span>
    <button class="refresh-btn" onclick="refresh()">↻</button>
  </div>

  <div class="info" id="info"></div>

  <button class="primary" onclick="cmd('localai.openPlayground')">💬 Chat Playground</button>

  <div class="section-title">Code Tools</div>
  <button onclick="cmd('localai.explainSelection')">🔍 Explain Selection</button>
  <button onclick="cmd('localai.refactorSelection')">♻️ Refactor Selection</button>
  <button onclick="cmd('localai.addComments')">💬 Add Comments</button>
  <button onclick="cmd('localai.writeTests')">🧪 Write Tests</button>
  <button onclick="cmd('localai.translateText')">🌐 Translate</button>
  <button onclick="cmd('localai.customPrompt')">✏️ Custom Prompt</button>

  <div class="section-title">Git</div>
  <button onclick="cmd('localai.generateCommitMessage')">✨ Generate Commit Message</button>

  <div class="section-title">Models</div>
  <button onclick="send('switchModel')">🔄 Switch Model</button>
  <button onclick="cmd('localai.listModels')">📋 List Models</button>

  <div class="info" id="version-info" style="margin-top:16px; font-size:10px; opacity:0.4; text-align:center;"></div>

  <script>
    const vscode = acquireVsCodeApi();

    function cmd(command) {
      vscode.postMessage({ type: "command", command });
    }
    function send(type) {
      vscode.postMessage({ type });
    }
    function refresh() {
      vscode.postMessage({ type: "refresh" });
    }

    window.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg.type === "status") {
        const badge = document.getElementById("badge");
        const badgeText = document.getElementById("badge-text");
        const info = document.getElementById("info");
        if (msg.alive) {
          badge.className = "status-badge online";
          badgeText.textContent = "Online";
        } else {
          badge.className = "status-badge offline";
          badgeText.textContent = "Offline";
        }
        let html = "<strong>Endpoint:</strong> " + msg.endpoint;
        if (msg.model) {
          html += "<br><strong>Model:</strong> " + msg.model;
        } else if (msg.models && msg.models.length > 0) {
          html += "<br><strong>Model:</strong> " + msg.models[0] + " (auto)";
        }
        info.innerHTML = html;
        var vi = document.getElementById("version-info");
        if (vi) vi.textContent = "LocalAI Toolkit v" + (msg.version || "?");
      }
    });

    refresh();
  </script>
</body>
</html>`;
  }
}
