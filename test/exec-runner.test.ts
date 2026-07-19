import { afterEach, describe, it, expect } from "vitest";
import {
  execCommand,
  isTransientError,
  resolveTimeoutMs,
  TIMEOUT_ENV_VAR,
} from "../src/lib/exec-runner.js";

describe("execCommand", () => {
  it("captures stdout from a simple command", async () => {
    const result = await execCommand({
      command: "echo",
      args: ["hello world"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", "echo error >&2"],
    });
    expect(result.stderr.trim()).toBe("error");
  });

  it("reports non-zero exit code", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", "exit 42"],
    });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("times out and kills long-running process", async () => {
    const result = await execCommand({
      command: "sleep",
      args: ["60"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });

  it("throws BridgeError for missing command", async () => {
    await expect(
      execCommand({
        command: "nonexistent_command_xyz_12345",
        args: [],
      }),
    ).rejects.toThrow("not found");
  });

  it("respects cwd option", async () => {
    const result = await execCommand({
      command: "pwd",
      args: [],
      cwd: "/tmp",
    });
    // macOS resolves /tmp to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });

  it("passes custom env vars", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", "echo $TEST_VAR"],
      env: { TEST_VAR: "bridge_test" },
    });
    expect(result.stdout.trim()).toBe("bridge_test");
  });

  it("increments BRIDGE_DEPTH in child env", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", "echo $BRIDGE_DEPTH"],
    });
    // Current depth is 0 (or whatever test env has), child should be +1
    const depth = parseInt(result.stdout.trim(), 10);
    expect(depth).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveTimeoutMs", () => {
  const saved = {
    codex: process.env[TIMEOUT_ENV_VAR],
    legacy: process.env["BRIDGE_TIMEOUT_MS"],
  };

  afterEach(() => {
    if (saved.codex === undefined) delete process.env[TIMEOUT_ENV_VAR];
    else process.env[TIMEOUT_ENV_VAR] = saved.codex;
    if (saved.legacy === undefined) delete process.env["BRIDGE_TIMEOUT_MS"];
    else process.env["BRIDGE_TIMEOUT_MS"] = saved.legacy;
  });

  it("names the documented env var", () => {
    expect(TIMEOUT_ENV_VAR).toBe("CODEX_BRIDGE_TIMEOUT_MS");
  });

  it("defaults to 30 minutes when nothing is set", () => {
    delete process.env[TIMEOUT_ENV_VAR];
    delete process.env["BRIDGE_TIMEOUT_MS"];
    expect(resolveTimeoutMs()).toBe(1_800_000);
  });

  it("reads CODEX_BRIDGE_TIMEOUT_MS", () => {
    delete process.env["BRIDGE_TIMEOUT_MS"];
    process.env[TIMEOUT_ENV_VAR] = "123456";
    expect(resolveTimeoutMs()).toBe(123456);
  });

  it("falls back to the legacy BRIDGE_TIMEOUT_MS", () => {
    delete process.env[TIMEOUT_ENV_VAR];
    process.env["BRIDGE_TIMEOUT_MS"] = "222222";
    expect(resolveTimeoutMs()).toBe(222222);
  });

  it("prefers CODEX_BRIDGE_TIMEOUT_MS over the legacy var", () => {
    process.env[TIMEOUT_ENV_VAR] = "111111";
    process.env["BRIDGE_TIMEOUT_MS"] = "999999";
    expect(resolveTimeoutMs()).toBe(111111);
  });

  it("ignores non-positive / non-numeric values and uses the default", () => {
    process.env[TIMEOUT_ENV_VAR] = "0";
    delete process.env["BRIDGE_TIMEOUT_MS"];
    expect(resolveTimeoutMs()).toBe(1_800_000);
    process.env[TIMEOUT_ENV_VAR] = "not-a-number";
    expect(resolveTimeoutMs()).toBe(1_800_000);
  });
});

describe("isTransientError", () => {
  it("returns false for exit code 0", () => {
    expect(
      isTransientError({ exitCode: 0, stdout: "", stderr: "rate limit", timedOut: false }),
    ).toBe(false);
  });

  it("returns false for timeouts", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "rate limit", timedOut: true }),
    ).toBe(false);
  });

  it("detects rate limit errors", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "Error: rate limit exceeded",
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("detects HTTP 429", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 429 Too Many Requests",
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("detects connection errors", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "Error: ECONNRESET", timedOut: false }),
    ).toBe(true);
  });

  it("detects 502 bad gateway", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "502 Bad Gateway", timedOut: false }),
    ).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "Invalid API key", timedOut: false }),
    ).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "SyntaxError: unexpected token",
        timedOut: false,
      }),
    ).toBe(false);
  });
});

describe("retry behavior", () => {
  it("retries on transient error and succeeds", async () => {
    // Use a counter file to make the script fail on first call, succeed on second
    const counterFile = `/tmp/bridge-retry-test-${Date.now()}`;
    const result = await execCommand({
      command: "sh",
      args: [
        "-c",
        `if [ ! -f "${counterFile}" ]; then echo 1 > "${counterFile}"; echo "503 service unavailable" >&2; exit 1; else rm -f "${counterFile}"; echo "success"; fi`,
      ],
      maxRetries: 2,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("success");
  });

  it("does not retry non-transient errors", async () => {
    const counterFile = `/tmp/bridge-no-retry-test-${Date.now()}`;
    const result = await execCommand({
      command: "sh",
      args: [
        "-c",
        `if [ ! -f "${counterFile}" ]; then echo 1 > "${counterFile}"; echo "invalid argument" >&2; exit 1; else rm -f "${counterFile}"; echo "should not reach"; fi`,
      ],
      maxRetries: 2,
    });
    // Should NOT have retried — counter file still exists
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("invalid argument");
    // Clean up
    await execCommand({ command: "rm", args: ["-f", counterFile], maxRetries: 0 });
  });

  it("respects maxRetries: 0 to disable retry", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", 'echo "rate limit" >&2; exit 1'],
      maxRetries: 0,
    });
    expect(result.exitCode).toBe(1);
  });

  it("gives up after exhausting retries", async () => {
    const result = await execCommand({
      command: "sh",
      args: ["-c", 'echo "connection refused" >&2; exit 1'],
      maxRetries: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("connection refused");
  });
});
