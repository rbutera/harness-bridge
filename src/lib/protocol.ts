/**
 * The typed edge between the client and the `codex app-server` JSON-RPC
 * protocol, backed by the generated bindings in src/generated (codex
 * 0.147.0, regenerate with `pnpm generate:protocol`).
 *
 * Two kinds of type live here for one hard reason:
 *
 * - **Request params** are re-exported straight from the generated bindings.
 *   Their transitive graphs are small enough to inline, so the send side is
 *   typed against the real protocol — a wrong field name fails the build.
 *
 * - **Incoming reads** (start/turn responses, notification payloads, thread
 *   items) are hand-written views that mirror the generated shapes but re-declare
 *   only the fields the client actually reads. The generated types for these
 *   (`Thread`, `Turn`, `ThreadItem`, and the `ServerNotification` union) reference
 *   hundreds of variants transitively; inlining them into the client's `.d.ts`
 *   exhausts the dts bundler's heap (measured: OOM on `pnpm build`). Keeping the
 *   read views narrow sidesteps that while still typing every field we touch.
 *   When the minimum codex version bumps and the bindings are regenerated, these
 *   views must be reconciled against src/generated/v2 by hand.
 */

// --- Request params: generated types used directly (dts-safe graphs) ----------

export type { InitializeParams } from "../generated/InitializeParams.js";
export type { ThreadStartParams } from "../generated/v2/ThreadStartParams.js";
export type { ThreadResumeParams } from "../generated/v2/ThreadResumeParams.js";
export type { TurnStartParams } from "../generated/v2/TurnStartParams.js";
export type { TurnInterruptParams } from "../generated/v2/TurnInterruptParams.js";
export type { ThreadDeleteParams } from "../generated/v2/ThreadDeleteParams.js";
export type { SandboxMode } from "../generated/v2/SandboxMode.js";
export type { SandboxPolicy } from "../generated/v2/SandboxPolicy.js";
import type { TokenUsageBreakdown } from "../generated/v2/TokenUsageBreakdown.js";

/** Wire method names the client sends. */
export const Method = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  threadDelete: "thread/delete",
} as const;

/** Wire notification method names the client reacts to (see ServerNotification). */
export const Notification = {
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  error: "error",
} as const;

// --- Incoming reads: narrow views mirroring the generated shapes --------------

/**
 * `thread/start` and `thread/resume` both answer with `{ thread: Thread, ... }`.
 * Mirrors ThreadStartResponse / ThreadResumeResponse; we read only the id.
 */
export interface ThreadStartedResult {
  thread?: { id?: string };
}

/**
 * `turn/start` answers with `{ turn: Turn }`. Mirrors TurnStartResponse; we read
 * the turn id so a later `turn/interrupt` can name it (interrupt needs both
 * threadId and turnId).
 */
export interface TurnStartedResult {
  turn?: { id?: string };
}

/**
 * The ThreadItem variants the bridge records, flattened to the fields it reads.
 * Mirrors the `agentMessage`, `fileChange`, and `commandExecution` arms of
 * src/generated/v2/ThreadItem.ts (all other arms are ignored).
 */
export interface ThreadItemView {
  type: string;
  /** agentMessage */
  text?: string;
  /** fileChange: each change is a path + patch kind. */
  changes?: Array<{ path: string; kind: string }>;
  /** commandExecution */
  command?: string;
  exitCode?: number | null;
  aggregatedOutput?: string | null;
}

/** `item/started` and `item/completed`. Mirrors Item{Started,Completed}Notification. */
export interface ItemNotification {
  threadId: string;
  item: ThreadItemView;
}

/**
 * `thread/tokenUsage/updated`. Mirrors ThreadTokenUsageUpdatedNotification; the
 * cumulative `total` breakdown is the generated leaf type, reused directly.
 */
export interface TokenUsageNotification {
  threadId: string;
  tokenUsage: { total: TokenUsageBreakdown };
}

/**
 * `error`. Mirrors ErrorNotification `{ error: TurnError, willRetry, threadId }`.
 * `willRetry` matters: the server retries the turn itself when it is set, so the
 * client must not abandon the turn on those.
 */
export interface ErrorNotification {
  threadId?: string;
  willRetry?: boolean;
  error?: { message?: string };
}
