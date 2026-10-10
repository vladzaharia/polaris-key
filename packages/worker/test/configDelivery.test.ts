/**
 * Config secret delivery rules: delivery enforced for every kind, no silent declassification,
 * malformed layers and the public schema projection.
 * The owner-line and provisioning cases live in accountOverrides.test.ts.
 */
import { describe, expect, it } from "vitest";
import { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import { validatePayload } from "../src/core/licensing/payload.js";
import { mergePayloads } from "../src/core/licensing/merge.js";
import { publicCatalogJson } from "../src/services/config/schema.js";
import {
  catalogDeliveryIssues,
  declassifiedKeys,
  declassifyRefusal,
  storedKeys,
} from "../src/core/configDelivery.js";
import { makeTestDb } from "./helpers.js";
import { seedProduct } from "./seed.js";

const e = (value: unknown, state = "enforced"): ManagedEntry =>
  ({ state, value, updatedAt: 1 }) as ManagedEntry;
const base = { category: "c", label: "l", description: "d", schema: {} };

describe("delivery enforced for every kind", () => {
  const catalog = new Catalog({
    schemaVersion: 1,
    entries: [
      { ...base, key: "a.cfg", kind: "config", delivery: "serverOnly" },
      { ...base, key: "b.sec", kind: "secret", delivery: "serverOnly" },
      { ...base, key: "c.mint", kind: "secret", delivery: "edgeMint" },
      { ...base, key: "d.ok", kind: "secret", delivery: "clientScoped" },
    ] as never,
  });
  it("drops serverOnly config and edgeMint secrets, keeps clientScoped", () => {
    const out = validatePayload(
      {
        config: { "a.cfg": e("x") },
        secrets: { "b.sec": e("x"), "c.mint": e("x"), "d.ok": e("x") },
        entitlements: {},
      },
      catalog,
    );
    expect(out.config).toEqual({});
    expect(Object.keys(out.secrets)).toEqual(["d.ok"]);
  });
  it("the catalog validator refuses delivery on a non-secret", () => {
    expect(catalogDeliveryIssues(catalog.entries)[0]).toContain("a.cfg");
  });
});

describe("no silent declassification", () => {
  const prev = JSON.stringify({
    entries: [{ ...base, key: "s", kind: "secret", delivery: "serverOnly" }],
  });
  const next = [{ ...base, key: "s", kind: "secret" }];
  it("detects the downgrade", () => {
    expect(declassifiedKeys(prev, next)).toEqual(["s"]);
    expect(
      declassifiedKeys(prev, [{ ...next[0], delivery: "edgeMint" }]),
    ).toEqual([]);
  });
  it("refuses only while a layer stores a value", async () => {
    const db = await makeTestDb();
    await seedProduct(db, "p");
    await db.run(
      "INSERT INTO profiles (product, id, name, description, payload_json, modified_by, modified_at) VALUES ('p','pr','n','',?,'t',1)",
      JSON.stringify({ config: {}, secrets: { s: e("v") }, entitlements: {} }),
    );
    expect(await storedKeys(db, "p", ["s", "zzz"])).toEqual(["s"]);
    expect(await declassifyRefusal(db, "p", prev, next)).toContain("s");
    expect(await declassifyRefusal(db, "other", prev, next)).toBeNull();
  });
});

describe("malformed layers", () => {
  it("skips null entries and unknown states instead of crashing", () => {
    const out = mergePayloads(
      JSON.stringify({
        config: {
          a: null,
          b: e(1),
          c: { state: "bogus", value: 2, updatedAt: 1 },
        },
        secrets: [],
        entitlements: { f: e(true) },
      }),
    );
    expect(Object.keys(out.config)).toEqual(["b"]);
    expect(out.secrets).toEqual({});
    expect(out.entitlements.f?.value).toBe(true);
  });
});

describe("public schema projection", () => {
  it("strips default/examples of secret entries only", () => {
    const out = JSON.parse(
      publicCatalogJson(
        JSON.stringify({
          entries: [
            {
              ...base,
              key: "s",
              kind: "secret",
              default: "LEAK",
              examples: ["LEAK"],
            },
            {
              ...base,
              key: "c",
              kind: "config",
              secret: true,
              default: "LEAK",
            },
            { ...base, key: "n", kind: "config", default: "ok" },
          ],
        }),
      ),
    );
    expect(JSON.stringify(out.entries.slice(0, 2))).not.toContain("LEAK");
    expect(out.entries[2].default).toBe("ok");
  });
  it("catalog validator refuses a default on a secret", () => {
    expect(
      catalogDeliveryIssues([
        { ...base, key: "s", kind: "secret", default: "x" },
      ]),
    ).toHaveLength(1);
  });
});
