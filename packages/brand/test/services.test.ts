// The section list must track the repo's service registry (tools/services.json): a new service
// without an accent fails here, not in a console that silently falls back to violet.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SERVICE_ACCENTS } from "../src/generated/tokens.js";
import {
  SERVICE_IDS,
  SERVICE_LABEL,
  SERVICE_MARK,
} from "../src/tokens/source.js";

const table = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../tools/services.json"),
    "utf8",
  ),
) as { services: { slug: string; label: string }[] };

describe("sections track tools/services.json", () => {
  it("core plus every service slug, in the table's order", () => {
    expect(SERVICE_IDS).toEqual(["core", ...table.services.map((s) => s.slug)]);
  });

  it("labels match the table", () => {
    for (const s of table.services)
      expect(SERVICE_LABEL[s.slug as keyof typeof SERVICE_LABEL]).toBe(s.label);
  });

  it("every section has an accent in both themes", () => {
    for (const theme of ["dark", "light"] as const)
      expect(Object.keys(SERVICE_ACCENTS[theme])).toEqual([...SERVICE_IDS]);
  });

  it("the Star Cut (Polaris Key Delivery) mark identifies the delivery family; the K everything else", () => {
    expect(SERVICE_IDS.filter((id) => SERVICE_MARK[id] === "update")).toEqual([
      "distribution",
      "update",
    ]);
  });
});
