# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LocalAI Toolkit — a VS Code extension that integrates with LM Studio (or any OpenAI-compatible local LLM server) for offline AI-powered developer tools. Zero runtime dependencies; uses only Node.js built-in `http`/`https` modules.

## Build & Development Commands

```bash
npm run compile      # TypeScript → dist/ (tsc -p ./)
npm run watch        # Watch mode for development
npm run lint         # Type-check only (tsc --noEmit)
npm run package      # Build .vsix extension package
```

No test framework is currently configured. No ESLint/Prettier setup.

## Architecture

Four source files in `src/`, compiled to `dist/` as CommonJS:

- **extension.ts** — Entry point. Registers 10 commands, manages status bar, handles Git integration (staged/unstaged diffs via `vscode.git` extension API), orchestrates selection-based tools with streaming output.
- **lmclient.ts** — HTTP client layer. Implements OpenAI-compatible API calls (`/v1/chat/completions`, `/v1/models`) with SSE streaming support. All configuration (endpoint, model, temperature, maxTokens, stream) read from VS Code settings.
- **prompts.ts** — Prompt templates returning `{ system, user }` pairs for each tool (commit messages, explain, refactor, comments, tests, translate, custom).
- **playground.ts** — Singleton webview panel for chat. Embedded HTML/CSS/JS with `postMessage` protocol for streaming responses. Maintains `conversationHistory[]` during session.

## Key Patterns

- **Adding a new tool:** Register command in `package.json` contributes, add prompt template in `prompts.ts`, add handler in `extension.ts` using `runSelectionTool()`.
- **Git commit messages:** Gets diff via child process `git diff`, truncates at 4KB, strips markdown fences from LLM response before inserting into SCM input box.
- **Streaming:** SSE parsing in `lmclient.ts` `streamRequest()`, consumed by both output channel (`showStreamingOutput`) and webview (`handleChat`).
- **Configuration defaults:** Endpoint `http://localhost:1234`, temperature `0.3`, maxTokens `2048`, streaming enabled.

## VS Code Extension Specifics

- Activation: lazy (on command invocation)
- Engine: `^1.85.0`
- Main entry: `./dist/extension.js`
- Context menus: editor right-click submenu + SCM panel button
- Key bindings: Cmd+Shift+G (commit), Cmd+Shift+E (explain), Cmd+Shift+P (custom), Cmd+Shift+L (playground)
