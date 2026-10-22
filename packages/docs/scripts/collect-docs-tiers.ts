// The per-file tier pass over the built site (DOC-03b): writes the Worker's
// `docsTiers.generated.ts`, run by `pnpm build` after the pages are final.
//
//   - A file under `/_astro/` (styles, fonts, script chunks, imported images) is public when any
//     public page, or any file a public page loads, names it. A file only gated pages reference
//     takes the lowest tier among them, so every reader who can open a referencing page can load
//     it and nobody else can. Gated-only files are listed; every other file under `/_astro/`
//     stays public.
//   - A moved-page redirect page (`/docs/users/...`) is served at its TARGET's tier, so a
//     sessionless reader of an old Help link reaches Help and not the access page.
//
// The Worker reads the table in `docsTierOf` (packages/worker/src/docs.ts); a Worker test pins it
// to a fresh sweep of the built site.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { doorOf, type Tier } from "../src/lib/doors";
// @ts-expect-error plain .mjs
import { isRedirectPage, redirectTarget } from "./redirect-fragments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RANK: Record<Tier, number> = { public: 0, member: 1, admin: 2 };

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

const idOfRoute = (route: string): string =>
  route
    .replace(/^\/docs\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "") || "index";

const tierOfRoute = (route: string): Tier =>
  doorOf(idOfRoute(route))?.tier ?? "admin";

/**
 * Astro names a processed asset `<name>.<hash>.<ext>`: the hash is the last dot-separated segment
 * before the extension, 8 characters of base64url. The table is keyed without it so the generated
 * file is the same on every machine (macOS and Linux sharp/libvips emit different image bytes,
 * hence different hashes). The Worker carries the same pattern in `stripAstroHash`
 * (packages/worker/src/docs.ts); a Worker test pins the two to each other.
 */
export const ASTRO_HASH = /^([^/]+)\.[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$/;
export const stripAstroHash = (name: string): string =>
  name.replace(ASTRO_HASH, "$1$2");

export interface DocsTiers {
  /** `/docs/_astro/<file without its hash segment>` -> tier, for the files no public page loads. */
  assets: Record<string, Exclude<Tier, "public">>;
  /** The resolved path of each moved-page redirect page -> its target's tier. */
  redirects: Record<string, Tier>;
}

export function collectDocsTiers(dist: string): DocsTiers {
  const astroDir = join(dist, "_astro");
  const names = new Set<string>(
    existsSync(astroDir) ? readdirSync(astroDir) : [],
  );
  const rank = new Map<string, number>();
  const tokens = (text: string): string[] =>
    (text.match(/[A-Za-z0-9_.\-]+\.[a-z0-9]+/g) ?? []).filter((t) =>
      names.has(t),
    );
  const lower = (name: string, r: number): boolean => {
    if (r >= (rank.get(name) ?? 99)) return false;
    rank.set(name, r);
    return true;
  };

  const redirects: Record<string, Tier> = {};
  const redirectOf = new Map<string, string>();
  for (const file of files(dist)) {
    if (!file.endsWith(".html")) continue;
    const rel = "/docs/" + relative(dist, file).split(sep).join("/");
    const html = readFileSync(file, "utf8");
    if (isRedirectPage(html)) {
      const target = redirectTarget(html) as string | null;
      if (target?.startsWith("/docs/")) redirectOf.set(rel, target);
      continue;
    }
    const route = rel.replace(/index\.html$/, "");
    const r = RANK[tierOfRoute(route === "/docs/" ? "/docs/" : route)];
    for (const t of tokens(html)) lower(t, r);
  }
  // A file loads the files it names (a stylesheet's fonts, a chunk's imports): they take its tier.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, r] of [...rank]) {
      if (!/\.(css|js|svg)$/.test(name)) continue;
      const text = readFileSync(join(astroDir, name), "utf8");
      for (const t of tokens(text))
        if (t !== name && lower(t, r)) changed = true;
    }
  }
  const assets: DocsTiers["assets"] = {};
  const TIERS: Tier[] = ["public", "member", "admin"];
  // Two different files that lose their hash to the same name cannot share a table row: fail
  // rather than let one tier silently cover the other (a gated row would also gate a public file).
  const byStable = new Map<string, string[]>();
  for (const name of names) {
    const key = stripAstroHash(name);
    byStable.set(key, [...(byStable.get(key) ?? []), name]);
  }
  for (const [name, r] of [...rank].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (r === 0) continue;
    const key = stripAstroHash(name);
    const same = byStable.get(key) ?? [name];
    if (same.length > 1)
      throw new Error(
        `collect-docs-tiers: ${same.join(", ")} share the stable name ${key} once the hash is stripped; rename a source asset`,
      );
    assets[`/docs/_astro/${key}`] = TIERS[r] as "member" | "admin";
  }

  for (const [page, target] of [...redirectOf].sort()) {
    let route = target;
    for (let hops = 0; hops < 5; hops += 1) {
      const next = redirectOf.get(
        route.replace(/[?#].*$/, "").replace(/\/?$/, "/") + "index.html",
      );
      if (!next) break;
      route = next;
    }
    redirects[page] = tierOfRoute(route);
  }
  return { assets, redirects };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = join(here, "..", "dist");
  const out = join(here, "..", "..", "worker", "src", "docsTiers.generated.ts");
  const { assets, redirects } = collectDocsTiers(dist);
  const body = (o: Record<string, string>) =>
    "{\n" +
    Object.entries(o)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`)
      .join("") +
    "}";
  writeFileSync(
    out,
    `// GENERATED FILE — do not edit by hand.
//
// Written by \`packages/docs/scripts/collect-docs-tiers.ts\` after every docs-site build: the
// per-file tiers the path prefixes cannot say. \`docsTierOf\` (src/docs.ts) reads it.

/** Files under \`/docs/_astro/\` that no public page loads, with the lowest tier that loads them. */
export const DOCS_ASSET_TIERS: Readonly<Record<string, "member" | "admin">> = ${body(assets)};

/** Moved-page redirect pages (resolved path), at their target's tier. */
export const DOCS_REDIRECT_TIERS: Readonly<
  Record<string, "public" | "member" | "admin">
> = ${body(redirects)};
`,
  );
  console.log(
    `collect-docs-tiers: ${Object.keys(assets).length} gated-only assets, ${Object.keys(redirects).length} redirect pages -> ${relative(process.cwd(), out)}`,
  );
}
