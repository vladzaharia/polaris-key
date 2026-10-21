// Puts every Markdown table in the console's table container (docs plan 8.3, 8.5): a labelled,
// focusable region that scrolls sideways on its own (WCAG 1.4.10, the console's `ScrollTable`),
// the table in `DataTable`'s compact classes. The page itself never scrolls sideways at 320 px.
//
// A build step over dist/, not a Markdown plugin: Astro 7's default Markdown processor (Sätteri)
// has no rehype hook, and a second processor for one wrapper is not worth its weight. A region's
// name is unique on the page: the nearest heading above the table plus "table", numbered from the
// second table under one heading. The same text is the table's screen-reader caption. Only bare
// `<table>` elements (what Markdown emits) also take `DataTable`'s classes; a table a component
// renders with its own class keeps its own look and just gains the region.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function styleTable(table: string): string {
  let out = table.replace(/^<table>/, `<table class="${TABLE.table}">`);
  out = out.replace(/<thead(\s[^>]*)?>[\s\S]*?<\/thead>/, (head) => {
    let h = head.replace(/^<thead[^>]*>/, (o) => withClass(o, TABLE.head));
    h = h.replace(/<tr(\s[^>]*)?>/g, (o) => withClass(o, TABLE.headRow));
    h = h.replace(/<th(\s[^>]*)?>/g, (o) => {
      const scoped = / scope="/.test(o)
        ? o
        : o.replace(/^<th/, '<th scope="col"');
      const aligned = / (align|style)="/.test(o);
      return withClass(
        scoped,
        aligned ? TABLE.headCell : `${TABLE.headCell} text-left`,
      );
    });
    return h;
  });
  out = out.replace(/<tbody(\s[^>]*)?>[\s\S]*?<\/tbody>/, (body) => {
    let b = body.replace(/<tr(\s[^>]*)?>/g, (o) =>
      withClass(o, `${TABLE.row} ${TABLE.rowCompact}`),
    );
    b = b.replace(/<td(\s[^>]*)?>/g, (o) => withClass(o, TABLE.cell));
    return b;
  });
  return out;
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
  let wrapped = 0;
  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, "utf8");
    if (!html.includes("<table")) continue;
    const next = wrapTables(html);
    if (next !== html) {
      writeFileSync(file, next);
      wrapped += (next.match(/data-pk-table/g) ?? []).length;
    }
  }
  console.log(`wrap-tables: ${wrapped} table(s) wrapped`);
}
