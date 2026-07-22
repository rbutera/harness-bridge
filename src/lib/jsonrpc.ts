/**
 * Minimal newline-delimited JSON-RPC 2.0 framing.
 *
 * Split out from the app-server client so the framing can be tested without
 * spawning a process. The `codex app-server` transport is one JSON object per
 * line on stdio, so a chunk from the pipe may contain several messages, or half
 * of one; the decoder buffers accordingly.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Accumulates stdout chunks and yields whole JSON-RPC messages. */
export class JsonRpcDecoder {
  #buffer = "";

  /**
   * Feed a chunk, get back every complete message it completed.
   *
   * Unparseable lines are skipped rather than thrown: the app-server is free to
   * emit non-JSON diagnostics on stdout, and one stray line must not kill a run.
   */
  push(chunk: string): JsonRpcMessage[] {
    this.#buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // Not a JSON-RPC line; ignore.
      }
    }
    return messages;
  }

  /** Bytes buffered but not yet terminated by a newline. Exposed for tests. */
  get pending(): string {
    return this.#buffer;
  }
}

/** Serialise a request as a single transport line. */
export function encode(message: JsonRpcMessage): string {
  return JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
}

/** True when the message is a response (has an id) rather than a notification. */
export function isResponse(message: JsonRpcMessage): boolean {
  return message.id !== undefined && message.method === undefined;
}
