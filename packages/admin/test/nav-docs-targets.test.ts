/**
 * The door rule for the console's Docs buttons (docs plan §3.1): a feature section's items point
 * under `features/<feature>/`, and Core and Platform items point under `operate/`. The exceptions
 * follow their subject instead, and are listed here so a new one is a decision, not an accident.
 * Every target must also be a final path: not a page the docs site moved away from.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBAL_PAGES, SECTIONS, type NavPage } from "../src/console/nav.js";
import { DOCS_LINKS } from "../src/lib/docsLinks.js";

const here = dirname(fileURLToPath(import.meta.url));
const siteMap = JSON.parse(
  readFileSync(join(here, "..", "..", "docs", "site-map.json"), "utf8"),
) as { rows: { from: string }[] };

/** Section key -> the feature directory its pages live under. */
const FEATURE_OF: Record<string, string> = {
  license: "licensing",
  config: "managed-config",
  release: "ship-builds",
  distribution: "ship-builds",
  update: "ship-builds",
  identity: "sign-in",
  sync: "cloud-sync",
};

/** Items that follow their subject, not their section. */
const SUBJECT_EXCEPTIONS: Record<string, string> = {
  // Core -> Devices is the license list.
  devices: "/docs/features/licensing/",
  // Platform -> Package feeds is Ship builds -> Packages.
  "platform-feeds": "/docs/features/ship-builds/packages/",
  // Platform -> Override migration is Managed config.
  "platform-override-migration": "/docs/features/managed-config/",
};

const platformPages = GLOBAL_PAGES.filter((p) => p.group === "platform");

function exceptionFor(page: NavPage): string | undefined {
  return SUBJECT_EXCEPTIONS[page.page];
}

describe("console Docs targets follow the door rule", () => {
  for (const section of SECTIONS) {
    const feature = FEATURE_OF[section.key];
    if (feature === undefined) continue;
    it(`${section.key}: the section and its items point under features/${feature}/`, () => {
      const prefix = `/docs/features/${feature}/`;
      expect(section.docs, `${section.key} section`).toMatch(
        new RegExp(`^${prefix}`),
      );
      for (const item of section.items)
        expect(item.docs, `${section.key}/${item.page}`).toMatch(
          new RegExp(`^${prefix}`),
        );
    });
  }

  it("core items point under operate/, except the ones that follow their subject", () => {
    const core = SECTIONS.find((s) => s.key === "core")!;
    expect(core.docs).toBe("/docs/operate/");
    for (const item of core.items) {
      const exception = exceptionFor(item);
      if (exception !== undefined) {
        expect(item.docs.startsWith(exception), `core/${item.page}`).toBe(true);
      } else {
        expect(item.docs, `core/${item.page}`).toMatch(/^\/docs\/operate\//);
      }
    }
  });

  it("platform items point under operate/, except the ones that follow their subject", () => {
    expect(platformPages.length).toBeGreaterThan(0);
    for (const item of platformPages) {
      const exception = exceptionFor(item);
      if (exception !== undefined) {
        expect(item.docs.startsWith(exception), item.page).toBe(true);
      } else {
        expect(item.docs, item.page).toMatch(/^\/docs\/operate\//);
      }
    }
  });

  it("the exceptions name pages that exist", () => {
    const pages = new Set(
      [...SECTIONS.flatMap((s) => s.items), ...GLOBAL_PAGES].map((p) => p.page),
    );
    for (const page of Object.keys(SUBJECT_EXCEPTIONS))
      expect(pages.has(page as never), page).toBe(true);
  });
});

describe("every console Docs target is a final path", () => {
  const moved = new Set(
    siteMap.rows.map((r) =>
      `/docs/${r.from.replace(/\/index$/, "")}/`.replace(/\/\/$/, "/"),
    ),
  );
  const targets: [string, string][] = [
    ...SECTIONS.flatMap((s) => [
      [`${s.key} section`, s.docs] as [string, string],
      ...s.items.map((i) => [`${s.key}/${i.page}`, i.docs] as [string, string]),
    ]),
    ...GLOBAL_PAGES.map((p) => [p.page, p.docs] as [string, string]),
    ...Object.entries(DOCS_LINKS).map(
      ([k, v]) => [`DOCS_LINKS.${k}`, v] as [string, string],
    ),
  ];

  it("none is a page the docs site moved, merged or deleted", () => {
    const stale = targets.filter(([, href]) => moved.has(href));
    expect(
      stale.map(([who, href]) => `${who}: ${href}`),
      "these point at an old path; they work through a redirect but should name the final page",
    ).toEqual([]);
  });
});
