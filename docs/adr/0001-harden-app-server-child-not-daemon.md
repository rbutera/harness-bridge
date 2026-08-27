# Keep the per-bridge app-server child; reject the codex daemon (for now)

---

status: accepted
date: 2026-08-27

---

For 1.0.0 the codex backend stays a `codex app-server` child spawned by each bridge
process over stdio, hardened in the style of pingdotgg/t3code's
`effect-codex-app-server` package (generated protocol bindings, an explicit error
taxonomy, robust child lifecycle), and becomes the default backend with `exec` kept
as an env-var fallback for one more release. We investigated migrating to the
durable `codex app-server daemon` and rejected it.

## Considered Options

**`codex app-server daemon` (rejected).** One shared server for all sessions,
managed by `codex app-server daemon bootstrap|start|stop`. Investigated deeply
(codex-cli 0.147.0, openai/codex source):

- The control socket speaks JSON-RPC **inside WebSocket frames** after an HTTP
  Upgrade over the unix socket; `codex app-server proxy` is a dumb byte pipe, not a
  protocol translator. Adopting it means writing a WS transport.
- `daemon start`/`bootstrap` refuse to run unless OpenAI's managed standalone codex
  is installed via `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, and
  `bootstrap` enrolls the machine in an hourly auto-update loop that re-runs that
  script. We were not willing to make the bridge depend on, or encourage running,
  that installer.
- The entire daemon lifecycle is Unix-only, PID-file based (not systemd/launchd),
  with no crash supervision (a crashed daemon stays down until the next explicit
  `start`).
- A shared daemon is shared infrastructure: restarting it on a wedge would yank
  threads from every other client, so wedge recovery becomes an etiquette problem
  instead of "kill our child and respawn".

**Hardened per-bridge child (chosen).** t3code drives codex the same way we already
do — one stdio `app-server` child per owning process — and demonstrates the design
done well. Our historical bugs here (MCP-stack leak per thread, wedge under memory
pressure, and a dev-machine outage caused by registering an unbuilt `dist/` path)
were implementation problems, not architectural ones.

## Consequences

- N concurrent sessions still run N app-server processes, each spawning its own MCP
  stacks per thread. If that memory pressure bites, the daemon can return as an
  additive transport in a later minor version behind the same threadId contract
  (see ADR-0002) — this ADR rejects it for 1.0.0, not forever.
- Cross-session and cross-reboot thread resume does **not** need the daemon: the
  thread store is `$CODEX_HOME` SQLite persisted by app-server core, so any child
  can `thread/resume` a threadId created by another process.
- Protocol types are generated via `codex app-server generate-ts` and checked in,
  regenerated when the minimum supported codex version bumps (which the bridge
  probes at first use and fails on with an actionable message).
- 1.0.0 ships as an npm publish so the installer's existing
  `npx harness-bridge serve …` registration actually resolves; registering an
  absolute path into a dev checkout's `dist/` is a dev-only setup.
