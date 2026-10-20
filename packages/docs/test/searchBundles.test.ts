/**
 * The tier pass the build runs last (scripts/build-search-bundles.ts): one search bundle per tier
 * that holds no text above its tier, noindex on gated pages, and a sitemap of public pages only.
 * Skips when the docs have not been built.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SEARCH_BUNDLES, doorOf } from "../src/lib/doors";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** The page urls (site-relative, no /docs) a bundle holds. */
function urlsOf(dir: string): string[] {
  const frag = join(dist, dir, "fragment");
  return readdirSync(frag).map((f) => {
    const raw = readFileSync(join(frag, f));
    const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const text = buf.toString("utf8").replace(/^pagefind_dcd/, "");
    return (JSON.parse(text) as { url: string }).url;
  });
}
const tierOfUrl = (url: string) =>
  doorOf(url.replace(/^\/|\/$/g, "") || "index")?.tier ?? "admin";

describe.skipIf(!existsSync(join(dist, "docs-access.json")))(
  "the per-tier search bundles",
  () => {
    it("hold no page above their tier", () => {
      const rank = { public: 0, member: 1, admin: 2 };
      for (const [dir, tier] of SEARCH_BUNDLES) {
        const urls = urlsOf(dir);
        expect(urls.length, dir).toBeGreaterThan(0);
        for (const url of urls)
          expect(rank[tierOfUrl(url)], `${dir} ${url}`).toBeLessThanOrEqual(
            rank[tier],
          );
      }
    });

    it("give the public bundle Help and the developer door, and the admin bundle the rest", () => {
      const pub = urlsOf("pagefind");
      expect(pub.some((u) => u.startsWith("/help/"))).toBe(true);
      expect(pub.some((u) => u.startsWith("/start/"))).toBe(true);
      expect(
        urlsOf("pagefind-member").some((u) => u.startsWith("/operate/")),
      ).toBe(true);
      expect(
        urlsOf("pagefind-admin").some((u) => u.startsWith("/contribute/")),
      ).toBe(true);
    });

    it("keep gated pages out of the sitemap and mark them noindex", () => {
      const xml = readFileSync(join(dist, "sitemap-0.xml"), "utf8");
      expect(xml).toContain("/docs/help/");
      expect(xml).not.toContain("/docs/operate/");
      expect(xml).not.toContain("/docs/contribute/");
      const gated = readFileSync(
        join(dist, "contribute", "index.html"),
        "utf8",
      );
      expect(gated).toContain('content="noindex"');
      const open = readFileSync(join(dist, "help", "index.html"), "utf8");
      expect(open).not.toContain('content="noindex"');
    });
  },
);
