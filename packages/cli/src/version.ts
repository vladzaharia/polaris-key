/**
 * The CLI's version, for `pkey help`'s header. The Action bundle has no `package.json` beside it,
 * so `scripts/bundle-action.mjs` defines `__PKEY_CLI_VERSION__` from this package's version; the
 * npm-installed CLI and the tests read `package.json`, one directory above `dist/` or `src/`.
 */

import { readFileSync } from "node:fs";

declare const __PKEY_CLI_VERSION__: string | undefined;

function read(): string {
  if (typeof __PKEY_CLI_VERSION__ !== "undefined") return __PKEY_CLI_VERSION__;
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION: string = read();
