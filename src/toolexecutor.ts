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
    case "run_command":
      return executeRunCommand(call.command, confirm);
    case "fetch_url":
      return executeFetchUrl(call.url, confirm);
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

    // Truncate very large files
    const MAX_READ = 16_000;
    if (content.length > MAX_READ) {
      content = content.slice(0, MAX_READ) + `\n\n... (truncated at ${MAX_READ} chars, file is ${content.length} chars total)`;
    }

    return { success: true, output: content };
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

  const approved = await confirm(
    `Write file: ${filePath}`,
    `The AI wants to create/overwrite this file (${content.length} chars). Allow?`
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

    return { success: true, output: `File written: ${filePath} (${content.length} chars)` };
  } catch (err: any) {
    return { success: false, output: `Failed to write ${filePath}: ${err.message}` };
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
      return { success: false, output: `Search string not found in ${filePath}. Read the file first to get exact content.` };
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

    return { success: true, output: `File edited: ${filePath}` };
  } catch (err: any) {
    return { success: false, output: `Failed to edit ${filePath}: ${err.message}` };
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
