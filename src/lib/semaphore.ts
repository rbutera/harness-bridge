/**
 * Bounded concurrency for outbound `codex exec` subprocesses.
 *
 * Without a cap, N parallel reviewers spawn N unmanaged subprocesses, each able
 * to hold a slot for the full exec timeout. That is the resource half of the
 * "bridge is saturated" report; the correctness half is the shared thread
 * pointer, fixed separately by keyed session isolation.
 *
 * Waiters are served strictly FIFO, so a burst of reviewers cannot starve an
 * earlier caller.
 */

export const CONCURRENCY_ENV_VAR = "HARNESS_BRIDGE_CODEX_MAX_CONCURRENT";
export const LEGACY_CONCURRENCY_ENV_VAR = "CODEX_BRIDGE_MAX_CONCURRENT";

/** Default in-flight cap. Chosen to keep a dual-review gate fully parallel. */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Resolve the cap from the environment, falling back to the default.
 *
 * A non-numeric or non-positive value falls back rather than throwing: a typo
 * in a shell profile should not take the bridge down. `0` and negatives would
 * deadlock every call, so they are rejected too.
 */
export function resolveMaxConcurrent(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[CONCURRENCY_ENV_VAR] ?? env[LEGACY_CONCURRENCY_ENV_VAR];
  if (!raw) return DEFAULT_MAX_CONCURRENT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT;
  return Math.floor(parsed);
}

export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
    }
    this.#available = Math.floor(max);
  }

  /** Slots currently free. Exposed for tests and diagnostics. */
  get available(): number {
    return this.#available;
  }

  /** Callers currently queued behind a full semaphore. */
  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * Run `fn` once a slot is free, releasing the slot afterwards.
   *
   * The slot is released in a `finally`, so a throwing `fn` cannot leak it.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter rather than incrementing,
      // which would let a later arrival barge ahead of the queue.
      next();
      return;
    }
    this.#available += 1;
  }
}
