import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { parseManifest } from "../src/release/manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Reuse the real djdl product catalog (products/djdl/catalog.json) as the schema doc.
const CATALOG_JSON = readFileSync(
  join(HERE, "..", "..", "..", "products", "djdl", "catalog.json"),
  "utf8",
);
const CATALOG = JSON.parse(CATALOG_JSON) as Record<string, unknown>;

// Small inline product + release docs (the djdl shapes, trimmed to the parser's scope).
const PRODUCT = {
  slug: "djdl",
  name: "DJDL",
  compatMin: "0.0.0",
  compatMax: "99.0.0",
  defaultMaxOfflineDays: 30,
  defaultMachineLimit: 5,
  adminGroup: "admin",
  oidc: {
    issuer: "https://id.scruffy.spot",
    clientId: "djdl",
    clientSecretSecret: "OIDC_CLIENT_SECRET__DJDL",
    redirectUris: ["https://key.plrs.im/djdl/auth/callback"],
    groupRoleMap: { admin: { role: "admin" } },
  },
  tiers: [
    { id: "standard", label: "Standard", profileId: null, policyExpiryDays: null, policyMachineLimit: 5 },
  ],
  provisioning: [
    { claim: "remnawaveAccess", entitlementKey: "polarisVpn", entitlementValue: true },
  ],
};

const RELEASE = {
  release: {
    ghOwner: "vladzaharia",
    ghRepo: "djdl",
    binaryName: "djdl",
    channelWorkflow: "channel.yml",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
    sparkleEd25519Pub: "REPLACE_WITH_SPARKLE_PUBLIC_KEY",
  },
  edgeMint: [
    {
      id: "applemusic",
      alg: "ES256",
      signingKeySecret: "EDGE_MINT__DJDL__APPLEMUSIC",
      kid: "KID",
      claimsTemplate: { iss: "TEAM" },
      ttlSeconds: 3600,
    },
  ],
};

describe("parseManifest", () => {
  it("parses a valid manifest from JSON files", () => {
    const res = parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify(PRODUCT),
      release: JSON.stringify(RELEASE),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.manifest;
    expect(m.product.slug).toBe("djdl");
    expect(m.product.name).toBe("DJDL");
    expect(m.product.defaultMachineLimit).toBe(5);
    expect(m.catalog.schemaVersion).toBe(1);
    expect(m.catalog.entries.length).toBe((CATALOG.entries as unknown[]).length);
    expect(m.oidc?.clientId).toBe("djdl");
    expect(m.tiers).toHaveLength(1);
    expect(m.provisioning).toHaveLength(1);
    expect(m.release?.ghOwner).toBe("vladzaharia");
    expect(m.release?.binaryName).toBe("djdl");
    expect(m.edgeMint).toHaveLength(1);
    expect(m.edgeMint[0]?.id).toBe("applemusic");
  });

  it("parses the SAME content expressed as YAML, yielding an identical ParsedManifest", () => {
    const fromJson = parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify(PRODUCT),
      release: JSON.stringify(RELEASE),
    });
    const fromYaml = parseManifest({
      schema: toYaml(CATALOG),
      product: toYaml(PRODUCT),
      release: toYaml(RELEASE),
    });

    expect(fromJson.ok).toBe(true);
    expect(fromYaml.ok).toBe(true);
    if (!fromJson.ok || !fromYaml.ok) return;
    // Same parsed data regardless of source serialization.
    expect(fromYaml.manifest).toEqual(fromJson.manifest);
  });

  it("detects JSON vs YAML per file independently (mixed inputs ok)", () => {
    const res = parseManifest({
      schema: CATALOG_JSON, // JSON
      product: toYaml(PRODUCT), // YAML
      release: JSON.stringify(RELEASE), // JSON
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.product.slug).toBe("djdl");
    expect(res.manifest.release?.ghRepo).toBe("djdl");
  });

  it("treats schema and release/oidc/etc as optional vs required correctly", () => {
    // Minimal valid manifest: only schema + product, no release/oidc/tiers.
    const res = parseManifest({
      schema: CATALOG_JSON,
      product: JSON.stringify({ slug: "minimal", name: "Minimal" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release).toBeUndefined();
    expect(res.manifest.oidc).toBeUndefined();
    expect(res.manifest.tiers).toEqual([]);
    expect(res.manifest.provisioning).toEqual([]);
    expect(res.manifest.edgeMint).toEqual([]);
  });

  it("aggregates multiple errors: bad slug, malformed schema fragment, missing schema", () => {
    // Bad slug + a malformed catalog fragment (invalid JSON-Schema keyword value).
    const badCatalog = {
      schemaVersion: 1,
      entries: [
        {
          key: "broken",
          kind: "config",
          category: "X",
          label: "Broken",
          description: "bad fragment",
          // `type` must be a string/array of strings — a number is an invalid fragment.
          schema: { type: 123 },
        },
      ],
    };
    const res = parseManifest({
      schema: JSON.stringify(badCatalog),
      product: JSON.stringify({ slug: "Bad Slug!" }),
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
    expect(res.errors.some((e) => e.startsWith("schema:"))).toBe(true);
    expect(res.errors.some((e) => e.startsWith("product:") && e.includes("slug"))).toBe(true);
  });

  it("reports missing schema and missing product as required errors", () => {
    const res = parseManifest({ release: JSON.stringify(RELEASE) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.startsWith("schema:") && e.includes("required"))).toBe(true);
    expect(res.errors.some((e) => e.startsWith("product:") && e.includes("required"))).toBe(true);
  });

  it("surfaces an unparseable document as a JSON/YAML error", () => {
    const res = parseManifest({
      schema: CATALOG_JSON,
      product: "{ this is : neither json :: nor yaml ][",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.startsWith("product:"))).toBe(true);
  });
});
