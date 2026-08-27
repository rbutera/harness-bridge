import type { CodexResult } from "./types.js";

// Safety limit to prevent exceeding MCP response token limits.
const MAX_RESPONSE_CHARS = 80_000;

/**
 * Format a Codex turn result into the MCP tool response shape.
 *
 * Every response that carries a thread ends with a `threadId: <id>` line so the
 * caller can pass that id back to resume the conversation (the resume contract,
 * see docs/adr/0002). The line is appended last — after any truncation — so it
 * survives even a response clipped at `MAX_RESPONSE_CHARS`, and it is included on
 * the error path too whenever a thread was actually created.
 */
export function formatCodexResponse(parsed: CodexResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (parsed.errors.length > 0 && !parsed.agentMessage) {
    let text = `Error: ${parsed.errors.join("; ")}`;
    text += threadIdLine(parsed.threadId);
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }

  let text = parsed.agentMessage;

  if (parsed.fileChanges.length > 0) {
    text += "\n\n**Files changed:**\n";
    for (const fc of parsed.fileChanges) {
      text += `- ${fc.kind}: ${fc.path}\n`;
    }
  }

  if (parsed.commandsExecuted.length > 0) {
    text += "\n\n**Commands executed:**\n";
    for (const cmd of parsed.commandsExecuted) {
      text += `- \`${cmd.command}\` (exit: ${cmd.exitCode})\n`;
    }
  }

  if (text.length > MAX_RESPONSE_CHARS) {
    text = text.slice(0, MAX_RESPONSE_CHARS) + "\n\n...[response truncated]";
  }

  text += threadIdLine(parsed.threadId);

  return { content: [{ type: "text", text }] };
}

/** The trailing resume marker, or nothing when no thread was created. */
function threadIdLine(threadId: string | null): string {
  return threadId ? `\n\nthreadId: ${threadId}` : "";
}
