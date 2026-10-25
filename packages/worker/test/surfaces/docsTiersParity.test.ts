/**
 * `docsTiers.generated.ts` is the docs build's per-file tier table (DOC-03b): the files only gated
 * pages load, and each moved-page redirect page at its target's tier. It must equal a fresh sweep
 * of the built site (skipped when there is no `packages/docs/dist`), so a page that starts or
 * stops loading a file cannot leave the Worker serving it at the wrong tier.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docsTierOf, stripAstroHash } from "../../src/docs.js";
import {
  DOCS_ASSET_TIERS,
  DOCS_REDIRECT_TIERS,
} from "../../src/docsTiers.generated.js";
import {
  collectDocsTiers,
  stripAstroHash as stripGen,
} from "../../../docs/scripts/collect-docs-tiers.js";
import { TEST_ROOT } from "../paths.js";

const dist = join(TEST_ROOT, "..", "..", "docs", "dist");

describe.skipIf(!existsSync(dist))("docsTiers.generated.ts", () => {
  it("matches the built site", () => {
    const fresh = collectDocsTiers(dist);
    expect(DOCS_ASSET_TIERS).toEqual(fresh.assets);
    expect(DOCS_REDIRECT_TIERS).toEqual(fresh.redirects);
  });

  it("puts the old Help pages in the public tier", () => {
    expect(DOCS_REDIRECT_TIERS["/docs/users/activation/index.html"]).toBe(
      "public",
    );
  });
});

describe("stripAstroHash", () => {
  const cases: [string, string][] = [
    ["/docs/_astro/a.B_dIUb7l.png", "/docs/_astro/a.png"],
    [
      "/docs/_astro/activate-enter-mobile-dark.CjfL-hzx.png",
      "/docs/_astro/activate-enter-mobile-dark.png",
    ],
    ["/docs/_astro/a.b.c.12345678.css", "/docs/_astro/a.b.c.css"],
    ["/docs/_astro/plain.png", "/docs/_astro/plain.png"],
    ["/docs/_astro/a.short.png", "/docs/_astro/a.short.png"],
    ["/docs/_astro/a.toolonghash.png", "/docs/_astro/a.toolonghash.png"],
    ["/docs/_astro/.12345678.png", "/docs/_astro/.12345678.png"],
    ["/docs/_astro/sub/a.12345678.png", "/docs/_astro/sub/a.12345678.png"],
    ["/docs/other/a.12345678.png", "/docs/other/a.12345678.png"],
    ["/docs/_astro/a.%2e%2e%2e%2e.png", "/docs/_astro/a.%2e%2e%2e%2e.png"],
  ];
  it.each(cases)("%s", (input, want) => {
    expect(stripAstroHash(input)).toBe(want);
    expect(stripGen(input.replace("/docs/_astro/", ""))).toBe(
      want.replace("/docs/_astro/", ""),
    );
  });

  it.skipIf(!existsSync(dist))(
    "agrees with the generator on every built file",
    () => {
      for (const name of readdirSync(join(dist, "_astro")))
        expect(stripAstroHash(`/docs/_astro/${name}`)).toBe(
          `/docs/_astro/${stripGen(name)}`,
        );
    },
  );
});

describe("docsTierOf with hashed asset names", () => {
  const entries = Object.entries(DOCS_ASSET_TIERS);
  const hashes = ["AAAAAAAA", "zz-_zz09", "B_dIUb7l"];

  it("keeps a gated asset at its tier under any hash", () => {
    for (const [key, tier] of entries) {
      const dot = key.lastIndexOf(".");
      for (const h of hashes)
        expect(
          docsTierOf(`${key.slice(0, dot)}.${h}${key.slice(dot)}`),
          key,
        ).toBe(tier);
      expect(docsTierOf(key), key).toBe(tier);
    }
  });

  it("serves an admin asset as admin whatever the hash", () => {
    const admin = entries.find(([, t]) => t === "admin");
    if (!admin) return;
    const [key] = admin;
    const dot = key.lastIndexOf(".");
    for (const h of hashes)
      expect(docsTierOf(`${key.slice(0, dot)}.${h}${key.slice(dot)}`)).toBe(
        "admin",
      );
  });

  it("leaves an unknown asset at its default (public under _astro, admin elsewhere)", () => {
    expect(docsTierOf("/docs/_astro/never-listed.12345678.png")).toBe("public");
    expect(docsTierOf("/docs/never-listed.12345678.png")).toBe("admin");
    expect(docsTierOf(null)).toBe("admin");
  });

  it("gives a crafted path the default, never a tier it does not own", () => {
    const [key] = entries[0] ?? ["/docs/_astro/x.png"];
    const dot = key.lastIndexOf(".");
    const stem = key.slice(0, dot);
    const ext = key.slice(dot);
    const name = stem.slice("/docs/_astro/".length);
    // None of these is `<stable name>.<8 base64url>.<ext>` directly under /docs/_astro/, so none
    // resolves to the gated row: each keeps the unknown-asset default (public under _astro).
    for (const p of [
      `${stem}.${"A".repeat(9)}${ext}`,
      `${stem}.${"A".repeat(7)}${ext}`,
      `${stem}..AAAAAAAA${ext}`,
      `${stem}.%41AAAAAAA${ext}`,
      `${stem}.AAAA%2eAAA${ext}`,
      `${stem}.AAAAAAAA${ext}.map`,
      `/docs/_astro/x/${name}.AAAAAAAA${ext}`,
      `/docs/_astro/../${name}.AAAAAAAA${ext}`,
    ])
      expect(docsTierOf(p), p).toBe("public");
    // Outside /docs/_astro/ the hash is never stripped: the admin default holds.
    expect(docsTierOf(`/docs/zzz/${name}.AAAAAAAA${ext}`)).toBe("admin");
  });
});
