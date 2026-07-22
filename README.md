# Harness Bridge

[![npm version](https://img.shields.io/npm/v/harness-bridge?color=f97316)](https://www.npmjs.com/package/harness-bridge)
[![CI](https://github.com/rbutera/harness-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/rbutera/harness-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Harness Bridge connects coding-agent harnesses through MCP so one harness can query, review, explain, and delegate implementation work to another.

It currently ships two adapters:

| Calling harness | Connected harness | MCP tools  |
| --------------- | ----------------- | ---------- |
| Claude Code     | OpenAI Codex      | `codex_*`  |
| OpenAI Codex    | Claude Code       | `claude_*` |

The adapter boundary keeps harness-specific execution, sessions, models, and capabilities separate while preserving a consistent set of task-oriented MCP tools.

## Execution contract

> [!WARNING]
> Every Claude-to-Codex call runs Codex without approvals or sandboxing. The exec backend always uses `--dangerously-bypass-approvals-and-sandbox`; the app-server backend always uses `dangerFullAccess`. The `codex_*` MCP tools expose no sandbox argument, so callers cannot change this policy.

Only connect Harness Bridge to projects and harnesses you trust with the permissions of your user account.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and authenticated
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli/), installed and authenticated
- Node.js 18 or newer

## Quick start

Configure both routes and install the bundled skills and Codex teammate agent:

```bash
npx harness-bridge setup
```

Configure one route without installing extras:

```bash
npx harness-bridge connect claude --to codex
npx harness-bridge connect codex --to claude
```

The compatibility forms remain available:

```bash
npx harness-bridge setup claude
npx harness-bridge setup codex
npx harness-bridge setup --skip-extras
```

`setup claude` means “configure Claude Code as the calling harness”; `setup codex` configures Codex as the caller.

## Manual configuration

### Claude Code calls Codex

```bash
claude mcp add codex -s user -- npx harness-bridge serve codex
```

Project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "codex": {
      "type": "stdio",
      "command": "npx",
      "args": ["harness-bridge", "serve", "codex"]
    }
  }
}
```

### Codex calls Claude Code

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude]
command = "npx"
args = ["harness-bridge", "serve", "claude"]
tool_timeout_sec = 600
```

## Tools

Each adapter exposes the same task categories with a harness-specific prefix:

| Task                 | Codex tool           | Claude tool           |
| -------------------- | -------------------- | --------------------- |
| General query        | `codex_query`        | `claude_query`        |
| Code review          | `codex_review_code`  | `claude_review_code`  |
| Plan review          | `codex_review_plan`  | `claude_review_plan`  |
| Code explanation     | `codex_explain_code` | `claude_explain_code` |
| Performance planning | `codex_plan_perf`    | `claude_plan_perf`    |
| Implementation       | `codex_implement`    | `claude_implement`    |

All tools accept `workingDirectory`. Both adapters also accept an optional `threadKey` for deliberate multi-turn continuity:

- Omit `threadKey` for independent calls. This is the concurrency-safe default.
- Reuse a stable key to continue one conversation.
- Calls sharing a key are serialized; different keys and keyless calls remain independent.

For Codex, omit `model` unless a specific override is required so the current default from `~/.codex/config.toml` applies.

## Bundled skills and agent

`setup` can install:

- a `/codex` skill for Claude Code
- a `codex-teammate` agent for Claude Code
- a `/claude` skill for Codex-compatible agent directories

Install them individually with:

```bash
npx harness-bridge install skill claude --global
npx harness-bridge install skill codex --global
npx harness-bridge install agent --global
```

Use `--local` instead to install into the current project.

## Configuration

| Variable                              | Purpose                                       | Default   |
| ------------------------------------- | --------------------------------------------- | --------- |
| `HARNESS_BRIDGE_TIMEOUT_MS`           | Per-call process timeout                      | `1800000` |
| `HARNESS_BRIDGE_MAX_RETRIES`          | Retries for transient CLI failures            | `2`       |
| `HARNESS_BRIDGE_DEBUG`                | Enable debug logging on stderr                | unset     |
| `HARNESS_BRIDGE_DEPTH`                | Recursion depth propagated to child harnesses | `0`       |
| `HARNESS_BRIDGE_CODEX_MAX_CONCURRENT` | Maximum simultaneous `codex exec` processes   | `4`       |
| `HARNESS_BRIDGE_CODEX_BACKEND`        | `exec` or opt-in `app-server`                 | `exec`    |

The previous `BRIDGE_*` and `CODEX_BRIDGE_*` names remain accepted for compatibility. New configuration should use `HARNESS_BRIDGE_*`.

### Codex app-server backend

```bash
HARNESS_BRIDGE_CODEX_BACKEND=app-server npx harness-bridge serve codex
```

The experimental app-server backend keeps one persistent Codex process, supports first-class threads, and can interrupt active turns. It uses the same unrestricted execution policy as the default exec backend.

## Migrating from claude-codex-bridge

See [MIGRATION.md](./MIGRATION.md) for the package, command, configuration, and environment-variable changes. MCP server names and tool names are unchanged.

## Development

```bash
git clone https://github.com/rbutera/harness-bridge.git
cd harness-bridge
pnpm install
pnpm check
```

`pnpm check` runs formatting, lint/type checking, all tests, the production build, and package linting.

## Origin and license

Harness Bridge began from Dunqing’s [`claude-codex-bridge`](https://github.com/Dunqing/claude-codex-bridge) v0.3.1. The original Git history and authorship are preserved; [ORIGIN.md](./ORIGIN.md) records the lineage and subsequent divergence.

Licensed under the [MIT License](./LICENSE).
