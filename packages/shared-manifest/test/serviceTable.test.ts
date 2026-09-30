/**
 * The manifest package's half of the service-table drift gate (P0-09).
 *
 * `src/services.generated.ts` is written from `tools/services.json`; these are the hand-written
 * things a new table row also needs on this side, each asserted so a missing one fails with a
 * message naming it (see /docs/contribute/layout/#adding-a-service).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_SERVICES,
  MODULE_SERVICES,
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  normalizeModules,
  servicesFromModules,
  validateManifestDocuments,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const productSchema = JSON.parse(
  readFileSync(
    join(here, "..", "schemas", "v1", "product.schema.json"),
    "utf8",
  ),
) as { $defs: { modules: { properties: Record<string, unknown> } } };
const validatorSource = readFileSync(
  join(here, "..", "src", "index.ts"),
  "utf8",
);

describe("the service table, as the manifest package sees it", () => {
  it("product.schema.json's modules block has a property for every slug and legacy name", () => {
    const declared = Object.keys(productSchema.$defs.modules.properties).sort();
    const expected = Object.keys(MODULE_SERVICES).sort();
    for (const name of expected) {
      expect(
        declared,
        `schemas/v1/product.schema.json $defs.modules.properties is missing "${name}"`,
      ).toContain(name);
    }
    expect(
      declared,
      "schemas/v1/product.schema.json declares a module the table does not have",
    ).toEqual(expected);
  });

  it("every requires edge has a literal <a>_requires_<b> code in the validator source", () => {
    // Rule 9: schema-parity.test.ts sweeps error codes out of the SOURCE, so a code built from
    // table data would vanish from it. The edge is data; the code must stay a literal.
    for (const slug of SERVICE_SLUGS) {
      for (const required of SERVICE_REQUIRES[slug]) {
        const code = `${slug}_requires_${required}`;
        expect(
          validatorSource.includes(`"${code}"`),
          `src/index.ts has no literal "${code}" for the table's ${slug} → ${required} edge`,
        ).toBe(true);
      }
    }
  });

  it("every requires edge is enforced by the validator", () => {
    for (const slug of SERVICE_SLUGS) {
      for (const required of SERVICE_REQUIRES[slug]) {
        const modules = Object.fromEntries(
          SERVICE_SLUGS.map((s) => [
            s,
            { enabled: s === slug || s === "license" },
          ]),
        );
        const result = validateManifestDocuments({
          product: {
            apiVersion: "pkey.dev/v1",
            product: { slug: "acme", name: "Acme" },
            modules,
          },
        });
        expect(result.errors.map((e) => e.code)).toContain(
          `${slug}_requires_${required}`,
        );
      }
    }
  });

  it("an undeclared modules block enables exactly the table's defaults", () => {
    expect(normalizeModules(undefined)).toEqual([...DEFAULT_ENABLED_SERVICES]);
    const map = servicesFromModules(DEFAULT_ENABLED_SERVICES);
    expect(Object.keys(map)).toEqual([...SERVICE_SLUGS]);
  });

  it("each slug enables itself, in canonical order", () => {
    for (const slug of SERVICE_SLUGS) {
      expect(normalizeModules({ [slug]: { enabled: true } })).toEqual([slug]);
    }
  });
});
