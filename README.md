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

### 🛠 AI Harness (v0.2.0+)
`Cmd+Shift+L` — opens the playground with **harness mode** enabled. Your local model can:
- **Read files** from your workspace (auto-approved by default)
- **Create files** with confirmation (existing files are protected — models must use edit tools)
- **Edit files** via line-number replacement (`replace_lines`) or search/replace (`edit_file`), with confirmation
- **Run shell commands** with confirmation and output capture
- **Fetch URLs** to pull documentation, API responses, or reference material from the web

The harness uses an agentic loop: the model streams a response, tool calls are parsed and executed, results are fed back, and the model continues — up to 10 iterations per message (configurable). All write/command operations require explicit user approval.

Uses prompt-based XML tool calling for universal model compatibility (works with any local model, no function calling support required). URL fetching includes safety guards (public URLs only, no localhost/private IPs, 64KB response limit, HTML tag stripping).

#### Reasoning Model Support (v0.5.0+)
Supports models with thinking/reasoning modes (Qwen3, DeepSeek-R1, etc.). The streaming parser captures both `delta.content` and `delta.reasoning_content`, rendering thinking tokens visually and stripping them from conversation history to conserve context window.

#### Fault-Tolerant Tool Parsing (v0.5.3+)
Models often hallucinate tool formats. The parser handles:
- Standard XML: `<name>read_file</name>`
- Attribute syntax: `<name=read_file>`
- Hybrid syntax: `<name=read_file</name>`, `<name=run_command</command>`
- **Tool aliasing**: invented tool names (`list_directory`, `cat`, `grep`, `ls`, `find`, etc.) are auto-mapped to real tools
- **Unknown tool feedback**: unrecognized tools return an error to the model listing available tools, instead of silently failing
- **Write protection**: `write_file` on existing files is rejected — models are directed to use `replace_lines` or `edit_file` for surgical edits

### 💬 Chat Playground
The playground supports streaming chat with conversation memory, markdown rendering, code blocks with Copy/Insert buttons, and a system prompt input. When harness mode is disabled, it works as a simple chat interface.

### 🔌 Model Management
- **List Models** — see what's loaded in LM Studio
- **Switch Model** — quick-pick to change the active model

### Status Bar
Shows connection state, current model, and extension version. Click to open the playground.

---

## Setup

### 1. Install
```bash
cd localai-toolkit
npm install
npm run package
code --install-extension localai-toolkit-*.vsix --force
```

Or dev mode: press `F5` in VS Code to launch Extension Host.

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

#### Harness Settings

| Setting | Default | Description |
|---|---|---|
| `localai.harness.enabled` | `true` | Enable tool use in the playground |
| `localai.harness.maxTokens` | `4096` | Max tokens for harness responses |
| `localai.harness.maxIterations` | `10` | Max tool-use iterations per message |
| `localai.harness.commandTimeout` | `30000` | Timeout (ms) for shell commands |
| `localai.harness.autoApproveReads` | `true` | Auto-approve file reads |
| `localai.harness.autoApproveAll` | `false` | Auto-approve all tool calls (no confirmation dialogs) |
| `localai.harness.blockedCommands` | `["rm -rf /", ...]` | Blocked command patterns |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+G` | Generate commit message |
| `Cmd+Shift+E` | Explain selection |
| `Cmd+Shift+L` | Open playground / harness |
| `Cmd+Shift+P` | Custom prompt on selection |

---

## Architecture

```
src/
  extension.ts     — command registration, Git integration, selection tools
  lmclient.ts      — LM Studio API client (streaming + non-streaming, buffered SSE)
  prompts.ts       — prompt templates for all tools + harness system prompt
  playground.ts    — webview chat panel with agentic harness loop
  sidebar.ts       — activity bar sidebar with status and quick actions
  toolparser.ts    — XML tool call parser (extracts structured tool calls from LLM output)
  toolexecutor.ts  — tool execution engine (read/write/edit files, run commands) with safety gates
```

Zero external runtime dependencies. Uses Node's built-in `http`/`https` for API calls.
Works with any OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp server, etc).

---

## Extending

**Add a new tool:**
1. Add a prompt template in `prompts.ts`
2. Add a case in `runSelectionTool()` in `extension.ts`
3. Register the command in `package.json` under `contributes.commands`

**Add a harness tool:**
1. Add the type to `ToolCall` union in `toolparser.ts`
2. Add parsing logic in `parseToolCalls()`
3. Add execution logic in `toolexecutor.ts`
4. Document the tool in `harnessSystemPrompt()` in `prompts.ts`

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
- [ ] Diff preview in webview for file edits (instead of native dialog)
- [ ] Inline approve/reject buttons in webview for tool calls

---

## License
MIT — Tommy @ Webface Media
