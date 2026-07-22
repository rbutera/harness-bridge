import { defineCommand } from "citty";
import { setupClaude, setupCodex } from "../lib/installer.js";

export default defineCommand({
  meta: {
    name: "connect",
    description: "Connect one harness to another",
  },
  args: {
    source: {
      type: "positional",
      description: "Harness making the calls: claude or codex",
      required: true,
    },
    to: {
      type: "string",
      description: "Harness to expose: claude or codex",
      required: true,
    },
  },
  async run({ args }) {
    if (args.source === "claude" && args.to === "codex") {
      await setupClaude();
      return;
    }
    if (args.source === "codex" && args.to === "claude") {
      await setupCodex();
      return;
    }

    console.error(`Unsupported route: ${args.source} -> ${args.to}`);
    console.error("Supported routes: claude -> codex, codex -> claude");
    process.exit(1);
  },
});
