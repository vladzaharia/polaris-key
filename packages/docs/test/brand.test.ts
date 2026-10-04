/**
 * The docs site's brand wiring (docs/design/BRAND.md §2, §3, §5, §6).
 *
 * - every service in tools/services.json gets its accent on its docs pages (data-service);
 * - the theme takes its colours from @polaris-key/brand's tokens, never its own hex values;
 * - the header mark and favicons come from the launch kit, and none of them carries the
 *   terminal bit (the default Polaris Key mark has none).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sectionFor } from "../src/lib/section";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "..", "..");
const read = (...p: string[]): string => readFileSync(join(...p), "utf8");

const table = JSON.parse(read(repoRoot, "tools", "services.json")) as {
  services: { slug: string; label: string }[];
};

describe("docs sections", () => {
  it("every service's pages take that service's data-service", () => {
    for (const { slug, label } of table.services) {
      expect(sectionFor(`services/${slug}`)).toEqual({ slug, label });
      expect(sectionFor(`services/${slug}/some-page`)).toEqual({ slug, label });
    }
  });

  it("core and every non-service page are the platform section", () => {
    for (const id of [
      "index",
      "services/core",
      "services/core/trust",
      "reference/error-codes",
      "start/service-model",
      "services/not-a-service/page",
    ]) {
      expect(sectionFor(id).slug).toBe("core");
    }
  });

  it("the stylesheet gives every service a sidebar marker", () => {
    const css = read(docsRoot, "src", "styles", "global.css");
    for (const { slug } of [{ slug: "core" }, ...table.services]) {
      expect(css).toContain(`a[href*="/docs/services/${slug}/"]`);
      expect(css).toContain(`var(--pk-service-${slug})`);
    }
  });
});

describe("docs theme", () => {
  it("global.css uses tokens only: no hex colour of its own", () => {
    const css = read(docsRoot, "src", "styles", "global.css");
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it("astro.config.mjs loads the brand tokens and fonts before the docs theme", () => {
    const config = read(docsRoot, "astro.config.mjs");
    const tokens = config.indexOf('"@polaris-key/brand/tokens.css"');
    const fonts = config.indexOf('"@polaris-key/brand/fonts.css"');
    const theme = config.indexOf('"./src/styles/global.css"');
    expect(tokens).toBeGreaterThan(-1);
    expect(fonts).toBeGreaterThan(tokens);
    expect(theme).toBeGreaterThan(fonts);
  });

  it("the pre-brand favicon is gone", () => {
    expect(existsSync(join(docsRoot, "public", "favicon.svg"))).toBe(false);
  });
});

describe("docs marks", () => {
  const brandKit = join(repoRoot, "packages", "brand", "kit");

  it("the header mark is the kit's bit-less service cut, one file per ground", () => {
    const title = read(docsRoot, "src", "components", "SiteTitle.astro");
    expect(title).toContain(
      "@polaris-key/brand/marks/key/svg/key-service-dark.svg?url",
    );
    expect(title).toContain(
      "@polaris-key/brand/marks/key/svg/key-service-light.svg?url",
    );
    expect(title).not.toMatch(/-signed-/);
  });

  it("the favicons and hero marks copied into public/ carry no terminal bit", () => {
    const copier = read(docsRoot, "scripts", "copy-artifacts.mjs");
    for (const spec of [
      "web/key/favicon.svg",
      "web/key/favicon.ico",
      "web/key/app-icon-dark-180.png",
      "marks/key/svg/key-display-dark.svg",
      "marks/key/svg/key-display-light.svg",
    ]) {
      expect(copier).toContain(`"@polaris-key/brand/${spec}"`);
    }
    expect(copier).not.toMatch(/-signed-|site\.webmanifest"/);
    // The unsigned display masters are three paths: the K's stem, its arm and the star.
    for (const ground of ["dark", "light"]) {
      const svg = read(
        brandKit,
        "01-marks",
        "key",
        "svg",
        `key-display-${ground}.svg`,
      );
      expect(svg.match(/<path\b/g)).toHaveLength(3);
    }
  });
});
