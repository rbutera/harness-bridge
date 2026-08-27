import { describe, expect, it } from "vitest";
import { formatCodexResponse } from "../src/lib/codex-response.js";
import type { CodexResult } from "../src/lib/types.js";

function result(overrides: Partial<CodexResult> = {}): CodexResult {
  return {
    threadId: null,
    agentMessage: "",
    fileChanges: [],
    commandsExecuted: [],
    usage: null,
    errors: [],
    ...overrides,
  };
}

describe("formatCodexResponse threadId contract", () => {
  it("appends a threadId line so the caller can resume", () => {
    const out = formatCodexResponse(result({ threadId: "T-123", agentMessage: "done" }));
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toBe("done\n\nthreadId: T-123");
  });

  it("omits the threadId line when no thread was created", () => {
    const out = formatCodexResponse(result({ agentMessage: "done" }));
    expect(out.content[0].text).toBe("done");
    expect(out.content[0].text).not.toContain("threadId:");
  });

  it("surfaces the threadId even on the error path when a thread exists", () => {
    const out = formatCodexResponse(result({ threadId: "T-9", errors: ["boom"] }));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Error: boom\n\nthreadId: T-9");
  });

  it("keeps the threadId line after truncating an oversized response", () => {
    const huge = "x".repeat(200_000);
    const out = formatCodexResponse(result({ threadId: "T-big", agentMessage: huge }));
    expect(out.content[0].text).toContain("...[response truncated]");
    expect(out.content[0].text.endsWith("threadId: T-big")).toBe(true);
  });
});
