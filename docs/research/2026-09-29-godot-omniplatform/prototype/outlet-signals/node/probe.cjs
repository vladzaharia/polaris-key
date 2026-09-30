#!/usr/bin/env node
let sea = "n/a";
try {
  sea = require("node:sea").isSea();
} catch (e) {
  sea = "throws " + e.code;
}
console.log(
  "NODE_PROBE " +
    JSON.stringify({
      node: process.version,
      argv1: (process.argv[1] || "").replace(process.env.HOME, "~"),
      filename: __filename.replace(process.env.HOME, "~"),
      npm_config_user_agent: process.env.npm_config_user_agent ?? null,
      npm_execpath:
        (process.env.npm_execpath ?? "").replace(process.env.HOME, "~") || null,
      npm_lifecycle_event: process.env.npm_lifecycle_event ?? null,
      isSea: sea,
    }),
);
