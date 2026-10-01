import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: unknown };

/** The npm package name. Not sent: `X-PKey-SDK` carries the short id `SdkId.node`
 *  (WIRE-CONTRACT-V3 §5.2). */
export const SDK_NAME = "@polaris-key/node";
export const SDK_VERSION =
  typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
