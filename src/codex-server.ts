#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand, resolveTimeoutMs, TIMEOUT_ENV_VAR } from "./lib/exec-runner.js";
import { parseCodexOutput } from "./lib/codex-output-parser.js";
import { buildExplainCodePrompt, buildPlanPerfPrompt } from "./lib/prompt-builder.js";
import { createProgressReporter, logger, type ProgressReporter } from "./lib/logger.js";
import { ThreadRegistry, type SandboxMode } from "./lib/thread-registry.js";
import { Semaphore, resolveMaxConcurrent } from "./lib/semaphore.js";
import { buildCodexArgs } from "./lib/codex-args.js";
import { AppServerClient, isAppServerEnabled } from "./lib/app-server.js";
import { CODEX_MODELS } from "./lib/types.js";
import type { CodexResult } from "./lib/types.js";

/**
 * Thread continuity, keyed and sandbox-matched. Replaces the module-global
 * `lastThreadId` that concurrent callers used to stomp. See thread-registry.ts.
 */
const threads = new ThreadRegistry();

/** Caps concurrent `codex exec` subprocesses. See semaphore.ts. */
const execSlots = new Semaphore(resolveMaxConcurrent());

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * Shared description for the opt-in continuity key.
 *
 * Deliberately opt-in: the default of no key gives every call its own thread,
 * which is what parallel reviewers want. Callers that genuinely need a
 * multi-turn conversation pass a stable key of their own choosing.
 */
const THREAD_KEY_DESCRIPTION =
  "Optional key enabling multi-turn continuity. Calls sharing a key resume the same Codex thread, " +
  "provided the sandbox also matches. OMIT for independent one-shot calls (the default), which is " +
  "what parallel reviews want — sharing a key across concurrent callers serialises them onto one thread.";

/**
 * Sandbox control for the read-oriented tools.
 *
 * These used to hardcode `read-only`, which meant a reviewer could not run a
 * build or a test to check its own claims. It had to reason from source alone
 * and then either guess or stall trying to run a command it was denied. Callers
 * that want a reviewer to verify its findings can now grant `workspace-write`.
 *
 * The default stays `read-only`: analysis should not mutate a repo unless the
 * caller explicitly asks, and an omitted argument must never be an escalation.
 */
const analysisSandboxSchema = z
  .enum(SANDBOX_MODES)
  .optional()
  .default("read-only")
  .describe(
    "Sandbox level. Defaults to read-only. Pass workspace-write when the analysis should be able " +
      "to run builds or tests to VERIFY its own findings rather than reasoning from source alone.",
  );

const server = new McpServer({ name: "codex-bridge", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportCodexEvent(line: string, progress: ProgressReporter): void {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = event["type"] as string | undefined;
    if (!type) return;
    const item = (event["item"] as Record<string, unknown>) ?? null;
    const itemType = (item?.["type"] as string) ?? (event["itemType"] as string) ?? "";
    if (!itemType) {
      progress.report(type);
      return;
    }
    // Extract a meaningful value based on the item type.
    let detail = "";
    if (itemType === "command_execution") {
      detail = (item?.["command"] as string) ?? (event["command"] as string) ?? "";
    } else if (itemType === "file_change") {
      const kind = (item?.["kind"] as string) ?? (event["kind"] as string) ?? "";
      const path = (item?.["path"] as string) ?? (event["path"] as string) ?? "";
      detail = kind && path ? `${kind} ${path}` : path || kind;
    } else if (itemType === "agent_message" || itemType === "message") {
      const msg =
        (item?.["text"] as string) ??
        (event["text"] as string) ??
        (item?.["content"] as string) ??
        (event["content"] as string) ??
        "";
      detail = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
    }
    progress.report(detail ? `${itemType}: ${detail}` : itemType);
  } catch {
    // Not valid JSON — skip.
  }
}

/**
 * Lazily-created app-server connection, shared across calls.
 *
 * Not created at module load: the exec backend is the default, and spawning an
 * app-server nobody asked for would cost a process on every bridge start.
 */
let appServer: AppServerClient | null = null;

/**
 * Phase 2 path. Same inputs, same `CodexResult` out, so it is a drop-in swap.
 *
 * Thread bookkeeping stays identical to the exec path, with one relaxation
 * available later: `thread/resume` accepts a sandbox, so the registry's
 * refuse-to-resume-on-mismatch rule is a safety net here rather than a
 * necessity. It is left in place so both backends behave the same way while
 * this one is still opt-in.
 */
async function runViaAppServer(
  prompt: string,
  options: {
    workingDirectory?: string;
    model?: string;
    sandbox: SandboxMode;
    threadKey?: string;
    resumeThreadId: string | null;
    progress?: ProgressReporter;
  },
): Promise<CodexResult> {
  appServer ??= new AppServerClient();

  try {
    const result = await appServer.runTurn({
      prompt,
      cwd: options.workingDirectory,
      sandbox: options.sandbox,
      model: options.model,
      resumeThreadId: options.resumeThreadId,
      progress: options.progress,
    });

    if (result.threadId) {
      threads.remember(options.threadKey, result.threadId, options.sandbox);
    }
    return result;
  } catch (error) {
    // Drop any remembered thread: resuming it after a failure would target a
    // thread whose state we can no longer reason about.
    threads.forget(options.threadKey);
    return {
      threadId: null,
      agentMessage: "",
      fileChanges: [],
      commandsExecuted: [],
      usage: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function runCodex(
  prompt: string,
  options: {
    workingDirectory?: string;
    model?: string;
    sandbox?: SandboxMode;
    threadKey?: string;
    fullAuto?: boolean;
    progress?: ProgressReporter;
  } = {},
): Promise<CodexResult> {
  // Default to read-only so an omitted sandbox is never an implicit escalation.
  const sandbox: SandboxMode = options.sandbox ?? "read-only";
  const resumeThreadId = threads.resolve(options.threadKey, sandbox);

  // Backend swap is invisible above this line: the MCP tool surface, and so
  // every caller and the codex-teammate agent, is identical either way.
  if (isAppServerEnabled()) {
    return runViaAppServer(prompt, { ...options, sandbox, resumeThreadId });
  }

  const args = buildCodexArgs({
    prompt,
    resumeThreadId,
    model: options.model,
    sandbox,
    fullAuto: options.fullAuto,
  });

  if (execSlots.available === 0) {
    options.progress?.report(`Queued behind ${execSlots.waiting + 1} call(s)...`);
  }
  options.progress?.report("Starting codex...");

  // Buffer for partial JSONL lines split across stdout chunks.
  let stdoutBuf = "";

  // Bounded: N parallel reviewers must not spawn N unmanaged subprocesses,
  // each able to hold a slot for the full exec timeout.
  const result = await execSlots.run(() =>
    execCommand({
      command: "codex",
      args,
      cwd: options.workingDirectory,
      onStdout: (chunk) => {
        const text = chunk.toString();

        // Parse streaming JSONL events for inline progress.
        if (options.progress) {
          stdoutBuf += text;
          const lines = stdoutBuf.split(/\r?\n|\r/);
          stdoutBuf = lines.pop()!;
          for (const line of lines) {
            reportCodexEvent(line, options.progress);
          }
        }
      },
      onStderr: (chunk) => {
        logger.warn(`[codex:stderr] ${chunk.toString().replace(/\n$/, "")}`);
      },
    }),
  );

  // Flush any remaining buffered JSONL fragment.
  if (options.progress && stdoutBuf.trim()) {
    reportCodexEvent(stdoutBuf, options.progress);
  }

  if (result.timedOut) {
    const timeoutMs = resolveTimeoutMs();
    const minutes = Math.round(timeoutMs / 60_000);
    return {
      threadId: null,
      agentMessage: "",
      fileChanges: [],
      commandsExecuted: [],
      usage: null,
      errors: [
        `Codex call exceeded the ${timeoutMs} ms (~${minutes} min) time limit and was terminated before finishing. ` +
          `Raise it by setting the ${TIMEOUT_ENV_VAR} env var (value in milliseconds) if this call legitimately needs longer.`,
      ],
    };
  }

  options.progress?.report("Parsing response...");
  const parsed = parseCodexOutput(result.stdout);

  // Only remember the thread when the caller opted into continuity with a key.
  // Without a key this is a no-op, so concurrent callers cannot stomp each other.
  if (parsed.threadId) {
    threads.remember(options.threadKey, parsed.threadId, sandbox);
    if (options.threadKey) {
      logger.debug(`Stored thread ${parsed.threadId} for key '${options.threadKey}' (${sandbox})`);
    }
  } else if (options.threadKey) {
    // Codex returned no thread id, so a later resume under this key would target
    // a stale thread. Drop it and let the next call start clean.
    threads.forget(options.threadKey);
  }

  // Check stderr for API key issues
  if (result.exitCode !== 0 && !parsed.agentMessage) {
    const stderr = result.stderr.toLowerCase();
    if (
      stderr.includes("api key") ||
      stderr.includes("authentication") ||
      stderr.includes("unauthorized")
    ) {
      parsed.errors.push("Codex API key issue. Ensure OPENAI_API_KEY is set.");
    } else if (result.stderr.trim()) {
      parsed.errors.push(result.stderr.trim());
    }
  }

  return parsed;
}

// Safety limit to prevent exceeding MCP response token limits.
const MAX_RESPONSE_CHARS = 80_000;

function formatCodexResponse(parsed: CodexResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (parsed.errors.length > 0 && !parsed.agentMessage) {
    return {
      content: [{ type: "text", text: `Error: ${parsed.errors.join("; ")}` }],
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

  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  "codex_query",
  {
    title: "Ask Codex",
    description:
      "Ask OpenAI Codex a question or give it a task. Use for getting a second opinion, exploring unfamiliar code, or tasks that benefit from a different model's perspective.",
    inputSchema: {
      prompt: z.string().describe("The question or task for Codex"),
      workingDirectory: z
        .string()
        .optional()
        .describe("Working directory (defaults to server cwd)"),
      model: z
        .enum(CODEX_MODELS)
        .optional()
        .describe(
          "Override the Codex model. OMIT this unless explicitly told otherwise: when omitted, the Codex CLI uses the default from ~/.codex/config.toml, which is kept current. This enum may lag behind newly released models.",
        ),
      sandbox: z
        .enum(SANDBOX_MODES)
        .optional()
        .default("read-only")
        .describe("Sandbox level controlling what Codex can modify"),
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async ({ prompt, workingDirectory, model, sandbox, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await runCodex(prompt, {
      workingDirectory,
      model,
      sandbox,
      threadKey,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

server.registerTool(
  "codex_review_code",
  {
    title: "Codex Code Review",
    description:
      "Ask Codex to review code. Provide a git diff range, file paths, or a code snippet. Returns specific, actionable feedback.",
    inputSchema: {
      target: z
        .string()
        .describe(
          'What to review: git diff range (e.g., "HEAD~3..HEAD"), file paths, or code snippet',
        ),
      focusAreas: z
        .string()
        .optional()
        .describe("Focus on: bugs, performance, style, security, etc."),
      context: z.string().optional().describe("Additional context about the codebase or changes"),
      workingDirectory: z.string().optional(),
      sandbox: analysisSandboxSchema,
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async ({ target, focusAreas, context, workingDirectory, sandbox, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Review the following code changes. Provide specific, actionable feedback with line references.\n\nTarget: ${target}`;
    if (focusAreas) prompt += `\n\nFocus areas: ${focusAreas}`;
    if (context) prompt += `\n\nContext: ${context}`;

    const parsed = await runCodex(prompt, {
      workingDirectory,
      sandbox,
      threadKey,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

server.registerTool(
  "codex_review_plan",
  {
    title: "Codex Plan Review",
    description:
      "Ask Codex to critique an implementation plan. Identifies gaps, risks, missing edge cases, and suggests improvements.",
    inputSchema: {
      plan: z.string().describe("The implementation plan or design to review"),
      codebasePath: z.string().optional().describe("Path to relevant codebase for context"),
      constraints: z
        .string()
        .optional()
        .describe("Known constraints: timeline, tech stack, compatibility"),
      workingDirectory: z.string().optional(),
      sandbox: analysisSandboxSchema,
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async ({ plan, codebasePath, constraints, workingDirectory, sandbox, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Critique this implementation plan. Identify gaps, risks, missing edge cases, and suggest improvements.\n\nPlan:\n${plan}`;
    if (codebasePath) prompt += `\n\nRelevant codebase: ${codebasePath}`;
    if (constraints) prompt += `\n\nConstraints: ${constraints}`;

    const parsed = await runCodex(prompt, {
      workingDirectory,
      sandbox,
      threadKey,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

server.registerTool(
  "codex_explain_code",
  {
    title: "Codex Explain Code",
    description:
      "Ask Codex to deeply explain code, logic, or architecture. Useful for understanding unfamiliar code, onboarding, or documenting complex systems.",
    inputSchema: {
      target: z
        .string()
        .describe("What to explain: file path, function name, module, or code snippet"),
      depth: z
        .enum(["overview", "detailed", "trace"])
        .optional()
        .default("detailed")
        .describe("Depth of explanation: overview, detailed, or full execution trace"),
      context: z.string().optional().describe("Additional context about the codebase"),
      workingDirectory: z.string().optional(),
      sandbox: analysisSandboxSchema,
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async ({ target, depth, context, workingDirectory, sandbox, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildExplainCodePrompt({ target, depth, context });
    const parsed = await runCodex(prompt, {
      workingDirectory,
      sandbox,
      threadKey,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

server.registerTool(
  "codex_plan_perf",
  {
    title: "Codex Performance Plan",
    description:
      "Ask Codex to analyze performance and create an improvement plan. Identifies bottlenecks, proposes ranked optimizations with expected impact.",
    inputSchema: {
      target: z.string().describe("What to optimize: function, module, or pipeline path"),
      metrics: z
        .array(z.enum(["latency", "throughput", "memory", "binary-size"]))
        .optional()
        .describe("Performance metrics to focus on"),
      constraints: z
        .string()
        .optional()
        .describe("Constraints: must not increase binary size, etc."),
      context: z.string().optional().describe("Additional context about usage patterns"),
      workingDirectory: z.string().optional(),
      sandbox: analysisSandboxSchema,
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async (
    { target, metrics, constraints, context, workingDirectory, sandbox, threadKey },
    extra,
  ) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildPlanPerfPrompt({ target, metrics, constraints, context });
    const parsed = await runCodex(prompt, {
      workingDirectory,
      sandbox,
      threadKey,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

server.registerTool(
  "codex_implement",
  {
    title: "Codex Implement",
    description:
      "Ask Codex to implement a feature, fix a bug, or make code changes. WARNING: This modifies your codebase. Returns a summary of what was changed.",
    inputSchema: {
      task: z.string().describe("What to implement or fix"),
      workingDirectory: z.string().optional(),
      model: z
        .enum(CODEX_MODELS)
        .optional()
        .describe(
          "Override the Codex model. OMIT this unless explicitly told otherwise: when omitted, the Codex CLI uses the default from ~/.codex/config.toml, which is kept current. This enum may lag behind newly released models.",
        ),
      sandbox: z
        .enum(["workspace-write", "danger-full-access"])
        .optional()
        .default("workspace-write")
        .describe(
          "Sandbox level (must allow writes). NOTE: workspace-write excludes a git worktree's " +
            "real .git directory, which lives at <main-repo>/.git/worktrees/<name>. Inside a " +
            "worktree it blocks commits and blocks test hosts that need to write outside the " +
            "workspace, so use danger-full-access there.",
        ),
      threadKey: z.string().optional().describe(THREAD_KEY_DESCRIPTION),
    },
  },
  async ({ task, workingDirectory, model, sandbox, threadKey }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await runCodex(task, {
      workingDirectory,
      model,
      sandbox,
      threadKey,
      fullAuto: true,
      progress,
    });
    return formatCodexResponse(parsed);
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("codex-bridge MCP server started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start codex-bridge:", err);
  process.exit(1);
});
