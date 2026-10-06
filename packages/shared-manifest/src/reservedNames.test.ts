import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isReservedEntitlementName,
  parseManifest,
  reservedNameDeclarations,
  reservedNameProblem,
  validateIngestDocuments,
  validateManifestDocuments,
} from "./index.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const PRODUCT = {
  slug: "acme",
  name: "Acme",
  modules: { license: { enabled: true }, config: { enabled: true } },
};

function flag(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    kind: "flag",
    category: "Policy",
    label: key,
    description: "",
    schema: { type: "boolean" },
    ...extra,
  };
}

function catalog(...entries: unknown[]) {
  return { schemaVersion: 1, entries };
}

const codes = (list: { code: string }[]) => list.map((m) => m.code);

describe("reserved entitlement names (S-19 §7.4, LX-05)", () => {
  it("knows the system keys and the reserved prefixes", () => {
    for (const k of [
      "channels",
      "deviceLimit",
      "app.minVersion",
      "app.maxVersion",
      "license.tier",
      "license.tierLabel",
      "license.anything",
      "app.build",
      "pkey.future",
    ])
      expect(isReservedEntitlementName(k), k).toBe(true);
    for (const k of ["acmeVpn", "channel", "apps.x", "licenseTier", "pkey"])
      expect(isReservedEntitlementName(k), k).toBe(false);
  });

  it("djdl's four declarations are compatible", () => {
    const djdl = JSON.parse(
      readFileSync(join(repoRoot, "products", "djdl", "catalog.json"), "utf8"),
    );
    const decls = reservedNameDeclarations(djdl);
    expect(decls.map((d) => d.key).sort()).toEqual([
      "app.maxVersion",
      "app.minVersion",
      "channels",
      "deviceLimit",
    ]);
    expect(decls.filter((d) => !d.compatible)).toEqual([]);
  });

  it("compatible declarations pass with no warning, narrowing and presentation included", () => {
    const schema = catalog(
      flag("channels", {
        schema: {
          type: "array",
          items: { type: "string", enum: ["stable", "beta"] },
          uniqueItems: true,
          minItems: 1,
        },
        default: ["stable"],
        userGrant: true,
        grantLabel: "Pre-release builds",
        ui: { widget: "select" },
      }),
      flag("deviceLimit", {
        schema: { type: "integer", minimum: 1, maximum: 10 },
        default: 3,
      }),
      flag("app.minVersion", {
        schema: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
      }),
      flag("license.tier", {
        schema: { type: "string", enum: ["free", "pro"] },
      }),
      flag("app.build", { schema: { type: "string" } }),
    );
    const res = validateIngestDocuments({ product: PRODUCT, schema });
    expect(res.ok).toBe(true);
    expect(codes(res.warnings)).not.toContain("incompatible_reserved_name");
    expect(codes(res.errors)).not.toContain("incompatible_reserved_name");
  });

  it("an incompatible declaration warns by default and does not refuse", () => {
    const schema = catalog(flag("channels"));
    const res = validateIngestDocuments({ product: PRODUCT, schema });
    expect(res.ok).toBe(true);
    expect(codes(res.errors)).not.toContain("incompatible_reserved_name");
    const w = res.warnings.find((m) => m.code === "incompatible_reserved_name");
    expect(w).toMatchObject({ file: "schema", path: "/entries/0" });
    expect(w!.message).toContain("channels");
    expect(w!.message).toContain("warning");
  });

  it("the same declaration is an error when the platform says error", () => {
    const schema = catalog(flag("acmeVpn"), flag("deviceLimit"));
    const res = validateManifestDocuments(
      { product: PRODUCT, schema },
      { reservedNames: "error" },
    );
    expect(res.ok).toBe(false);
    const e = res.errors.find((m) => m.code === "incompatible_reserved_name");
    expect(e).toMatchObject({ path: "/entries/1" });
    expect(codes(res.warnings)).not.toContain("incompatible_reserved_name");
    // A compatible one stays valid in error mode too.
    expect(
      validateManifestDocuments(
        {
          product: PRODUCT,
          schema: catalog(
            flag("deviceLimit", { schema: { type: "integer", minimum: 0 } }),
          ),
        },
        { reservedNames: "error" },
      ).ok,
    ).toBe(true);
  });

  it("parseManifest refuses an incompatible declaration only in error mode", () => {
    const files = {
      product: JSON.stringify(PRODUCT),
      schema: JSON.stringify(catalog(flag("app.minVersion"))),
    };
    expect(parseManifest(files).ok).toBe(true);
    const refused = parseManifest(files, { reservedNames: "error" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.errors.join("\n")).toContain(
      "app.minVersion is a reserved entitlement name",
    );
  });

  it("is judged with Config off too: flags are entitlements", () => {
    const res = validateIngestDocuments({
      product: { slug: "acme", name: "Acme" },
      schema: catalog(flag("deviceLimit")),
    });
    expect(codes(res.warnings)).toContain("incompatible_reserved_name");
  });

  it.each([
    ["the wrong type", flag("deviceLimit", { schema: { type: "number" } })],
    [
      "a nullable type",
      flag("app.maxVersion", { schema: { type: ["string", "null"] } }),
    ],
    ["no type at all", flag("license.tierLabel", { schema: {} })],
    [
      "an array of non-strings",
      flag("channels", {
        schema: { type: "array", items: { type: "integer" } },
      }),
    ],
    [
      "an array with no items schema",
      flag("channels", { schema: { type: "array" } }),
    ],
    [
      "a widening keyword",
      flag("app.minVersion", {
        schema: { type: "string", anyOf: [{ type: "string" }] },
      }),
    ],
    [
      "an enum of the wrong type",
      flag("deviceLimit", { schema: { type: "integer", enum: ["1"] } }),
    ],
    [
      "a default of the wrong type",
      flag("deviceLimit", { schema: { type: "integer" }, default: "5" }),
    ],
    [
      "an entry field that changes behaviour",
      flag("channels", {
        schema: { type: "array", items: { type: "string" } },
        combine: "max",
      }),
    ],
    [
      "an unknown name under license.",
      flag("license.seats", { schema: { type: "string" } }),
    ],
    [
      "any name under pkey.",
      flag("pkey.region", { schema: { type: "string" } }),
    ],
    [
      "a non-string under app.",
      flag("app.build", { schema: { type: "integer" } }),
    ],
  ])("is incompatible: %s", (_label, entry) => {
    expect(reservedNameProblem(entry)).not.toBeNull();
    expect(
      codes(
        validateIngestDocuments({ product: PRODUCT, schema: catalog(entry) })
          .warnings,
      ),
    ).toContain("incompatible_reserved_name");
  });

  it("config and secret keys never collide with an entitlement", () => {
    for (const kind of ["config", "secret"]) {
      const entry = { ...flag("channels"), kind };
      expect(reservedNameProblem(entry)).toBeNull();
      expect(reservedNameDeclarations(catalog(entry))).toEqual([]);
    }
  });
});
