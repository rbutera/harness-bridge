import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PRODUCT_NAME = "harness-bridge";
export const PRODUCT_TITLE = "Harness Bridge";
export const PRODUCT_VERSION = "0.4.0";

export type HarnessId = "claude" | "codex";

export interface HarnessDescriptor {
  id: HarnessId;
  displayName: string;
  executable: string;
  capabilities: readonly HarnessCapability[];
}

export type HarnessCapability =
  | "allowed-tools"
  | "cancellation"
  | "models"
  | "sessions"
  | "unrestricted-execution";

export interface HarnessAdapter<TResult, TOptions> {
  descriptor: HarnessDescriptor;
  run(prompt: string, options: TOptions): Promise<TResult>;
}

export const HARNESSES = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    capabilities: ["allowed-tools", "models", "sessions"],
  },
  codex: {
    id: "codex",
    displayName: "OpenAI Codex",
    executable: "codex",
    capabilities: ["cancellation", "models", "sessions", "unrestricted-execution"],
  },
} as const satisfies Record<HarnessId, HarnessDescriptor>;

export const CONVERSATION_KEY_DESCRIPTION =
  "Optional key enabling multi-turn continuity. Calls sharing a key use the same harness " +
  "conversation and are serialized. Omit it for independent one-shot calls, including parallel reviews.";

export function createHarnessServer(descriptor: HarnessDescriptor): McpServer {
  return new McpServer({
    name: `${PRODUCT_NAME}-${descriptor.id}`,
    title: `${PRODUCT_TITLE}: ${descriptor.displayName}`,
    version: PRODUCT_VERSION,
  });
}
