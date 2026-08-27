/**
 * Maps a caller-chosen conversation key to a harness session id, in memory.
 *
 * Claude adapter only as of 1.0. The codex adapter dropped this in favour of the
 * threadId resume contract — the caller echoes back the real thread id instead of
 * a key the bridge has to remember (see docs/adr/0002). The claude adapter still
 * resolves a caller key to a Claude session id through this registry.
 */
export class SessionRegistry {
  readonly #sessions = new Map<string, string>();

  resolve(key: string | undefined): string | null {
    if (!key) return null;
    return this.#sessions.get(key) ?? null;
  }

  remember(key: string | undefined, sessionId: string): void {
    if (!key) return;
    this.#sessions.set(key, sessionId);
  }

  forget(key: string | undefined): void {
    if (!key) return;
    this.#sessions.delete(key);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
