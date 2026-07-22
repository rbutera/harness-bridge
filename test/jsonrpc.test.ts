import { describe, expect, it } from "vitest";
import { JsonRpcDecoder, encode, isResponse } from "../src/lib/jsonrpc.js";

describe("JsonRpcDecoder", () => {
  it("decodes a single whole message", () => {
    const decoder = new JsonRpcDecoder();
    expect(decoder.push('{"id":1,"result":{}}\n')).toEqual([{ id: 1, result: {} }]);
  });

  it("decodes several messages arriving in one chunk", () => {
    const decoder = new JsonRpcDecoder();
    const messages = decoder.push('{"id":1}\n{"id":2}\n{"id":3}\n');
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("holds a partial message until its newline arrives", () => {
    const decoder = new JsonRpcDecoder();

    // The transport is a pipe, so a message can be split across chunks at any
    // byte. Emitting the fragment early would corrupt the stream.
    expect(decoder.push('{"id":1,"resu')).toEqual([]);
    expect(decoder.pending).not.toBe("");
    expect(decoder.push('lt":{"ok":true}}\n')).toEqual([{ id: 1, result: { ok: true } }]);
    expect(decoder.pending).toBe("");
  });

  it("reassembles a message split across three chunks", () => {
    const decoder = new JsonRpcDecoder();
    expect(decoder.push('{"id"')).toEqual([]);
    expect(decoder.push(":7,")).toEqual([]);
    expect(decoder.push('"method":"x"}\n')).toEqual([{ id: 7, method: "x" }]);
  });

  it("skips unparseable lines instead of throwing", () => {
    const decoder = new JsonRpcDecoder();

    // The app-server may print diagnostics to stdout. One stray line must not
    // take down a run, and must not swallow the valid messages around it.
    const messages = decoder.push('not json\n{"id":1}\nalso not json\n{"id":2}\n');
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("ignores blank lines", () => {
    const decoder = new JsonRpcDecoder();
    expect(decoder.push('\n\n{"id":1}\n\n')).toEqual([{ id: 1 }]);
  });
});

describe("encode", () => {
  it("stamps jsonrpc 2.0 and terminates with a newline", () => {
    expect(encode({ id: 1, method: "ping" })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });
});

describe("isResponse", () => {
  it("treats an id without a method as a response", () => {
    expect(isResponse({ id: 1, result: {} })).toBe(true);
  });

  it("treats a method without an id as a notification", () => {
    expect(isResponse({ method: "turn/completed", params: {} })).toBe(false);
  });

  it("treats a request (id AND method) as not a response", () => {
    // Server-to-client requests carry both. Routing one to a pending-response
    // handler would resolve the wrong call.
    expect(isResponse({ id: 5, method: "applyPatchApproval" })).toBe(false);
  });
});
