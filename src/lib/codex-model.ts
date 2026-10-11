/** Env var that pins this server's default Codex model when a call passes none. */
export const MODEL_ENV_VAR = "HARNESS_BRIDGE_CODEX_MODEL";

/**
 * The model for one Codex call: the caller's explicit choice, else the server default from
 * HARNESS_BRIDGE_CODEX_MODEL, else undefined (Codex falls back to ~/.codex/config.toml).
 */
export function resolveCodexModel(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit?.trim()) return explicit;
  const pinned = env[MODEL_ENV_VAR]?.trim();
  return pinned ? pinned : undefined;
}
