/**
 * ST-06 (notes/S-18 §4.13 item 3): the settings reference page and the console's settings
 * search index are generated from the registry, and `pnpm gen:settings -- --check` fails when
 * either is stale. This suite byte-compares both, so `pnpm test` fails on a stale page too, and
 * pins that the outputs follow the registry.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeConfirm,
  describeValue,
  DOCS_PATH,
  INDEX_PATH,
  indexEntries,
  renderAll,
  renderDocsPage,
  ROOT,
} from "../scripts/gen-settings.js";
import { SETTINGS } from "../src/mount.js";
import { NOT_A_SETTING } from "../scripts/settings-coverage.js";

describe("the generated settings outputs (ST-06)", () => {
  it("are up to date (pnpm gen:settings)", async () => {
    const rendered = await renderAll();
    expect(Object.keys(rendered).sort()).toEqual(
      [INDEX_PATH, DOCS_PATH].sort(),
    );
    for (const [path, content] of Object.entries(rendered))
      expect(
        readFileSync(join(ROOT, path), "utf8"),
        `${path} is stale: run pnpm gen:settings`,
      ).toBe(content);
  });

  it("would be stale after a registry change", () => {
    const committed = readFileSync(join(ROOT, DOCS_PATH), "utf8");
    const [first, ...rest] = SETTINGS.entries;
    const changed = renderDocsPage(
      [{ ...first!, label: `${first!.label} (renamed)` }, ...rest],
      NOT_A_SETTING,
    );
    expect(changed).not.toBe(committed);
  });

  it("carry the GENERATED banner and every registry key", () => {
    const page = readFileSync(join(ROOT, DOCS_PATH), "utf8");
    const index = readFileSync(join(ROOT, INDEX_PATH), "utf8");
    expect(page).toContain("GENERATED PAGE — do not edit");
    expect(index).toContain("DO NOT EDIT");
    for (const e of SETTINGS.entries) {
      expect(page).toContain(`\`${e.key}\``);
      expect(index).toContain(`"${e.key}"`);
    }
    for (const n of NOT_A_SETTING) expect(index).toContain(n.reason);
  });

  it("index every entry once per scope, with what search filters on", () => {
    const idx = indexEntries(SETTINGS.entries);
    expect(idx).toHaveLength(SETTINGS.entries.length);
    const pairs = idx.map((e) => `${e.scope}:${e.key}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const lazy = idx.find((e) => e.key === "deltas.lazy.mode")!;
    expect(lazy).toMatchObject({
      scope: "platform",
      service: "platform",
      aliases: ["LAZY_DELTAS"],
      secret: false,
      pending: null,
    });
    // LX-06 made the licensing settings live; billing-retry grace waits for LX-23.
    expect(
      idx.find((e) => e.key === "licensing.entitlementModel")?.pending,
    ).toBeNull();
    expect(
      idx.find((e) => e.key === "licensing.dunningGraceDays")?.pending,
    ).toBe("LX-23");
  });

  it("describe values and confirmation levels in words", () => {
    expect(describeValue({ kind: "switch" })).toBe("on or off");
    expect(
      describeValue({ kind: "integer", unit: "days", min: 1, max: 365 }),
    ).toBe("integer 1–365 days");
    expect(
      describeValue({
        kind: "list",
        of: { kind: "string", maxLength: 10 },
        max: 3,
      }),
    ).toBe("list of up to 3: text, at most 10 characters");
    expect(describeConfirm({ on: "L1", off: "L0" })).toBe("L1 on, L0 off");
    expect(describeConfirm({ up: "L2", down: "L2" })).toBe("L2");
    expect(describeConfirm({ change: "L1" })).toBe("L1 on change");
  });
});
