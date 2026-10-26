/**
 * The roles matrix (ST-31.10) against `can()`: one synthetic principal per role, and every cell of
 * `core/rbac/matrix.ts` derived from what the predicate answers. A tick must be allowed, a dash
 * denied, and an exception word must say exactly what `can()` says for its row. A change to
 * `can()` that the matrix does not follow fails here, and the generated docs page and console
 * data are rendered from the same rows (`pnpm gen roles-matrix --check`).
 */

import { describe, expect, it } from "vitest";
import { AREAS, PRODUCT_AREAS } from "../../src/core/rbac/areas.js";
import {
  can,
  PLATFORM,
  ROLES,
  type Principal,
  type Role,
  type Scope,
} from "../../src/core/rbac/can.js";
import {
  FOOTNOTES,
  MATRIX_ROLES,
  MATRIX_ROWS,
  PLATFORM_ROWS,
  PRODUCT_ROWS,
  footnoteOf,
} from "../../src/core/rbac/matrix.js";
import { docsAllows } from "../../src/docs.js";

const product: Scope = { kind: "product", slug: "demo", system: false };

/** One principal per role, each holding that role alone at its widest scope. */
const PRINCIPAL: Record<Role, Principal> = {
  superadmin: {
    memberId: "m",
    grants: [
      { role: "superadmin", scope: "platform", areas: null, source: "grant" },
    ],
  },
  platform_admin: {
    memberId: "m",
    grants: [
      {
        role: "platform_admin",
        scope: "platform",
        areas: null,
        source: "grant",
      },
    ],
  },
  product_admin: {
    memberId: "m",
    grants: [
      {
        role: "product_admin",
        scope: "products:*",
        areas: null,
        source: "grant",
      },
    ],
  },
  console_access: {
    memberId: "m",
    grants: [
      {
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "grant",
      },
    ],
  },
};

describe("roles matrix", () => {
  it("has one column per role, in ROLES order", () => {
    expect([...MATRIX_ROLES]).toEqual([...ROLES]);
  });

  it("lists the eleven product areas in AREAS order with Members last, then the six platform rows", () => {
    expect(PRODUCT_ROWS.map((r) => r.area)).toEqual([
      ...PRODUCT_AREAS.filter((a) => a !== "members"),
      "members",
    ]);
    expect([...PRODUCT_ROWS.map((r) => r.area)].sort()).toEqual(
      [...PRODUCT_AREAS].sort(),
    );
    expect(PRODUCT_ROWS).toHaveLength(11);
    expect(PLATFORM_ROWS.map((r) => r.name)).toEqual([
      "Members",
      "Connections",
      "Platform settings",
      "Packages and Status",
      "New products",
      "Docs",
    ]);
    for (const r of PRODUCT_ROWS)
      expect(r.name).toBe(AREAS.find((a) => a.id === r.area)!.name);
  });

  for (const row of MATRIX_ROWS) {
    MATRIX_ROLES.forEach((role, i) => {
      const cell = row.cells[i]!;
      it(`${row.name} x ${role}: ${cell.kind === "word" ? cell.word : cell.kind}`, () => {
        const p = PRINCIPAL[role];
        const probe = row.probe;
        // What the predicate allows for this row.
        const allowed =
          probe.kind === "docs"
            ? docsAllows(p, "admin")
            : can(
                p,
                probe.kind === "product" ? product : PLATFORM,
                probe.area,
                "edit",
              );
        if (cell.kind === "tick") expect(allowed).toBe(true);
        else if (cell.kind === "none") {
          expect(allowed).toBe(false);
          // A dash is no access at all: not even the member-tier docs.
          if (probe.kind === "docs")
            expect(docsAllows(p, "member")).toBe(false);
        } else {
          expect(allowed).toBe(cell.can);
          if (probe.kind === "docs") expect(docsAllows(p, "member")).toBe(true);
        }
      });
    });
  }

  it("every word cell points at a footnote for that word (and role, when it has one)", () => {
    const used = new Set<string>();
    for (const row of MATRIX_ROWS)
      row.cells.forEach((cell, i) => {
        if (cell.kind !== "word") return;
        const f = footnoteOf(cell.note);
        expect(f.word).toBe(cell.word);
        if (f.role) expect(f.role).toBe(MATRIX_ROLES[i]);
        used.add(f.id);
      });
    expect([...used].sort()).toEqual(FOOTNOTES.map((f) => f.id).sort());
  });
});
