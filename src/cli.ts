#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { PRODUCT_NAME } from "./lib/harness.js";

const main = defineCommand({
  meta: {
    name: PRODUCT_NAME,
    description: "Connect coding-agent harnesses through MCP",
  },
  subCommands: {
    serve: () => import("./commands/serve.js").then((r) => r.default),
    connect: () => import("./commands/connect.js").then((r) => r.default),
    setup: () => import("./commands/setup.js").then((r) => r.default),
    install: () => import("./commands/install.js").then((r) => r.default),
  },
});

runMain(main);
