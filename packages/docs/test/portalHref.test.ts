/**
 * Links into the customer portal (docs plan section 8.3). The portal is one page at the site root
 * that routes by hash (`#/` is the Library), and the Worker serves its shell for `/`,
 * `/index.html`, `/activate` and `/assets/` only (packages/worker/src/router.ts), so a path such
 * as `/library` is a 404. `<PortalLink to>` maps the page it names to the root or to a hash route,
 * and no built page links into the portal anywhere else. The built-page check runs when the docs
 * have been built, as slugManifest.test.ts does.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portalHref } from "../src/lib/portalHref";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(docsRoot, "dist");

describe("portalHref", () => {
  it("is the portal root for the Library", () => {
    for (const to of ["library", "/library", "//library", "/", ""])
      expect(portalHref(to), JSON.stringify(to)).toBe("/");
  });

  it("is a hash route for any other page", () => {
    expect(portalHref("account")).toBe("/#/account");
    expect(portalHref("/account/methods")).toBe("/#/account/methods");
    expect(portalHref("discover")).toBe("/#/discover");
    expect(portalHref("p/fern/devices")).toBe("/#/p/fern/devices");
    expect(portalHref("#/account")).toBe("/#/account");
  });

  it("never is a path of its own, which the Worker would not serve", () => {
    for (const to of ["library", "account", "discover", "p/fern", "/x", ""]) {
      const href = portalHref(to);
      expect(href === "/" || href.startsWith("/#/"), to).toBe(true);
    }
  });

  it("is what the PortalLink component links to", () => {
    const source = readFileSync(
      join(docsRoot, "src", "components", "docs", "PortalLink.astro"),
      "utf8",
    );
    expect(source).toContain("href={portalHref(to)}");
    expect(source).toContain('target="_blank" rel="noopener"');
  });
});

describe.skipIf(
  !existsSync(join(dist, "contribute", "docs-components", "index.html")),
)("the built pages", () => {
  it("link into the portal at its root or a hash route, never at a path the Worker does not serve", () => {
    const found: string[] = [];
    for (const file of readdirSync(dist, { recursive: true, encoding: "utf8" }))
      if (file.endsWith(".html"))
        for (const m of readFileSync(join(dist, file), "utf8").matchAll(
          /<a class="pk-portal-link" href="([^"]*)"/g,
        ))
          found.push(`${file}: ${m[1]}`);
    // The contributor page's demo and every library link of a message.
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.filter((link) => !/: (?:\/|\/#\/.*)$/.test(link)),
      "a link into the portal at a path the Worker does not serve",
    ).toEqual([]);
  });
});
