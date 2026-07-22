# Migrating to Harness Bridge

Harness Bridge is the standalone continuation of `claude-codex-bridge`. The npm package, primary CLI, repository, and configuration variable names changed in v0.4.0. MCP registration names and tool names did not.

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
npx harness-bridge setup
```

The `ccb-claude`, `ccb-codex`, and `claude-codex-bridge` binary aliases remain in the new package for compatibility with global installs. Running `npx claude-codex-bridge`, however, still resolves the separately owned upstream npm package; use `npx harness-bridge`.

## MCP configuration

Running `npx harness-bridge setup` will offer to replace existing `codex` and `claude` MCP registrations with commands that use the new package.

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

Keyless calls now start independent conversations in both adapters. Pass the same optional `threadKey` to continue a conversation. Calls sharing a key are serialized to prevent concurrent session corruption.
