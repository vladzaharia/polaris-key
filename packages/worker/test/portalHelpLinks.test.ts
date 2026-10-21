/**
 * Portal help links ↔ docs site (DOC-06a): the drift gate for `packages/admin/src/portal/helpLinks.ts`,
 * the way `docsLinks.test.ts` gates the console's tables. Every `/docs/...` path the table
 * declares must be a route of the built site (`packages/docs/dist/docs-slugs.json`) and every
 * `#anchor` a heading on that page (message ids are anchors, dots included). Each must also be a
 * public Help page: the portal puts these in front of people with no console session.
 *
 * Skips the slug checks when the docs dist is absent; CI builds the docs first.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const table = join(here, "..", "..", "admin", "src", "portal", "helpLinks.ts");
const slugManifest = join(here, "..", "..", "docs", "dist", "docs-slugs.json");

const links = [
  ...readFileSync(table, "utf8").matchAll(/"(\/docs\/[^"]*)"/g),
].map((m) => m[1]!);

describe("portal help links are well-formed", () => {
  it("declares links", () => {
    expect(links.length).toBeGreaterThan(10);
  });
  it("are absolute, trailing-slash paths into the Help door", () => {
    for (const link of links)
      expect(link, link).toMatch(
        /^\/docs\/help\/([a-z0-9-]+\/)*(#[a-z0-9._-]+)?$/,
      );
  });
});

describe.skipIf(!existsSync(slugManifest))(
  "portal help links resolve in the built docs site",
  () => {
    const manifest = JSON.parse(readFileSync(slugManifest, "utf8")) as {
      routes: string[];
      pages: Record<string, { anchors?: string[] }>;
    };
    const routes = new Set(manifest.routes);

    it("every path exists", () => {
      const missing = links.filter((l) => !routes.has(l.split("#")[0]!));
      expect(missing, `no such page: ${missing.join(", ")}`).toEqual([]);
    });

    it("every #anchor names a heading on its page", () => {
      const unanchored = links.filter((l) => {
        const [route, fragment] = l.split("#");
        return fragment && !manifest.pages[route!]?.anchors?.includes(fragment);
      });
      expect(unanchored, `no such heading: ${unanchored.join(", ")}`).toEqual(
        [],
      );
    });
  },
);
