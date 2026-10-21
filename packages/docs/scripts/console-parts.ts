// Build step over dist/ that makes Markdown output use the console's parts (docs plan 8.2, 8.3):
//
// - Tables: every table sits in a labelled, focusable region that scrolls sideways on its own
//   (WCAG 1.4.10, the console's `ScrollTable`), the table in `DataTable`'s compact classes.
//   `src/scripts/regions.ts` takes the tab stop away while the region fits. A region's name is
//   unique on the page: the nearest heading above the table plus "table", numbered from the
//   second table under one heading; the same text is the table's screen-reader caption. Only
//   bare `<table>` elements (what Markdown emits) also take `DataTable`'s classes; a table a
//   component renders with its own class keeps its own look and just gains the region.
// - Asides: a `:::note` / `:::tip` / `:::caution` / `:::danger` block is a Starlight aside; it is
//   re-rendered through the console's `Callout` (note is info, tip success, caution warning,
//   danger danger), so the site has one callout look.
// - The React client bundle Astro emits for the renderer is deleted when no page loads it: the
//   docs render the console's components at build time and ship no component JavaScript.
//
// A build step, not a Markdown plugin: Astro 7's default Markdown processor (Satteri) has no
// rehype hook, and a second processor for one wrapper is not worth its weight.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Callout } from "../../admin/src/ui/Callout.tsx";
import { TABLE } from "../../admin/src/ui/classes.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* htmlFiles(full);
    else if (entry.endsWith(".html")) yield full;
  }
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const plain = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Adds classes to a tag's opening string, keeping every attribute it has. */
function withClass(open: string, classes: string): string {
  if (/\sclass="/.test(open))
    return open.replace(
      /\sclass="([^"]*)"/,
      (_, c) => ` class="${c} ${classes}"`,
    );
  return open.replace(/^<(\w+)/, `<$1 class="${classes}"`);
}

/** Columns whose cells hold running text (longer than a label): they get a readable minimum. */
function proseColumns(table: string): Set<number> {
  const prose = new Set<number>();
  for (const row of table.match(/<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/g) ?? []) {
    [...row.matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/g)].forEach(
      (cell, i) => {
        if (plain(cell[1] ?? "").length > 60) prose.add(i);
      },
    );
  }
  return prose;
}

/** Applies `fn` to the opening tag of every cell of a row, with the cell's column index. */
function eachCell(
  row: string,
  tag: "th" | "td",
  fn: (open: string, column: number) => string,
): string {
  let column = 0;
  return row.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"), (open) =>
    fn(open, column++),
  );
}

function styleTable(table: string): string {
  const prose = proseColumns(table);
  const proseClass = (column: number): string =>
    prose.has(column) ? ` ${TABLE.proseCell}` : "";
  let out = table.replace(/^<table>/, `<table class="${TABLE.table}">`);
  out = out.replace(/<thead(\s[^>]*)?>[\s\S]*?<\/thead>/, (head) => {
    let h = head.replace(/^<thead[^>]*>/, (o) => withClass(o, TABLE.head));
    h = h.replace(/<tr(\s[^>]*)?>[\s\S]*?<\/tr>/g, (row) =>
      eachCell(
        row.replace(/^<tr(\s[^>]*)?>/, (o) => withClass(o, TABLE.headRow)),
        "th",
        (o, column) => {
          const scoped = / scope="/.test(o)
            ? o
            : o.replace(/^<th/, '<th scope="col"');
          const aligned = / (align|style)="/.test(o);
          return withClass(
            scoped,
            (aligned ? TABLE.headCell : `${TABLE.headCell} text-left`) +
              proseClass(column),
          );
        },
      ),
    );
    return h;
  });
  out = out.replace(/<tbody(\s[^>]*)?>[\s\S]*?<\/tbody>/, (body) =>
    body.replace(/<tr(\s[^>]*)?>[\s\S]*?<\/tr>/g, (row) =>
      eachCell(
        row.replace(/^<tr(\s[^>]*)?>/, (o) =>
          withClass(o, `${TABLE.row} ${TABLE.rowCompact}`),
        ),
        "td",
        (o, column) => withClass(o, TABLE.cell + proseClass(column)),
      ),
    ),
  );
  return out;
}

const ASIDE =
  /<aside aria-label="([^"]*)" class="starlight-aside starlight-aside--(note|tip|caution|danger)"><p class="starlight-aside__title" aria-hidden="true">[\s\S]*?<\/p><div class="starlight-aside__content">([\s\S]*?)<\/div><\/aside>/g;
const TONE = {
  note: "info",
  tip: "success",
  caution: "warning",
  danger: "danger",
} as const;

/** Re-renders Starlight asides through the console's Callout. */
export function convertAsides(html: string): string {
  return html.replace(
    ASIDE,
    (_m, label: string, type: keyof typeof TONE, inner: string) => {
      const title = label
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      const callout = renderToStaticMarkup(
        createElement(
          Callout,
          { tone: TONE[type], title },
          createElement("div", { dangerouslySetInnerHTML: { __html: inner } }),
        ),
      );
      return `<div class="pk-callout not-content my-4" data-callout="${type}">${callout}</div>`;
    },
  );
}

export function wrapTables(html: string): string {
  // Only the article body: the chrome has no Markdown tables.
  let heading = "Page";
  const seen = new Map<string, number>();
  const token =
    /<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>|<table(?:\s[^>]*)?>[\s\S]*?<\/table>/g;
  return html.replace(token, (m, h: string | undefined, offset: number) => {
    if (h !== undefined) {
      heading = plain(h).replace(/\s*(Section titled.*)$/i, "") || heading;
      return m;
    }
    if (html.slice(Math.max(0, offset - 20), offset).endsWith("data-pk-table>"))
      return m;
    const n = (seen.get(heading) ?? 0) + 1;
    seen.set(heading, n);
    const label = escape(`${heading} table${n > 1 ? ` ${n}` : ""}`);
    const bare = m.startsWith("<table>");
    const alreadyCaptioned = /<caption[\s>]/.test(m);
    const styled = (bare ? styleTable(m) : m).replace(
      /^(<table[^>]*>)/,
      alreadyCaptioned ? "$1" : `$1<caption class="sr-only">${label}</caption>`,
    );
    return `<div role="region" aria-label="${label}" tabindex="0" class="${TABLE.scroller}" data-pk-table>${styled}</div>`;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let tables = 0;
  let asides = 0;
  const pages: string[] = [];
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, "utf8");
    pages.push(html);
    if (!html.includes("<table") && !html.includes("starlight-aside")) continue;
    const next = convertAsides(wrapTables(html));
    if (next !== html) {
      writeFileSync(file, next);
      tables += (next.match(/data-pk-table/g) ?? []).length;
      asides += (html.match(/class="starlight-aside /g) ?? []).length;
    }
  }
  // Astro's React client entry: delete it when nothing references it.
  const assets = join(dist, "_astro");
  let removed = 0;
  for (const f of readdirSync(assets).filter((n) =>
    /^client\..*\.js$/.test(n),
  )) {
    if (pages.some((h) => h.includes(f))) continue;
    rmSync(join(assets, f));
    removed++;
  }
  console.log(
    `console-parts: ${tables} table(s) wrapped, ${asides} aside(s) as callouts, ${removed} unused client bundle(s) removed`,
  );
}
