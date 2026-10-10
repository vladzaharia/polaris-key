/**
 * The frontmatter schema (docs plan section 2): every page's values are legal, a stub carries the
 * full set, and `type` follows the door that owns the page.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANE_IDS, PAGE_STATUSES, PAGE_TYPES, SDK_IDS } from "../src/lib/docs";
import { doorOf } from "../src/lib/doors";
import { allIds, fileFor, splitFrontmatter } from "../scripts/site-map.mjs";
import table from "../../../tools/services.json";

const services = new Set(
  (table as { services: { slug: string }[] }).services.map((s) => s.slug),
);
const pages = allIds().map((id) => ({
  id,
  data: splitFrontmatter(readFileSync(fileFor(id)!, "utf8")).data as Record<
    string,
    unknown
  >,
}));

describe("frontmatter values", () => {
  it("are legal wherever they are declared", () => {
    const bad: string[] = [];
    for (const { id, data } of pages) {
      if (
        data.type !== undefined &&
        !(PAGE_TYPES as readonly string[]).includes(data.type as string)
      )
        bad.push(`${id}: type ${String(data.type)}`);
      if (
        data.status !== undefined &&
        !(PAGE_STATUSES as readonly string[]).includes(data.status as string)
      )
        bad.push(`${id}: status ${String(data.status)}`);
      for (const s of (data.services as string[] | undefined) ?? [])
        if (!services.has(s)) bad.push(`${id}: service ${s}`);
      for (const s of (data.sdks as string[] | undefined) ?? [])
        if (!(SDK_IDS as readonly string[]).includes(s))
          bad.push(`${id}: sdk ${s}`);
      for (const l of (data.lanes as string[] | undefined) ?? [])
        if (!(LANE_IDS as readonly string[]).includes(l))
          bad.push(`${id}: lane ${l}`);
      if (
        data.lastReviewed !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(data.lastReviewed))
      )
        bad.push(`${id}: lastReviewed ${String(data.lastReviewed)}`);
    }
    expect(bad).toEqual([]);
  });

  it("Help pages use the Help types, and nothing else does", () => {
    const wrong: string[] = [];
    for (const { id, data } of pages) {
      const consumer = data.type === "help" || data.type === "help-messages";
      if (data.type !== undefined && consumer !== (doorOf(id)?.door === "help"))
        wrong.push(`${id}: ${String(data.type)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a stub declares a type and is hidden", () => {
    const stubs = pages.filter((p) => p.data.status === "stub");
    expect(stubs.length).toBeGreaterThan(0);
    for (const { id, data } of stubs) {
      expect(data.type, id).toBeDefined();
      expect((data.sidebar as { hidden?: boolean }).hidden, id).toBe(true);
    }
  });
});
