import type { SandboxMode } from "./thread-registry.js";

/**
 * Build the `codex` argv for a call.
 *
 * Lives in `lib/` rather than beside the server so tests can import it without
 * executing `codex-server.ts`, whose top-level `main()` would start a real MCP
 * server on stdio.
 *
 * The sandbox rule here is the crux of the concurrency fix. `codex exec resume`
 * accepts no `--sandbox` flag (verified against `codex exec resume --help`), so
 * a resumed thread always runs under whatever sandbox created it. Passing the
 * flag anyway would make the CLI reject the call. `resumeThreadId` is therefore
 * only ever non-null when the thread registry has already confirmed the
 * recorded sandbox matches the requested one.
 */
export function buildCodexArgs(options: {
  prompt: string;
  resumeThreadId: string | null;
  model?: string;
  sandbox?: SandboxMode;
  fullAuto?: boolean;
}): string[] {
  const args = options.resumeThreadId
    ? ["exec", "resume", options.resumeThreadId, "--json"]
    : ["exec", "--json"];

  if (options.model) args.push("--model", options.model);
  // Only a fresh exec accepts --sandbox; on resume the flag does not exist.
  if (!options.resumeThreadId && options.sandbox) args.push("--sandbox", options.sandbox);
  if (options.fullAuto) args.push("--full-auto");

  args.push(options.prompt);
  return args;
}
