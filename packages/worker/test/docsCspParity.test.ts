/**
 * The committed CSP-hash module must match the docs build it claims to describe.
 *
 * `docsCsp.generated.ts` is written by `packages/docs/scripts/collect-csp-hashes.mjs` and
 * COMMITTED (so an upgrade that adds an inline script is a reviewable diff). The risk of a
 * committed generated file is staleness — someone rebuilds the site and skips the collect
 * step. This suite recomputes the hashes straight from `packages/docs/dist` and compares:
 * in CI the docs build runs before the worker tests, so a stale module fails here instead of
 * shipping a CSP that blocks (or over-allows) the live site.
 *
 * Skips cleanly when the docs dist does not exist (fresh clone, worker-only iteration) —
 * the gate is meaningful exactly when there is a build to compare against.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCS_SCRIPT_HASHES,
  DOCS_STYLE_HASHES,
} from "../src/docsCsp.generated.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "docs", "dist");

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

const SCRIPT_RE = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style[^>]*>(?<body>[\s\S]*?)<\/style>/gi;

function cspHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

describe.skipIf(!existsSync(dist))(
  "docsCsp.generated.ts ↔ docs dist parity",
  () => {
    it("the committed hash sets equal a fresh sweep of the built HTML", () => {
      const scripts = new Set<string>();
      const styles = new Set<string>();
      for (const file of htmlFiles(dist)) {
        const html = readFileSync(file, "utf8");
        for (const match of html.matchAll(SCRIPT_RE)) {
          const attrs = match.groups?.attrs ?? "";
          const body = match.groups?.body ?? "";
          if (/\ssrc\s*=/i.test(attrs) || body.length === 0) continue;
          scripts.add(cspHash(body));
        }
        for (const match of html.matchAll(STYLE_RE)) {
          const body = match.groups?.body ?? "";
          if (body.length === 0) continue;
          styles.add(cspHash(body));
        }
      }
      expect([...scripts].sort()).toEqual([...DOCS_SCRIPT_HASHES]);
      expect([...styles].sort()).toEqual([...DOCS_STYLE_HASHES]);
    });
  },
);
