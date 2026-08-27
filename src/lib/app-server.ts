import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcDecoder, encode, isResponse, type JsonRpcMessage } from "./jsonrpc.js";
import { unrestrictedSandboxPolicy } from "./sandbox-policy.js";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from "./harness.js";
import { logger, type ProgressReporter } from "./logger.js";
import { resolveTimeoutMs } from "./exec-runner.js";
import type { CodexResult } from "./types.js";
import {
  HandshakeError,
  OverloadedError,
  ProtocolError,
  RequestTimeoutError,
  ServerCrashedError,
  SpawnError,
  mapRequestError,
} from "./app-server-errors.js";
import {
  Method,
  Notification,
  type ErrorNotification,
  type InitializeParams,
  type ItemNotification,
  type ThreadDeleteParams,
  type ThreadItemView,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStartedResult,
  type TokenUsageNotification,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartedResult,
} from "./protocol.js";

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
 * The protocol edge is typed against the generated bindings (src/generated, via
 * src/lib/protocol.ts) rather than hand-shaped `unknown` access, so a wrong field
 * name is a build error rather than a silently-dropped value.
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

/**
 * How long to wait for a single app-server JSON-RPC response before treating the
 * server as wedged.
 *
 * The failure this bounds is real and was expensive: under memory pressure the
 * `codex app-server` gets swapped out and stops answering. A protocol request
 * (`initialize`, `thread/start`, `turn/start`) then never comes back, and with no
 * timeout the whole call hangs until the MCP client's own ~30-minute limit fires.
 * A bounded request turns "hangs for half an hour" into "fails in two minutes and
 * the next call spawns a fresh server".
 */
export const REQUEST_TIMEOUT_ENV_VAR = "HARNESS_BRIDGE_APP_SERVER_REQUEST_TIMEOUT_MS";

function resolveRequestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[REQUEST_TIMEOUT_ENV_VAR];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * Best-effort thread disposal must never hold up a completed turn. If the server
 * is too wedged to answer a `thread/delete` in this window, the leaked stack is a
 * smaller problem than blocking the caller, so we give up and log.
 */
const DISPOSE_TIMEOUT_MS = 10_000;

/**
 * Retry budget for a request the server rejects as overloaded (JSON-RPC -32001).
 * Overload is transient and the server stays alive, so the fix is to back off and
 * resend, not to fail the call or tear the server down. Delays sit between
 * attempts (so 3 attempts means two waits).
 */
const OVERLOAD_MAX_ATTEMPTS = 3;
const OVERLOAD_BACKOFF_MS = [100, 400];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TurnOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Resume this thread instead of starting a new one. */
  resumeThreadId?: string | null;
  /**
   * Keep the thread alive after the turn so a later call can resume it.
   *
   * Defaults to disposing the thread. The app-server spawns a full MCP stack —
   * one child process per configured server — for each thread it starts, and
   * terminates those children only when the thread is dropped. A caller that
   * starts a thread, runs one turn, and walks away therefore leaks an entire MCP
   * stack every time. Only a caller that will actually resume the thread should
   * keep it.
   */
  keepThread?: boolean;
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
   * True once `initialize` has been answered. Distinguishes a child that dies
   * mid-handshake (an old/missing subcommand — a `HandshakeError`) from one that
   * crashes after it was working (a `ServerCrashedError`).
   */
  #initialized = false;

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
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (cause) {
      throw new SpawnError(cause);
    }
    this.#child = child;
    this.#initialized = false;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const message of this.#decoder.push(chunk.toString())) {
        this.#dispatch(message);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logger.debug(`[app-server:stderr] ${chunk.toString().replace(/\n$/, "")}`);
    });
    // A spawn-level failure (ENOENT when codex is not on PATH, EACCES, …) arrives
    // as an `error` event, not `exit`, and the process never runs. Without this
    // handler the pending `initialize` would hang until its timeout; instead we
    // fail every waiter now with an actionable "is codex installed?" message.
    child.on("error", (cause: Error) => {
      this.#failAllPending(new SpawnError(cause));
    });
    child.on("exit", (code: number | null) => {
      // A child that exits before the handshake completes almost always means a
      // codex too old to expose `app-server`; one that exits after means a crash.
      // Either way every in-flight call is failed rather than left hanging.
      const error = this.#initialized
        ? new ServerCrashedError(code)
        : new HandshakeError(`process exited with code ${code} during initialize`);
      this.#failAllPending(error);
    });

    const params: InitializeParams = {
      clientInfo: { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: PRODUCT_VERSION },
      capabilities: null,
    };
    await this.request(Method.initialize, params);
    this.#initialized = true;
  }

  #dispatch(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.#pending.get(message.id as number);
      if (!pending) return;
      this.#pending.delete(message.id as number);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(mapRequestError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const handler of this.#notificationHandlers) handler(message);
  }

  /**
   * Fail every in-flight request and reset the client so the next call spawns a
   * fresh, re-initialized server. Called from the `error` and `exit` handlers and
   * safe to run more than once (a cleared pending map makes a second call a
   * no-op).
   */
  #failAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#child = null;
    this.#ready = null;
    this.#initialized = false;
  }

  /**
   * Tear the app-server down after it stops answering, so the next call spawns a
   * fresh one rather than queueing behind a wedged process. Killing the child
   * fires its `exit` handler, which fails every remaining in-flight call.
   */
  #markUnhealthy(): void {
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    this.#initialized = false;
    child?.kill();
  }

  /**
   * Issue a JSON-RPC request and await its response, retrying on overload.
   *
   * `timeoutMs` bounds each attempt. A non-positive value disables the bound
   * (used by callers that impose their own, longer, bound around a whole turn).
   * Only overload (-32001) is retried, with bounded backoff; every other failure
   * — timeout, crash, protocol error — propagates immediately.
   */
  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = resolveRequestTimeoutMs(),
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#sendOnce<T>(method, params, timeoutMs);
      } catch (error) {
        if (error instanceof OverloadedError && attempt < OVERLOAD_MAX_ATTEMPTS) {
          const wait = OVERLOAD_BACKOFF_MS[attempt - 1] ?? OVERLOAD_BACKOFF_MS.at(-1) ?? 400;
          await delay(wait);
          continue;
        }
        // Report the attempts actually made rather than the mapper's placeholder.
        if (error instanceof OverloadedError) throw new OverloadedError(method, attempt);
        throw error;
      }
    }
  }

  #sendOnce<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const child = this.#child;
    if (!child) return Promise.reject(new ServerCrashedError(null));

    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        method,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          // Only act if we still own this id; a response may have raced in.
          if (!this.#pending.delete(id)) return;
          reject(new RequestTimeoutError(method, timeoutMs));
          this.#markUnhealthy();
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      try {
        child.stdin.write(encode({ id, method, params }));
      } catch (cause) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new ServerCrashedError(null, { cause }));
      }
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

    const started = options.resumeThreadId
      ? await this.request<ThreadStartedResult>(Method.threadResume, {
          threadId: options.resumeThreadId,
          cwd: options.cwd,
          sandbox: "danger-full-access",
          model: options.model,
        } satisfies ThreadResumeParams)
      : await this.request<ThreadStartedResult>(Method.threadStart, {
          cwd: options.cwd,
          sandbox: "danger-full-access",
          model: options.model,
        } satisfies ThreadStartParams);

    const threadId = started.thread?.id;
    if (!threadId) throw new ProtocolError("start response carried no thread id");

    const result: CodexResult = {
      threadId,
      agentMessage: "",
      fileChanges: [],
      commandsExecuted: [],
      usage: null,
      errors: [],
    };

    let unsubscribe: () => void = () => {};
    const completion = new Promise<void>((resolve, reject) => {
      unsubscribe = this.#onNotification((message) => {
        const params = message.params;
        switch (message.method) {
          case Notification.itemCompleted: {
            const notification = params as ItemNotification;
            if (notification.threadId && notification.threadId !== threadId) return;
            this.#recordItem(result, notification.item);
            break;
          }
          case Notification.itemStarted: {
            const notification = params as ItemNotification;
            if (notification.threadId && notification.threadId !== threadId) return;
            if (notification.item?.type) options.progress?.report(notification.item.type);
            break;
          }
          case Notification.tokenUsageUpdated: {
            const notification = params as TokenUsageNotification;
            if (notification.threadId && notification.threadId !== threadId) return;
            const total = notification.tokenUsage?.total;
            if (total) {
              result.usage = {
                inputTokens: total.inputTokens ?? 0,
                outputTokens: total.outputTokens ?? 0,
              };
            }
            break;
          }
          case Notification.turnCompleted: {
            const notification = params as { threadId?: string };
            if (notification.threadId && notification.threadId !== threadId) return;
            resolve();
            break;
          }
          case Notification.error: {
            const notification = params as ErrorNotification;
            if (notification.threadId && notification.threadId !== threadId) return;
            const text = notification.error?.message ?? "unknown app-server error";
            result.errors.push(text);
            // Abandon the turn only on a terminal error. When the server sets
            // `willRetry` it retries internally and a later `turn/completed` still
            // arrives; rejecting here would tear the thread down mid-retry.
            if (!notification.willRetry) reject(new Error(text));
            break;
          }
        }
      });
    });

    try {
      options.progress?.report("Starting codex turn...");
      const turn = await this.request<TurnStartedResult>(Method.turnStart, {
        threadId,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        cwd: options.cwd,
        sandboxPolicy,
        model: options.model,
        effort: options.effort,
      } satisfies TurnStartParams);
      const turnId = turn.turn?.id;

      await this.#withTimeout(
        completion,
        resolveTimeoutMs(),
        `codex turn on thread ${threadId}`,
        () => {
          // Best-effort: nudge the server to abandon the turn so its slot frees up.
          // `turn/interrupt` needs the turn id as well as the thread id.
          if (turnId) void this.interrupt(threadId, turnId).catch(() => {});
        },
      );
    } catch (error) {
      // The thread is abandoned now — free its MCP stack instead of leaking it.
      await this.disposeThread(threadId);
      throw error;
    } finally {
      unsubscribe();
    }

    // A throwaway thread (no caller will resume it) is deleted so the app-server
    // drops it and terminates the per-thread MCP servers it spawned. Skipping this
    // is the whole respawn-without-reap leak: one abandoned MCP stack per call.
    if (!options.keepThread) await this.disposeThread(threadId);
    return result;
  }

  /** Cancel a turn in flight. The exec backend has no equivalent. */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request(Method.turnInterrupt, { threadId, turnId } satisfies TurnInterruptParams);
  }

  /**
   * Delete a thread we are finished with. The app-server terminates that thread's
   * MCP servers when the thread is dropped, so this is what stops a throwaway call
   * from leaking a full MCP stack. Best-effort by design: a failure here must
   * never surface to the caller or hold up a completed turn, so it is bounded by
   * a short timeout and swallowed.
   */
  async disposeThread(threadId: string): Promise<void> {
    if (!this.#child) return;
    try {
      await this.request(
        Method.threadDelete,
        { threadId } satisfies ThreadDeleteParams,
        DISPOSE_TIMEOUT_MS,
      );
    } catch (error) {
      logger.debug(
        `thread/delete failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Race a promise against a timeout. On expiry, `onTimeout` runs (best-effort
   * cleanup) and the returned promise rejects. A non-positive `ms` disables the
   * bound and returns the promise unchanged.
   */
  async #withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    onTimeout: () => void,
  ): Promise<T> {
    if (!(ms > 0)) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Extract the fields the bridge reports from a completed item. */
  #recordItem(result: CodexResult, item: ThreadItemView | undefined): void {
    if (!item) return;
    switch (item.type) {
      case "agentMessage": {
        if (typeof item.text === "string") result.agentMessage += item.text;
        break;
      }
      case "fileChange": {
        // A fileChange item carries a list of per-path patches (not a single
        // path/kind pair), each with the patch kind. Record every path touched.
        for (const change of item.changes ?? []) {
          if (typeof change.path === "string") {
            result.fileChanges.push({ path: change.path, kind: String(change.kind ?? "modify") });
          }
        }
        break;
      }
      case "commandExecution": {
        if (typeof item.command === "string") {
          result.commandsExecuted.push({
            command: item.command,
            exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
            output: item.aggregatedOutput ?? "",
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
    this.#initialized = false;
  }
}
