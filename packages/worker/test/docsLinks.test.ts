/**
 * Console help links ↔ docs site — the drift gate for the in-app documentation links.
 *
 * The console declares its links in exactly three tables: `NavPage.docs` / `NavSection.docs`
 * in `packages/admin/src/console/nav.ts` (page docs — the same table the sidebar renders),
 * `DOCS_LINKS` in `packages/admin/src/lib/docsLinks.ts` (dialogs, empty states, callouts) and
 * the generated settings search index `packages/admin/src/console/settings.generated.ts`
 * (ST-06: each registry entry's `docs` page). This suite sweeps all three SOURCES for `/docs/...` paths and asserts each exists in the built
 * site's slug manifest (`packages/docs/dist/docs-slugs.json`, written by the docs build) —
 * so a help link cannot point at a page that stopped existing, and a docs restructure fails
 * CI until the console follows.
 *
 * Skips cleanly when the docs dist is absent (worker-only iteration); in CI the docs build
 * runs first, so the gate is always live there.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const adminSrc = join(here, "..", "..", "admin", "src");
const slugManifest = join(here, "..", "..", "docs", "dist", "docs-slugs.json");

const LINK_SOURCES = [
  join(adminSrc, "console", "nav.ts"),
  join(adminSrc, "lib", "docsLinks.ts"),
  // The settings search index (ST-06): every registry entry's `docs` page, generated.
  join(adminSrc, "console", "settings.generated.ts"),
];

function declaredLinks(): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const file of LINK_SOURCES) {
    const source = readFileSync(file, "utf8");
    const links = [...source.matchAll(/"(\/docs\/[^"]*)"/g)].map((m) => m[1]!);
    bySource.set(file, links);
  }
  return bySource;
}

describe.skipIf(!existsSync(slugManifest))(
  "console help links resolve in the built docs site",
  () => {
    const manifest = JSON.parse(readFileSync(slugManifest, "utf8")) as {
      routes: string[];
      pages: Record<string, { anchors?: string[] }>;
    };
    const routes = new Set<string>(manifest.routes);

    it("the slug manifest is non-trivial", () => {
      expect(routes.size).toBeGreaterThan(10);
      expect(routes.has("/docs/")).toBe(true);
    });

    for (const [file, links] of declaredLinks()) {
      it(`every /docs/ path in ${file.split("/").slice(-2).join("/")} exists`, () => {
        expect(links.length).toBeGreaterThan(0);
        const missing = links.filter(
          (link) => !routes.has(link.split("#")[0]!),
        );
        expect(
          missing,
          `help links pointing at pages that do not exist: ${missing.join(", ")}`,
        ).toEqual([]);
        // A #fragment must name a heading on the page it points at.
        const unanchored = links.filter((link) => {
          const [route, fragment] = link.split("#");
          return (
            fragment && !manifest.pages[route!]?.anchors?.includes(fragment)
          );
        });
        expect(
          unanchored,
          `help links naming a heading that does not exist: ${unanchored.join(", ")}`,
        ).toEqual([]);
      });
    }
  },
);

describe("help-link declarations are well-formed", () => {
  for (const [file, links] of declaredLinks()) {
    it(`${file.split("/").slice(-2).join("/")} uses absolute trailing-slash paths`, () => {
      for (const link of links) {
        expect(link, link).toMatch(/^\/docs\/([a-z0-9-]+\/)*(#[a-z0-9-]+)?$/);
      }
    });
  }
});
