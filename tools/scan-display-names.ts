// DISPLAY-NAME-INVISIBLE D-12: the read-only production scan that runs before the Worker deploy
// carrying the new display-name rule. It reads the JSON `wrangler d1 execute --json` prints on
// stdin, checks every product name, listing name and listing developer name with the manifest's
// own `checkDisplayName`, and prints one line per name that fails:
//
//   slug,field,verdict,name        verdict: invalid | reserved; name: JSON, invisibles as \u{...}
//
// It writes nothing, opens no network connection and reads no file: stdin in, stdout out. The
// rows are `t, slug, name, developer_name`, where `t` is `product`, `listing` or `listing-locale`
// (a per-locale listing name, `dist_listing_locales.name`; see
// docs/RUNBOOK.md, "Display-name scan"). `invalid` is renamed in the console before the deploy,
// since an unchanged manifest that holds one fails its next resync. `reserved` is judged by the
// code's floor only: the platform's extra terms and a product's approval live in settings this
// scan does not read, so a `reserved` hit may already be approved.
//
//   <wrangler ... --json --command "..."> | pnpm tsx tools/scan-display-names.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DISPLAY_NAME_KEPT,
  DISPLAY_NAME_REFUSED,
  checkDisplayName,
} from "../packages/shared-manifest/src/displayName.js";

export interface ScanHit {
  slug: string;
  field: string;
  verdict: "invalid" | "reserved";
  name: string;
}

type Row = Record<string, unknown>;

const inRanges = (
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** The rows of a `wrangler d1 execute --json` document, or of a bare row array. */
export function rowsOf(doc: unknown): Row[] {
  const items = Array.isArray(doc) ? doc : [doc];
  const rows: Row[] = [];
  for (const item of items) {
    const results =
      item && typeof item === "object" && "results" in item
        ? (item as { results: unknown }).results
        : item;
    if (Array.isArray(results)) {
      for (const r of results)
        if (r && typeof r === "object") rows.push(r as Row);
    } else if (results && typeof results === "object")
      rows.push(results as Row);
  }
  return rows;
}

/** Every product, listing or developer name in `rows` that fails `checkDisplayName`. */
export function scanRows(rows: readonly Row[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    const table =
      row.t === "listing" || row.t === "listing-locale" ? row.t : "product";
    const fields: [string, unknown][] = [
      [
        table === "listing-locale" ? "listing.locale.name" : `${table}.name`,
        row.name,
      ],
      ...(table === "listing"
        ? ([["listing.developerName", row.developer_name]] as [
            string,
            unknown,
          ][])
        : []),
    ];
    for (const [field, value] of fields) {
      if (typeof value !== "string" || value === "") continue;
      const verdict = checkDisplayName(value, { slug });
      if (verdict) hits.push({ slug, field, verdict, name: value });
    }
  }
  return hits;
}

/** The name as a JSON string, each invisible or non-space whitespace code point spelled `\u{...}`. */
export function showName(name: string): string {
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    const hidden =
      inRanges(cp, DISPLAY_NAME_REFUSED) ||
      inRanges(cp, DISPLAY_NAME_KEPT) ||
      (/\s/u.test(ch) && ch !== " ");
    out += hidden
      ? `\\u{${cp.toString(16).toUpperCase()}}`
      : JSON.stringify(ch).slice(1, -1);
  }
  return `"${out}"`;
}

export function formatHits(hits: readonly ScanHit[]): string {
  return hits
    .map((h) => `${h.slug},${h.field},${h.verdict},${showName(h.name)}`)
    .join("\n");
}

function main(): number {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("scan-display-names: stdin is not JSON\n");
    return 2;
  }
  const rows = rowsOf(doc);
  const hits = scanRows(rows);
  if (hits.length > 0) process.stdout.write(`${formatHits(hits)}\n`);
  process.stderr.write(
    `scan-display-names: ${rows.length} rows, ${hits.length} hits\n`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main();
