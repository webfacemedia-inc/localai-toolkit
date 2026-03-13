import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { ToolCall } from "./toolparser";

export interface ToolResult {
  success: boolean;
  output: string;
}

// ────────────────────────────────────────────────────────────────
// Syntax validation — catches common LLM edit mistakes
// ────────────────────────────────────────────────────────────────

function validateSyntax(content: string, filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const errors: string[] = [];

  // JSON validation
  if (ext === ".json") {
    try {
      JSON.parse(content);
    } catch (e: any) {
      return `JSON syntax error: ${e.message}`;
    }
    return null;
  }

  // Bracket/brace/paren balance for code files
  const codeExts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".css", ".scss", ".less"];
  if (!codeExts.includes(ext)) return null;

  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: { char: string; line: number }[] = [];
  const lines = content.split("\n");

  let inString: string | null = null;
  let inTemplateLiteral = false;
  let templateDepth = 0;
  let inLineComment = false;
  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    inLineComment = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      // Handle block comments
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      // Handle line comments
      if (inLineComment) continue;

      // Handle strings
      if (inString) {
        if (ch === "\\" ) { i++; continue; }
        if (ch === inString) { inString = null; }
        continue;
      }

      // Handle template literals
      if (inTemplateLiteral && templateDepth === 0) {
        if (ch === "\\" ) { i++; continue; }
        if (ch === "`") { inTemplateLiteral = false; continue; }
        if (ch === "$" && next === "{") {
          templateDepth++;
          i++;
          continue;
        }
        continue;
      }

      // Start of comments
      if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }

      // Start of strings
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === "`") { inTemplateLiteral = true; continue; }

      // Template literal expression end
      if (inTemplateLiteral && templateDepth > 0 && ch === "}") {
        templateDepth--;
        if (templateDepth === 0) continue;
      }

      // Bracket matching
      if (pairs[ch]) {
        stack.push({ char: ch, line: lineIdx + 1 });
      } else if (closers[ch]) {
        if (stack.length === 0) {
          errors.push(`Line ${lineIdx + 1}: unexpected '${ch}' with no matching '${closers[ch]}'`);
        } else {
          const top = stack[stack.length - 1];
          if (top.char !== closers[ch]) {
            errors.push(`Line ${lineIdx + 1}: '${ch}' doesn't match '${top.char}' opened at line ${top.line}`);
          } else {
            stack.pop();
          }
        }
      }
    }
  }

  // Check unclosed brackets
  for (const item of stack) {
    errors.push(`Line ${item.line}: unclosed '${item.char}'`);
  }

  // Check for JSX-specific issues in JSX/TSX files
  if ([".jsx", ".tsx", ".js"].includes(ext)) {
    // Detect duplicate adjacent closing tags like </button></button>
    const dupCloseRe = /(<\/(\w+)>)\s*\1/g;
    let m: RegExpExecArray | null;
    const contentForSearch = content;
    while ((m = dupCloseRe.exec(contentForSearch)) !== null) {
      const before = contentForSearch.slice(0, m.index);
      const lineNum = before.split("\n").length;
      errors.push(`Line ${lineNum}: duplicate closing tag </${m[2]}> — likely a copy/paste error`);
    }
  }

  if (errors.length > 0) {
    return `SYNTAX WARNING after editing ${filePath}:\n${errors.slice(0, 5).join("\n")}\n\nPlease fix these issues before proceeding.`;
  }
  return null;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string | undefined {
  const root = getWorkspaceRoot();
  if (!root) return undefined;

  // Reject absolute paths and traversal
  if (path.isAbsolute(filePath) || filePath.includes("..")) return undefined;

  const resolved = path.resolve(root, filePath);
  // Double-check it's still inside workspace
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return undefined;

  return resolved;
}

function isCommandBlocked(command: string): boolean {
  const cfg = vscode.workspace.getConfiguration("localai.harness");
  const blocked = cfg.get<string[]>("blockedCommands", [
    "rm -rf /", "sudo rm", "mkfs", "format", ":(){:|:&};:",
  ]);
  const lower = command.toLowerCase();
  return blocked.some((pattern) => lower.includes(pattern.toLowerCase()));
}

// ────────────────────────────────────────────────────────────────
// Execute a single tool call
// ────────────────────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  switch (call.type) {
    case "read_file":
      return executeReadFile(call.path);
    case "write_file":
      return executeWriteFile(call.path, call.content, confirm);
    case "edit_file":
      return executeEditFile(call.path, call.search, call.replace, confirm);
    case "replace_lines":
      return executeReplaceLines(call.path, call.startLine, call.endLine, call.content, confirm);
    case "run_command":
      return executeRunCommand(call.command, confirm);
    case "fetch_url":
      return executeFetchUrl(call.url, confirm);
    case "invalid":
      return { success: false, output: call.error };
  }
}

// ────────────────────────────────────────────────────────────────
// read_file
// ────────────────────────────────────────────────────────────────

async function executeReadFile(filePath: string): Promise<ToolResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, output: `Invalid path: ${filePath}. Must be relative to workspace, no ".." allowed.` };
  }

  try {
    const uri = vscode.Uri.file(resolved);
    const bytes = await vscode.workspace.fs.readFile(uri);
    let content = Buffer.from(bytes).toString("utf-8");

    // Add line numbers and truncate very large files
    const lines = content.split("\n");
    let numbered = lines.map((line, i) => `${i + 1}: ${line}`).join("\n");

    const MAX_READ = 16_000;
    if (numbered.length > MAX_READ) {
      numbered = numbered.slice(0, MAX_READ) + `\n\n... (truncated at ${MAX_READ} chars, file has ${lines.length} lines total)`;
    }

    return { success: true, output: numbered };
  } catch (err: any) {
    return { success: false, output: `Cannot read ${filePath}: ${err.message}` };
  }
}

// ────────────────────────────────────────────────────────────────
// write_file
// ────────────────────────────────────────────────────────────────

async function executeWriteFile(
  filePath: string,
  content: string,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, output: `Invalid path: ${filePath}. Must be relative to workspace, no ".." allowed.` };
  }

  // Block write_file on existing files — force models to use replace_lines or edit_file
  try {
    const uri = vscode.Uri.file(resolved);
    await vscode.workspace.fs.stat(uri);
    // File exists — reject
    return {
      success: false,
      output: `REJECTED: "${filePath}" already exists. write_file is ONLY for creating NEW files. `
        + `To modify an existing file, use replace_lines (preferred — specify line numbers from read_file output) `
        + `or edit_file (search/replace). Read the file first if you haven't already.`,
    };
  } catch {
    // File doesn't exist — good, proceed with creation
  }

  const approved = await confirm(
    `Create file: ${filePath}`,
    `The AI wants to create this NEW file (${content.length} chars). Allow?`
  );
  if (!approved) {
    return { success: false, output: "User rejected write_file operation." };
  }

  try {
    const uri = vscode.Uri.file(resolved);
    // Ensure parent directory exists
    const dir = vscode.Uri.file(path.dirname(resolved));
    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      await vscode.workspace.fs.createDirectory(dir);
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));

    // Open the file so user can see it
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);

    let msg = `File created: ${filePath} (${content.length} chars)`;
    const syntaxErr = validateSyntax(content, filePath);
    if (syntaxErr) {
      msg += `\n\n${syntaxErr}`;
    }
    return { success: true, output: msg };
  } catch (err: any) {
    return { success: false, output: `Failed to create ${filePath}: ${err.message}` };
  }
}

// ────────────────────────────────────────────────────────────────
// edit_file (search/replace)
// ────────────────────────────────────────────────────────────────

async function executeEditFile(
  filePath: string,
  search: string,
  replace: string,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, output: `Invalid path: ${filePath}. Must be relative to workspace, no ".." allowed.` };
  }

  try {
    const uri = vscode.Uri.file(resolved);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const original = Buffer.from(bytes).toString("utf-8");

    if (!original.includes(search)) {
      // Find the most similar section to help the model correct itself
      const lines = original.split("\n");
      const searchFirstLine = search.split("\n")[0].trim();
      let bestLineIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        // Simple overlap score
        const overlap = searchFirstLine.split("").filter((c, j) => line[j] === c).length;
        const score = overlap / Math.max(searchFirstLine.length, line.length);
        if (score > bestScore) {
          bestScore = score;
          bestLineIdx = i;
        }
      }
      let hint = "";
      if (bestLineIdx >= 0 && bestScore > 0.3) {
        const start = Math.max(0, bestLineIdx - 2);
        const end = Math.min(lines.length, bestLineIdx + 5);
        const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        hint = `\n\nClosest match near line ${bestLineIdx + 1}:\n${snippet}\n\nTip: Use replace_lines with line numbers instead — it's more reliable.`;
      }
      return { success: false, output: `Search string not found in ${filePath}. The text must match exactly.${hint}` };
    }

    const modified = original.replace(search, replace);

    const approved = await confirm(
      `Edit file: ${filePath}`,
      `Replace ${search.length} chars with ${replace.length} chars. Allow?`
    );
    if (!approved) {
      return { success: false, output: "User rejected edit_file operation." };
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(modified, "utf-8"));

    // Open and show the edited file
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);

    let msg = `File edited: ${filePath}`;
    const syntaxErr = validateSyntax(modified, filePath);
    if (syntaxErr) {
      msg += `\n\n${syntaxErr}`;
    }
    return { success: true, output: msg };
  } catch (err: any) {
    return { success: false, output: `Failed to edit ${filePath}: ${err.message}` };
  }
}

// ────────────────────────────────────────────────────────────────
// replace_lines (line-number-based editing)
// ────────────────────────────────────────────────────────────────

async function executeReplaceLines(
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  const resolved = resolvePath(filePath);
  if (!resolved) {
    return { success: false, output: `Invalid path: ${filePath}. Must be relative to workspace, no ".." allowed.` };
  }

  try {
    const uri = vscode.Uri.file(resolved);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const original = Buffer.from(bytes).toString("utf-8");
    const lines = original.split("\n");

    if (startLine < 1 || endLine < startLine || startLine > lines.length) {
      return { success: false, output: `Invalid line range ${startLine}-${endLine}. File has ${lines.length} lines.` };
    }

    // Clamp endLine to file length
    const clampedEnd = Math.min(endLine, lines.length);

    const oldSection = lines.slice(startLine - 1, clampedEnd).join("\n");

    const approved = await confirm(
      `Replace lines ${startLine}-${clampedEnd}: ${filePath}`,
      `Replacing ${clampedEnd - startLine + 1} lines. Allow?`
    );
    if (!approved) {
      return { success: false, output: "User rejected replace_lines operation." };
    }

    const newLines = content.split("\n");
    lines.splice(startLine - 1, clampedEnd - startLine + 1, ...newLines);
    const modified = lines.join("\n");

    await vscode.workspace.fs.writeFile(uri, Buffer.from(modified, "utf-8"));

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);

    let msg = `Replaced lines ${startLine}-${clampedEnd} in ${filePath} (${clampedEnd - startLine + 1} old lines → ${newLines.length} new lines)`;
    const syntaxErr = validateSyntax(modified, filePath);
    if (syntaxErr) {
      msg += `\n\n${syntaxErr}`;
    }
    return { success: true, output: msg };
  } catch (err: any) {
    return { success: false, output: `Failed to replace lines in ${filePath}: ${err.message}` };
  }
}

// ────────────────────────────────────────────────────────────────
// run_command
// ────────────────────────────────────────────────────────────────

async function executeRunCommand(
  command: string,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  if (isCommandBlocked(command)) {
    return { success: false, output: `Command blocked by safety filter: ${command}` };
  }

  const root = getWorkspaceRoot();
  if (!root) {
    return { success: false, output: "No workspace folder open." };
  }

  const approved = await confirm(
    `Run command`,
    `The AI wants to execute: ${command}`
  );
  if (!approved) {
    return { success: false, output: "User rejected run_command operation." };
  }

  const cfg = vscode.workspace.getConfiguration("localai.harness");
  const timeout = cfg.get<number>("commandTimeout", 30_000);

  return new Promise((resolve) => {
    cp.exec(command, { cwd: root, maxBuffer: 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const output = [
          stderr ? `STDERR:\n${stderr.slice(0, 4000)}` : "",
          stdout ? `STDOUT:\n${stdout.slice(0, 4000)}` : "",
          `Exit code: ${err.code ?? "unknown"}`,
          err.killed ? "(process was killed — timeout or signal)" : "",
        ].filter(Boolean).join("\n");
        resolve({ success: false, output: output || err.message });
      } else {
        const output = [
          stdout ? stdout.slice(0, 8000) : "(no output)",
          stderr ? `\nSTDERR:\n${stderr.slice(0, 2000)}` : "",
        ].filter(Boolean).join("");
        resolve({ success: true, output });
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────
// fetch_url
// ────────────────────────────────────────────────────────────────

function isUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // Block local/private IPs
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.startsWith("172.") ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function executeFetchUrl(
  url: string,
  confirm: (message: string, detail: string) => Promise<boolean>
): Promise<ToolResult> {
  if (!isUrlAllowed(url)) {
    return { success: false, output: `URL not allowed: ${url}. Only public http/https URLs are permitted.` };
  }

  const approved = await confirm(
    `Fetch URL`,
    `The AI wants to fetch: ${url}`
  );
  if (!approved) {
    return { success: false, output: "User rejected fetch_url operation." };
  }

  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "LocalAI-Toolkit/1.0" }, timeout: 15_000 }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        if (!isUrlAllowed(redirectUrl)) {
          resolve({ success: false, output: `Redirect to disallowed URL: ${redirectUrl}` });
          return;
        }
        const rmod = redirectUrl.startsWith("https") ? https : http;
        rmod.get(redirectUrl, { headers: { "User-Agent": "LocalAI-Toolkit/1.0" }, timeout: 15_000 }, (rres) => {
          collectResponse(rres, resolve);
        }).on("error", (err) => {
          resolve({ success: false, output: `Fetch error (redirect): ${err.message}` });
        });
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        resolve({ success: false, output: `HTTP ${res.statusCode} fetching ${url}` });
        return;
      }

      collectResponse(res, resolve);
    });

    req.on("error", (err) => {
      resolve({ success: false, output: `Fetch error: ${err.message}` });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, output: `Fetch timed out after 15s: ${url}` });
    });
  });
}

function collectResponse(
  res: http.IncomingMessage,
  resolve: (result: ToolResult) => void
) {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const MAX_SIZE = 64_000; // 64KB max

  res.on("data", (chunk: Buffer) => {
    totalSize += chunk.length;
    if (totalSize <= MAX_SIZE) {
      chunks.push(chunk);
    }
  });

  res.on("end", () => {
    let body = Buffer.concat(chunks).toString("utf-8");

    // Strip HTML tags for cleaner output (basic)
    const contentType = res.headers["content-type"] || "";
    if (contentType.includes("text/html")) {
      // Remove script/style blocks entirely
      body = body.replace(/<script[\s\S]*?<\/script>/gi, "");
      body = body.replace(/<style[\s\S]*?<\/style>/gi, "");
      // Strip remaining HTML tags
      body = body.replace(/<[^>]+>/g, " ");
      // Collapse whitespace
      body = body.replace(/\s{2,}/g, " ").trim();
    }

    // Truncate if still too long
    if (body.length > 16_000) {
      body = body.slice(0, 16_000) + "\n\n... (truncated)";
    }

    if (totalSize > MAX_SIZE) {
      body += `\n\n(response truncated at ${MAX_SIZE} bytes, total was ${totalSize} bytes)`;
    }

    resolve({ success: true, output: body || "(empty response)" });
  });

  res.on("error", (err) => {
    resolve({ success: false, output: `Stream error: ${err.message}` });
  });
}
