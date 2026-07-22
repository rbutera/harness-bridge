/**
 * Keyed thread continuity for the Codex bridge.
 *
 * Replaces the previous module-global `lastThreadId`, which every concurrent
 * tool call read and wrote. That global caused two distinct defects:
 *
 * 1. **Thread stomping.** One MCP server process serves every concurrent
 *    caller. Parallel reviewers each overwrote the same pointer, so a call
 *    could resume a thread another call was mid-way through.
 *
 * 2. **Silent sandbox downgrade.** `codex exec resume` accepts no `--sandbox`
 *    flag (verified against the CLI). The old code resumed whenever the global
 *    was set, so a `danger-full-access` request silently inherited whatever
 *    sandbox the resumed thread was created under. Only the very first call in
 *    a process lifetime ever honoured its sandbox argument, and nothing
 *    reported the difference.
 *
 * The fix is to make continuity **explicit, keyed, and sandbox-matched**:
 *
 * - No key means no resume. A fresh `codex exec` runs, so `--sandbox` is always
 *   passed. This is the correct default for parallel reviewers, which want
 *   isolation rather than a shared conversation.
 * - A key resumes only a thread recorded under that same key *and* the same
 *   sandbox. A sandbox mismatch starts a fresh thread instead of running under
 *   the wrong one, so the failure mode is a lost conversation rather than a
 *   silently over- or under-privileged run.
 */

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface ThreadRecord {
  threadId: string;
  /** Sandbox the thread was created under. Resume is only safe if this matches. */
  sandbox: SandboxMode;
}

export class ThreadRegistry {
  readonly #threads = new Map<string, ThreadRecord>();

  /**
   * The thread id to resume for this key under this sandbox, or `null` to start
   * a fresh thread.
   *
   * Returns `null` when there is no key, no record for the key, or the record
   * was created under a different sandbox.
   */
  resolve(key: string | undefined, sandbox: SandboxMode): string | null {
    if (!key) return null;
    const record = this.#threads.get(key);
    if (!record) return null;
    if (record.sandbox !== sandbox) return null;
    return record.threadId;
  }

  /** Record the thread Codex returned so a later call with the same key can resume it. */
  remember(key: string | undefined, threadId: string, sandbox: SandboxMode): void {
    if (!key) return;
    this.#threads.set(key, { threadId, sandbox });
  }

  /** Drop a key's thread. Used when a call fails so the next one starts clean. */
  forget(key: string | undefined): void {
    if (!key) return;
    this.#threads.delete(key);
  }

  /** Live key count. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#threads.size;
  }
}
