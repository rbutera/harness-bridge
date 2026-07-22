import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcDecoder, encode, isResponse, type JsonRpcMessage } from "./jsonrpc.js";
import { unrestrictedSandboxPolicy } from "./sandbox-policy.js";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from "./harness.js";
import { logger, type ProgressReporter } from "./logger.js";
import type { CodexResult } from "./types.js";

/**
 * Phase 2 backend: drive Codex through `codex app-server` instead of spawning a
 * `codex exec` subprocess per call.
 *
 * Why this exists, beyond tidiness. The exec transport has two structural
 * limits that no amount of care around it removes:
 *
 * - **Process cost.** Exec starts a new CLI process for every call.
 * - **No cancellation.** A wedged exec holds its slot until the timeout expires.
 *   `turn/interrupt` cancels a turn in flight.
 *
 * Threads are first-class in the protocol, so concurrency is a protocol feature
 * rather than something the caller works around.
 *
 * Enable with `HARNESS_BRIDGE_CODEX_BACKEND=app-server`. It ships disabled: the exec
 * path stays the default until this has run in anger, and `codex app-server` is
 * still marked experimental in the CLI.
 *
 * **Known behavioural difference, measured 2026-07-22.** `codex exec` refuses to
 * run outside a trusted git directory ("Not inside a trusted directory and
 * --skip-git-repo-check was not specified"); the app-server has no equivalent
 * guard and will happily work in a bare directory. Inside a git repo the two
 * backends returned identical output for the same tool call (17.8s vs 19.5s on
 * a file query). Treat the missing guard as a real difference, not an
 * improvement: it removes a check that today prevents a stray call from acting
 * somewhere unintended.
 */

export const BACKEND_ENV_VAR = "HARNESS_BRIDGE_CODEX_BACKEND";
export const LEGACY_BACKEND_ENV_VAR = "CODEX_BRIDGE_BACKEND";

/** True when the app-server backend has been explicitly opted into. */
export function isAppServerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[BACKEND_ENV_VAR] ?? env[LEGACY_BACKEND_ENV_VAR]) === "app-server";
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface TurnOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Resume this thread instead of starting a new one. */
  resumeThreadId?: string | null;
  progress?: ProgressReporter;
}

/**
 * A connection to one `codex app-server` process.
 *
 * One instance is shared by the whole bridge process. Threads isolate callers
 * from each other, so a shared connection is safe in a way the exec path's
 * shared thread pointer never was.
 */
export class AppServerClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #decoder = new JsonRpcDecoder();
  #pending = new Map<number, Pending>();
  #notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  #nextId = 0;
  #ready: Promise<void> | null = null;

  /**
   * Spawn and initialize the app-server, at most once.
   *
   * Readiness is tracked as a promise rather than by checking whether the child
   * exists. `#doStart` assigns `#child` synchronously, before `initialize` has
   * been answered, so a concurrent caller testing for the child would sail past
   * and issue requests on an un-initialized server. Awaiting the same promise
   * makes every caller wait for the handshake.
   *
   * A failed start clears the promise so the next call retries rather than
   * caching the rejection forever.
   */
  start(): Promise<void> {
    this.#ready ??= this.#doStart().catch((error: unknown) => {
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async #doStart(): Promise<void> {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const message of this.#decoder.push(chunk.toString())) {
        this.#dispatch(message);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logger.debug(`[app-server:stderr] ${chunk.toString().replace(/\n$/, "")}`);
    });
    child.on("exit", (code: number | null) => {
      // Fail every in-flight call rather than leaving callers hanging forever.
      const error = new Error(`codex app-server exited with code ${code}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#child = null;
    });

    await this.request("initialize", {
      clientInfo: { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION },
      capabilities: null,
    });
  }

  #dispatch(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.#pending.get(message.id as number);
      if (!pending) return;
      this.#pending.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const handler of this.#notificationHandlers) handler(message);
  }

  /** Issue a JSON-RPC request and await its response. */
  request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("app-server is not running"));

    const id = ++this.#nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.stdin.write(encode({ id, method, params }));
    });
  }

  #onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  /**
   * Run one turn to completion and return it in the same shape the exec backend
   * produces, so this is a drop-in replacement for `runCodex`.
   */
  async runTurn(options: TurnOptions): Promise<CodexResult> {
    await this.start();

    const sandboxPolicy = unrestrictedSandboxPolicy();

    const threadResult = (await (options.resumeThreadId
      ? this.request("thread/resume", {
          threadId: options.resumeThreadId,
          cwd: options.cwd,
          sandbox: "danger-full-access",
          model: options.model,
        })
      : this.request("thread/start", {
          cwd: options.cwd,
          sandbox: "danger-full-access",
          model: options.model,
        }))) as { thread?: { id?: string }; threadId?: string };

    const threadId = threadResult.threadId ?? threadResult.thread?.id;
    if (!threadId) throw new Error("app-server returned no threadId");

    const result: CodexResult = {
      threadId,
      agentMessage: "",
      fileChanges: [],
      commandsExecuted: [],
      usage: null,
      errors: [],
    };

    const completion = new Promise<void>((resolve, reject) => {
      const unsubscribe = this.#onNotification((message) => {
        const params = (message.params ?? {}) as Record<string, unknown>;
        // Ignore traffic belonging to other concurrent turns.
        if (params["threadId"] && params["threadId"] !== threadId) return;

        switch (message.method) {
          case "item/completed": {
            this.#recordItem(result, params["item"] as Record<string, unknown> | undefined);
            break;
          }
          case "item/started": {
            const item = params["item"] as Record<string, unknown> | undefined;
            if (item?.["type"]) options.progress?.report(String(item["type"]));
            break;
          }
          case "thread/tokenUsage/updated": {
            const usage = params["usage"] as Record<string, number> | undefined;
            if (usage) {
              result.usage = {
                inputTokens: usage["inputTokens"] ?? 0,
                outputTokens: usage["outputTokens"] ?? 0,
              };
            }
            break;
          }
          case "turn/completed": {
            unsubscribe();
            resolve();
            break;
          }
          case "error": {
            const text = String(params["message"] ?? "unknown app-server error");
            result.errors.push(text);
            unsubscribe();
            reject(new Error(text));
            break;
          }
        }
      });
    });

    options.progress?.report("Starting codex turn...");
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      sandboxPolicy,
      model: options.model,
      effort: options.effort,
    });

    await completion;
    return result;
  }

  /** Cancel a turn in flight. The exec backend has no equivalent. */
  async interrupt(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  /** Extract the fields the bridge reports from a completed item. */
  #recordItem(result: CodexResult, item: Record<string, unknown> | undefined): void {
    if (!item) return;
    switch (item["type"]) {
      case "agentMessage": {
        const text = item["text"];
        if (typeof text === "string") result.agentMessage += text;
        break;
      }
      case "fileChange": {
        const path = item["path"];
        if (typeof path === "string") {
          result.fileChanges.push({ path, kind: String(item["kind"] ?? "modify") });
        }
        break;
      }
      case "commandExecution": {
        const command = item["command"];
        if (typeof command === "string") {
          const exit = item["exitCode"];
          result.commandsExecuted.push({
            command,
            exitCode: typeof exit === "number" ? exit : null,
            output: String(item["output"] ?? ""),
          });
        }
        break;
      }
    }
  }

  /** Shut the app-server down. */
  stop(): void {
    this.#child?.kill();
    this.#ready = null;
    this.#child = null;
  }
}
