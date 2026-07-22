# Fork notes — `rbutera/claude-codex-bridge`

What this fork changes versus upstream [`Dunqing/claude-codex-bridge`](https://github.com/Dunqing/claude-codex-bridge), and why.

Upstream is at `v0.3.1` and has been unmaintained since February 2026.

---

## TL;DR

| | Upstream v0.3.1 | This fork |
|---|---|---|
| Commits ahead | — | 4 |
| `src/` lines | 1,723 | 2,504 (+45%) |
| Test files / cases | 5 | 11 / 104 |
| New source modules | — | 6 |
| Concurrency model | one global thread pointer | per-key thread isolation + bounded pool |
| Sandbox on analysis tools | hardcoded `read-only` | caller-controlled, defaults `read-only` |
| Sandbox on resume | silently dropped | matched, or a fresh thread |
| Backends | `codex exec` only | `codex exec` (default) + `codex app-server` (opt-in) |

Diff: `+1293 / -59` across 16 files. The reverse leg (`src/claude-server.ts`, Codex→Claude) is **untouched** — every change is on the Claude→Codex side.

---

## Why the fork exists

The bridge was reported "saturated" under concurrent review load: a `/wave` run fires an Opus reviewer and a Codex reviewer in parallel, per wave, sometimes across several worktrees at once. That workload broke it.

Diagnosis found three separate defects, two of which fail **silently** — they report success while doing something other than what was asked. Those are the expensive kind: a loud failure costs you a retry, a quiet one costs you a wrong decision made confidently.

---

## Defect 1 — one shared thread pointer

**Upstream** (`src/codex-server.ts:12`):

```ts
let lastThreadId: string | null = null;
```

Claude Code spawns **one** `serve codex` process. Every `codex_*` call from every concurrent agent funnels through it and reads/writes that same module-level variable. Session continuity was designed for a serial conversation, not parallel reviewers.

With N reviewers in flight, each call mutates the shared pointer and `codex exec resume <id>` races against the others: later callers resume a thread mid-flight or serialise behind it. That interleaving is the "saturation".

**This fork.** The global is gone. Continuity is an explicit, opt-in `threadKey` (`src/lib/thread-registry.ts`):

- **No key → no resume.** Every call gets its own thread. This is the default, because it is what parallel reviewers want.
- **A key resumes only that key's thread**, and only when the sandbox also matches (see defect 2).

Concurrent callers can no longer see each other's threads at all.

---

## Defect 2 — `--sandbox` silently dropped on resume

**Upstream** (`src/codex-server.ts:66-76`):

```ts
if (lastThreadId) {
  // Resume an existing thread — --sandbox is not supported on resume
  args = ["exec", "resume", lastThreadId, "--json"];
  //  ...no --sandbox pushed
} else {
  if (options.sandbox) args.push("--sandbox", options.sandbox);
}
```

The comment is accurate — `codex exec resume --help` confirms no such flag exists. The consequence was not accounted for.

Because the global was set after the first call, **every subsequent call resumed**, so `--sandbox` was never passed again. `codex_implement({ sandbox: "danger-full-access" })` therefore only honoured its argument on the **very first call in the process lifetime**. After that it silently inherited whatever sandbox the resumed thread was created under. No error, no warning, no way to tell from the outside.

**This fork.** A thread is resumed only when its recorded sandbox matches the request. A mismatch starts a **fresh** thread rather than running under the wrong one. The failure mode becomes a lost conversation instead of a silent privilege change.

---

## Defect 3 — analysis tools could not verify their own findings

**Upstream** hardcoded the sandbox in four places (`src/codex-server.ts:258, 289, 320, 352`):

```ts
const parsed = await runCodex(prompt, {
  workingDirectory,
  sandbox: "read-only",   // codex_review_code / review_plan / explain_code / plan_perf
  progress,
});
```

A reviewer that cannot run `dotnet build` or the test suite cannot check its own claims. It either reasons from source and guesses, or tries to run a command, gets denied, and stalls.

**This fork.** `sandbox` is a parameter on all four, still defaulting to `read-only` so an omitted argument is never an escalation. Pass `workspace-write` when the reviewer should verify findings by running the gates.

---

## Added: bounded concurrency

`src/lib/semaphore.ts`. Without a cap, N parallel reviewers spawn N unmanaged `codex exec` subprocesses, each able to hold a slot for the full 30-minute timeout. That is the resource half of "saturated"; defect 1 was the correctness half.

FIFO-fair, so a burst cannot starve an earlier caller. Slots release in a `finally`, so a throwing call cannot leak one. Configure with `CODEX_BRIDGE_MAX_CONCURRENT` (default 4); an invalid value falls back rather than throwing, since a typo in a shell profile should not take the bridge down.

---

## Added: `codex app-server` backend (opt-in)

`src/lib/app-server.ts`, `src/lib/jsonrpc.ts`, `src/lib/sandbox-policy.ts`.

Enable with `CODEX_BRIDGE_BACKEND=app-server`. **Ships disabled.**

The exec transport has limits that are structural rather than things care can work around. `codex app-server` is a JSON-RPC service where threads are first-class:

| | `codex exec` | `codex app-server` |
|---|---|---|
| Sandbox on resume | flag does not exist | `thread/resume` **and** per-turn `turn/start` both accept one |
| Worktree writes | `workspace-write` grants only the cwd, so the only escape is `danger-full-access` | `SandboxPolicy.workspaceWrite.writableRoots` grants exactly the paths needed |
| Cancellation | none; a wedged call holds its slot for the whole timeout | `turn/interrupt` |
| Event stream | parse JSONL out of stdout with a hand-rolled line buffer | typed notifications |
| Process cost | one CLI spawn per call | one persistent server |

The `writableRoots` capability is the standout. A git worktree's `.git` is a *file* pointing at `<main-repo>/.git/worktrees/<name>`, outside the workspace — which is why `workspace-write` blocks commits there and the only workaround was dropping the sandbox entirely. The app-server can grant precisely that one directory. Least privilege becomes available for the first time.

The protocol is machine-describable (`codex app-server generate-ts`, `generate-json-schema`), which materially de-risks its `[experimental]` label: a client can be pinned against a generated schema.

**Why it is not the default yet:** the subcommand is still marked experimental, and the per-repo BUSY/dedicated-server fallback would have to be reimplemented here. The exec path stays default so there is always a working fallback.

### Known behavioural difference

`codex exec` refuses to run outside a trusted git directory ("Not inside a trusted directory and `--skip-git-repo-check` was not specified"). The app-server has no equivalent guard and will work in a bare directory. Treat that as a **removed check, not an improvement**.

---

## Verification approach

Every guard added here was **mutation-tested**: broken on purpose, and the suite confirmed to turn red. A test that has never failed has not been shown to test anything.

That process earned its keep. The first battery found that the keyless guards in `ThreadRegistry.resolve` and `.remember` were not *independently* pinned — a regression touching only one of them would have passed. Two dedicated tests now cover that.

The app-server backend was verified against real Codex rather than only compiled:

- stdio handshake, `thread/start` with a sandbox, and a full turn driven end to end returning expected file contents (25s).
- **Backend parity:** the same `codex_query` MCP call through both backends returned identical output (17.8s exec vs 19.5s app-server).

---

## File-by-file

**New:**

| File | Purpose |
|---|---|
| `src/lib/thread-registry.ts` | Keyed, sandbox-matched thread continuity. Replaces the global. |
| `src/lib/semaphore.ts` | FIFO-fair bounded concurrency for `codex exec`. |
| `src/lib/codex-args.ts` | Builds `codex` argv. Separate from the server so tests can import it without the server's top-level `main()` starting a real stdio process. |
| `src/lib/app-server.ts` | JSON-RPC client for `codex app-server`. |
| `src/lib/jsonrpc.ts` | Newline-delimited JSON-RPC framing. |
| `src/lib/sandbox-policy.ts` | Sandbox mode → app-server `SandboxPolicy`, incl. `writableRoots`. |

**Modified:** `src/codex-server.ts` (the three defects, plus backend dispatch), `src/lib/types.ts` and `src/lib/exec-runner.ts` (model enum + timeout, from the earlier commits).

**Untouched:** `src/claude-server.ts`, the Codex→Claude direction.

---

## Earlier fork commits

- **`2adca2f`** — added `gpt-5.6-sol` / `gpt-5.5` to the model enum, and documented that callers should **omit** `model` so the `~/.codex/config.toml` default applies. A stale enum silently downgrades results.
- **`5c0fc1d`** — dropped the `*-codex` model variants, which a ChatGPT-account Codex CLI hard-rejects (so picking one yields a hang, not a downgrade); raised and renamed the exec timeout.

---

## Upstreaming

None of this has been sent to upstream, which is unmaintained. Defects 1-3 are general bugs rather than anything local to our setup, so they would apply to any concurrent user of the bridge.
