# Migrating to Harness Bridge

Harness Bridge is the standalone continuation of `claude-codex-bridge`. The npm package, primary CLI, repository, and configuration variable names changed in v0.4.0. MCP registration names and tool names did not.

## 0.x → 1.0.0

Three things change for callers of the Codex tools. Registration names and tool names are unchanged.

### `threadKey` is removed from the Codex tools — use `threadId` from the response

The Codex tools (`codex_query`, `codex_review_code`, `codex_review_plan`, `codex_explain_code`, `codex_plan_perf`, `codex_implement`) no longer accept a caller-chosen `threadKey`. Instead, every response that carries a thread ends with a trailing `threadId: <id>` line. To continue a conversation, echo that id back on the next call.

Before:

```jsonc
// continue a conversation by choosing your own key
{ "prompt": "First question", "threadKey": "my-session" }
{ "prompt": "Follow-up",      "threadKey": "my-session" }
```

After:

```jsonc
// start fresh; the response ends with a `threadId: <id>` line
{ "prompt": "First question" }
// pass that returned id back to continue
{ "prompt": "Follow-up", "threadId": "0199a1b2-c3d4-..." }
```

The id is Codex's real thread id, persisted in Codex's own storage, so resume survives bridge restarts, Claude sessions, and reboots. The Claude tools are unchanged this release and still use `threadKey`.

### The Codex backend defaults to app-server

The app-server backend is now the default (previously it was opt-in and `exec` was the default). To keep the old `codex exec` behavior:

```bash
HARNESS_BRIDGE_CODEX_BACKEND=exec npx @rbutera/harness-bridge serve codex
```

The value `app-server` is still accepted as an explicit no-op, and the legacy `CODEX_BRIDGE_BACKEND` name still works. Threads created under one backend are not guaranteed to resume under the other.

### codex >= 0.147.0 required for the default backend

The default app-server path needs codex 0.147.0 or newer. A missing or too-old codex fails with an actionable error naming the version and how to check it (`codex --version`). If you cannot upgrade codex, set `HARNESS_BRIDGE_CODEX_BACKEND=exec`.

### First npm publish

1.0.0 is the first npm publish, so `npx @rbutera/harness-bridge …` registrations (which the installer already emits) now resolve to the published package.

## Package and commands

Replace:

```text
claude-codex-bridge
```

with:

```text
harness-bridge
```

For example:

```bash
npx @rbutera/harness-bridge setup
```

The `ccb-claude`, `ccb-codex`, and `claude-codex-bridge` binary aliases remain in the new package for compatibility with global installs. Running `npx claude-codex-bridge`, however, still resolves the separately owned upstream npm package; use `npx @rbutera/harness-bridge`.

## MCP configuration

Running `npx @rbutera/harness-bridge setup` will offer to replace existing `codex` and `claude` MCP registrations with commands that use the new package.

For checked-in `.mcp.json` files and other manually managed configuration, change only the package command. Keep the MCP server names `codex` and `claude` unchanged.

## Environment variables

| Previous                                         | Current                               |
| ------------------------------------------------ | ------------------------------------- |
| `BRIDGE_TIMEOUT_MS` or `CODEX_BRIDGE_TIMEOUT_MS` | `HARNESS_BRIDGE_TIMEOUT_MS`           |
| `BRIDGE_MAX_RETRIES`                             | `HARNESS_BRIDGE_MAX_RETRIES`          |
| `BRIDGE_DEBUG`                                   | `HARNESS_BRIDGE_DEBUG`                |
| `BRIDGE_DEPTH`                                   | `HARNESS_BRIDGE_DEPTH`                |
| `CODEX_BRIDGE_MAX_CONCURRENT`                    | `HARNESS_BRIDGE_CODEX_MAX_CONCURRENT` |
| `CODEX_BRIDGE_BACKEND`                           | `HARNESS_BRIDGE_CODEX_BACKEND`        |

The previous names remain supported in v0.4.0.

## Codex execution policy

Harness Bridge v0.4.0 deliberately removes the `sandbox` argument from every `codex_*` MCP tool. Every Codex call runs without approvals or sandboxing on both supported backends.

## Session continuity

Keyless calls now start independent conversations in both adapters. Pass the same optional `threadKey` to continue a conversation. Calls sharing a key are serialized to prevent concurrent session corruption. (As of 1.0.0 this applies to the Claude tools only — the Codex tools use `threadId`; see the 0.x → 1.0.0 section above.)
