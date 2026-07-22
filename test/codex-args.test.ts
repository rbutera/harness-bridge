import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../src/lib/codex-args.js";

describe("buildCodexArgs", () => {
  it("passes --sandbox on a fresh exec", () => {
    const args = buildCodexArgs({
      prompt: "review this",
      resumeThreadId: null,
      sandbox: "danger-full-access",
    });

    expect(args).toEqual(["exec", "--json", "--sandbox", "danger-full-access", "review this"]);
  });

  it("omits --sandbox on resume, because the CLI has no such flag there", () => {
    const args = buildCodexArgs({
      prompt: "keep going",
      resumeThreadId: "thread-1",
      sandbox: "workspace-write",
    });

    // Verified against `codex exec resume --help`: no --sandbox option exists.
    // Passing it would make the CLI reject the call outright.
    expect(args).not.toContain("--sandbox");
    expect(args).toEqual(["exec", "resume", "thread-1", "--json", "keep going"]);
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

  it("passes --full-auto on both fresh and resumed calls", () => {
    expect(buildCodexArgs({ prompt: "p", resumeThreadId: null, fullAuto: true })).toContain(
      "--full-auto",
    );
    expect(buildCodexArgs({ prompt: "p", resumeThreadId: "t", fullAuto: true })).toContain(
      "--full-auto",
    );
  });

  it("always puts the prompt last", () => {
    const args = buildCodexArgs({
      prompt: "the prompt",
      resumeThreadId: null,
      model: "gpt-5.6-sol",
      sandbox: "read-only",
      fullAuto: true,
    });

    expect(args[args.length - 1]).toBe("the prompt");
  });
});
