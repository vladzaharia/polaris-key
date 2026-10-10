/**
 * The site map's contract (docs plan section 5): every page that existed before the restructure
 * still resolves, every redirect lands on a page, and the mechanical moves left page text alone.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeRows,
  allIds,
  contentRoot,
  fileFor,
  fixImports,
  loadMap,
  redirectsFor,
  routeOf,
  splitFrontmatter,
} from "../scripts/site-map.mjs";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const map = loadMap() as {
  rows: {
    from: string;
    action: "move" | "split" | "merge" | "delete";
    to: string[];
    primary?: boolean;
    deferred?: string;
  }[];
  stubs: {
    path: string;
    type: string;
    title: string;
    nearest: string;
    messages?: string[];
  }[];
  extraRedirects: Record<string, string>;
};
const old = JSON.parse(
  readFileSync(join(docsRoot, "old-pages.json"), "utf8"),
) as {
  pages: string[];
};
const redirects = redirectsFor(map);
const ids = new Set(allIds());

/** The content id a redirect target route names, or null. */
function idOfRoute(route: string): string | null {
  const bare = route.replace(/^\/docs\//, "").replace(/\/$/, "");
  if (bare === "") return "index";
  if (ids.has(bare)) return bare;
  if (ids.has(`${bare}/index`)) return `${bare}/index`;
  return null;
}

describe("every old page still resolves", () => {
  it("is still a page, or a redirect forwards it to one", () => {
    const lost: string[] = [];
    for (const id of old.pages) {
      // A page moved to `<id>/index` keeps its route.
      if (ids.has(id) || ids.has(`${id}/index`)) continue;
      const route =
        routeOf(id)
          .replace(/^\/docs/, "")
          .replace(/\/$/, "") || "/";
      const target = redirects[route];
      if (target === undefined) lost.push(`${id}: no page and no redirect`);
      else if (idOfRoute(target) === null)
        lost.push(`${id}: redirects to ${target}, which is not a page`);
    }
    expect(lost).toEqual([]);
  });

  it("a redirect never shadows a live page", () => {
    for (const from of Object.keys(redirects)) {
      const id = from === "/" ? "index" : from.slice(1);
      expect(ids.has(id) || ids.has(`${id}/index`), from).toBe(false);
    }
  });

  it("every redirect lands on a stub or a page", () => {
    for (const [from, to] of Object.entries(redirects))
      expect(idOfRoute(to), `${from} -> ${to}`).not.toBeNull();
  });
});

describe("the rows", () => {
  it("name pages that existed", () => {
    const before = new Set(old.pages);
    for (const row of map.rows)
      expect(before.has(row.from), row.from).toBe(true);
  });

  it("each old page has one row", () => {
    const froms = map.rows.map((r) => r.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("have their pages at the first target once applied, or are deferred", () => {
    for (const row of map.rows) {
      if (row.deferred) {
        expect(fileFor(row.from), `deferred ${row.from} stays`).not.toBeNull();
        continue;
      }
      expect(fileFor(row.from), `${row.from} is gone`).toBeNull();
      expect(fileFor(row.to[0]!), `${row.to[0]} exists`).not.toBeNull();
    }
  });

  it("every merge target has exactly one base", () => {
    const targets = new Map<string, string[]>();
    for (const r of activeRows(map, true)) {
      if (r.action === "merge" && r.primary === true)
        targets.set(r.to[0]!, [...(targets.get(r.to[0]!) ?? []), r.from]);
      if (r.action === "move" || r.action === "split")
        targets.set(r.to[0]!, [...(targets.get(r.to[0]!) ?? []), r.from]);
    }
    for (const r of map.rows.filter((x) => x.action === "merge")) {
      const bases = targets.get(r.to[0]!) ?? [];
      // A merge into a page that was never a row's target (contribute/corpus) has its base in place.
      expect(bases.length <= 1, `${r.to[0]}: ${bases.join(", ")}`).toBe(true);
    }
  });

  it("deferred rows name the package that is editing the page", () => {
    for (const r of map.rows.filter((x) => x.deferred))
      expect(r.deferred, r.from).toMatch(/^[A-Z]+-\d+[a-z]?$/);
  });
});

describe("stubs", () => {
  it("exist (or were replaced by a written page) and never shadow a row's page", () => {
    for (const s of map.stubs) {
      expect(fileFor(s.path), s.path).not.toBeNull();
      expect(
        map.rows.some((r) => r.from === s.path),
        s.path,
      ).toBe(false);
    }
  });

  it("each live stub is hidden from the sidebar, search and robots", () => {
    for (const s of map.stubs) {
      const { data } = splitFrontmatter(readFileSync(fileFor(s.path)!, "utf8"));
      if (data.status !== "stub") continue; // a writer replaced it
      expect(data.sidebar?.hidden, `${s.path} sidebar`).toBe(true);
      expect(data.pagefind, `${s.path} pagefind`).toBe(false);
      expect(JSON.stringify(data.head), `${s.path} robots`).toContain(
        "noindex",
      );
      expect(data.type, `${s.path} type`).toBe(s.type);
      expect(data.title, `${s.path} title`).toBe(s.title);
    }
  });

  it("each points at a nearest page that is live", () => {
    for (const s of map.stubs) {
      const target = idOfRoute(s.nearest);
      expect(target, `${s.path} -> ${s.nearest}`).not.toBeNull();
      const { data } = splitFrontmatter(
        readFileSync(fileFor(target!)!, "utf8"),
      );
      expect(
        data.status,
        `${s.path}: the nearest page ${s.nearest} is a stub`,
      ).not.toBe("stub");
    }
  });
});

describe("fixImports", () => {
  it("keeps a moved page's relative imports pointing at the same file", () => {
    const text =
      'import { Content } from "../../../../../../docs/RUNBOOK.md";\n';
    const from = join(contentRoot, "admin", "kek.mdx");
    const to = join(contentRoot, "operate", "platform", "runbook", "index.mdx");
    expect(fixImports(text, from, to)).toBe(
      'import { Content } from "../../../../../../../../docs/RUNBOOK.md";\n',
    );
  });
});
