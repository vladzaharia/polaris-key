/**
 * HA-04: asset refs in `.pkey/product` `presentation` and the `.pkey/distribution` listing.
 *
 * The grammar (`src/assets.ts`), the normalised `kind`, the deprecated `iconUrl`/`headerUrl`
 * aliases, the JSON Schemas' copies of the patterns, and DJDL's real distribution document.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import {
  ASSET_REPO_PATH_PATTERN,
  ASSET_SHA256_PATTERN,
  ASSET_URL_PATTERN,
  HEX_COLOUR_PATTERN,
  MAX_ASSET_REPO_PATH,
  MAX_ASSET_URL,
  MAX_LISTING_SCREENSHOTS,
  assetRefProblem,
  assetRefUrl,
  listingImageUrl,
  listingScreenshotUrls,
  normalizeAssetRef,
  outletListing,
  parseManifest,
  validateManifestDocuments,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas", "v1");
const repoRoot = join(here, "..", "..", "..");
const readSchema = (name: string) =>
  JSON.parse(readFileSync(join(schemasDir, name), "utf8"));

const SHA = "0123456789abcdef".repeat(4);

describe("the asset-ref grammar", () => {
  const valid: unknown[] = [
    "https://cdn.example/icon.png",
    "https://raw.githubusercontent.com/o/r/3bb6/listing/icon.png?raw=1",
    "icon.png",
    "./icon.png",
    "art/icon.jpg",
    "art/icon.jpeg",
    "art/hero.webp",
    "art/anim.gif",
    "art/photo.avif",
    ".pkey/art/icon.png",
    "a..b/c~d@e+f-g_h.png",
    "a".repeat(MAX_ASSET_REPO_PATH - 4) + ".png",
    { src: "art/icon.png" },
    { src: "https://cdn.example/i.png", sha256: SHA },
  ];
  const invalid: unknown[] = [
    "",
    "http://cdn.example/icon.png",
    "ftp://cdn.example/icon.png",
    "https://",
    "/abs/icon.png",
    "../icon.png",
    "art/../icon.png",
    "art/./icon.png",
    "./../icon.png",
    "art//icon.png",
    "art\\icon.png",
    "C:/art/icon.png",
    "art/icon.svg",
    "art/icon.PNG",
    "art/icon",
    "art/my icon.png",
    "art/icon.png/",
    "a".repeat(MAX_ASSET_REPO_PATH - 3) + ".png",
    "https://cdn.example/" + "a".repeat(MAX_ASSET_URL),
    7,
    null,
    ["icon.png"],
    {},
    { src: "icon.png", sha256: SHA.toUpperCase() },
    { src: "icon.png", sha256: "abc" },
    { src: "icon.png", extra: true },
    { src: "../icon.png" },
  ];

  it.each(valid.map((v) => [JSON.stringify(v).slice(0, 80), v]))(
    "accepts %s",
    (_, v) => {
      expect(assetRefProblem(v)).toBeNull();
    },
  );

  it.each(invalid.map((v) => [JSON.stringify(v)?.slice(0, 80), v]))(
    "refuses %s",
    (_, v) => {
      expect(assetRefProblem(v)).not.toBeNull();
    },
  );

  it("the JSON Schemas spell the same patterns and bounds as the validator", () => {
    for (const name of ["product.schema.json", "distribution.schema.json"]) {
      const s = readSchema(name);
      const [url, repo] = s.$defs.assetSrc.anyOf;
      expect(url.pattern, name).toBe(ASSET_URL_PATTERN);
      expect(url.maxLength, name).toBe(MAX_ASSET_URL);
      expect(repo.pattern, name).toBe(ASSET_REPO_PATH_PATTERN);
      expect(repo.maxLength, name).toBe(MAX_ASSET_REPO_PATH);
      expect(s.$defs.assetRef.anyOf[1].properties.sha256.pattern, name).toBe(
        ASSET_SHA256_PATTERN,
      );
    }
    expect(readSchema("product.schema.json").$defs.hexColour.pattern).toBe(
      HEX_COLOUR_PATTERN,
    );
    expect(
      readSchema("distribution.schema.json").$defs.listing.properties
        .screenshots.maxItems,
    ).toBe(MAX_LISTING_SCREENSHOTS);
  });

  it("the schema agrees with the validator on every case above", () => {
    const ajv = new Ajv2020({ strict: false });
    const schema = readSchema("product.schema.json");
    const check = ajv.compile({
      $defs: schema.$defs,
      $ref: "#/$defs/assetRef",
    });
    for (const v of valid) expect(check(v), JSON.stringify(v)).toBe(true);
    for (const v of invalid) expect(check(v), JSON.stringify(v)).toBe(false);
  });
});

describe("normalised refs carry their kind", () => {
  it("url and repo, with the leading ./ dropped and the hash kept", () => {
    expect(normalizeAssetRef("https://cdn.example/i.png")).toEqual({
      kind: "url",
      src: "https://cdn.example/i.png",
    });
    expect(normalizeAssetRef({ src: "./art/i.png", sha256: SHA })).toEqual({
      kind: "repo",
      src: "art/i.png",
      sha256: SHA,
    });
    expect(normalizeAssetRef(".pkey/art/i.png")).toEqual({
      kind: "repo",
      src: ".pkey/art/i.png",
    });
    expect(normalizeAssetRef("../i.png")).toBeNull();
  });

  it("only a url ref has a URL; a pre-HA-04 string still reads", () => {
    expect(assetRefUrl({ kind: "url", src: "https://a.example/i.png" })).toBe(
      "https://a.example/i.png",
    );
    expect(assetRefUrl({ kind: "repo", src: "art/i.png" })).toBeUndefined();
    expect(assetRefUrl("https://a.example/i.png")).toBe(
      "https://a.example/i.png",
    );
    expect(assetRefUrl("art/i.png")).toBeUndefined();
  });

  it("listingImageUrl and listingScreenshotUrls read both stored shapes", () => {
    const stored = {
      iconUrl: "https://old.example/i.png",
      headerUrl: "https://old.example/h.png",
      screenshots: ["https://old.example/1.png"],
    };
    expect(listingImageUrl(stored, "icon")).toBe("https://old.example/i.png");
    expect(listingImageUrl(stored, "header")).toBe("https://old.example/h.png");
    expect(listingScreenshotUrls(stored)).toEqual([
      "https://old.example/1.png",
    ]);
    const current = {
      icon: { kind: "repo", src: "art/i.png" },
      header: { kind: "url", src: "https://new.example/h.png" },
      screenshots: [
        { kind: "repo", src: "art/1.png" },
        { kind: "url", src: "https://new.example/2.png" },
      ],
    };
    expect(listingImageUrl(current, "icon")).toBeUndefined();
    expect(listingImageUrl(current, "header")).toBe(
      "https://new.example/h.png",
    );
    expect(listingScreenshotUrls(current)).toEqual([
      "https://new.example/2.png",
    ]);
    expect(listingImageUrl(null, "icon")).toBeUndefined();
    expect(listingScreenshotUrls(undefined)).toEqual([]);
  });
});

const SCHEMA = { schemaVersion: 1, entries: [] };
const RELEASE = {
  release: {
    provider: { type: "github", owner: "acme", repo: "desktop" },
    binaryName: "acme",
  },
};

const product = (extra: Record<string, unknown> = {}) => ({
  product: { slug: "acme", name: "Acme" },
  modules: {
    release: { enabled: true },
    distribution: { enabled: true },
  },
  ...extra,
});

function parse(
  productDoc: Record<string, unknown>,
  distribution?: Record<string, unknown>,
) {
  const files: Record<string, string> = {
    product: JSON.stringify(productDoc),
    schema: JSON.stringify(SCHEMA),
    release: JSON.stringify(RELEASE),
  };
  if (distribution) files.distribution = JSON.stringify(distribution);
  const res = parseManifest(files);
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest;
}

describe("presentation", () => {
  it("is parsed with the icon's kind, and only the declared members", () => {
    const m = parse(
      product({
        presentation: {
          icon: "./.pkey/art/icon.png",
          accent: "#2ED6E6",
        },
      }),
    );
    expect(m.presentation).toEqual({
      icon: { kind: "repo", src: ".pkey/art/icon.png" },
      accent: "#2ED6E6",
    });
  });

  it("is absent from the parsed manifest when undeclared", () => {
    expect("presentation" in parse(product())).toBe(false);
  });

  it("errors point at the member", () => {
    const res = validateManifestDocuments({
      schema: SCHEMA,
      release: RELEASE,
      product: product({
        presentation: { icon: "/icon.png", accentDark: "blue" },
      }),
    });
    expect(res.errors.map((e) => [e.path, e.code])).toEqual([
      ["/presentation/icon", "invalid_asset_ref"],
      ["/presentation/accentDark", "invalid_presentation"],
    ]);
  });
});

describe("listing art", () => {
  it("normalises icon, header and screenshots with their kinds", () => {
    const m = parse(product(), {
      listing: {
        icon: "art/icon.png",
        header: { src: "https://cdn.example/h.png", sha256: SHA },
        screenshots: ["https://cdn.example/1.png", "./art/2.webp"],
      },
    });
    expect(m.distribution?.listing).toEqual({
      icon: { kind: "repo", src: "art/icon.png" },
      header: { kind: "url", src: "https://cdn.example/h.png", sha256: SHA },
      screenshots: [
        { kind: "url", src: "https://cdn.example/1.png" },
        { kind: "repo", src: "art/2.webp" },
      ],
    });
  });

  it("the deprecated aliases normalise into icon and header, and an outlet override merges over them", () => {
    const m = parse(product(), {
      outlets: { direct: {}, altstore: { listing: { icon: "art/alt.png" } } },
      listing: {
        iconUrl: "https://cdn.example/i.png",
        headerUrl: "https://cdn.example/h.png",
      },
    });
    expect(m.distribution?.listing).toEqual({
      icon: { kind: "url", src: "https://cdn.example/i.png" },
      header: { kind: "url", src: "https://cdn.example/h.png" },
    });
    expect(outletListing(m.distribution!, "altstore")).toEqual({
      icon: { kind: "repo", src: "art/alt.png" },
      header: { kind: "url", src: "https://cdn.example/h.png" },
    });
  });

  it("an alias warns at its own path and is not an error", () => {
    const res = validateManifestDocuments({
      product: product(),
      schema: SCHEMA,
      release: RELEASE,
      distribution: {
        listing: { headerUrl: "https://cdn.example/h.png" },
        outlets: {
          direct: { listing: { iconUrl: "https://cdn.example/i.png" } },
        },
      },
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings.map((w) => [w.path, w.code])).toEqual([
      ["/outlets/direct/listing/iconUrl", "listing_url_field_deprecated"],
      ["/listing/headerUrl", "listing_url_field_deprecated"],
    ]);
  });
});

/** The deprecated spellings `products/djdl/product.json` uses (rows 1–6 and 11), in table order. */
const DJDL_PRODUCT_SPELLINGS = [
  "/slug",
  "/name",
  "/adminGroup",
  "/compatMin",
  "/compatMax",
  "/defaultDeviceLimit",
  "/defaultMaxOfflineDays",
  "/tiers",
  "/release",
];

describe("DJDL's distribution document (vladzaharia/djdl 9ba79dd)", () => {
  const djdl = parseYaml(
    readFileSync(join(here, "fixtures", "djdl", "distribution.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const djdlProduct = JSON.parse(
    readFileSync(join(repoRoot, "products", "djdl", "product.json"), "utf8"),
  );
  const djdlCatalog = JSON.parse(
    readFileSync(join(repoRoot, "products", "djdl", "catalog.json"), "utf8"),
  );

  it("validates with only the deprecation warnings", () => {
    const res = validateManifestDocuments({
      product: djdlProduct,
      schema: djdlCatalog,
      distribution: djdl,
    });
    expect(res.errors).toEqual([]);
    // The product fixture mirrors djdl's flat product.json, so ST-19's spelling warnings
    // (plans/ST-19.md §3.3) come first; the distribution document adds only its two aliases.
    expect(res.warnings.map((w) => [w.file, w.path, w.code])).toEqual([
      ...DJDL_PRODUCT_SPELLINGS.map((path) => [
        "product",
        path,
        "deprecated_spelling",
      ]),
      ["distribution", "/listing/iconUrl", "listing_url_field_deprecated"],
      ["distribution", "/listing/headerUrl", "listing_url_field_deprecated"],
    ]);
  });

  it("passes the published schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const check = ajv.compile(readSchema("distribution.schema.json"));
    expect(check(djdl), JSON.stringify(check.errors)).toBe(true);
  });

  it("normalises its two URLs into url-kind icon and header", () => {
    const res = parseManifest({
      product: JSON.stringify(djdlProduct),
      schema: JSON.stringify(djdlCatalog),
      distribution: JSON.stringify(djdl),
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const listing = res.manifest.distribution!.listing!;
    expect(listing.icon?.kind).toBe("url");
    expect(listing.header?.kind).toBe("url");
    expect(listing.icon?.src).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/vladzaharia\/djdl-assets\/.*\/icon\.png$/,
    );
    expect("iconUrl" in listing).toBe(false);
  });
});
