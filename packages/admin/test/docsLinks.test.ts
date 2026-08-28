/**
 * The help-link resolution model: every tab resolves to a docs path, tab declarations win
 * over section fallbacks, and the registry's keys stay well-formed. (Existence of the target
 * pages is the WORKER's docsLinks gate, which checks against the built site's slug manifest —
 * here we pin the console-side contract only.)
 */

import { describe, expect, it } from "vitest";
import { docsFor, SECTIONS, TABS } from "../src/route.js";
import { DOCS_LINKS, docsUrl } from "../src/lib/docsLinks.js";

describe("docsFor", () => {
  it("resolves every tab to an absolute trailing-slash docs path", () => {
    for (const item of TABS) {
      const href = docsFor(item.tab);
      expect(href, item.tab).toMatch(/^\/docs\/([a-z0-9-]+\/)*$/);
    }
  });

  it("prefers the tab's own declaration over the section fallback", () => {
    // `licenses` declares its own page; its section fallback is the License service landing.
    expect(docsFor("licenses")).toBe("/docs/admin/licenses-and-devices/");
    const licenseSection = SECTIONS.find((s) => s.key === "license");
    expect(licenseSection?.docs).toBe("/docs/services/license/");
  });

  it("every section carries a fallback so no tab can resolve to nothing", () => {
    for (const section of SECTIONS) {
      expect(section.docs, section.key).toMatch(/^\/docs\//);
    }
  });
});

describe("DOCS_LINKS registry", () => {
  it("every entry is an absolute trailing-slash docs path", () => {
    for (const [key, href] of Object.entries(DOCS_LINKS)) {
      expect(href, key).toMatch(/^\/docs\/([a-z0-9-]+\/)*$/);
    }
  });

  it("docsUrl returns the registered path", () => {
    expect(docsUrl("mintBundle")).toBe(DOCS_LINKS.mintBundle);
  });
});
