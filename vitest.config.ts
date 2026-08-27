import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The generated protocol bindings (src/generated) are type-only and carry no
    // tests; keep vitest from ever crawling or transforming that large tree.
    exclude: [...configDefaults.exclude, "src/generated/**"],
  },
});
