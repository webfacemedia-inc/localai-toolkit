# LocalAI Toolkit

**VS Code extension that connects to your local LM Studio for zero-cost, private AI dev tools.**

Built for developers who run local models and want practical everyday tools — not a Copilot clone.

---

## Features

### 🔀 Git Commit Messages
`Cmd+Shift+G` — generates a commit message from your staged (or unstaged) diff and drops it into the SCM input box. Supports Conventional Commits, descriptive, and brief styles.

### 🔍 Code Tools (right-click menu)
Select any code, right-click → **LocalAI Toolkit**:
- **Explain Selection** — streams an explanation to an output panel
- **Refactor Selection** — returns improved code, offers to replace inline
- **Add Comments** — adds JSDoc/docstrings without changing code
- **Write Tests** — generates test file opened beside your code
- **Translate Selection** — translate text/comments to English, French, or Spanish (configurable)
- **Custom Prompt** — type any instruction to run on the selection

### 💬 Chat Playground
`Cmd+Shift+L` — opens a streaming chat panel beside your editor. Set a system prompt, test models, iterate on prompts. Full conversation memory within the session.

### 🔌 Model Management
- **List Models** — see what's loaded in LM Studio
- **Switch Model** — quick-pick to change the active model

### Status Bar
Shows connection state and current model at a glance. Click to open the playground.

---

## Setup

### 1. Install
```bash
cd localai-toolkit
npm install
npm run compile
```

Then either:
- **Dev mode:** Press `F5` in VS Code to launch Extension Host
- **Package:** `npm run package` → install the `.vsix` file

### 2. Configure LM Studio
Make sure LM Studio's local server is running (default: `http://localhost:1234`).

Load any model — the extension auto-detects whatever is loaded.

### 3. Settings (optional)
Open VS Code Settings → search "LocalAI":

| Setting | Default | Description |
|---|---|---|
| `localai.endpoint` | `http://localhost:1234` | LM Studio server URL |
| `localai.model` | (auto) | Override model ID |
| `localai.temperature` | `0.3` | Generation temperature |
| `localai.maxTokens` | `2048` | Max response tokens |
| `localai.commitStyle` | `conventional` | `conventional` / `descriptive` / `brief` |
| `localai.languages` | `["English","French","Spanish"]` | Translation targets |
| `localai.streamResponses` | `true` | Stream in playground & explain |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+G` | Generate commit message |
| `Cmd+Shift+E` | Explain selection |
| `Cmd+Shift+L` | Open playground |
| `Cmd+Shift+P` | Custom prompt on selection |

---

## Architecture

```
src/
  extension.ts   — command registration, Git integration, selection tools
  lmclient.ts    — LM Studio API client (streaming + non-streaming)
  prompts.ts     — prompt templates for all tools
  playground.ts  — webview chat panel
```

Zero external runtime dependencies. Uses Node's built-in `http`/`https` for API calls.
Works with any OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp server, etc).

---

## Extending

**Add a new tool:**
1. Add a prompt template in `prompts.ts`
2. Add a case in `runSelectionTool()` in `extension.ts`
3. Register the command in `package.json` under `contributes.commands`

**Use with Ollama or other backends:**
Just change `localai.endpoint` to `http://localhost:11434` (Ollama) or whatever your server runs on.

---

## Future Ideas
- [ ] Inline ghost-text completions (tab-accept)
- [ ] Per-project model profiles (`.localai.json`)
- [ ] Model benchmarking panel (compare outputs side-by-side)
- [ ] Integrate with Webface Control MCP server (Phase 5)
- [ ] RAG: index workspace files for context-aware chat
- [ ] Prompt library: save/load custom prompts

---

## License
MIT — Tommy @ Webface Media
