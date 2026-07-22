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
