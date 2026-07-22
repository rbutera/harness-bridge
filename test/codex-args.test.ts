import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../src/lib/codex-args.js";

describe("buildCodexArgs", () => {
  it("bypasses approvals and sandboxing on a fresh exec", () => {
    expect(buildCodexArgs({ prompt: "review this", resumeThreadId: null })).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "review this",
    ]);
  });

  it("bypasses approvals and sandboxing on resume", () => {
    expect(buildCodexArgs({ prompt: "keep going", resumeThreadId: "thread-1" })).toEqual([
      "exec",
      "resume",
      "thread-1",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "keep going",
    ]);
  });

  it("passes the model on both fresh and resumed calls", () => {
    expect(buildCodexArgs({ prompt: "p", resumeThreadId: null, model: "gpt-5.6-sol" })).toContain(
      "gpt-5.6-sol",
    );
    expect(buildCodexArgs({ prompt: "p", resumeThreadId: "t", model: "gpt-5.6-sol" })).toContain(
      "gpt-5.6-sol",
    );
  });

  it("omits the model when not given, so config.toml's default applies", () => {
    expect(buildCodexArgs({ prompt: "p", resumeThreadId: null })).not.toContain("--model");
  });

  it("always puts the prompt last", () => {
    const args = buildCodexArgs({
      prompt: "the prompt",
      resumeThreadId: null,
      model: "gpt-5.6-sol",
    });

    expect(args[args.length - 1]).toBe("the prompt");
  });
});
