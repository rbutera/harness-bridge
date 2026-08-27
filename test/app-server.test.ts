import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcDecoder, encode, type JsonRpcMessage } from "../src/lib/jsonrpc.js";

// Mock the codex child process so the client can be driven without spawning.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { AppServerClient } from "../src/lib/app-server.js";
import {
  OverloadedError,
  RequestError,
  ServerCrashedError,
  SpawnError,
} from "../src/lib/app-server-errors.js";

type TurnBehavior = "complete" | "error" | "hang";

/** A request interceptor: return true to claim the request, false to fall through. */
type RequestHook = (message: JsonRpcMessage, emit: (message: JsonRpcMessage) => void) => boolean;

interface FakeChild {
  child: unknown;
  sentMethods: string[];
  sent: JsonRpcMessage[];
  killed: () => boolean;
  /** Attach a custom handler for specific methods (checked before the defaults). */
  onRequest?: RequestHook;
  /** Emit an `exit` event, simulating a crash of the running server. */
  crash: (code: number | null) => void;
  /** Emit an `error` event, simulating a spawn-level failure (e.g. ENOENT). */
  spawnError: (error: Error) => void;
}

/**
 * A stand-in for `codex app-server`. It answers protocol requests the way the
 * real server (codex 0.147.0) does for a happy-path turn — matching the real
 * wire shapes: `thread/start` returns `{ thread: { id } }`, `error`
 * notifications carry `{ error: { message }, willRetry }` — and records every
 * method it received, so a test can assert which lifecycle calls the client made.
 */
function createFakeChild(turn: TurnBehavior = "complete"): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const decoder = new JsonRpcDecoder();
  const sentMethods: string[] = [];
  const sent: JsonRpcMessage[] = [];
  let killed = false;

  const fake: FakeChild = {
    child,
    sentMethods,
    sent,
    killed: () => killed,
    crash: (code) => child.emit("exit", code),
    spawnError: (error) => child.emit("error", error),
  };

  const emit = (message: JsonRpcMessage) => {
    stdout.emit("data", Buffer.from(encode(message)));
  };

  const handle = (message: JsonRpcMessage) => {
    if (fake.onRequest?.(message, emit)) return;
    const id = message.id as number;
    switch (message.method) {
      case "initialize":
        emit({ id, result: {} });
        break;
      case "thread/start":
        emit({ id, result: { thread: { id: "T1" } } });
        break;
      case "thread/resume": {
        const params = (message.params ?? {}) as Record<string, unknown>;
        emit({ id, result: { thread: { id: params["threadId"] ?? "T1" } } });
        break;
      }
      case "turn/start":
        emit({ id, result: { turn: { id: "turn-1" } } });
        if (turn === "complete") emit({ method: "turn/completed", params: { threadId: "T1" } });
        else if (turn === "error")
          emit({
            method: "error",
            params: { threadId: "T1", willRetry: false, error: { message: "boom" } },
          });
        // "hang": deliberately emit nothing further.
        break;
      case "mock/hang":
        // Never respond: used to exercise the request timeout.
        break;
      default:
        emit({ id, result: {} });
    }
  };

  const stdin = {
    write: (data: string) => {
      for (const message of decoder.push(data)) {
        if (message.method) {
          sentMethods.push(message.method);
          sent.push(message);
          queueMicrotask(() => handle(message));
        }
      }
      return true;
    },
  };

  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit("exit", null));
    return true;
  };

  return fake;
}

describe("AppServerClient thread lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("deletes a throwaway (keyless) thread so its MCP stack is torn down", async () => {
    const fake = createFakeChild("complete");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    const result = await client.runTurn({ prompt: "hi", keepThread: false });

    expect(result.threadId).toBe("T1");
    expect(fake.sentMethods).toContain("thread/start");
    expect(fake.sentMethods).toContain("turn/start");
    // The whole point: a keyless turn must dispose its thread.
    expect(fake.sentMethods).toContain("thread/delete");
    const del = fake.sent.find((m) => m.method === "thread/delete");
    expect((del?.params as Record<string, unknown>)?.["threadId"]).toBe("T1");
  });

  it("keeps a thread the caller will resume (keepThread) — no delete", async () => {
    const fake = createFakeChild("complete");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await client.runTurn({ prompt: "hi", keepThread: true });

    expect(fake.sentMethods).toContain("turn/start");
    expect(fake.sentMethods).not.toContain("thread/delete");
  });

  it("disposes the thread when the turn errors", async () => {
    const fake = createFakeChild("error");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await expect(client.runTurn({ prompt: "hi", keepThread: false })).rejects.toThrow(/boom/);
    // Even a kept thread would be freed here: the turn failed, so it is abandoned.
    expect(fake.sentMethods).toContain("thread/delete");
  });

  it("keepThread thread is still disposed when the turn errors", async () => {
    const fake = createFakeChild("error");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await expect(client.runTurn({ prompt: "hi", keepThread: true })).rejects.toThrow(/boom/);
    expect(fake.sentMethods).toContain("thread/delete");
  });
});

describe("AppServerClient request timeout", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("rejects a wedged request and tears the server down for a respawn", async () => {
    const fake = createFakeChild("complete");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await client.start(); // resolves via the initialize response

    await expect(client.request("mock/hang", {}, 30)).rejects.toThrow(/timed out after 30ms/);
    // A request that never comes back means the server is wedged; it must be
    // killed so the next call spawns a fresh one rather than queueing behind it.
    expect(fake.killed()).toBe(true);
  });
});

describe("AppServerClient crash recovery", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("fails in-flight requests when the child crashes, then respawns cleanly", async () => {
    const first = createFakeChild("complete");
    const second = createFakeChild("complete");
    spawnMock.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);

    const client = new AppServerClient();
    await client.start();

    // A request with the per-request bound disabled stays pending until the crash.
    const inflight = client.request("mock/hang", {}, 0);
    first.crash(1);

    await expect(inflight).rejects.toBeInstanceOf(ServerCrashedError);
    await expect(inflight).rejects.toThrow(/exited with code 1/);

    // The client reset on the crash, so the next call spawns a fresh server and
    // re-runs the initialize handshake rather than reusing the dead child.
    const result = await client.runTurn({ prompt: "hi", keepThread: false });
    expect(result.threadId).toBe("T1");
    expect(second.sentMethods).toContain("initialize");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("AppServerClient overload backpressure", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("retries an overloaded (-32001) request and returns the eventual success", async () => {
    const fake = createFakeChild("complete");
    let attempts = 0;
    fake.onRequest = (message, emit) => {
      if (message.method !== "mock/overload") return false;
      attempts += 1;
      if (attempts < 3) emit({ id: message.id, error: { code: -32001, message: "overloaded" } });
      else emit({ id: message.id, result: { ok: true } });
      return true;
    };
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await client.start();

    const result = await client.request("mock/overload", {});
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("gives up with an OverloadedError after the retry budget is exhausted", async () => {
    const fake = createFakeChild("complete");
    fake.onRequest = (message, emit) => {
      if (message.method !== "mock/overload") return false;
      emit({ id: message.id, error: { code: -32001, message: "overloaded" } });
      return true;
    };
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await client.start();

    await expect(client.request("mock/overload", {})).rejects.toBeInstanceOf(OverloadedError);
    await expect(client.request("mock/overload", {})).rejects.toThrow(/overloaded/i);
  });
});

describe("AppServerClient error taxonomy", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("maps a non-overload JSON-RPC error to a RequestError carrying the server message", async () => {
    const fake = createFakeChild("complete");
    fake.onRequest = (message, emit) => {
      if (message.method !== "mock/fail") return false;
      emit({ id: message.id, error: { code: -32603, message: "kaboom" } });
      return true;
    };
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    await client.start();

    await expect(client.request("mock/fail", {})).rejects.toBeInstanceOf(RequestError);
    await expect(client.request("mock/fail", {})).rejects.toThrow(/kaboom \(code -32603\)/);
  });

  it("fails with an actionable SpawnError when codex cannot be spawned", async () => {
    const fake = createFakeChild("complete");
    spawnMock.mockReturnValue(fake.child);

    const client = new AppServerClient();
    const started = client.start();
    // ENOENT surfaces as an `error` event before the handshake can complete.
    fake.spawnError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));

    await expect(started).rejects.toBeInstanceOf(SpawnError);
    // The message must tell the caller how to diagnose it.
    await expect(started).rejects.toThrow(/codex --version/);
  });
});
