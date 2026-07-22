/**
 * Serializes async work per key.
 *
 * Exists because removing the module-global `lastThreadId` made *implicit*
 * thread sharing impossible but left *explicit* sharing — a `threadKey` — racy.
 * Resolving the key, running the turn, and recording the resulting thread is a
 * read-modify-write, and without a lock two concurrent calls on one key
 * interleave:
 *
 * - **New key:** both resolve to `null`, both start their own Codex thread, and
 *   both write the registry. One thread id is lost and its conversation is
 *   orphaned, so the continuity the caller asked for silently did not happen.
 * - **Existing key:** both resolve the same id and both `codex exec resume` it
 *   at once. That is the original interleaving bug, merely scoped to a key.
 *
 * Serializing a key costs nothing legitimate: a conversation is inherently
 * sequential, so two turns on one thread were never going to be parallel.
 * Keyless calls, which are the default, never touch this.
 *
 * Lock ordering is always keyed-mutex first, then the exec semaphore. Semaphore
 * holders never acquire a mutex, so there is no cycle and no deadlock.
 */
export class KeyedMutex {
  /** Tail of the promise chain per key. Absent means the key is free. */
  readonly #chains = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` with exclusive access to `key`.
   *
   * Callers queue behind the current holder in arrival order. The entry is
   * dropped once nothing is queued behind it, so the map cannot grow without
   * bound across many short-lived keys.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Never rejects: it is either a fresh resolved promise or a `tail` below,
    // which absorbs both outcomes. So one caller's failure cannot cascade into
    // the callers queued behind it on the same key.
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const runNext = previous.then(fn);

    // Park a settled-either-way link as the new tail, so the next waiter chains
    // onto this call's *completion* rather than onto its success.
    const tail = runNext.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(key, tail);

    try {
      return await runNext;
    } finally {
      // Only clear if nobody else has since claimed the tail.
      if (this.#chains.get(key) === tail) this.#chains.delete(key);
    }
  }

  /** Keys currently held or queued. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#chains.size;
  }
}
