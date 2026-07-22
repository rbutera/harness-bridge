import type { SandboxMode } from "./thread-registry.js";

/**
 * The app-server's structured sandbox policy.
 *
 * Mirrors the generated `SandboxPolicy` type from
 * `codex app-server generate-ts`. Kept hand-written and narrow rather than
 * vendoring the generated tree: we use three of its shapes, and a local type we
 * control is easier to pin than a 400-file generated dump.
 */
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/**
 * Translate a coarse sandbox mode into an app-server policy.
 *
 * `writableRoots` is the reason this indirection is worth having. Under the
 * `codex exec` CLI, `--sandbox workspace-write` makes only the cwd writable,
 * which is what breaks git worktrees: their `.git` is a file pointing at
 * `<main-repo>/.git/worktrees/<name>`, outside the workspace. The only escape
 * was `danger-full-access` — dropping the sandbox entirely to fix a path
 * problem.
 *
 * The app-server takes explicit writable roots, so a worktree can be granted
 * exactly its own git directory and nothing else. Least privilege becomes
 * available for the first time.
 */
export function toSandboxPolicy(
  mode: SandboxMode,
  options: { writableRoots?: string[] } = {},
): SandboxPolicy {
  switch (mode) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: options.writableRoots ?? [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}
