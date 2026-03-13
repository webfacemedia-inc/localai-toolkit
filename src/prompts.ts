import * as vscode from "vscode";

// ────────────────────────────────────────────────────────────────
// Commit message prompts
// ────────────────────────────────────────────────────────────────

const COMMIT_STYLES: Record<string, string> = {
  conventional: `Write a commit message using Conventional Commits format.
Format: <type>(<scope>): <description>

Types: feat, fix, refactor, style, docs, test, chore, perf, ci, build
The scope should be the main area changed (brief, 1-2 words).
The description should be imperative mood, lowercase, no period.

If there are multiple significant changes, add a blank line then bullet points.
Keep the first line under 72 characters.`,

  descriptive: `Write a detailed commit message.
First line: concise summary of what changed (under 72 chars).
Then a blank line, then a paragraph explaining WHY the change was made and any notable details.
Be specific about what files/components were affected.`,

  brief: `Write a single-line commit message (under 72 characters).
Be specific but concise. Use imperative mood ("Add", "Fix", "Update", not "Added").
No prefixes or conventional commit format needed.`,
};

export function commitMessagePrompt(diff: string): { system: string; user: string } {
  const style = vscode.workspace.getConfiguration("localai").get<string>("commitStyle", "conventional");
  return {
    system: `You are a commit message generator. ${COMMIT_STYLES[style] ?? COMMIT_STYLES.conventional}

Respond with ONLY the commit message, no markdown, no code fences, no explanation.`,
    user: `Generate a commit message for this diff:\n\n${diff}`,
  };
}

// ────────────────────────────────────────────────────────────────
// Code tool prompts
// ────────────────────────────────────────────────────────────────

export function explainPrompt(code: string, language: string) {
  return {
    system: `You are a senior developer explaining code to a colleague. Be concise but thorough. Use markdown formatting. Mention any potential issues or edge cases you see.`,
    user: `Explain this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
  };
}

export function refactorPrompt(code: string, language: string) {
  return {
    system: `You are a senior developer refactoring code. Return ONLY the improved code inside a single code fence. Add a brief comment at the top noting what you changed. Preserve the original functionality.`,
    user: `Refactor this ${language} code for clarity, performance, and best practices:\n\n\`\`\`${language}\n${code}\n\`\`\``,
  };
}

export function addCommentsPrompt(code: string, language: string) {
  return {
    system: `You are a senior developer adding documentation comments. Return ONLY the code with added comments — JSDoc/TSDoc for functions, inline comments for complex logic. Don't change any code, only add comments. Return inside a single code fence.`,
    user: `Add documentation comments to this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
  };
}

export function writeTestsPrompt(code: string, language: string) {
  return {
    system: `You are a senior developer writing unit tests. Infer the test framework from the language (Jest for TS/JS, pytest for Python, etc). Cover happy path, edge cases, and error cases. Return ONLY the test code inside a single code fence.`,
    user: `Write comprehensive unit tests for this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
  };
}

export function translatePrompt(text: string, targetLang: string) {
  return {
    system: `You are a professional translator. Translate the text naturally — not word-for-word. Preserve formatting, code references, and technical terms. Return ONLY the translated text.`,
    user: `Translate to ${targetLang}:\n\n${text}`,
  };
}

export function customPrompt(code: string, language: string, instruction: string) {
  return {
    system: `You are a senior developer assistant. Follow the user's instruction precisely. If the result is code, return it in a code fence. Be concise.`,
    user: `Language: ${language}\nInstruction: ${instruction}\n\nCode:\n\`\`\`${language}\n${code}\n\`\`\``,
  };
}

// ────────────────────────────────────────────────────────────────
// Harness system prompt — teaches the model to use tools
// ────────────────────────────────────────────────────────────────

export function harnessSystemPrompt(workspacePath: string, openFiles: string[]): string {
  const fileList = openFiles.length > 0
    ? `Currently open files:\n${openFiles.map((f) => `- ${f}`).join("\n")}`
    : "No files currently open.";

  return `You are an AI coding assistant with access to the user's workspace at: ${workspacePath}

You can use tools by writing <tool_call> blocks. Available tools:

## read_file
Read a file from the workspace.
<tool_call>
<name>read_file</name>
<path>relative/path/to/file</path>
</tool_call>

## write_file
Create or overwrite a file. The user will be asked to confirm.
<tool_call>
<name>write_file</name>
<path>relative/path/to/file</path>
<content>
full file contents here
</content>
</tool_call>

## edit_file
Edit a specific section of a file using search/replace. The user will be asked to confirm.
<tool_call>
<name>edit_file</name>
<path>relative/path/to/file</path>
<search>exact text to find</search>
<replace>replacement text</replace>
</tool_call>

## run_command
Execute a shell command. The user will be asked to confirm.
<tool_call>
<name>run_command</name>
<command>the command to run</command>
</tool_call>

## fetch_url
Fetch a web page or API endpoint. Useful for reading documentation, checking APIs, or pulling reference material. The user will be asked to confirm. Only public URLs are allowed (no localhost/private IPs).
<tool_call>
<name>fetch_url</name>
<url>https://example.com/docs/api</url>
</tool_call>

Rules:
- Always read a file before editing it so you have the exact content
- Use edit_file for small changes, write_file for new files or complete rewrites
- After making changes, consider verifying by reading the file or running tests
- Explain what you're doing and why before using tools
- You can use multiple tools in one response
- Keep tool_call blocks on their own lines, separate from your explanation text
- Paths must be relative to the workspace root

${fileList}`;
}
