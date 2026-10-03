/**
 * The console's half of the service-table drift gate (P0-09).
 *
 * `src/services.generated.ts` carries each service's slug, label, summary, accent token and icon
 * name from `tools/services.json`. The views, the nav section, the accent CSS and the coherence
 * messages are hand-written; each is asserted here so a new table row fails with a message
 * naming exactly what the console still needs (/docs/contribute/layout/#adding-a-service).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_ERROR_MESSAGES } from "../src/api.js";
import { SECTIONS } from "../src/route.js";
import {
  SERVICE_REQUIRES,
  SERVICE_SLUGS,
  SERVICE_TABLE,
} from "../src/services.generated.js";

// The accent CSS now ships in @polaris-key/brand (docs/design/BRAND.md §5): tokens.css keys every
// section by its slug and carries both themes' values; styles.css only imports it.
const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
const brandTokens = readFileSync(
  join(here, "..", "..", "brand", "css", "tokens.css"),
  "utf8",
);

describe("the service table, as the console sees it", () => {
  it("SERVICE_TABLE is the slug list, in order", () => {
    expect(SERVICE_TABLE.map((row) => row.slug)).toEqual([...SERVICE_SLUGS]);
  });

  it("route.ts SECTIONS has one section per service, with the table's accent", () => {
    for (const row of SERVICE_TABLE) {
      const section = SECTIONS.find((s) => s.key === row.slug);
      expect(
        section,
        `src/route.ts SECTIONS has no section for the "${row.slug}" service`,
      ).toBeDefined();
      expect(section!.service, `section "${row.slug}" gates on`).toBe(row.slug);
      expect(
        section!.accent,
        `section "${row.slug}" must carry the table's accent "${row.accent}"`,
      ).toBe(row.accent);
      expect(
        section!.items.length,
        `section "${row.slug}" has no views`,
      ).toBeGreaterThan(0);
    }
    expect(
      SECTIONS.filter((s) => s.service !== null).map((s) => s.key),
      "src/route.ts SECTIONS has a service section the table does not have, or out of order",
    ).toEqual([...SERVICE_SLUGS]);
  });

  it("the brand tokens have a section rule and both themes' accent per service", () => {
    expect(styles).toContain('@import "@polaris-key/brand/tokens.css";');
    for (const row of SERVICE_TABLE) {
      const rule = new RegExp(
        `(^|\\n)\\[data-service="${row.accent}"\\]\\s*\\{[^}]*--pk-section-bit:`,
      );
      expect(
        rule.test(brandTokens),
        `@polaris-key/brand tokens.css has no [data-service="${row.accent}"] section rule (service "${row.slug}")`,
      ).toBe(true);
      // One declaration per theme block: dark (:root), light (media query) and data-theme="light".
      expect(
        brandTokens.split(`--pk-service-${row.accent}:`).length - 1,
        `@polaris-key/brand tokens.css lacks a dark or light --pk-service-${row.accent} (service "${row.slug}")`,
      ).toBe(3);
    }
  });

  it("every requires edge has a console message for its coherence code", () => {
    for (const slug of SERVICE_SLUGS) {
      for (const required of SERVICE_REQUIRES[slug]) {
        const code = `${slug}_requires_${required}`;
        expect(
          SERVICE_ERROR_MESSAGES[code],
          `src/api.ts SERVICE_ERROR_MESSAGES has no message for "${code}"`,
        ).toEqual(expect.any(String));
      }
    }
  });
});
