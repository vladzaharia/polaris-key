/**
 * The three doors, the access tiers and the sidebar data (docs plan sections 3.1, 3.2): every
 * page belongs to a door and a tier by its directory, the sidebar lists every live page once and
 * no stub, and a stub is hidden from the sidebar, search and robots.
 */

import { describe, expect, it } from "vitest";
import {
  DOOR_TREES,
  TIER_PREFIXES,
  doorOf,
  slugOf,
  starlightSidebar,
  treeIds,
} from "../src/lib/doors";
import {
  allIds,
  fileFor,
  loadMap,
  splitFrontmatter,
} from "../scripts/site-map.mjs";
import { readFileSync } from "node:fs";

const map = loadMap() as {
  rows: { from: string; deferred?: string }[];
};
const ids = allIds();
const statusOf = (id: string): unknown =>
  splitFrontmatter(readFileSync(fileFor(id)!, "utf8")).data.status;
// Underscore files are unpublished templates.
const live = ids.filter(
  (id) => statusOf(id) !== "stub" && !id.split("/").pop()!.startsWith("_"),
);
/** Pages a deferred row is about to move or delete: listed in the sidebar until the move. */
const deferred = new Set(map.rows.filter((r) => r.deferred).map((r) => r.from));

describe("doors and tiers come from the directory", () => {
  it("every page belongs to a door and a tier", () => {
    const orphans = ids.filter((id) => doorOf(id) === null);
    expect(orphans).toEqual([]);
  });

  it.each([
    ["index", "landing", "public"],
    ["access", "landing", "public"],
    ["help/activate", "help", "public"],
    ["help/messages/devices", "help", "public"],
    ["start/first-product", "developers", "public"],
    ["build/install", "developers", "public"],
    ["features/licensing/model", "developers", "public"],
    ["reference/protocol/envelope", "developers", "public"],
    ["operate/index", "operate", "member"],
    ["operate/console/products", "operate", "member"],
    ["operate/platform/deploy", "operate", "admin"],
    ["contribute/architecture", "operate", "admin"],
  ] as const)("%s is %s / %s", (id, door, tier) => {
    expect(doorOf(id)).toMatchObject({ door, tier });
  });

  it("the table has no duplicate prefix", () => {
    const prefixes = TIER_PREFIXES.map(([p]) => p);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("the old top-level directories are gone", () => {
    for (const dir of ["users/", "services/", "admin/", "agents/"])
      expect(
        ids.filter((id) => id.startsWith(dir)),
        dir,
      ).toEqual([]);
  });
});

describe("the sidebar", () => {
  const listed = treeIds();

  it("lists no page twice", () => {
    const dupes = listed.filter((id, i) => listed.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("lists only pages that exist", () => {
    const missing = listed.filter(
      (id) => !ids.includes(id) && !deferred.has(id),
    );
    expect(
      missing,
      "a deferred move was applied: update src/lib/doors.ts to the new path",
    ).toEqual([]);
  });

  it("lists no stub", () => {
    expect(listed.filter((id) => statusOf(id) === "stub")).toEqual([]);
  });

  it("lists every live page, except unfinished deferred ones", () => {
    const unlisted = live.filter(
      (id) => !listed.includes(id) && !deferred.has(id) && id !== "index",
    );
    expect(
      unlisted,
      "add the page to its door's tree in src/lib/doors.ts",
    ).toEqual([]);
  });

  it("a page sits in the tree of its own door", () => {
    for (const tree of DOOR_TREES) {
      for (const id of treeIds([tree])) {
        const door = doorOf(id)?.door;
        // Contribute is in the Operate door's tree.
        expect(door, id).toBe(tree.door);
      }
    }
  });

  it("converts to Starlight slugs", () => {
    expect(slugOf("features/licensing/index")).toBe("features/licensing");
    expect(slugOf("index")).toBe("index");
    expect(slugOf("build/install")).toBe("build/install");
    expect(starlightSidebar().length).toBeGreaterThan(5);
  });
});
