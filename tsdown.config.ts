import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/codex-server.ts", "src/claude-server.ts"],
  format: "esm",
  dts: true,
  clean: true,
  inlineOnly: false,
  noExternal: [/.*/],
  publint: true,
});
