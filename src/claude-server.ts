#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand } from "./lib/exec-runner.js";
import { parseClaudeOutput } from "./lib/claude-output-parser.js";
import { buildClaudeArgs } from "./lib/claude-args.js";
import { buildExplainCodePrompt, buildPlanPerfPrompt } from "./lib/prompt-builder.js";
import { createProgressReporter, logger, type ProgressReporter } from "./lib/logger.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { SessionRegistry } from "./lib/session-registry.js";
import {
  CONVERSATION_KEY_DESCRIPTION,
  createHarnessServer,
  HARNESSES,
  type HarnessAdapter,
} from "./lib/harness.js";
import { CLAUDE_MODELS } from "./lib/types.js";
import type { ClaudeResult } from "./lib/types.js";

const sessions = new SessionRegistry();
const keyLocks = new KeyedMutex();

const server = createHarnessServer(HARNESSES.claude);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ClaudeRunOptions {
  workingDirectory?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  threadKey?: string;
  progress?: ProgressReporter;
}

async function runClaude(prompt: string, options: ClaudeRunOptions = {}): Promise<ClaudeResult> {
  const key = options.threadKey;
  if (!key) return runClaudeUnlocked(prompt, options);
  return keyLocks.run(key, () => runClaudeUnlocked(prompt, options));
}

async function runClaudeUnlocked(prompt: string, options: ClaudeRunOptions): Promise<ClaudeResult> {
  const sessionId = sessions.resolve(options.threadKey);
  const args = buildClaudeArgs({
    prompt,
    resumeSessionId: sessionId,
    model: options.model,
    maxTurns: options.maxTurns,
    allowedTools: options.allowedTools,
  });

  options.progress?.report("Starting claude...");

  // Buffer for partial stderr lines split across chunks.
  let stderrBuf = "";

  let result;
  try {
    result = await execCommand({
      command: "claude",
      args,
      cwd: options.workingDirectory,
      onStdout: (chunk) => {
        logger.info(`[claude] ${chunk.toString().replace(/\n$/, "")}`);
      },
      onStderr: (chunk) => {
        const text = chunk.toString();
        logger.warn(`[claude:stderr] ${text.replace(/\n$/, "")}`);

        if (options.progress) {
          stderrBuf += text;
          const lines = stderrBuf.split(/\r?\n|\r/);
          stderrBuf = lines.pop()!;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) options.progress.report(trimmed);
          }
        }
      },
    });
  } catch (error) {
    sessions.forget(options.threadKey);
    throw error;
  }

  // Flush any remaining buffered stderr fragment.
  if (options.progress && stderrBuf.trim()) {
    options.progress.report(stderrBuf.trim());
  }

  if (result.timedOut) {
    sessions.forget(options.threadKey);
    return {
      resultText: "",
      sessionId: null,
      costUsd: null,
      errors: ["Claude timed out. Increase HARNESS_BRIDGE_TIMEOUT_MS if needed."],
    };
  }

  options.progress?.report("Parsing response...");
  const parsed = parseClaudeOutput(result.stdout);

  if (parsed.sessionId) {
    sessions.remember(options.threadKey, parsed.sessionId);
    if (options.threadKey) {
      logger.debug(`Stored Claude session ${parsed.sessionId} for key '${options.threadKey}'`);
    }
  } else if (options.threadKey) {
    sessions.forget(options.threadKey);
  }

  // Check stderr for API key issues
  if (result.exitCode !== 0 && !parsed.resultText) {
    const stderr = result.stderr.toLowerCase();
    if (
      stderr.includes("api key") ||
      stderr.includes("authentication") ||
      stderr.includes("unauthorized")
    ) {
      parsed.errors.push("Claude API key issue. Ensure ANTHROPIC_API_KEY is set.");
    } else if (result.stderr.trim()) {
      parsed.errors.push(result.stderr.trim());
    }
  }

  return parsed;
}

// Safety limit to prevent exceeding MCP response token limits.
const MAX_RESPONSE_CHARS = 80_000;

function formatClaudeResponse(parsed: ClaudeResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (parsed.errors.length > 0 && !parsed.resultText) {
    return {
      content: [{ type: "text" as const, text: `Error: ${parsed.errors.join("; ")}` }],
      isError: true,
    };
  }

  let text = parsed.resultText;
  if (text.length > MAX_RESPONSE_CHARS) {
    text = text.slice(0, MAX_RESPONSE_CHARS) + "\n\n...[response truncated]";
  }

  return { content: [{ type: "text" as const, text }] };
}

const claudeAdapter: HarnessAdapter<ClaudeResult, ClaudeRunOptions> = {
  descriptor: HARNESSES.claude,
  run: runClaude,
};

// Read-only tool set for review/analysis tasks
const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
];

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  "claude_query",
  {
    title: "Ask Claude",
    description:
      "Ask Claude Code a question or give it a task. Claude will use its full toolset (file reading, code search, web search, etc.) to answer.",
    inputSchema: {
      prompt: z.string().describe("The question or task for Claude"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory (defaults to server cwd)"),
      model: z.enum(CLAUDE_MODELS).optional().describe("Claude model alias"),
      maxTurns: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum agentic turns (limits runtime)"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe('Restrict tools (e.g., ["Read", "Grep", "Glob"])'),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async ({ prompt, workingDirectory, model, maxTurns, allowedTools, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await claudeAdapter.run(prompt, {
      workingDirectory,
      model,
      maxTurns,
      allowedTools,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

server.registerTool(
  "claude_review_code",
  {
    title: "Claude Code Review",
    description:
      "Ask Claude to review code for quality, bugs, security issues, and best practices. Provide a git diff range, file paths, or code snippet.",
    inputSchema: {
      target: z.string().describe("What to review: git diff range, file paths, or code snippet"),
      focusAreas: z
        .string()
        .optional()
        .describe("Focus on: bugs, performance, style, security, etc."),
      context: z.string().optional().describe("Additional context about the changes"),
      workingDirectory: z.string().optional(),
      maxTurns: z.number().optional().default(5),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async ({ target, focusAreas, context, workingDirectory, maxTurns, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Review the following code changes. Provide specific, actionable feedback with line references.\n\nTarget: ${target}`;
    if (focusAreas) prompt += `\n\nFocus areas: ${focusAreas}`;
    if (context) prompt += `\n\nContext: ${context}`;

    const parsed = await claudeAdapter.run(prompt, {
      workingDirectory,
      maxTurns,
      allowedTools: READ_ONLY_TOOLS,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

server.registerTool(
  "claude_review_plan",
  {
    title: "Claude Plan Review",
    description:
      "Ask Claude to critique an implementation plan. Claude will examine the actual codebase to validate feasibility and consistency with existing patterns.",
    inputSchema: {
      plan: z.string().describe("The implementation plan to review"),
      codebasePath: z.string().optional().describe("Path to relevant codebase for context"),
      constraints: z.string().optional().describe("Known constraints"),
      workingDirectory: z.string().optional(),
      maxTurns: z.number().optional().default(8),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async ({ plan, codebasePath, constraints, workingDirectory, maxTurns, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Critique this implementation plan. Evaluate feasibility against the actual codebase, check consistency with existing patterns, identify gaps and risks.\n\nPlan:\n${plan}`;
    if (codebasePath) prompt += `\n\nRelevant codebase: ${codebasePath}`;
    if (constraints) prompt += `\n\nConstraints: ${constraints}`;

    const parsed = await claudeAdapter.run(prompt, {
      workingDirectory,
      maxTurns,
      allowedTools: READ_ONLY_TOOLS,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

server.registerTool(
  "claude_explain_code",
  {
    title: "Claude Explain Code",
    description:
      "Ask Claude to deeply explain code, logic, or architecture. Claude will read the actual source files to give grounded explanations.",
    inputSchema: {
      target: z
        .string()
        .describe("What to explain: file path, function name, module, or code snippet"),
      depth: z
        .enum(["overview", "detailed", "trace"])
        .optional()
        .default("detailed")
        .describe("Depth: overview, detailed, or full execution trace"),
      context: z.string().optional().describe("Additional context about the codebase"),
      workingDirectory: z.string().optional(),
      maxTurns: z.number().optional().default(8),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async ({ target, depth, context, workingDirectory, maxTurns, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildExplainCodePrompt({ target, depth, context });
    const parsed = await claudeAdapter.run(prompt, {
      workingDirectory,
      maxTurns,
      allowedTools: READ_ONLY_TOOLS,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

server.registerTool(
  "claude_plan_perf",
  {
    title: "Claude Performance Plan",
    description:
      "Ask Claude to analyze performance and create an improvement plan. Claude reads the actual code to identify bottlenecks and propose optimizations.",
    inputSchema: {
      target: z.string().describe("What to optimize: function, module, or pipeline path"),
      metrics: z
        .array(z.enum(["latency", "throughput", "memory", "binary-size"]))
        .optional()
        .describe("Performance metrics to focus on"),
      constraints: z.string().optional().describe("Constraints"),
      context: z.string().optional().describe("Additional context about usage patterns"),
      workingDirectory: z.string().optional(),
      maxTurns: z.number().optional().default(10),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async (
    { target, metrics, constraints, context, workingDirectory, maxTurns, threadKey },
    extra,
  ) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildPlanPerfPrompt({ target, metrics, constraints, context });
    const parsed = await claudeAdapter.run(prompt, {
      workingDirectory,
      maxTurns,
      allowedTools: READ_ONLY_TOOLS,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

server.registerTool(
  "claude_implement",
  {
    title: "Claude Implement",
    description:
      "Ask Claude to implement a feature, fix a bug, or make code changes. WARNING: This modifies your codebase.",
    inputSchema: {
      task: z.string().describe("What to implement or fix"),
      workingDirectory: z.string().optional(),
      model: z.enum(CLAUDE_MODELS).optional().describe("Claude model alias"),
      maxTurns: z.number().optional().default(15),
      threadKey: z.string().optional().describe(CONVERSATION_KEY_DESCRIPTION),
    },
  },
  async ({ task, workingDirectory, model, maxTurns, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await claudeAdapter.run(task, {
      workingDirectory,
      model,
      maxTurns,
      threadKey,
      progress,
    });
    return formatClaudeResponse(parsed);
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("harness-bridge claude adapter started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start harness-bridge claude adapter:", err);
  process.exit(1);
});
