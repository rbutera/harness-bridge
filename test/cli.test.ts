import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { execCommand } from "../src/lib/exec-runner.js";

const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;
const TSX_CLI_PATH = createRequire(import.meta.url).resolve("tsx/cli");

function runCli(args: string[]) {
  return execCommand({
    command: process.execPath,
    args: [TSX_CLI_PATH, CLI_PATH, ...args],
    timeoutMs: 5000,
  });
}

describe("cli", { timeout: 10_000 }, () => {
  it("shows help with available commands when no subcommand given", async () => {
    const result = await runCli([]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("serve");
    expect(output).toContain("connect");
    expect(output).toContain("setup");
    expect(output).toContain("install");
  });

  it("exits with error for unknown subcommand", async () => {
    const result = await runCli(["unknown"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });

  it("starts codex server on 'serve codex'", async () => {
    const result = await runCli(["serve", "codex"]);
    // The server starts on stdio and blocks waiting for input,
    // so it will be killed by timeout. Check that it started successfully.
    expect(result.stderr).toContain("harness-bridge codex adapter started");
  });

  it("starts claude server on 'serve claude'", async () => {
    const result = await runCli(["serve", "claude"]);
    expect(result.stderr).toContain("harness-bridge claude adapter started");
  });

  it("shows serve help with codex and claude subcommands", async () => {
    const result = await runCli(["serve", "--help"]);
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("claude");
  });

  it("shows install help with skill and agent subcommands", async () => {
    const result = await runCli(["install", "--help"]);
    expect(result.stdout).toContain("skill");
    expect(result.stdout).toContain("agent");
  });

  it("rejects unsupported harness routes", async () => {
    const result = await runCli(["connect", "claude", "--to", "claude"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unsupported route: claude -> claude");
  });
});
