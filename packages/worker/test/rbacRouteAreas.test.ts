/**
 * The area drift gate (ST-29; ST-28 plan §2.7). Bindings name areas, not routes, so a route that
 * changes area silently changes who may call it. `fixtures/rbac-route-areas.json` records every
 * route's ORIGINAL area, `METHOD path → area`:
 *
 *   - a new or removed route updates the fixture in the same change;
 *   - a route's area is never edited in the fixture: a move is an `AREA_MOVES` entry
 *     (`core/rbac/areas.ts`), and the route's area must equal the fixture's with the moves applied;
 *   - a move **into a new area** (one no pinned route had: a split) names its rewrite migration by
 *     suffix (`_rbac_move_<n>.sql`, found under `migrations/`), which gives holders of `from` the
 *     new area too, so it widens no one;
 *   - a move **into an existing area** rewrites nothing, so holders of `from` lose the route; it is
 *     marked `narrows: true`, needs the security reviewer's sign-off, and is refused with a
 *     migration, because rewriting bindings into an existing area would widen every holder of
 *     `from` to every route of `to`.
 *
 * The sidebar (`nav.ts`) is never an input.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_ROUTES } from "../src/console/routes.js";
import { routeKey } from "../src/console/routeMatch.js";
import { AREA_IDS, AREA_MOVES, type AreaMove } from "../src/core/rbac/areas.js";

const here = dirname(fileURLToPath(import.meta.url));
const PINNED = JSON.parse(
  readFileSync(join(here, "fixtures", "rbac-route-areas.json"), "utf8"),
) as Record<string, string>;
const MIGRATIONS = readdirSync(join(here, "..", "migrations")).filter((f) =>
  f.endsWith(".sql"),
);

interface Inputs {
  /** `METHOD path → area` for every route now. */
  current: Record<string, string>;
  /** The fixture: every route's original area. */
  pinned: Record<string, string>;
  moves: readonly AreaMove[];
  areas: readonly string[];
  migrations: readonly string[];
}

/** Every way the inputs break the gate, as readable strings. */
function checkRouteAreas(i: Inputs): string[] {
  const out: string[] = [];
  const movesFor = (route: string) => i.moves.filter((m) => m.route === route);

  for (const m of i.moves) {
    const at = `AREA_MOVES ${m.route} (${m.from} → ${m.to})`;
    if (!(m.route in i.pinned) || !(m.route in i.current))
      out.push(`${at}: no such route`);
    if (!i.areas.includes(m.to) || !i.areas.includes(m.from))
      out.push(`${at}: an area is not in AREAS`);
    // `to` is new when no pinned route outside this split had it.
    const toWasUsed = Object.entries(i.pinned).some(
      ([route, area]) =>
        area === m.to &&
        !i.moves.some((x) => x.route === route && x.to === m.to),
    );
    if (m.migration && m.narrows)
      out.push(`${at}: a move either rewrites bindings or narrows, not both`);
    else if (m.migration) {
      if (toWasUsed)
        out.push(
          `${at}: refused: rewriting bindings into an existing area widens every holder of ${m.from}`,
        );
      if (!/^_rbac_move_\d+\.sql$/.test(m.migration))
        out.push(`${at}: migration is a suffix, _rbac_move_<n>.sql`);
      else if (!i.migrations.some((f) => f.endsWith(m.migration!)))
        out.push(`${at}: no migration file ends in ${m.migration}`);
    } else if (m.narrows) {
      if (!toWasUsed)
        out.push(
          `${at}: a move into a new area is a split: name its rewrite migration`,
        );
    } else out.push(`${at}: name a migration (a split) or narrows: true`);
  }

  for (const [route, area] of Object.entries(i.current)) {
    if (!(route in i.pinned)) {
      out.push(`${route}: new route: add it to fixtures/rbac-route-areas.json`);
      continue;
    }
    let expected = i.pinned[route]!;
    for (const m of movesFor(route)) {
      if (m.from !== expected)
        out.push(
          `${route}: AREA_MOVES says from ${m.from}, but it was ${expected}`,
        );
      expected = m.to;
    }
    if (area !== expected)
      out.push(
        `${route}: area ${area}, pinned ${expected}: a move needs an AREA_MOVES entry`,
      );
  }
  for (const route of Object.keys(i.pinned))
    if (!(route in i.current))
      out.push(
        `${route}: removed route: remove it from fixtures/rbac-route-areas.json`,
      );
  return out;
}

function currentAreas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of ADMIN_ROUTES) out[routeKey(r)] = r.area;
  return out;
}

describe("the admin route areas", () => {
  it("has one row per METHOD and path", () => {
    const keys = ADMIN_ROUTES.map(routeKey);
    const dupes = keys.filter((k, n) => keys.indexOf(k) !== n);
    expect(dupes).toEqual([]);
  });

  it("match the pinned fixture with AREA_MOVES applied", () => {
    expect(
      checkRouteAreas({
        current: currentAreas(),
        pinned: PINNED,
        moves: AREA_MOVES,
        areas: AREA_IDS,
        migrations: MIGRATIONS,
      }),
    ).toEqual([]);
  });

  it("name an area of AREAS, or byKey for settings/:key and claims/:key alone", () => {
    for (const r of ADMIN_ROUTES) {
      if (r.area === "byKey")
        expect(r.path, routeKey(r)).toMatch(
          /^\/products\/:slug\/(settings|claims)\/:key$/,
        );
      else expect(AREA_IDS, routeKey(r)).toContain(r.area);
    }
  });
});

describe("the gate refuses", () => {
  const pinned = {
    "GET /products/:slug/license/**": "license",
    "GET /products/:slug/ci-tokens": "keys",
  };
  const base = (over: Partial<Inputs>): string[] =>
    checkRouteAreas({
      current: { ...pinned },
      pinned,
      moves: [],
      areas: [...AREA_IDS, "tokens"],
      migrations: ["0042_rbac_move_1.sql"],
      ...over,
    });

  it("nothing when nothing moved", () => {
    expect(base({})).toEqual([]);
  });

  it("an area change without an AREA_MOVES entry", () => {
    expect(
      base({ current: { ...pinned, "GET /products/:slug/ci-tokens": "ship" } }),
    ).toEqual([expect.stringMatching(/needs an AREA_MOVES entry/)]);
  });

  it("a new route missing from the fixture, and a removed one left in it", () => {
    expect(
      base({
        current: {
          "GET /products/:slug/license/**": "license",
          "GET /products/:slug/new": "core",
        },
      }),
    ).toEqual([
      expect.stringMatching(/new route/),
      expect.stringMatching(/removed route/),
    ]);
  });

  it("accepts a split into a new area with its rewrite migration", () => {
    const move: AreaMove = {
      route: "GET /products/:slug/ci-tokens",
      from: "keys",
      to: "tokens" as never,
      migration: "_rbac_move_1.sql",
    };
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "tokens" },
        moves: [move],
      }),
    ).toEqual([]);
  });

  it("a split whose migration file is missing", () => {
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "tokens" },
        moves: [
          {
            route: "GET /products/:slug/ci-tokens",
            from: "keys",
            to: "tokens" as never,
            migration: "_rbac_move_2.sql",
          },
        ],
      }),
    ).toEqual([expect.stringMatching(/no migration file ends in/)]);
  });

  it("a rewrite of bindings into an existing area (it would widen every holder of from)", () => {
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "license" },
        moves: [
          {
            route: "GET /products/:slug/ci-tokens",
            from: "keys",
            to: "license",
            migration: "_rbac_move_1.sql",
          },
        ],
      }),
    ).toEqual([expect.stringMatching(/refused: rewriting bindings/)]);
  });

  it("accepts a narrowing into an existing area, which rewrites nothing", () => {
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "license" },
        moves: [
          {
            route: "GET /products/:slug/ci-tokens",
            from: "keys",
            to: "license",
            narrows: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("a narrowing into a new area, and a move that names neither kind", () => {
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "tokens" },
        moves: [
          {
            route: "GET /products/:slug/ci-tokens",
            from: "keys",
            to: "tokens" as never,
            narrows: true,
          },
        ],
      }),
    ).toEqual([expect.stringMatching(/is a split/)]);
    expect(
      base({
        current: { ...pinned, "GET /products/:slug/ci-tokens": "license" },
        moves: [
          {
            route: "GET /products/:slug/ci-tokens",
            from: "keys",
            to: "license",
          },
        ],
      }),
    ).toEqual([expect.stringMatching(/name a migration/)]);
  });

  it("a stale move for a route that does not exist", () => {
    expect(
      base({
        moves: [
          {
            route: "GET /products/:slug/gone",
            from: "keys",
            to: "license",
            narrows: true,
          },
        ],
      }),
    ).toEqual([expect.stringMatching(/no such route/)]);
  });
});
