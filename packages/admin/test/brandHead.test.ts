import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Both SPAs carry the Polaris Key web identity (BRAND.md §7.1: the console and the portal are
 * Pinned K surfaces), from @polaris-key/brand/web/key. vite.config.ts emits the files under
 * /assets/branding/key/ (the only static prefix the Worker routes to the assets binding besides
 * /manage); this pins the head links, the emitted list and the brand files to one another, so a
 * link can never point at a file the build does not ship.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const brandWebKey = join(pkg, "..", "brand", "kit", "04-web", "key");
const PREFIX = "/assets/branding/key/";

const viteConfig = readFileSync(join(pkg, "vite.config.ts"), "utf8");
const emitted = Array.from(
  (
    viteConfig.match(/BRAND_WEB_FILES[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
  ).matchAll(/"([^"]+)"/g),
  (m) => m[1]!,
);

function headLinks(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((h) => h.startsWith(PREFIX))
    .map((h) => h.slice(PREFIX.length));
}

describe("the brand head snippet", () => {
  it("vite.config.ts emits only files that exist in @polaris-key/brand/web/key", () => {
    expect(emitted.length).toBeGreaterThan(0);
    for (const name of emitted)
      expect(existsSync(join(brandWebKey, name)), name).toBe(true);
  });

  it("the manifest's icons are emitted next to it", () => {
    const manifest = JSON.parse(
      readFileSync(join(brandWebKey, "site.webmanifest"), "utf8"),
    ) as { icons: { src: string }[] };
    for (const icon of manifest.icons) expect(emitted).toContain(icon.src);
  });

  it.each(["index.html", "manage.html"])(
    "%s links the favicon, touch icon and manifest, all emitted",
    (file) => {
      const html = readFileSync(join(pkg, file), "utf8");
      const links = headLinks(html);
      expect(links).toEqual(
        expect.arrayContaining([
          "favicon.svg",
          "favicon.ico",
          "app-icon-dark-180.png",
          "site.webmanifest",
        ]),
      );
      for (const name of links) expect(emitted).toContain(name);
      expect(html).toContain('<meta name="theme-color" content="#060912" />');
    },
  );

  it("loads no font but the brand's self-hosted Rubik", () => {
    const styles = readFileSync(join(pkg, "src", "styles.css"), "utf8");
    expect(styles).toContain('@import "@polaris-key/brand/fonts.css";');
    for (const file of ["index.html", "manage.html", "src/styles.css"]) {
      const text = readFileSync(join(pkg, file), "utf8");
      expect(text, file).not.toMatch(
        /fonts\.googleapis|fonts\.gstatic|@font-face/,
      );
    }
  });
});
