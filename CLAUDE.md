# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LocalAI Toolkit — a VS Code extension that integrates with LM Studio (or any OpenAI-compatible local LLM server) for offline AI-powered developer tools, including an agentic harness that can read/write files and run commands. Zero runtime dependencies; uses only Node.js built-in `http`/`https` modules.

## Build & Development Commands

```bash
npm run compile      # TypeScript → dist/ (tsc -p ./)
npm run watch        # Watch mode for development
npm run lint         # Type-check only (tsc --noEmit)
npm run package      # Compile + build .vsix extension package
```

Install: `code --install-extension localai-toolkit-x.x.x.vsix --force`

No test framework is currently configured. No ESLint/Prettier setup.

## Architecture

Seven source files in `src/`, compiled to `dist/` as CommonJS:

- **extension.ts** — Entry point. Registers 10 commands, manages status bar (single reusable output channel), handles Git integration (staged/unstaged diffs via `vscode.git` extension API), orchestrates selection-based tools with streaming output.
- **lmclient.ts** — HTTP client layer. Implements OpenAI-compatible API calls (`/v1/chat/completions`, `/v1/models`) with buffered SSE streaming (handles chunk boundaries). All configuration (endpoint, model, temperature, maxTokens) read from VS Code settings. Health check verifies models are actually loaded.
- **prompts.ts** — Prompt templates returning `{ system, user }` pairs for each tool (commit messages, explain, refactor, comments, tests, translate, custom) plus `harnessSystemPrompt()` that teaches the model to use XML tool calls.
- **playground.ts** — Singleton webview panel with agentic harness loop. Streams LLM responses, parses tool calls, executes them with user confirmation, feeds results back for multi-turn tool use. Includes markdown rendering, code block actions (Copy/Insert), tool call status cards, cancel/stop support. Conversation history cleared on panel dispose.
- **sidebar.ts** — Activity bar sidebar showing connection status, model info, version, and quick-action buttons.
- **toolparser.ts** — Regex-based XML parser for `<tool_call>` blocks. Extracts typed `ToolCall` objects (read_file, write_file, edit_file, run_command) from LLM output. No external XML library.
- **toolexecutor.ts** — Executes tool calls against VS Code workspace APIs. Path sandboxing (rejects `..` and absolute paths), command blocklist, configurable timeout. All write/command operations require user confirmation via modal dialog.

## Key Patterns

- **Adding a new tool:** Register command in `package.json` contributes, add prompt template in `prompts.ts`, add handler in `extension.ts` using `runSelectionTool()`.
- **Adding a harness tool:** Add type to `ToolCall` in `toolparser.ts`, add parsing in `parseToolCalls()`, add execution in `toolexecutor.ts`, document in `harnessSystemPrompt()`.
- **Git commit messages:** Gets diff via child process `git diff`, truncates at 4KB, strips markdown fences from LLM response before inserting into SCM input box.
- **Streaming:** Buffered SSE parsing in `lmclient.ts` `streamRequest()` with line accumulation across TCP chunks. Consumed by output channel (`showStreamingOutput`) and webview harness loop (`handleChat`).
- **Harness agentic loop:** Stream response → parse `<tool_call>` blocks → execute with confirmation → append tool results as user messages → loop (max iterations configurable, default 10).
- **Tool call format:** Prompt-based XML tags (not OpenAI function calling) for universal local model compatibility.
- **Configuration defaults:** Endpoint `http://localhost:1234`, temperature `0.3`, maxTokens `2048`, harness enabled with 4096 max tokens and 10 max iterations.

## VS Code Extension Specifics

- Activation: lazy (on command invocation)
- Engine: `^1.85.0`
- Main entry: `./dist/extension.js`
- Context menus: editor right-click submenu + SCM panel button
- Key bindings: Cmd+Shift+G (commit), Cmd+Shift+E (explain), Cmd+Shift+P (custom), Cmd+Shift+L (playground/harness)
- Version displayed in playground status bar and sidebar
