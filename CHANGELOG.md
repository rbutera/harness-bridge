# Changelog

## 1.0.1 - 2026-11-25

### Fixed

- Sub-agent threads no longer leak their MCP stacks. With Codex's multi-agent tools on, a turn can spawn sub-agent threads, each loading its own MCP servers; the bridge unsubscribed only the main thread, so on codex 0.171.0 every sub-agent stayed loaded, its MCP servers running, until the app-server exited (one long-lived bridge reached 124 processes, about 16G, in a day). After each turn the bridge now lists the loaded threads, finds the ones descended from its thread by `parentThreadId`, and unsubscribes them too. Other callers' threads on the same server are left alone. Measured on one call that spawns two sub-agents: 1.0.0 leaves 8 processes under the bridge for good, 1.0.1 settles at 2 (the app-server and its code-mode host) once the server's ~60s idle unload runs.
- Also includes `HARNESS_BRIDGE_CODEX_MODEL` (#4), unreleased until now.

## 1.0.0 - 2026-08-28

### Breaking

- Removed `threadKey` from every Codex tool. Continue a conversation by passing back the `threadId` a prior call returned; each thread-bearing response ends with a trailing `threadId: <id>` line (appended after truncation, and included on error responses when a thread was created). Concurrent calls with the same `threadId` are serialized; calls without one run fully parallel. Thread state lives in Codex's own storage, so resume works across bridge restarts, Claude sessions, and reboots. The Claude adapter's tools still use `threadKey` this release.
- Made the Codex app-server backend the default (was `exec`). Set `HARNESS_BRIDGE_CODEX_BACKEND=exec` (or the legacy `CODEX_BRIDGE_BACKEND=exec`) to opt back into the exec path; the value `app-server` remains accepted as a no-op. The default path requires codex >= 0.147.0.

### Added

- First npm publish, as `@rbutera/harness-bridge` (npm rejects the unscoped name as too similar to the unrelated `harnessbridge` package), so `npx -y @rbutera/harness-bridge …` registrations emitted by the installer now resolve.

### Changed

- After every turn the bridge sends `thread/unsubscribe`, so the app-server unloads the thread's MCP stack while the thread stays resumable — fixing the historical per-call MCP-stack leak without breaking resume.
- Hardened the app-server client: a typed error taxonomy with actionable messages (a missing or too-old codex names the fix), crash recovery (in-flight requests fail fast, the next call respawns cleanly), bounded retry with backoff on server-overload (-32001), and request timeouts as before.
- Typed the protocol edge against generated bindings (`src/generated`, regenerate with `pnpm generate:protocol` against the minimum codex version), fixing several silent data losses (token usage, file changes, command output, error messages).

### Notes

- Threads created under the exec backend and under the app-server backend are not guaranteed to be mutually resumable across backends.

## 0.4.1 - 2026-08-10

- Fixed a Codex app-server MCP-stack memory leak by disposing per-call threads (`keepThread` + `thread/delete`, reap-on-drop) instead of letting them accumulate.
- Fast-fail wedged Codex requests with a 120s request timeout, ending the intermittent 30-minute hangs. (#3)

## 0.4.0 - 2026-07-22

- Renamed the standalone project, npm package, and CLI to Harness Bridge.
- Introduced shared harness descriptors and adapter contracts for Claude Code and OpenAI Codex.
- Added `connect <source> --to <target>` for explicit cross-harness routes.
- Made Claude and Codex conversation continuity explicit, keyed, isolated, and serialized per key.
- Removed every Codex MCP sandbox option and made all Codex calls run unrestricted on exec and app-server backends.
- Added canonical `HARNESS_BRIDGE_*` configuration names with legacy aliases.
- Updated the MCP SDK and pinned its URI parser to patched releases.
- Preserved existing `claude_*`, `codex_*`, `ccb-claude`, and `ccb-codex` compatibility surfaces.
- Reframed the upstream divergence record as project lineage and preserved original authorship.
