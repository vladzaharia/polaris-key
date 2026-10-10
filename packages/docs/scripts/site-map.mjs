// The docs site map: every move, split, merge and delete of the docs plan (section 5), and the
// hidden stub that reserves every other target path.
//
//   node scripts/site-map.mjs apply [--include-deferred]   perform the rows and write the stubs
//   node scripts/site-map.mjs redirects                    print the redirect table
//
// `site-map.json` is the only source: astro.config.mjs reads its redirects, test/siteMap.test.ts
// walks it. A row marked `deferred` names a package that is editing the page right now; its
// move waits for that package to merge, then `apply --include-deferred` performs it.
//
// Rules the rows follow (docs plan section 5):
//   move    the page keeps its content at the new path
//   split   the whole page goes to the first target; each other target is a stub
//   merge   the primary row's page is the target; every other row appends its body under its own
//           H2, so nothing leaves the site before a writer joins it
//   delete  the page is removed and redirects to the first target

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
export const docsRoot = join(here, "..");
export const contentRoot = join(docsRoot, "src", "content", "docs");
export const mapFile = join(docsRoot, "site-map.json");

export const loadMap = () => JSON.parse(readFileSync(mapFile, "utf8"));

/** The file for a content id ("build/api"), or null. */
export function fileFor(id, root = contentRoot) {
  for (const ext of [".md", ".mdx"]) {
    const file = join(root, id + ext);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The served route for a content id: "services/license/index" -> "/docs/services/license/". */
export function routeOf(id) {
  const clean = id === "index" ? "" : id.replace(/\/index$/, "");
  return clean === "" ? "/docs/" : `/docs/${clean}/`;
}

/** Splits a file into its frontmatter data and body. */
export function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: yaml.load(m[1]) ?? {}, body: text.slice(m[0].length) };
}

/** Rows that are not deferred. */
export const activeRows = (map, includeDeferred = false) =>
  map.rows.filter((r) => includeDeferred || !r.deferred);

/**
 * The redirects Astro writes: old route (without the base) -> new full URL. A row redirects only
 * once its source page is gone, so a deferred row (page still there) adds none.
 */
export function redirectsFor(map, root = contentRoot) {
  const out = {};
  for (const row of map.rows) {
    if (fileFor(row.from, root)) continue;
    const old = routeOf(row.from).replace(/^\/docs/, "").replace(/\/$/, "");
    out[old === "" ? "/" : old] = routeOf(row.to[0]);
  }
  for (const [from, to] of Object.entries(map.extraRedirects ?? {}))
    out[from] = to;
  return out;
}

/** Rewrites relative imports of a moved .mdx so they still resolve. */
export function fixImports(text, oldFile, newFile) {
  return text.replace(
    /(\bfrom\s+")(\.{1,2}\/[^"]+)(")/g,
    (_all, pre, spec, post) => {
      const abs = resolve(dirname(oldFile), spec);
      let rel = relative(dirname(newFile), abs).split("\\").join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${pre}${rel}${post}`;
    },
  );
}

function move(fromFile, toFile) {
  mkdirSync(dirname(toFile), { recursive: true });
  renameSync(fromFile, toFile);
  if (toFile.endsWith(".mdx")) {
    const text = readFileSync(toFile, "utf8");
    const next = fixImports(text, fromFile, toFile);
    if (next !== text) writeFileSync(toFile, next);
  }
}

/** The stub page for a map entry. */
export function renderStub(stub, nearestTitle, file) {
  const q = (s) => JSON.stringify(s);
  const mdx = Boolean(stub.messages?.length);
  const lines = [
    "---",
    `title: ${q(stub.title)}`,
    `description: ${q(stub.description)}`,
    `type: ${q(stub.type)}`,
    `status: "stub"`,
    "sidebar:",
    "  hidden: true",
    "pagefind: false",
    "head:",
    "  - tag: meta",
    "    attrs:",
    "      name: robots",
    "      content: noindex",
    "---",
    "",
  ];
  if (mdx) {
    const depth = stub.path.split("/").length;
    const up = "../".repeat(depth + 1); // src/content/docs/<path> -> src/
    lines.push(
      `import HelpMessage from "${up}components/docs/HelpMessage.astro";`,
      "",
    );
  }
  lines.push(
    `Placeholder page. See [${nearestTitle}](${stub.nearest}) for the nearest live page.`,
    "",
  );
  for (const a of stub.anchors ?? [])
    lines.push(`<h2 id=${q(a.id)}>${a.title}</h2>`, "");
  for (const id of stub.messages ?? [])
    lines.push(`<HelpMessage id=${q(id)} />`, "");
  void file;
  return lines.join("\n");
}

function titleOfRoute(map, route, root) {
  const id = route.replace(/^\/docs\//, "").replace(/\/$/, "") || "index";
  const file = fileFor(id, root) ?? fileFor(`${id}/index`, root);
  if (file) return splitFrontmatter(readFileSync(file, "utf8")).data.title ?? id;
  const stub = map.stubs.find((s) => s.path === id);
  return stub?.title ?? "the docs home";
}

export function apply({ includeDeferred = false, root = contentRoot } = {}) {
  const map = loadMap();
  const rows = activeRows(map, includeDeferred).filter(
    (r) => fileFor(r.from, root),
  );
  const log = [];
  // 1. Pages that land at a path: moves, split first targets, primary merges.
  for (const row of rows) {
    const isBase =
      row.action === "move" ||
      row.action === "split" ||
      (row.action === "merge" && row.primary === true);
    if (!isBase) continue;
    move(fileFor(row.from, root), join(root, row.to[0] + extOf(fileFor(row.from, root))));
    log.push(`${row.action} ${row.from} -> ${row.to[0]}`);
  }
  // 2. Appends and deletes.
  for (const row of rows) {
    const source = fileFor(row.from, root);
    if (!source) continue;
    if (row.action === "merge" && row.primary !== true) {
      const target = fileFor(row.to[0], root);
      if (!target) throw new Error(`merge target ${row.to[0]} does not exist`);
      if (source.endsWith(".mdx") || target.endsWith(".mdx"))
        throw new Error(`merge of ${row.from} into ${row.to[0]}: md only`);
      const { data, body } = splitFrontmatter(readFileSync(source, "utf8"));
      const current = readFileSync(target, "utf8").replace(/\s*$/, "\n");
      writeFileSync(
        target,
        `${current}\n## ${data.title ?? row.from}\n\n${body.trim()}\n`,
      );
      rmSync(source);
      log.push(`merge ${row.from} -> ${row.to[0]}`);
    } else if (row.action === "delete") {
      rmSync(source);
      log.push(`delete ${row.from}`);
    }
  }
  // 3. Stubs, once everything else is in place so each can name its nearest page.
  for (const stub of map.stubs) {
    if (fileFor(stub.path, root)) continue;
    const ext = stub.messages?.length ? ".mdx" : ".md";
    const file = join(root, stub.path + ext);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      renderStub(stub, titleOfRoute(map, stub.nearest, root), file),
    );
    log.push(`stub ${stub.path}`);
  }
  return log;
}

const extOf = (file) => (file.endsWith(".mdx") ? ".mdx" : ".md");

/** Every content id under a root. */
export function allIds(root = contentRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.mdx?$/.test(name))
        out.push(
          posix.normalize(relative(root, full).split("\\").join("/")).replace(/\.mdx?$/, ""),
        );
    }
  };
  walk(root);
  return out.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cmd = process.argv[2];
  if (cmd === "apply") {
    const log = apply({ includeDeferred: process.argv.includes("--include-deferred") });
    console.log(log.join("\n"));
    console.log(`site-map: ${log.length} changes`);
  } else if (cmd === "redirects") {
    console.log(JSON.stringify(redirectsFor(loadMap()), null, 2));
  } else {
    console.error("usage: site-map.mjs apply [--include-deferred] | redirects");
    process.exit(2);
  }
}
