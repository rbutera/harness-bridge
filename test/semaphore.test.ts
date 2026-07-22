import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_ENV_VAR,
  DEFAULT_MAX_CONCURRENT,
  LEGACY_CONCURRENCY_ENV_VAR,
  Semaphore,
  resolveMaxConcurrent,
} from "../src/lib/semaphore.js";

/** A promise plus the handles to settle it from the outside. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("resolveMaxConcurrent", () => {
  it("falls back to the default when unset", () => {
    expect(resolveMaxConcurrent({})).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("reads a valid override", () => {
    expect(resolveMaxConcurrent({ [CONCURRENCY_ENV_VAR]: "8" })).toBe(8);
  });

  it("accepts the legacy override", () => {
    expect(resolveMaxConcurrent({ [LEGACY_CONCURRENCY_ENV_VAR]: "6" })).toBe(6);
  });

  it.each(["nonsense", "0", "-3", ""])("falls back rather than throwing on %j", (value) => {
    // A typo in a shell profile must not take the bridge down, and 0 or a
    // negative would deadlock every call.
    expect(resolveMaxConcurrent({ [CONCURRENCY_ENV_VAR]: value })).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it("floors a fractional override", () => {
    expect(resolveMaxConcurrent({ [CONCURRENCY_ENV_VAR]: "2.9" })).toBe(2);
  });
});

describe("Semaphore", () => {
  it("rejects a non-positive max", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });

  it("runs work immediately while slots are free", async () => {
    const semaphore = new Semaphore(2);
    await expect(semaphore.run(async () => "done")).resolves.toBe("done");
    expect(semaphore.available).toBe(2);
  });

  it("caps how many run at once and admits the next as one finishes", async () => {
    const semaphore = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map((gate) =>
      semaphore.run(async () => {
        started += 1;
        await gate.promise;
      }),
    );

    // Two slots, three callers: the third must be queued, not running.
    await Promise.resolve();
    expect(started).toBe(2);
    expect(semaphore.waiting).toBe(1);

    gates[0].resolve();
    await runs[0];
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(semaphore.available).toBe(2);
  });

  it("serves waiters in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];
    const first = deferred();

    const runs = [
      semaphore.run(async () => {
        order.push(0);
        await first.promise;
      }),
      semaphore.run(async () => {
        order.push(1);
      }),
      semaphore.run(async () => {
        order.push(2);
      }),
    ];

    first.resolve();
    await Promise.all(runs);

    // A later arrival must not barge ahead of an earlier one.
    expect(order).toEqual([0, 1, 2]);
  });

  it("releases the slot when the work throws", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A leaked slot here would wedge every later call forever.
    expect(semaphore.available).toBe(1);
    await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
  });
});
