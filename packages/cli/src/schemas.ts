/**
 * `pkey manifest schemas --out <dir>` (P2-06, handed over by P0-07): write the published `.pkey/`
 * JSON Schemas (`@polaris-key/manifest`'s `schemas/v1/*.schema.json`) into a directory, so an
 * editor in a repository with no `node_modules` — a Godot project — can point its
 * `yaml-language-server: $schema=` header at a vendored copy.
 *
 * Two sources, one answer: the standalone bundle (`actions/publish/dist/index.js`, attached to
 * GitHub releases as `pkey.mjs`) carries the schemas inlined at bundle time as
 * `__PKEY_EMBEDDED_SCHEMAS__`; the npm-installed CLI reads them from the installed
 * `@polaris-key/manifest` package.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

declare const __PKEY_EMBEDDED_SCHEMAS__: Record<string, string> | undefined;

/** `{ "<name>.schema.json": "<file contents>" }`, sorted by name. */
export async function manifestSchemas(): Promise<Record<string, string>> {
  if (typeof __PKEY_EMBEDDED_SCHEMAS__ !== "undefined")
    return __PKEY_EMBEDDED_SCHEMAS__;
  const entry = createRequire(import.meta.url).resolve("@polaris-key/manifest");
  const dir = path.join(path.dirname(entry), "..", "schemas", "v1");
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".schema.json"))
    .sort();
  const out: Record<string, string> = {};
  for (const name of names)
    out[name] = await readFile(path.join(dir, name), "utf8");
  return out;
}

/** Write every schema into `outDir` (created if needed); the written paths. */
export async function writeManifestSchemas(outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, body] of Object.entries(await manifestSchemas())) {
    const file = path.join(outDir, name);
    await writeFile(file, body, "utf8");
    written.push(file);
  }
  return written;
}
