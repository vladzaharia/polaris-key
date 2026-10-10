/**
 * Features (docs plan section 3.2.1): the map from feature to service slugs, checked against the
 * service table, and the section a page's accent comes from.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_IDS, FEATURES } from "../src/lib/features";
import { sectionFor } from "../src/lib/section";
import { allIds } from "../scripts/site-map.mjs";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(
  readFileSync(join(docsRoot, "..", "..", "tools", "services.json"), "utf8"),
) as { services: { slug: string; label: string }[] };
const slugs = table.services.map((s) => s.slug);

describe("features", () => {
  it("covers every row of the service table exactly once", () => {
    const owned = FEATURE_IDS.flatMap((id) => FEATURES[id].services);
    expect([...owned].sort()).toEqual([...slugs].sort());
  });

  it("takes every accent from the service table", () => {
    for (const id of FEATURE_IDS) {
      const f = FEATURES[id];
      expect(slugs, `${id} accent`).toContain(f.accent);
      for (const accent of Object.values(f.areas ?? {}))
        expect(slugs, `${id} area accent`).toContain(accent);
    }
  });

  it("keys the map by id", () => {
    for (const id of FEATURE_IDS) expect(FEATURES[id].id).toBe(id);
  });

  it("every feature with a service has a docs directory with an index page", () => {
    const ids = new Set(allIds());
    for (const id of FEATURE_IDS) {
      if (FEATURES[id].services.length === 0) continue;
      expect(ids.has(`features/${id}/index`), `features/${id}/index`).toBe(
        true,
      );
    }
  });

  it("every page under features/ belongs to a known feature", () => {
    const known = new Set<string>(FEATURE_IDS);
    for (const id of allIds().filter(
      (i) => i.startsWith("features/") && i !== "features/index",
    ))
      expect(known.has(id.split("/")[1]!), id).toBe(true);
  });

  it("Commerce reserves its directory and has no page yet", () => {
    expect(allIds().some((id) => id.startsWith("features/commerce/"))).toBe(
      false,
    );
    expect(
      existsSync(join(docsRoot, "src/content/docs/features/commerce")),
    ).toBe(false);
  });
});

describe("sections", () => {
  it("a feature page takes its feature's accent", () => {
    expect(sectionFor("features/licensing/model")).toEqual({
      slug: "license",
      label: "Licensing",
    });
    expect(sectionFor("features/sign-in/index").slug).toBe("identity");
    expect(sectionFor("features/cloud-sync/index").slug).toBe("sync");
    expect(sectionFor("features/managed-config/catalog").slug).toBe("config");
  });

  it("Ship builds names one accent per sub-area", () => {
    const accent = (id: string): string => sectionFor(id).slug;
    expect(accent("features/ship-builds/ci")).toBe("release");
    expect(accent("features/ship-builds/releases/index")).toBe("release");
    expect(accent("features/ship-builds/channels/steam")).toBe("distribution");
    expect(accent("features/ship-builds/updates/sparkle")).toBe("update");
    expect(accent("features/ship-builds/packages/index")).toBe("distribution");
    expect(accent("features/ship-builds/packs/index")).toBe("release");
    expect(accent("features/ship-builds/commerce")).toBe("distribution");
    expect(sectionFor("features/ship-builds/channels/steam").label).toBe(
      "Ship builds",
    );
  });

  it("every other page is the platform", () => {
    for (const id of [
      "index",
      "operate/platform/deploy",
      "reference/error-codes",
      "features/nonesuch/x",
    ])
      expect(sectionFor(id).slug).toBe("core");
  });
});
