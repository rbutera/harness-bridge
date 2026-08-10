# Changelog

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
