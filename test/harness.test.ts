import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESSES, PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_VERSION } from "../src/lib/harness.js";

describe("harness metadata", () => {
  it("defines the shipped harness adapters", () => {
    expect(HARNESSES.claude.displayName).toBe("Claude Code");
    expect(HARNESSES.codex.displayName).toBe("OpenAI Codex");
    expect(HARNESSES.codex.capabilities).toContain("unrestricted-execution");
    expect(HARNESSES.codex.capabilities).not.toContain("sandbox");
  });

  it("keeps runtime and package identity in sync", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };

    // The npm package is scoped (@rbutera/harness-bridge); the runtime identity
    // stays the unscoped tail so MCP server names read `harness-bridge-codex`.
    expect(packageJson.name.split("/").at(-1)).toBe(PRODUCT_NAME);
    expect(PRODUCT_TITLE).toBe("Harness Bridge");
    expect(PRODUCT_VERSION).toBe(packageJson.version);
  });
});
