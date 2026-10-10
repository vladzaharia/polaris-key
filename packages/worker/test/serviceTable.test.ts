/**
 * The worker's half of the service-table drift gate (P0-09).
 *
 * The opt-in services are declared once, in `tools/services.json`; `pnpm gen services` writes the
 * slug constants into `@polaris-key/manifest`, which the worker imports. What CANNOT be generated
 * — a service's directory, its descriptor, its `mount.ts` entry, its OpenAPI discovery key and the
 * literal coherence codes — is asserted here instead, one message per missing piece, so adding a
 * table row fails with a list of exactly what the new service still needs. The checklist the
 * messages point at is /docs/contribute/layout/#adding-a-service.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SERVICE_REQUIRES } from "@polaris-key/manifest";
import { SERVICES } from "../src/mount.js";
import {
  SERVICE_SLUGS,
  validateServices,
  type ServicesMap,
} from "../src/core/services.js";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string =>
  readFileSync(join(WORKER_ROOT, rel), "utf8");

describe("the service table, as the worker sees it", () => {
  it("every row has a src/services/<slug>/ directory with a descriptor", () => {
    for (const slug of SERVICE_SLUGS) {
      const index = `src/services/${slug}/index.ts`;
      // Soft, so a brand-new row reports the directory AND the descriptor in one run.
      expect
        .soft(
          existsSync(join(WORKER_ROOT, "src", "services", slug)),
          `src/services/${slug}/ is missing — tools/services.json has a "${slug}" row`,
        )
        .toBe(true);
      const hasIndex = existsSync(join(WORKER_ROOT, index));
      expect
        .soft(
          hasIndex,
          `${index} is missing — the "${slug}" service needs a ServiceDescriptor there`,
        )
        .toBe(true);
      if (!hasIndex) continue;
      expect(
        read(index).includes(`slug: "${slug}"`),
        `${index} declares no ServiceDescriptor with slug: "${slug}"`,
      ).toBe(true);
    }
  });

  it("mount.ts registers exactly the table's services, in canonical order", () => {
    for (const slug of SERVICE_SLUGS) {
      expect(
        SERVICES.has(slug),
        `src/mount.ts SERVICES has no entry for "${slug}"`,
      ).toBe(true);
      expect(SERVICES.get(slug)?.slug).toBe(slug);
    }
    expect(
      [...SERVICES.keys()],
      "src/mount.ts SERVICES registers a service the table does not have, or out of order",
    ).toEqual([...SERVICE_SLUGS]);
  });

  it("the OpenAPI discovery document requires exactly the table's slugs, in order", () => {
    const spec = parseYaml(read("openapi/polaris-key.v3.yaml")) as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { required?: string[] }> }
        >;
      };
    };
    const discovery = Object.values(spec.components.schemas).find(
      (s) => s.properties?.services?.required !== undefined,
    );
    const required = discovery?.properties?.services?.required ?? [];
    for (const slug of SERVICE_SLUGS) {
      expect(
        required,
        `openapi/polaris-key.v3.yaml discovery services.required is missing "${slug}"`,
      ).toContain(slug);
    }
    expect(
      required,
      "openapi/polaris-key.v3.yaml discovery services.required differs from the table",
    ).toEqual([...SERVICE_SLUGS]);
  });

  it("every requires edge has a literal <a>_requires_<b> code in core/services.ts", () => {
    // Codes stay literal on purpose: the admin API, the console and the manifest validator all
    // key off them, and rule 9's parity sweep reads codes from source. The edge is data.
    const source = read("src/core/services.ts");
    for (const slug of SERVICE_SLUGS) {
      for (const required of SERVICE_REQUIRES[slug]) {
        const code = `${slug}_requires_${required}`;
        expect(
          source.includes(`"${code}"`),
          `src/core/services.ts has no literal "${code}" for the table's ${slug} → ${required} edge`,
        ).toBe(true);
      }
    }
  });

  it("validateServices enforces every requires edge", () => {
    for (const slug of SERVICE_SLUGS) {
      for (const required of SERVICE_REQUIRES[slug]) {
        const services = Object.fromEntries(
          SERVICE_SLUGS.map((s) => [
            s,
            { enabled: s === slug || s === "license" },
          ]),
        ) as ServicesMap;
        expect(validateServices(services)).toContain(
          `${slug}_requires_${required}`,
        );
      }
    }
  });
});
