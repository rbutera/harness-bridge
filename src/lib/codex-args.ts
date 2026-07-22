/**
 * Build the `codex` argv for a call.
 *
 * Both fresh and resumed turns use Codex's explicit bypass flag. Harness Bridge
 * is a local automation connector and never applies a restricted Codex sandbox
 * on behalf of its MCP caller.
 */
export function buildCodexArgs(options: {
  prompt: string;
  resumeThreadId: string | null;
  model?: string;
}): string[] {
  const args = options.resumeThreadId
    ? ["exec", "resume", options.resumeThreadId, "--json"]
    : ["exec", "--json"];

  if (options.model) args.push("--model", options.model);
  args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push(options.prompt);
  return args;
}
