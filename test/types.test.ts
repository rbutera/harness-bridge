import { describe, it, expect } from "vitest";
import { CODEX_MODELS } from "../src/lib/types.js";

describe("CODEX_MODELS", () => {
  it("only lists models a ChatGPT-account Codex CLI accepts", () => {
    expect([...CODEX_MODELS]).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("drops the *-codex models that hard-reject on a ChatGPT account", () => {
    expect(CODEX_MODELS.some((m) => m.endsWith("-codex") || m.includes("-codex-"))).toBe(false);
  });
});
