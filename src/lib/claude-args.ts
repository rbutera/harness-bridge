export function buildClaudeArgs(options: {
  prompt: string;
  resumeSessionId: string | null;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
}): string[] {
  const args = ["-p", "--output-format", "json"];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  for (const tool of options.allowedTools ?? []) args.push("--allowedTools", tool);
  args.push(options.prompt);
  return args;
}
