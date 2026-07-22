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
  it("is off when unset, so the exec backend stays the default", () => {
    expect(isAppServerEnabled({})).toBe(false);
  });

  it("is on only for the exact opt-in value", () => {
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "app-server" })).toBe(true);
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "exec" })).toBe(false);
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "true" })).toBe(false);
    expect(isAppServerEnabled({ [BACKEND_ENV_VAR]: "" })).toBe(false);
  });

  it("accepts the legacy backend variable", () => {
    expect(isAppServerEnabled({ [LEGACY_BACKEND_ENV_VAR]: "app-server" })).toBe(true);
  });
});
