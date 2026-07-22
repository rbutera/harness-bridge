import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/lib/claude-args.js";

describe("buildClaudeArgs", () => {
  it("starts a fresh session when no keyed session was resolved", () => {
    const args = buildClaudeArgs({ prompt: "review", resumeSessionId: null });

    expect(args).not.toContain("--resume");
    expect(args.at(-1)).toBe("review");
  });

  it("resumes only the explicitly resolved keyed session", () => {
    const args = buildClaudeArgs({ prompt: "continue", resumeSessionId: "session-1" });

    expect(args).toEqual(["-p", "--output-format", "json", "--resume", "session-1", "continue"]);
  });

  it("passes model, turn limit, and allowed tools", () => {
    const args = buildClaudeArgs({
      prompt: "review",
      resumeSessionId: null,
      model: "opus",
      maxTurns: 5,
      allowedTools: ["Read", "Grep"],
    });

    expect(args).toContain("opus");
    expect(args).toContain("5");
    expect(args.filter((arg) => arg === "--allowedTools")).toHaveLength(2);
  });
});
