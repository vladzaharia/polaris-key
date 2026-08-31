/**
 * The COMMITTED CSP-hash module must match the docs build it claims to describe.
 *
 * `docsCsp.generated.ts` is written by `packages/docs/scripts/collect-csp-hashes.mjs` and
 * COMMITTED (so an upgrade that adds an inline script is a reviewable diff). The risk of a
 * committed generated file is staleness — someone rebuilds the site and skips the collect step,
 * or hand-edits the module — and AGENTS.md rule 3 promises that "a hand edit fails CI rather
 * than shipping". This suite is what has to make that true.
 *
 * ── WHY THIS FILE WAS RESTRUCTURED (A7-06 / B6-08) ──────────────────────────────────────────
 *
 * It used to assert ONE property: that the hashes exported by the module equal a fresh sweep of
 * `packages/docs/dist`. In CI that assertion is unfalsifiable. `.github/workflows/ci.yml` runs
 * `pnpm build` — which builds the docs site, which runs `collect-csp-hashes.mjs`, which
 * OVERWRITES `docsCsp.generated.ts` — and only then runs `pnpm test`. So the test compared a
 * file generated ninety seconds earlier against the build that generated it. Both sides of the
 * comparison came from the same run; it could not fail.
 *
 * That is worse than having no gate, because the gate is trusted. Concretely, the thing it was
 * supposed to catch sails straight through: hand-widen the hash list, push, and CI regenerates
 * the file in the runner's working tree, the test passes, the PR merges — and the WRONG bytes
 * are still what is committed, which is what a reviewer reads and what anyone who builds the
 * worker without running the docs generators ships.
 *
 * So the property is split in two, and the first half is the new one:
 *
 *   1. COMMITTED == WORKING TREE. Read the module's bytes back out of git and compare them to
 *      the file on disk. A hand edit fails this immediately, with no docs build needed at all.
 *      In CI it fails when `pnpm build` regenerates the module into something other than what
 *      was committed — which is precisely "you changed the docs and did not commit the
 *      regenerated CSP".
 *   2. WORKING TREE == THE BUILT SITE. The original assertion, unchanged. It answers a
 *      different question ("does this CSP actually match this site?") and needs a `dist`.
 *
 * Neither implies the other, and only both together mean "the committed CSP matches the site".
 */

import { execFileSync } from "node:child_process";
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
const repoRoot = join(here, "..", "..", "..");
const dist = join(here, "..", "..", "docs", "dist");

/** Repo-relative, because that is the spelling `git show` wants. */
const GENERATED_REL = "packages/worker/src/docsCsp.generated.ts";
const generatedAbs = join(repoRoot, GENERATED_REL);

/**
 * The module's bytes as COMMITTED, or null when git cannot answer.
 *
 * Null means "not a git checkout" (a published tarball, a vendored copy) and only that — an
 * unknown path or a corrupt object would throw out of `execFileSync` just the same, so the
 * caller treats a null as a skip and everything else as a failure it should not paper over.
 * `-c core.quotepath=false` keeps a non-ASCII path from coming back escaped.
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

const SCRIPT_RE = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style[^>]*>(?<body>[\s\S]*?)<\/style>/gi;

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
          "  · If you edited it by hand: don't — it is generated (AGENTS.md rule 3).\n" +
          "  · If a docs build regenerated it: commit the result in this same change.\n" +
          `  Regenerate with: pnpm --filter @polaris-key/docs build`,
      ).toBe(sha256(committed as string));
      // Belt and braces: if the digests somehow agree the contents must too, and this is the
      // assertion that actually shows the diff when they don't.
      expect(onDisk).toBe(committed);
    });

    it("still carries its GENERATED banner", () => {
      // Cheap, but it is the banner rule 3 is stated in terms of. A regenerator that stopped
      // emitting it would quietly turn this file into something a reviewer may edit.
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
