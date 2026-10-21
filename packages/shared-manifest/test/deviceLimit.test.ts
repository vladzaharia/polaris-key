/**
 * The device seat cap is bounded at manifest ingest, in every spelling the validator accepts.
 *
 * A seat cap becomes `claimDeviceSeat`'s `limit`, which materialises one row per seat inside a
 * single D1 statement, and a `.pkey/product` in a third party's repo reaches the validator
 * through a push webhook (`githubWebhook.ts` → `release/resync.ts` → `parseManifest`). So the
 * ceiling guards a cost, not tidiness: `MAX_DEVICE_LIMIT` bounds that statement.
 *
 * `schema-parity.test.ts` pins the code this rule emits against the published JSON Schema. This
 * file pins the behaviour: which values pass, which are refused, and that nothing is clamped.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_DEVICE_LIMIT,
  parseManifest,
  validateManifestDocuments,
  type ManifestDocuments,
} from "../src/index.js";

const SCHEMA_DOC = { schemaVersion: 1, catalog: [] };

/** The smallest valid manifest (default modules are license + config, so a catalog is needed),
 *  with `extra` merged into the product document's root. */
function withRoot(extra: Record<string, unknown>): ManifestDocuments {
  return {
    product: { slug: "acme", name: "Acme", compatMin: "1.0.0", ...extra },
    schema: SCHEMA_DOC,
  };
}

/** `defaultDeviceLimit` written in each spelling the validator reads. */
const SPELLINGS: Record<string, (value: unknown) => ManifestDocuments> = {
  "licensing.defaultDeviceLimit": (value) =>
    withRoot({ licensing: { defaultDeviceLimit: value } }),
  "a flat document's root defaultDeviceLimit": (value) =>
    withRoot({ defaultDeviceLimit: value }),
  "defaultDeviceLimit under product:": (value) => ({
    product: {
      product: {
        slug: "acme",
        name: "Acme",
        compatMin: "1.0.0",
        defaultDeviceLimit: value,
      },
    },
    schema: SCHEMA_DOC,
  }),
  "defaultDeviceLimit beside product:": (value) => ({
    product: {
      product: { slug: "acme", name: "Acme", compatMin: "1.0.0" },
      defaultDeviceLimit: value,
    },
    schema: SCHEMA_DOC,
  }),
};

/** A tier's `policyDeviceLimit`, under `licensing.tiers` and under the deprecated root `tiers`. */
const TIER_SPELLINGS: Record<string, (value: unknown) => ManifestDocuments> = {
  "licensing.tiers": (value) =>
    withRoot({
      licensing: { tiers: [{ id: "pro", policyDeviceLimit: value }] },
    }),
  "root tiers": (value) =>
    withRoot({ tiers: [{ id: "pro", policyDeviceLimit: value }] }),
};

const codes = (docs: ManifestDocuments): string[] =>
  validateManifestDocuments(docs).errors.map((e) => e.code);

describe("MAX_DEVICE_LIMIT", () => {
  it("is 1000, and is the maximum the published product schema states", () => {
    expect(MAX_DEVICE_LIMIT).toBe(1000);
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(
      readFileSync(
        join(here, "..", "schemas", "v1", "product.schema.json"),
        "utf8",
      ),
    ) as { $defs: { deviceLimit: { minimum: number; maximum: number } } };
    expect(schema.$defs.deviceLimit).toMatchObject({
      minimum: 0,
      maximum: MAX_DEVICE_LIMIT,
    });
  });
});

describe("defaultDeviceLimit is bounded in every spelling", () => {
  for (const [spelling, docs] of Object.entries(SPELLINGS)) {
    it(`refuses ${spelling} past the ceiling, naming the path and the ceiling`, () => {
      for (const over of [MAX_DEVICE_LIMIT + 1, 100_000_000, 1e300]) {
        const res = validateManifestDocuments(docs(over));
        expect(res.ok, `${over}`).toBe(false);
        const error = res.errors.find((e) => e.code === "invalid_device_limit");
        expect(error, `${over}`).toMatchObject({
          path: "/licensing/defaultDeviceLimit",
          message: `defaultDeviceLimit must be at most ${MAX_DEVICE_LIMIT}.`,
        });
      }
    });

    it(`accepts ${spelling} at zero, a real count and exactly the ceiling`, () => {
      for (const value of [0, 1, 5, MAX_DEVICE_LIMIT])
        expect(codes(docs(value)), `${value}`).toEqual([]);
    });
  }

  it("rejects, never clamps: an over-ceiling manifest is not parsed at all", () => {
    const res = parseManifest({
      product: JSON.stringify({
        slug: "acme",
        name: "Acme",
        licensing: { defaultDeviceLimit: 100_000_000 },
      }),
      schema: JSON.stringify(SCHEMA_DOC),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("defaultDeviceLimit");
    expect(res.errors.join("\n")).toContain(String(MAX_DEVICE_LIMIT));
  });

  it("parses the ceiling itself to exactly the ceiling", () => {
    const res = parseManifest({
      product: JSON.stringify({
        slug: "acme",
        name: "Acme",
        licensing: { defaultDeviceLimit: MAX_DEVICE_LIMIT },
      }),
      schema: JSON.stringify(SCHEMA_DOC),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.product.defaultDeviceLimit).toBe(MAX_DEVICE_LIMIT);
  });

  it("reports a value that is not a whole number once, by its own rule", () => {
    // A fraction or a string past the ceiling is not a seat count at all: `invalid_number`
    // already says so, and a second "at most 1000" would only repeat it. A numeric string is
    // never coerced into a value the ceiling then has to catch.
    for (const bad of [1000.5, 1e9 + 0.5, "100000000", "1e9"]) {
      for (const [spelling, docs] of Object.entries(SPELLINGS))
        expect(codes(docs(bad)), `${spelling}: ${String(bad)}`).toEqual([
          "invalid_number",
        ]);
    }
    // A non-finite number (YAML `.inf`) is the representability rule's to refuse, not this one's.
    for (const docs of Object.values(SPELLINGS))
      expect(codes(docs(Infinity))).not.toContain("invalid_device_limit");
  });
});

describe("a tier's policyDeviceLimit is bounded in every spelling", () => {
  for (const [spelling, docs] of Object.entries(TIER_SPELLINGS)) {
    it(`refuses ${spelling} past the ceiling`, () => {
      for (const over of [MAX_DEVICE_LIMIT + 1, 100_000_000]) {
        const res = validateManifestDocuments(docs(over));
        expect(res.ok, `${over}`).toBe(false);
        expect(
          res.errors.find((e) => e.code === "invalid_device_limit"),
          `${over}`,
        ).toMatchObject({
          path: "/licensing/tiers/0/policyDeviceLimit",
          message: `policyDeviceLimit must be a non-negative integer of at most ${MAX_DEVICE_LIMIT}.`,
        });
      }
    });

    it(`accepts ${spelling} at zero, a real count and exactly the ceiling`, () => {
      for (const value of [0, 1, 5, MAX_DEVICE_LIMIT])
        expect(codes(docs(value)), `${value}`).toEqual([]);
    });

    it(`still refuses a non-integer, a negative and a string on ${spelling}`, () => {
      for (const bad of [1.5, -1, "5"])
        expect(codes(docs(bad)), `${String(bad)}`).toEqual([
          "invalid_device_limit",
        ]);
    });
  }

  it("leaves a tier that sets no limit alone: it inherits the product default", () => {
    const res = parseManifest({
      product: JSON.stringify({
        slug: "acme",
        name: "Acme",
        licensing: { tiers: [{ id: "free" }] },
      }),
      schema: JSON.stringify(SCHEMA_DOC),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.tiers[0]?.policyDeviceLimit).toBeNull();
  });

  it("refuses an over-ceiling tier at ingest rather than storing a clamped cap", () => {
    const res = parseManifest({
      product: JSON.stringify({
        slug: "acme",
        name: "Acme",
        licensing: { tiers: [{ id: "pro", policyDeviceLimit: 100_000 }] },
      }),
      schema: JSON.stringify(SCHEMA_DOC),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join("\n")).toContain("policyDeviceLimit");
    expect(res.errors.join("\n")).toContain(String(MAX_DEVICE_LIMIT));
  });
});

describe("defaultMaxOfflineDays is bounded in every spelling (B-149)", () => {
  const OFFLINE: Record<string, (value: unknown) => ManifestDocuments> = {
    "licensing.defaultMaxOfflineDays": (value) =>
      withRoot({ licensing: { defaultMaxOfflineDays: value } }),
    "a flat document's root defaultMaxOfflineDays": (value) =>
      withRoot({ defaultMaxOfflineDays: value }),
  };
  for (const [spelling, docs] of Object.entries(OFFLINE)) {
    it(`refuses ${spelling} past 365, accepts 0, a real count and 365`, () => {
      for (const over of [366, 100_000_000, 1e300]) {
        const res = validateManifestDocuments(docs(over));
        expect(res.ok, `${over}`).toBe(false);
        expect(
          res.errors.find((e) => e.code === "invalid_offline_days"),
        ).toMatchObject({
          path: "/licensing/defaultMaxOfflineDays",
          message: "defaultMaxOfflineDays must be at most 365.",
        });
      }
      for (const ok of [0, 30, 365])
        expect(codes(docs(ok)), `${ok}`).toEqual([]);
    });
  }
});
