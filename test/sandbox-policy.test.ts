import { describe, expect, it } from "vitest";
import { unrestrictedSandboxPolicy } from "../src/lib/sandbox-policy.js";
import {
  BACKEND_ENV_VAR,
  isAppServerEnabled,
  LEGACY_BACKEND_ENV_VAR,
} from "../src/lib/app-server.js";

describe("unrestrictedSandboxPolicy", () => {
  it("always grants unrestricted access", () => {
    expect(unrestrictedSandboxPolicy()).toEqual({ type: "dangerFullAccess" });
  });
});

describe("isAppServerEnabled", () => {
  it("is on when unset, so the app-server backend is the default", () => {
    expect(isAppServerEnabled({})).toBe(true);
  });

  it("falls back to exec only for the exact opt-out value", () => {
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "exec" })).toBe(false);
    // "app-server" still works as an explicit no-op for anyone who pinned it.
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "app-server" })).toBe(true);
    // Any other value is not the opt-out, so the default (app-server) holds.
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "true" })).toBe(true);
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "" })).toBe(true);
  });

  it("honours the legacy backend variable both ways", () => {
    expect(isAppServerEnabled({ [LEGACY_BACKEND_ENV_VAR]: "exec" })).toBe(false);
    expect(isAppServerEnabled({ [LEGACY_BACKEND_ENV_VAR]: "app-server" })).toBe(true);
  });
});
