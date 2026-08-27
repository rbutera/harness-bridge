#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand, resolveTimeoutMs, TIMEOUT_ENV_VAR } from "./lib/exec-runner.js";
import { parseCodexOutput } from "./lib/codex-output-parser.js";
import { buildExplainCodePrompt, buildPlanPerfPrompt } from "./lib/prompt-builder.js";
import { createProgressReporter, logger, type ProgressReporter } from "./lib/logger.js";
import { Semaphore, resolveMaxConcurrent } from "./lib/semaphore.js";
import { KeyedMutex } from "./lib/keyed-mutex.js";
import { buildCodexArgs } from "./lib/codex-args.js";
import { formatCodexResponse } from "./lib/codex-response.js";
import { AppServerClient, isAppServerEnabled } from "./lib/app-server.js";
import { createHarnessServer, HARNESSES, type HarnessAdapter } from "./lib/harness.js";
import { CODEX_MODELS } from "./lib/types.js";
import type { CodexResult } from "./lib/types.js";

/**
 * Continue a previous Codex conversation by passing back the `threadId` a prior
 * call returned. Lives here rather than in harness.ts because the threadId
 * contract is codex-specific: the claude adapter still uses a caller-chosen
 * conversation key (see CONVERSATION_KEY_DESCRIPTION in harness.ts).
 */
const THREAD_ID_DESCRIPTION =
  "Continue a previous Codex conversation: pass the threadId returned by an earlier call. " +
  "Omit to start a fresh thread.";

/** Caps concurrent `codex exec` subprocesses. See semaphore.ts. */
const execSlots = new Semaphore(resolveMaxConcurrent());

/**
 * Serializes calls that resume the same explicit `threadId`, so two concurrent
 * turns never run against one thread (a conversation is inherently sequential).
 * Calls without a threadId are independent and run fully parallel. Acquired
 * OUTSIDE `execSlots`; that ordering is fixed, and semaphore holders never take a
 * key lock, so the two cannot deadlock. See keyed-mutex.ts.
 */
const keyLocks = new KeyedMutex();

const server = createHarnessServer(HARNESSES.codex);

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
 * Not created at module load: even though the app-server is the default backend,
 * a bridge start where no codex tool is ever called should not pay for a spawned
 * process. The connection is created on first use instead.
 */
let appServer: AppServerClient | null = null;

/**
 * App-server path. Same inputs, same `CodexResult` out, so it is a drop-in swap
 * for the exec path. The caller's explicit `resumeThreadId` flows straight to
 * `thread/resume`; the returned `CodexResult.threadId` is the id the caller
 * echoes back to continue the conversation.
 */
async function runViaAppServer(
  prompt: string,
  options: {
    workingDirectory?: string;
    model?: string;
    resumeThreadId: string | null;
    progress?: ProgressReporter;
  },
): Promise<CodexResult> {
  appServer ??= new AppServerClient();

  try {
    return await appServer.runTurn({
      prompt,
      cwd: options.workingDirectory,
      model: options.model,
      resumeThreadId: options.resumeThreadId,
      progress: options.progress,
    });
  } catch (error) {
    // The turn failed. If a thread was created before it failed, runTurn attaches
    // its id to the error; surface that so the caller can still resume it.
    const threadId = (error as { threadId?: string })?.threadId ?? null;
    return {
      threadId,
      agentMessage: "",
      fileChanges: [],
      commandsExecuted: [],
      usage: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

interface CodexRunOptions {
  workingDirectory?: string;
  model?: string;
  /** Explicit thread to resume; echoed back from a prior call's response. */
  threadId?: string;
  progress?: ProgressReporter;
}

async function runCodex(prompt: string, options: CodexRunOptions = {}): Promise<CodexResult> {
  // Serialize concurrent turns that target the same explicit thread: a
  // conversation is sequential, so two turns resuming one thread at once would
  // race. Calls without a threadId are independent and skip the lock, staying
  // fully parallel (the default for one-shot reviews).
  const key = options.threadId;
  if (!key) return runCodexUnlocked(prompt, options);
  return keyLocks.run(key, () => runCodexUnlocked(prompt, options));
}

async function runCodexUnlocked(prompt: string, options: CodexRunOptions): Promise<CodexResult> {
  const resumeThreadId = options.threadId ?? null;

  // Backend swap is invisible above this line: the MCP tool surface, and so
  // every caller and the codex-teammate agent, is identical either way.
  if (isAppServerEnabled()) {
    return runViaAppServer(prompt, { ...options, resumeThreadId });
  }

  const args = buildCodexArgs({
    prompt,
    resumeThreadId,
    model: options.model,
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

  // The parsed thread id is surfaced verbatim to the caller by formatCodexResponse;
  // there is no server-side registry to update — the caller owns the id now.
  if (parsed.threadId) {
    logger.debug(`Codex turn produced thread ${parsed.threadId}`);
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

const codexAdapter: HarnessAdapter<CodexResult, CodexRunOptions> = {
  descriptor: HARNESSES.codex,
  run: runCodex,
};

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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ prompt, workingDirectory, model, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await codexAdapter.run(prompt, {
      workingDirectory,
      model,
      threadId,
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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ target, focusAreas, context, workingDirectory, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Review the following code changes. Provide specific, actionable feedback with line references.\n\nTarget: ${target}`;
    if (focusAreas) prompt += `\n\nFocus areas: ${focusAreas}`;
    if (context) prompt += `\n\nContext: ${context}`;

    const parsed = await codexAdapter.run(prompt, {
      workingDirectory,
      threadId,
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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ plan, codebasePath, constraints, workingDirectory, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    let prompt = `Critique this implementation plan. Identify gaps, risks, missing edge cases, and suggest improvements.\n\nPlan:\n${plan}`;
    if (codebasePath) prompt += `\n\nRelevant codebase: ${codebasePath}`;
    if (constraints) prompt += `\n\nConstraints: ${constraints}`;

    const parsed = await codexAdapter.run(prompt, {
      workingDirectory,
      threadId,
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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ target, depth, context, workingDirectory, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildExplainCodePrompt({ target, depth, context });
    const parsed = await codexAdapter.run(prompt, {
      workingDirectory,
      threadId,
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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ target, metrics, constraints, context, workingDirectory, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const prompt = buildPlanPerfPrompt({ target, metrics, constraints, context });
    const parsed = await codexAdapter.run(prompt, {
      workingDirectory,
      threadId,
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
      threadId: z.string().optional().describe(THREAD_ID_DESCRIPTION),
    },
  },
  async ({ task, workingDirectory, model, threadId }, extra) => {
    const progress = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
    const parsed = await codexAdapter.run(task, {
      workingDirectory,
      model,
      threadId,
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
  logger.info("harness-bridge codex adapter started on stdio");
}

main().catch((err) => {
  logger.error("Failed to start harness-bridge codex adapter:", err);
  process.exit(1);
});
