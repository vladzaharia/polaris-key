/**
 * The COMMITTED CSP-hash module must match the docs build it claims to describe.
 *
 * `docsCsp.generated.ts` is written by `packages/docs/scripts/collect-csp-hashes.mjs` and
 * COMMITTED (so an upgrade that adds an inline script is a reviewable diff). The risk of a
 * committed generated file is staleness: someone rebuilds the site and skips the collect step,
 * or hand-edits the module. AGENTS.md promises that a hand edit fails CI; this suite is what
 * makes that true.
 *
 * It checks two properties, and neither implies the other:
 *
 *   1. COMMITTED == WORKING TREE. The module's bytes are read back out of git and compared to
 *      the file on disk. A hand edit fails this with no docs build at all. In CI, `pnpm build`
 *      (which runs the docs build, which overwrites the module) comes before `pnpm test`, so a
 *      comparison of the file with its own generator could never fail there; comparing with
 *      git does: it fails when the build regenerates something other than what was committed,
 *      i.e. the docs changed and the regenerated CSP was not committed with them.
 *   2. WORKING TREE == THE BUILT SITE. The module's hash sets equal a fresh sweep of
 *      `packages/docs/dist`: does this CSP match this site? It needs a built `dist`.
 *
 * Each half skips cleanly when it has nothing to compare against: (1) outside a git checkout,
 * (2) when the docs dist does not exist (fresh clone, worker-only iteration). Locally, a docs
 * rebuild that changes the module fails (1) until the regenerated file is committed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script of the docs package
import { inlineScripts } from "../../docs/scripts/inline-scripts.mjs";
import {
  DOCS_SCRIPT_HASHES,
  DOCS_STYLE_ATTR_HASHES,
  DOCS_STYLE_HASHES,
} from "../src/docsCsp.generated.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "docs", "dist");
const repoRoot = join(here, "..", "..", "..");

/** Repo-relative, because that is the spelling `git show` wants. */
const GENERATED_REL = "packages/worker/src/docsCsp.generated.ts";
const generatedAbs = join(repoRoot, GENERATED_REL);

/**
 * The module's bytes as COMMITTED, or null when git cannot answer.
 *
 * Null means "not a git checkout" (a published tarball, a vendored copy) and the caller skips;
 * any other git failure is indistinguishable here, so it skips too. `-c core.quotepath=false`
 * keeps a non-ASCII path from coming back escaped.
 */
function committedGeneratedModule(): string | null {
  try {
    return execFileSync(
      "git",
      ["-c", "core.quotepath=false", "show", `HEAD:${GENERATED_REL}`],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
}

const committed = committedGeneratedModule();

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

const STYLE_RE = /<style[^>]*>(?<body>[\s\S]*?)<\/style>/gi;

const STYLE_ATTR_RE = /<[a-z][^>]*?\sstyle="(?<value>[^"]*)"/gi;
const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&#x27;": "'",
};
const decode = (v: string): string =>
  v.replace(/&(?:quot|amp|lt|gt|#39|#x27);/g, (m) => ENTITIES[m]!);

function cspHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── 1. the committed artifact is the one under test ──────────────────────────

describe.skipIf(committed === null)(
  "docsCsp.generated.ts — committed artifact freshness",
  () => {
    it("the file on disk is byte-identical to the committed one", () => {
      const onDisk = readFileSync(generatedAbs, "utf8");
      // Compared by digest first so a failure reports two 64-char strings instead of dumping
      // two copies of a hash list nobody can diff by eye; the message says what to do.
      expect(
        sha256(onDisk),
        `${GENERATED_REL} differs from the committed copy.\n` +
          "  · If you edited it by hand: don't, it is generated (AGENTS.md rule 3).\n" +
          "  · If a docs build regenerated it: commit the result in this same change.\n" +
          "  Regenerate with: pnpm --filter @polaris-key/docs build",
      ).toBe(sha256(committed ?? ""));
      // If the digests agree the contents do too; when they do not, this is the assertion
      // that shows the diff.
      expect(onDisk).toBe(committed);
    });

    it("still carries its GENERATED banner", () => {
      // The banner is what rule 3 is stated in terms of: a regenerator that stopped emitting
      // it would quietly turn this file into something a reviewer may edit.
      expect(readFileSync(generatedAbs, "utf8")).toContain(
        "GENERATED FILE — do not edit by hand.",
      );
    });
  },
);

// ── 2. that artifact describes the site that actually got built ──────────────

describe.skipIf(!existsSync(dist))(
  "docsCsp.generated.ts ↔ docs dist parity",
  () => {
    it("the committed hash sets equal a fresh sweep of the built HTML", () => {
      const scripts = new Set<string>();
      const styles = new Set<string>();
      const styleAttrs = new Set<string>();
      for (const file of htmlFiles(dist)) {
        const html = readFileSync(file, "utf8");
        // Real inline <script> elements only: `<script>` text inside an attribute value is not one.
        for (const body of inlineScripts(html)) scripts.add(cspHash(body));
        for (const match of html.matchAll(STYLE_ATTR_RE)) {
          const value = decode(match.groups?.value ?? "");
          if (value.length > 0) styleAttrs.add(cspHash(value));
        }
        for (const match of html.matchAll(STYLE_RE)) {
          const body = match.groups?.body ?? "";
          if (body.length === 0) continue;
          styles.add(cspHash(body));
        }
      }
      expect([...scripts].sort()).toEqual([...DOCS_SCRIPT_HASHES]);
      expect([...styles].sort()).toEqual([...DOCS_STYLE_HASHES]);
      expect([...styleAttrs].sort()).toEqual([...DOCS_STYLE_ATTR_HASHES]);
    });
  },
);
