import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcDecoder, encode, type JsonRpcMessage } from "../src/lib/jsonrpc.js";

// Mock the codex child process so the client can be driven without spawning.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { AppServerClient } from "../src/lib/app-server.js";

type TurnBehavior = "complete" | "error" | "hang";

interface FakeChild {
  child: unknown;
  sentMethods: string[];
  sent: JsonRpcMessage[];
  killed: () => boolean;
}

/**
 * A stand-in for `codex app-server`. It answers protocol requests the way the
 * real server does for a happy-path turn and records every method it received,
 * so a test can assert which lifecycle calls the client made.
 */
function createFakeChild(turn: TurnBehavior = "complete"): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const decoder = new JsonRpcDecoder();
  const sentMethods: string[] = [];
  const sent: JsonRpcMessage[] = [];
  let killed = false;

  const emit = (message: JsonRpcMessage) => {
    stdout.emit("data", Buffer.from(encode(message)));
  };

  const handle = (message: JsonRpcMessage) => {
    const id = message.id as number;
    switch (message.method) {
      case "initialize":
        emit({ id, result: {} });
        break;
      case "thread/start":
        emit({ id, result: { threadId: "T1" } });
        break;
      case "thread/resume": {
        const params = (message.params ?? {}) as Record<string, unknown>;
        emit({ id, result: { threadId: params["threadId"] ?? "T1" } });
        break;
      }
      case "turn/start":
        emit({ id, result: {} });
        if (turn === "complete") emit({ method: "turn/completed", params: { threadId: "T1" } });
        else if (turn === "error")
          emit({ method: "error", params: { threadId: "T1", message: "boom" } });
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

  return { child, sentMethods, sent, killed: () => killed };
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
