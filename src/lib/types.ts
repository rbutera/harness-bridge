// Only models a ChatGPT-account Codex CLI accepts. The *-codex variants are
// hard-rejected ("not supported when using Codex with a ChatGPT account"), so
// an agent that picks one from the enum gets a hang/timeout, not a downgrade —
// they are traps, not compatibility. Prefer OMITting the model param entirely
// so the ~/.codex/config.toml default (kept current) applies.
export const CODEX_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.5",
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export interface ExecOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  onStdout?: (chunk: Buffer | string) => void;
  onStderr?: (chunk: Buffer | string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CodexResult {
  threadId: string | null;
  agentMessage: string;
  fileChanges: Array<{
    path: string;
    kind: string;
  }>;
  commandsExecuted: Array<{
    command: string;
    exitCode: number | null;
    output: string;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  errors: string[];
}

export interface ClaudeResult {
  resultText: string;
  sessionId: string | null;
  costUsd: number | null;
  errors: string[];
}
