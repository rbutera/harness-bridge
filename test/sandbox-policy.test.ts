import { describe, expect, it } from "vitest";
import { toSandboxPolicy } from "../src/lib/sandbox-policy.js";
import { BACKEND_ENV_VAR, isAppServerEnabled } from "../src/lib/app-server.js";

describe("toSandboxPolicy", () => {
  it("maps read-only, with network access off", () => {
    expect(toSandboxPolicy("read-only")).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("maps danger-full-access", () => {
    expect(toSandboxPolicy("danger-full-access")).toEqual({ type: "dangerFullAccess" });
  });

  it("maps workspace-write with no extra roots by default", () => {
    expect(toSandboxPolicy("workspace-write")).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it("carries explicit writable roots through", () => {
    // This is the capability the exec backend never had: a worktree can be
    // granted exactly its own git directory instead of escalating to
    // danger-full-access just to make `git commit` work.
    const policy = toSandboxPolicy("workspace-write", {
      writableRoots: ["/repo/.git/worktrees/feature"],
    });

    expect(policy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/repo/.git/worktrees/feature"],
    });
  });

  it("never grants network access implicitly", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      const policy = toSandboxPolicy(mode) as { networkAccess: boolean };
      expect(policy.networkAccess).toBe(false);
    }
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
});
