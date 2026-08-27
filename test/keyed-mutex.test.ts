import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../src/lib/keyed-mutex.js";
import { SessionRegistry } from "../src/lib/session-registry.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedMutex", () => {
  it("serializes work sharing a key", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const first = deferred();

    const a = mutex.run("k", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = mutex.run("k", async () => {
      events.push("b:start");
    });

    await Promise.resolve();
    // b must not have started while a holds the key.
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("runs different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const gate = deferred();

    const a = mutex.run("x", async () => {
      events.push("x:start");
      await gate.promise;
    });
    const b = mutex.run("y", async () => {
      events.push("y:start");
    });

    await Promise.resolve();
    // Independent keys must not block each other, or the lock would serialise
    // every reviewer instead of only same-key ones.
    expect(events).toEqual(["x:start", "y:start"]);

    gate.resolve();
    await Promise.all([a, b]);
  });

  it("preserves arrival order across several waiters", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const gate = deferred();

    const runs = [0, 1, 2, 3].map((i) =>
      mutex.run("k", async () => {
        if (i === 0) await gate.promise;
        order.push(i);
      }),
    );

    gate.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("releases the key when the work throws", async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A held-forever key would wedge every later call on it.
    await expect(mutex.run("k", async () => "ok")).resolves.toBe("ok");
  });

  it("does not cascade one caller's failure to the next on the same key", async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run("k", async () => {
      throw new Error("first fails");
    });
    const following = mutex.run("k", async () => "second succeeds");

    await expect(failing).rejects.toThrow("first fails");
    await expect(following).resolves.toBe("second succeeds");
  });

  it("a newcomer still waits when an earlier holder finishes but a waiter remains", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const aGate = deferred();
    const bGate = deferred();

    const a = mutex.run("k", async () => {
      events.push("a:start");
      await aGate.promise;
      events.push("a:end");
    });
    const b = mutex.run("k", async () => {
      events.push("b:start");
      await bGate.promise;
      events.push("b:end");
    });

    // Let A finish while B is still queued. If releasing the key were
    // unconditional, A's cleanup would drop the entry that B owns, and C would
    // then see a free key and run alongside B.
    aGate.resolve();
    await a;

    const c = mutex.run("k", async () => {
      events.push("c:start");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain("c:start");

    bGate.resolve();
    await Promise.all([b, c]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);
  });

  it("drops the entry once a key is idle, so the map cannot grow unbounded", async () => {
    const mutex = new KeyedMutex();
    for (let i = 0; i < 50; i++) {
      await mutex.run(`key-${i}`, async () => i);
    }
    expect(mutex.size).toBe(0);
  });
});

describe("keyed continuity under concurrency (the race this fixes)", () => {
  /**
   * Models the claude adapter's keyed read-modify-write: resolve a caller key to
   * a session, run a turn, then record the resulting session. Without a lock two
   * concurrent calls on one key interleave. (The codex adapter dropped this in 1.0
   * for the threadId contract; the mutex there now serialises turns on one thread.)
   */
  async function call(
    registry: SessionRegistry,
    key: string,
    newThreadId: string,
    mutex?: KeyedMutex,
  ) {
    const body = async () => {
      const resumed = registry.resolve(key);
      // Yield, standing in for the real `codex exec` await.
      await new Promise((r) => setTimeout(r, 0));
      const threadId = resumed ?? newThreadId;
      registry.remember(key, threadId);
      return { resumed, threadId };
    };
    return mutex ? mutex.run(key, body) : body();
  }

  it("WITHOUT a lock, two calls on one key both start a thread and one is lost", async () => {
    const registry = new SessionRegistry();
    const [a, b] = await Promise.all([
      call(registry, "shared", "thread-A"),
      call(registry, "shared", "thread-B"),
    ]);

    // Both saw an empty registry, so neither resumed and two threads exist.
    expect(a.resumed).toBeNull();
    expect(b.resumed).toBeNull();
    expect(a.threadId).not.toBe(b.threadId);
    // Only one survives; the other conversation is orphaned.
    expect(registry.resolve("shared")).toBe("thread-B");
  });

  it("WITH the lock, the second call resumes the first call's thread", async () => {
    const registry = new SessionRegistry();
    const mutex = new KeyedMutex();
    const [a, b] = await Promise.all([
      call(registry, "shared", "thread-A", mutex),
      call(registry, "shared", "thread-B", mutex),
    ]);

    expect(a.resumed).toBeNull();
    expect(a.threadId).toBe("thread-A");
    // The whole point: the second call sees the first's write and continues it.
    expect(b.resumed).toBe("thread-A");
    expect(b.threadId).toBe("thread-A");
    expect(registry.resolve("shared")).toBe("thread-A");
  });
});
