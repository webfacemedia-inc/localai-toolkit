// ────────────────────────────────────────────────────────────────
// Tool call parser — extracts structured tool calls from LLM output
// Uses XML-style tags for universal model compatibility
// ────────────────────────────────────────────────────────────────

export interface ReadFileCall {
  type: "read_file";
  path: string;
}

export interface WriteFileCall {
  type: "write_file";
  path: string;
  content: string;
}

export interface EditFileCall {
  type: "edit_file";
  path: string;
  search: string;
  replace: string;
}

export interface RunCommandCall {
  type: "run_command";
  command: string;
}

export interface ReplaceLinesCall {
  type: "replace_lines";
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface FetchUrlCall {
  type: "fetch_url";
  url: string;
}

export interface InvalidToolCall {
  type: "invalid";
  name: string;
  error: string;
}

export type ToolCall = ReadFileCall | WriteFileCall | EditFileCall | ReplaceLinesCall | RunCommandCall | FetchUrlCall | InvalidToolCall;

const VALID_TOOLS = ["read_file", "write_file", "edit_file", "replace_lines", "run_command", "fetch_url"];

// Common aliases models invent → map to actual tool names
const TOOL_ALIASES: Record<string, string> = {
  list_directory: "run_command",
  list_dir: "run_command",
  ls: "run_command",
  list_files: "run_command",
  search: "run_command",
  grep: "run_command",
  find: "run_command",
  cat: "read_file",
  view_file: "read_file",
  show_file: "read_file",
  open_file: "read_file",
  create_file: "write_file",
  update_file: "edit_file",
  modify_file: "edit_file",
  patch_file: "edit_file",
  execute: "run_command",
  exec: "run_command",
  shell: "run_command",
  bash: "run_command",
  terminal: "run_command",
  curl: "fetch_url",
  wget: "fetch_url",
  http: "fetch_url",
};

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)<\/tool_call>/g;

/**
 * Extract a tag value, handling multiple formats models use:
 *  - <tag>value</tag>        (correct)
 *  - <tag=value>             (Qwen-style attribute)
 *  - <tag=value></tag>       (hybrid)
 *  - <tag = value>           (spaced)
 */
function extractTag(xml: string, tag: string): string | undefined {
  // Standard: <tag>value</tag>
  const stdRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const stdMatch = xml.match(stdRe);
  if (stdMatch) return stdMatch[1];

  // Hybrid: <tag=value</anything> (model mixes attribute syntax with any closing tag)
  const hybridRe = new RegExp(`<${tag}\\s*=\\s*([^<>]*)<\\/[^>]*>`, "i");
  const hybridMatch = xml.match(hybridRe);
  if (hybridMatch) return hybridMatch[1].trim();

  // Attribute-style: <tag=value> (no closing tag, stops at < or >)
  const attrRe = new RegExp(`<${tag}\\s*=\\s*([^<>]*)>`, "i");
  const attrMatch = xml.match(attrRe);
  if (attrMatch) return attrMatch[1].trim();

  return undefined;
}

/**
 * Extract the tool name from a tool_call body, handling multiple formats:
 *  - <name>tool_name</name>
 *  - <name=tool_name>
 *  - <name=tool_name></name>
 *  - <tool_name> (bare tool name as first tag)
 */
function extractToolName(body: string): string | undefined {
  // Try standard and attribute-style extraction
  const name = extractTag(body, "name");
  if (name) return name.trim();

  // Bare tool name: models sometimes write <read_file> instead of <name>read_file</name>
  for (const tool of [...VALID_TOOLS, ...Object.keys(TOOL_ALIASES)]) {
    if (body.match(new RegExp(`<${tool}[\\s>/]`, "i"))) {
      return tool;
    }
  }

  return undefined;
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    const body = match[1];
    let name = extractToolName(body);
    if (!name) continue;

    // Resolve aliases — convert invented tool names to real ones
    const originalName = name;
    if (TOOL_ALIASES[name]) {
      name = TOOL_ALIASES[name];
    }

    // For aliased commands that map to run_command, synthesize the command
    if (name === "run_command" && !VALID_TOOLS.includes(originalName)) {
      const aliasedCommand = synthesizeCommand(originalName, body);
      if (aliasedCommand) {
        calls.push({ type: "run_command", command: aliasedCommand });
        continue;
      }
    }

    // For aliased read operations
    if (name === "read_file" && !VALID_TOOLS.includes(originalName)) {
      const filePath = extractTag(body, "path")?.trim()
        || extractTag(body, "file")?.trim()
        || extractTag(body, "filename")?.trim();
      if (filePath) {
        calls.push({ type: "read_file", path: filePath });
        continue;
      }
    }

    switch (name) {
      case "read_file": {
        const path = extractTag(body, "path")?.trim()
          || extractTag(body, "file")?.trim()
          || extractTag(body, "filename")?.trim();
        if (path) calls.push({ type: "read_file", path });
        break;
      }
      case "write_file": {
        const path = extractTag(body, "path")?.trim()
          || extractTag(body, "file")?.trim();
        const content = extractTag(body, "content");
        if (path && content !== undefined) {
          calls.push({ type: "write_file", path, content: content.replace(/^\n/, "").replace(/\n$/, "") });
        }
        break;
      }
      case "edit_file": {
        const path = extractTag(body, "path")?.trim()
          || extractTag(body, "file")?.trim();
        const search = extractTag(body, "search")
          ?? extractTag(body, "old")
          ?? extractTag(body, "find");
        const replace = extractTag(body, "replace")
          ?? extractTag(body, "new")
          ?? extractTag(body, "replacement");
        if (path && search !== undefined && replace !== undefined) {
          calls.push({
            type: "edit_file",
            path,
            search: search.replace(/^\n/, "").replace(/\n$/, ""),
            replace: replace.replace(/^\n/, "").replace(/\n$/, ""),
          });
        }
        break;
      }
      case "replace_lines": {
        const path = extractTag(body, "path")?.trim();
        const startStr = extractTag(body, "start_line")?.trim();
        const endStr = extractTag(body, "end_line")?.trim();
        const content = extractTag(body, "content");
        if (path && startStr && endStr && content !== undefined) {
          const startLine = parseInt(startStr, 10);
          const endLine = parseInt(endStr, 10);
          if (!isNaN(startLine) && !isNaN(endLine)) {
            calls.push({
              type: "replace_lines",
              path,
              startLine,
              endLine,
              content: content.replace(/^\n/, "").replace(/\n$/, ""),
            });
          }
        }
        break;
      }
      case "run_command": {
        const command = extractTag(body, "command")?.trim()
          || extractTag(body, "cmd")?.trim();
        if (command) calls.push({ type: "run_command", command });
        break;
      }
      case "fetch_url": {
        const url = extractTag(body, "url")?.trim();
        if (url) calls.push({ type: "fetch_url", url });
        break;
      }
      default: {
        // Unknown tool — return error so the model gets feedback
        calls.push({
          type: "invalid",
          name: originalName,
          error: `Unknown tool "${originalName}". Available tools: ${VALID_TOOLS.join(", ")}`,
        });
        break;
      }
    }
  }

  return calls;
}

/**
 * For aliased tool names (list_directory, ls, grep, etc.), try to
 * synthesize a shell command from the body parameters.
 */
function synthesizeCommand(alias: string, body: string): string | undefined {
  const pathArg = extractTag(body, "path")?.trim()
    || extractTag(body, "directory")?.trim()
    || extractTag(body, "dir")?.trim();

  switch (alias) {
    case "list_directory":
    case "list_dir":
    case "ls":
    case "list_files":
      return `ls -la ${pathArg || "."}`;
    case "search":
    case "grep":
      const pattern = extractTag(body, "pattern")?.trim()
        || extractTag(body, "query")?.trim()
        || extractTag(body, "term")?.trim();
      if (pattern) return `grep -rn "${pattern}" ${pathArg || "."}`;
      return undefined;
    case "find":
      const findPattern = extractTag(body, "pattern")?.trim()
        || extractTag(body, "name")?.trim();
      if (findPattern) return `find ${pathArg || "."} -name "${findPattern}"`;
      return pathArg ? `find ${pathArg} -type f` : undefined;
    default:
      return undefined;
  }
}

/** Detect if text has an incomplete tool_call block still being streamed */
export function hasPartialToolCall(text: string): boolean {
  const openCount = (text.match(/<tool_call>/g) || []).length;
  const closeCount = (text.match(/<\/tool_call>/g) || []).length;
  return openCount > closeCount;
}

/** Strip tool_call blocks from text, returning just the conversational parts */
export function stripToolCalls(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
}
