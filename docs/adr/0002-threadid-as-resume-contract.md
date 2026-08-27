# threadId is the codex resume contract; the threadKey registry goes

---

status: accepted
date: 2026-08-27

---

The codex tools return the app-server's real `threadId` in their results, and
callers pass `threadId` back to resume a conversation. The caller-chosen
`threadKey` parameter is removed from the codex tools in 1.0.0 (a breaking
tool-API change, recorded in MIGRATION.md). The in-memory `SessionRegistry`
survives only for the claude adapter, whose tools keep `threadKey` this release;
extending the same id-as-contract change to it is expected follow-up work.

The mapping had to live somewhere, and every home for it was bad: the in-memory
map died with each bridge process; a state file on disk was a second source of
truth to lock and sync; and the protocol offers no server-side home for client
names — `thread/start` accepts no metadata or label field and `thread/list` only
filters by cwd/source/recency (verified against codex-cli 0.147.0 generated
schemas). Passing the real id through instead means the only persistent state is
the app-server's own `$CODEX_HOME` SQLite thread store, which survives bridge
restarts, session boundaries, and reboots, and the calling agent keeps the id in
its own conversation context. Any client that can echo back a string gets durable
resume for free.
