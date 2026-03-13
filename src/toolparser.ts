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

export interface FetchUrlCall {
  type: "fetch_url";
  url: string;
}

export type ToolCall = ReadFileCall | WriteFileCall | EditFileCall | RunCommandCall | FetchUrlCall;

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)<\/tool_call>/g;

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    const body = match[1];
    const name = extractTag(body, "name")?.trim();
    if (!name) continue;

    switch (name) {
      case "read_file": {
        const path = extractTag(body, "path")?.trim();
        if (path) calls.push({ type: "read_file", path });
        break;
      }
      case "write_file": {
        const path = extractTag(body, "path")?.trim();
        const content = extractTag(body, "content");
        if (path && content !== undefined) {
          // Trim leading/trailing newline from content (XML formatting artifact)
          calls.push({ type: "write_file", path, content: content.replace(/^\n/, "").replace(/\n$/, "") });
        }
        break;
      }
      case "edit_file": {
        const path = extractTag(body, "path")?.trim();
        const search = extractTag(body, "search");
        const replace = extractTag(body, "replace");
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
      case "run_command": {
        const command = extractTag(body, "command")?.trim();
        if (command) calls.push({ type: "run_command", command });
        break;
      }
      case "fetch_url": {
        const url = extractTag(body, "url")?.trim();
        if (url) calls.push({ type: "fetch_url", url });
        break;
      }
    }
  }

  return calls;
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
