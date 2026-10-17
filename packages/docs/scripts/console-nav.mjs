// The console's navigation table, read from packages/admin/src/console/nav.ts as text: the
// admin package pulls in icon components, so a Node script cannot import it. Shared by the tour
// emitter in gen-reference.mjs and by test/consoleDocsTargets.test.ts.
//
// Reads, in order: the product sections (`SECTIONS`), the Platform group (`PLATFORM_PAGES`) and
// the global pages (`GLOBAL_PAGES`). Each page keeps the fields the docs need.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const navFile = join(
  here,
  "..",
  "..",
  "admin",
  "src",
  "console",
  "nav.ts",
);

const str = (block, field) =>
  new RegExp(`^\\s*${field}: "((?:[^"\\\\]|\\\\.)*)",?$`, "m").exec(block)?.[1];

/** The text between `start` and the first line that equals `end`. */
function slice(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`nav.ts: no "${start}"`);
  const to = text.indexOf(end, from);
  return text.slice(from, to < 0 ? text.length : to);
}

function pages(text) {
  const out = [];
  const marks = [...text.matchAll(/^\s*page: "([a-z0-9-]+)",$/gm)];
  marks.forEach((m, i) => {
    const block = text.slice(m.index, marks[i + 1]?.index ?? text.length);
    // The page's own fields end where its icon is declared and a docs line follows; the block is
    // cut at the next page, so a section header after the last item cannot leak in.
    out.push({
      page: m[1],
      label: str(block, "label"),
      path: str(block, "path") ?? "",
      docs: str(block, "docs"),
      inNav: /^\s*inNav: true,/m.test(block),
      group: str(block, "group"),
      shortcut: str(block, "shortcut"),
      shortcutLabel: str(block, "shortcutLabel"),
    });
  });
  return out;
}

export function readNav(text = readFileSync(navFile, "utf8")) {
  const sectionsText = slice(text, "export const SECTIONS", "\n];\n");
  const sections = [];
  const heads = [
    ...sectionsText.matchAll(
      /^ {2}\{\n {4}key: "([a-z]+)",\n {4}label: "([^"]+)",/gm,
    ),
  ];
  heads.forEach((h, i) => {
    const block = sectionsText.slice(
      h.index,
      heads[i + 1]?.index ?? sectionsText.length,
    );
    const itemsAt = block.indexOf("    items: [");
    const header = block.slice(0, itemsAt);
    sections.push({
      key: h[1],
      label: h[2],
      docs: str(header, "docs"),
      service: str(header, "service"),
      items: pages(block.slice(itemsAt)),
    });
  });
  const platform = pages(slice(text, "const PLATFORM_PAGES", "\n];\n"));
  const globals = pages(
    slice(text, "export const GLOBAL_PAGES", "\n];\n"),
  ).filter((p) => p.group !== "platform");
  return {
    sections,
    platform,
    globals,
    platformDocs: /PLATFORM_GROUP = \{[\s\S]*?docs: "([^"]+)"/.exec(text)?.[1],
  };
}

/** The global shortcuts the keyboard sheet lists, read from admin/src/console/shortcuts.tsx. */
export function readGlobalShortcuts() {
  const text = readFileSync(join(dirname(navFile), "shortcuts.tsx"), "utf8");
  const block = slice(text, "export const GLOBAL_SHORTCUTS", "\n];\n");
  return [
    ...block.matchAll(/keys: "((?:[^"\\]|\\.)*)", label: "([^"]+)"/g),
  ].map((m) => ({ keys: m[1].replace(/\\\\/g, "\\"), label: m[2] }));
}
