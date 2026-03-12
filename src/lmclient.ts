import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
}

export interface ModelInfo {
  id: string;
  object: string;
  owned_by?: string;
}

// ────────────────────────────────────────────────────────────────
// Config helper
// ────────────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("localai");
  return {
    endpoint: cfg.get<string>("endpoint", "http://localhost:1234"),
    model: cfg.get<string>("model", ""),
    temperature: cfg.get<number>("temperature", 0.3),
    maxTokens: cfg.get<number>("maxTokens", 2048),
    stream: cfg.get<boolean>("streamResponses", true),
  };
}

// ────────────────────────────────────────────────────────────────
// Low-level fetch (no external deps — uses Node http/https)
// ────────────────────────────────────────────────────────────────

function request(
  url: string,
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error("Request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function streamRequest(
  url: string,
  options: http.RequestOptions,
  body: string,
  onToken: (token: string) => void,
  cancel: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    let full = "";
    const req = lib.request(url, options, (res) => {
      res.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) {
              full += token;
              onToken(token);
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      });
      res.on("end", () => resolve(full));
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("Stream timed out")));

    cancel.onCancellationRequested(() => {
      req.destroy(new Error("Cancelled"));
    });

    req.write(body);
    req.end();
  });
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/** Check if the LM Studio server is reachable */
export async function healthCheck(): Promise<boolean> {
  const { endpoint } = getConfig();
  try {
    const { status } = await request(`${endpoint}/v1/models`, { method: "GET" });
    return status === 200;
  } catch {
    return false;
  }
}

/** List available models */
export async function listModels(): Promise<ModelInfo[]> {
  const { endpoint } = getConfig();
  const { status, data } = await request(`${endpoint}/v1/models`, {
    method: "GET",
  });
  if (status !== 200) throw new Error(`LM Studio returned ${status}: ${data}`);
  const parsed = JSON.parse(data);
  return parsed.data ?? [];
}

/** Non-streaming completion */
export async function complete(opts: CompletionOptions): Promise<string> {
  const cfg = getConfig();
  const endpoint = `${cfg.endpoint}/v1/chat/completions`;
  const body = JSON.stringify({
    model: opts.model || cfg.model || undefined,
    messages: opts.messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: false,
  });

  const { status, data } = await request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, body);

  if (status !== 200) throw new Error(`LM Studio returned ${status}: ${data}`);
  const parsed = JSON.parse(data);
  return parsed.choices?.[0]?.message?.content ?? "";
}

/** Streaming completion — calls onToken for each chunk */
export async function completeStream(
  opts: CompletionOptions,
  onToken: (token: string) => void,
  cancel: vscode.CancellationToken
): Promise<string> {
  const cfg = getConfig();
  const endpoint = `${cfg.endpoint}/v1/chat/completions`;
  const body = JSON.stringify({
    model: opts.model || cfg.model || undefined,
    messages: opts.messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: true,
  });

  return streamRequest(
    endpoint,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    body,
    onToken,
    cancel
  );
}
