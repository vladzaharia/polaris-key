import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatHits,
  rowsOf,
  scanRows,
  showName,
} from "./scan-display-names.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The shape `wrangler d1 execute --json` prints for the owner's UNION query. */
const FIXTURE = [
  {
    results: [
      { t: "product", slug: "acme", name: "Acme Arcade", developer_name: null },
      {
        t: "product",
        slug: "filler",
        name: "Steam\u3164",
        developer_name: null,
      },
      { t: "product", slug: "blank", name: "\u2800", developer_name: null },
      {
        t: "product",
        slug: "emoji",
        name: "\u{1F3AE}\uFE0F Arcade",
        developer_name: null,
      },
      {
        t: "product",
        slug: "zwj",
        name: "\u{1F469}\u200D\u{1F4BB} Dev",
        developer_name: null,
      },
      {
        t: "product",
        slug: "valve",
        name: "Steam Deck Helper",
        developer_name: null,
      },
      {
        t: "product",
        slug: "polaris-key",
        name: "Polaris Key",
        developer_name: null,
      },
      { t: "listing", slug: "acme", name: "Acme", developer_name: "Acme Inc." },
      {
        t: "listing",
        slug: "tags",
        name: "Ste\u{E0061}am",
        developer_name: "Dev\u202E",
      },
      { t: "listing", slug: "lead", name: "\uFE0FAcme", developer_name: null },
    ],
    success: true,
    meta: {},
  },
];

describe("scan-display-names (DISPLAY-NAME-INVISIBLE D-12)", () => {
  it("reads the wrangler document and lists each failing name", () => {
    const hits = scanRows(rowsOf(FIXTURE));
    expect(hits.map((h) => `${h.slug},${h.field},${h.verdict}`)).toEqual([
      "filler,product.name,invalid",
      "blank,product.name,invalid",
      "zwj,product.name,invalid",
      "valve,product.name,reserved",
      "tags,listing.name,reserved",
      "tags,listing.developerName,invalid",
      "lead,listing.name,invalid",
    ]);
  });

  it("spells invisible code points out", () => {
    expect(showName("Steam\u3164")).toBe('"Steam\\u{3164}"');
    expect(showName('A"b')).toBe('"A\\"b"');
    expect(formatHits(scanRows(rowsOf(FIXTURE))).split("\n")[0]).toBe(
      'filler,product.name,invalid,"Steam\\u{3164}"',
    );
  });

  it("accepts a bare row array and ignores empty and null values", () => {
    expect(
      scanRows(
        rowsOf([{ t: "product", slug: "a", name: "", developer_name: null }]),
      ),
    ).toEqual([]);
  });

  it("is a stdin-to-stdout filter: prints hits, exits 0, and exits 2 on bad input", () => {
    const run = (input: string) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", join(here, "scan-display-names.ts")],
        { input, encoding: "utf8", cwd: join(here, "..") },
      );
    const ok = run(JSON.stringify(FIXTURE));
    expect(ok.status).toBe(0);
    expect(ok.stdout.split("\n")[0]).toBe(
      'filler,product.name,invalid,"Steam\\u{3164}"',
    );
    expect(ok.stderr).toContain("10 rows, 7 hits");
    const empty = run(JSON.stringify([{ results: [] }]));
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("");
    expect(run("not json").status).toBe(2);
  });
});
