/**
 * The area list is append-only (ST-29; ST-28 plan §2.1). Bindings store area ids (ST-31), so a
 * renamed, reused or removed id would silently change what a stored binding grants.
 * `fixtures/rbac-areas.json` is the record: it only ever grows, by appending the new area in the
 * change that adds it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AREAS, PRODUCT_AREAS, SERVICE_AREA } from "../src/core/rbac/areas.js";
import { SERVICE_SLUGS } from "../src/core/services.js";

const here = dirname(fileURLToPath(import.meta.url));
const pinned = JSON.parse(
  readFileSync(join(here, "fixtures", "rbac-areas.json"), "utf8"),
) as { id: string; name: string; scope: string }[];

describe("AREAS", () => {
  it("is the pinned list, in order: an id is never renamed, reused or removed", () => {
    const current = AREAS.map((a) => ({
      id: a.id,
      name: a.name,
      scope: a.scope,
    }));
    // Append-only: the pinned list is a prefix of the current one, id by id.
    expect(current.slice(0, pinned.length).map((a) => a.id)).toEqual(
      pinned.map((a) => a.id),
    );
    // And the fixture is kept in step: an added area is appended to it in the same change.
    expect(current).toEqual(pinned);
  });

  it("has unique ids", () => {
    const ids = AREAS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every service an area, and never `platform`, `docs` or `console`", () => {
    for (const slug of SERVICE_SLUGS) {
      expect(SERVICE_AREA[slug], slug).toBeTruthy();
      expect(PRODUCT_AREAS, slug).toContain(SERVICE_AREA[slug]);
    }
  });
});
