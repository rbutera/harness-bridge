import { describe, expect, it } from "vitest";

import { resolveCodexModel } from "../src/lib/codex-model.js";

describe("resolveCodexModel", () => {
  it("prefers the explicit per-call model", () => {
    expect(resolveCodexModel("gpt-x", { HARNESS_BRIDGE_CODEX_MODEL: "gpt-6.1-sol" })).toBe("gpt-x");
  });
  it("falls back to HARNESS_BRIDGE_CODEX_MODEL", () => {
    expect(resolveCodexModel(undefined, { HARNESS_BRIDGE_CODEX_MODEL: "gpt-6.1-sol" })).toBe(
      "gpt-6.1-sol",
    );
  });
  it("treats blank values as unset so Codex uses its config default", () => {
    expect(resolveCodexModel("  ", { HARNESS_BRIDGE_CODEX_MODEL: " " })).toBeUndefined();
    expect(resolveCodexModel(undefined, {})).toBeUndefined();
  });
});
