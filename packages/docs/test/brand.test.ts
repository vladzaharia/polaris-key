/**
 * The docs site's brand wiring (docs/design/BRAND.md §2, §3, §5, §6).
 *
 * - every service in tools/services.json gets its accent on its docs pages (data-service);
 * - the theme takes its colours from @polaris-key/brand's tokens, never its own hex values;
 * - the header mark, favicons and social card come from the Locker kit (LK-00 §14.2).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_ALIAS } from "@polaris-key/brand";
import { FEATURES } from "../src/lib/features.generated";
import { sectionFor } from "../src/lib/section";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "..", "..");
const read = (...p: string[]): string => readFileSync(join(...p), "utf8");

const table = JSON.parse(read(repoRoot, "tools", "services.json")) as {
  services: { slug: string; label: string }[];
};

describe("docs sections", () => {
  it("every service's feature pages take that service's data-service", () => {
    for (const { slug } of table.services) {
      const feature = Object.values(FEATURES).find((f) =>
        f.services.includes(slug),
      )!;
      // The primary area of the feature (a sub-area may take another accent).
      expect(sectionFor(`features/${feature.id}/some-page`).slug).toBe(
        feature.accent,
      );
    }
  });

  it("core and every non-feature page are the platform section", () => {
    for (const id of [
      "index",
      "operate/index",
      "reference/protocol/trust",
      "reference/error-codes",
      "start/how-it-works",
      "features/not-a-feature/page",
    ]) {
      expect(sectionFor(id).slug).toBe("core");
    }
  });

  it("the stylesheet gives every feature accent a sidebar marker", () => {
    const css = read(docsRoot, "src", "styles", "global.css");
    const markers: [string, string][] = [
      ["licensing", "license"],
      ["managed-config", "config"],
      ["ship-builds/releases", "release"],
      ["ship-builds/channels", "distribution"],
      ["ship-builds/updates", "update"],
      ["sign-in", "identity"],
      ["cloud-sync", "sync"],
      // Commerce takes the Distribution green family (B1): the brand CSS has no variables of its own.
      ["commerce", "distribution"],
    ];
    for (const [dir, slug] of markers) {
      expect(css).toContain(`a[href*="/docs/features/${dir}/"]`);
      expect(css).toContain(`var(--pk-service-${slug})`);
    }
    // Every service has a marker.
    for (const { slug } of table.services)
      expect(css).toContain(
        `var(--pk-service-${SERVICE_ALIAS[slug as keyof typeof SERVICE_ALIAS] ?? slug})`,
      );
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
  it("the header mark is the Locker kit's master cut, one file per ground", () => {
    const title = read(docsRoot, "src", "components", "SiteTitle.astro");
    expect(title).toContain(
      "@polaris-key/brand/marks/locker/dark-master.svg?url",
    );
    expect(title).toContain(
      "@polaris-key/brand/marks/locker/light-master.svg?url",
    );
  });

  it("every page sits in the Locker context; core pages carry no data-service", () => {
    const frame = read(docsRoot, "src", "components", "PageFrame.astro");
    expect(frame).toContain('data-brand="locker"');
    expect(frame).toContain('section.slug === "core" ? undefined');
  });

  it("the favicons and social card copied into public/ are the Locker kit's", () => {
    const copier = read(docsRoot, "scripts", "copy-artifacts.mjs");
    for (const spec of [
      "web/locker/favicon.svg",
      "web/locker/favicon.ico",
      "web/locker/apple-touch-icon.png",
      "social/locker/social-landscape-1200.png",
    ]) {
      expect(copier).toContain(`"@polaris-key/brand/${spec}"`);
    }
    expect(copier).not.toMatch(/site\.webmanifest"/);
    const config = read(docsRoot, "astro.config.mjs");
    expect(config).toContain('title: "Polaris Locker docs"');
    expect(config).toContain('favicon: "/branding/locker/favicon.svg"');
    expect(config).not.toContain("branding/key");
  });
});
