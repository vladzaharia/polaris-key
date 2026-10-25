/**
 * The grant rules G1 to G4 and SM-6 (ST-31 slice 3; ST-28 plan §2.3, §2.5). The oracle is a
 * table written by hand: for every target, which of the eight synthetic granters may grant it.
 * Nothing here is derived from `can()` or from `grantRules.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  confirmLevel,
  inviteBootstrapAllowed,
  isWidening,
  mayChange,
  mayGrant,
  mayRevoke,
  validateGrant,
} from "../../src/core/rbac/grantRules.js";
import { PRODUCT_AREAS } from "../../src/core/rbac/areas.js";
import {
  can,
  isSuperadmin,
  PLATFORM,
  type Principal,
} from "../../src/core/rbac/can.js";
import { PRINCIPALS, EXTRA_GRANTERS } from "../rbacFixtures.js";

// Column order of every oracle row.
const COLS = [
  "none",
  "stranger",
  "consoleOnly",
  "alphaAdmin",
  "alphaShip",
  "allProducts",
  "platformAdmin",
  "root",
] as const;

type Row = [
  label: string,
  target: unknown,
  grant: readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1],
  revoke: readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1],
];

const pa = (scope: string, areas: string[] | null) => ({
  role: "product_admin",
  scope,
  areas,
});

//                          none strg cons aAdm aShp allP pAdm root
const ORACLE: Row[] = [
  [
    "superadmin",
    { role: "superadmin", scope: "platform", areas: null },
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
  [
    "platform_admin",
    { role: "platform_admin", scope: "platform", areas: null },
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
  [
    "console_access",
    { role: "console_access", scope: "platform", areas: null },
    // grant (G3): alphaAdmin and allProducts hold `members` on a product, alphaShip does not.
    [0, 0, 0, 1, 0, 1, 1, 1],
    // revoke: platform `members` edit only, so a product admin cannot remove a console user.
    [0, 0, 0, 0, 0, 0, 1, 1],
  ],
  [
    "alpha, every area",
    pa("product:alpha", null),
    [0, 0, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 1, 0, 1, 0, 1],
  ],
  [
    "alpha [members]",
    pa("product:alpha", ["members"]),
    [0, 0, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 1, 0, 1, 0, 1],
  ],
  [
    "alpha [ship]",
    pa("product:alpha", ["ship"]),
    [0, 0, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 1, 0, 1, 0, 1],
  ],
  [
    "alpha [ship, commerce]",
    pa("product:alpha", ["ship", "commerce"]),
    [0, 0, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 1, 0, 1, 0, 1],
  ],
  [
    "alpha [core]",
    pa("product:alpha", ["core"]),
    [0, 0, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 1, 0, 1, 0, 1],
  ],
  [
    "beta, every area",
    pa("product:beta", null),
    [0, 0, 0, 0, 0, 1, 0, 1],
    [0, 0, 0, 0, 0, 1, 0, 1],
  ],
  [
    "beta [ship]",
    pa("product:beta", ["ship"]),
    [0, 0, 0, 0, 0, 1, 0, 1],
    [0, 0, 0, 0, 0, 1, 0, 1],
  ],
  [
    "products:*, every area",
    pa("products:*", null),
    [0, 0, 0, 0, 0, 0, 0, 1],
    // B1: a products:* binding is revoked or narrowed by a Superadmin alone.
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
  [
    "products:* [ship]",
    pa("products:*", ["ship"]),
    [0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
  [
    "system product (invalid)",
    pa("product:polaris-key", null),
    [0, 0, 0, 0, 0, 0, 0, 0],
    // A Superadmin can still remove a stored binding that no longer validates.
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
  [
    "upper-case scope (invalid)",
    pa("PRODUCT:alpha", null),
    [0, 0, 0, 0, 0, 0, 0, 0],
    // A Superadmin can still remove a stored binding that no longer validates.
    [0, 0, 0, 0, 0, 0, 0, 1],
  ],
];

describe("grant rules: the hand-written oracle", () => {
  it("covers 8 granters", () => {
    expect(COLS).toHaveLength(8);
    expect(Object.keys(PRINCIPALS)).toEqual([...COLS]);
  });

  for (const [label, target, grant, revoke] of ORACLE) {
    COLS.forEach((name, i) => {
      it(`${name} ${grant[i] ? "may" : "may not"} grant ${label}`, () => {
        expect(mayGrant(PRINCIPALS[name], target)).toBe(grant[i] === 1);
      });
      it(`${name} ${revoke[i] ? "may" : "may not"} revoke ${label}`, () => {
        expect(mayRevoke(PRINCIPALS[name], target)).toBe(revoke[i] === 1);
      });
    });
  }
});

describe("grant rules: soundness against can() (an upper bound, not the oracle)", () => {
  const granters: [string, Principal][] = [
    ...Object.entries(PRINCIPALS).filter(([, p]) => p !== null),
    ...Object.entries(EXTRA_GRANTERS),
  ] as [string, Principal][];
  const product = (slug: string) =>
    ({ kind: "product", slug, system: false }) as const;
  /** What `can()` says the granter holds of what the target hands out or takes away. */
  const holds = (g: Principal, target: unknown, taking = false) => {
    const v = validateGrant(target);
    if (!v.ok) {
      // Only a Superadmin may take away a binding that does not validate (clean-up).
      if (taking && isSuperadmin(g)) return;
      throw new Error("a rule accepted an invalid target");
    }
    const t = v.grant;
    if (t.role === "product_admin") {
      const slugs =
        t.scope === "products:*"
          ? ["alpha", "beta", "gamma"]
          : [t.scope.slice("product:".length)];
      for (const slug of slugs) {
        expect(can(g, product(slug), "members", "edit")).toBe(true);
        for (const a of t.areas ?? PRODUCT_AREAS)
          expect(can(g, product(slug), a, "edit")).toBe(true);
      }
    } else if (t.role === "console_access") {
      const slugs = ["alpha", "beta", "gamma"];
      expect(
        can(g, PLATFORM, "members", "edit") ||
          slugs.some((s) => can(g, product(s), "members", "edit")),
      ).toBe(true);
    } else {
      expect(can(g, PLATFORM, "platform", "edit")).toBe(true);
    }
  };
  for (const [name, g] of granters) {
    for (const [label, target] of ORACLE) {
      it(`${name} granting ${label} implies can() holds what it hands out`, () => {
        if (mayGrant(g, target)) holds(g, target);
      });
      it(`${name} revoking ${label} implies can() holds what it takes away`, () => {
        if (mayRevoke(g, target)) holds(g, target, true);
      });
    }
    it(`${name} changing a binding implies it may revoke the old and grant a widening`, () => {
      for (const [, before] of ORACLE)
        for (const [, after] of ORACLE) {
          if (!mayChange(g, before, after)) continue;
          holds(g, before, true);
          if (isWidening(before, after)) holds(g, after);
        }
    });
  }
});

describe("grant rules: named cases", () => {
  it("a Platform admin cannot grant Superadmin, to itself or anyone", () => {
    const t = { role: "superadmin", scope: "platform", areas: null };
    expect(mayGrant(PRINCIPALS.platformAdmin, t)).toBe(false);
    expect(
      mayGrant(PRINCIPALS.platformAdmin, { ...t, role: "platform_admin" }),
    ).toBe(false);
  });

  it("a narrowed admin cannot widen past its own areas", () => {
    const g = EXTRA_GRANTERS.alphaMembersShip;
    expect(mayGrant(g, pa("product:alpha", ["ship"]))).toBe(true);
    expect(mayGrant(g, pa("product:alpha", ["members", "ship"]))).toBe(true);
    expect(mayGrant(g, pa("product:alpha", ["ship", "commerce"]))).toBe(false);
    expect(mayGrant(g, pa("product:alpha", ["core"]))).toBe(false);
    expect(mayGrant(g, pa("product:alpha", null))).toBe(false);
    expect(mayGrant(g, pa("product:beta", ["ship"]))).toBe(false);
    expect(mayGrant(g, pa("products:*", ["ship"]))).toBe(false);
    expect(
      mayGrant(g, { role: "console_access", scope: "platform", areas: null }),
    ).toBe(true);
  });

  it("a product admin of another product reaches nothing on alpha", () => {
    const b = EXTRA_GRANTERS.betaAdmin;
    expect(mayGrant(b, pa("product:alpha", ["ship"]))).toBe(false);
    expect(mayGrant(b, pa("product:beta", null))).toBe(true);
    expect(mayRevoke(b, pa("product:alpha", ["ship"]))).toBe(false);
  });

  it("only a Superadmin grants products:*", () => {
    for (const name of COLS)
      expect(mayGrant(PRINCIPALS[name], pa("products:*", ["ship"]))).toBe(
        name === "root",
      );
    expect(mayGrant(PRINCIPALS.allProducts, pa("products:*", null))).toBe(
      false,
    );
  });

  it("NULL-areas grants need a NULL-holding granter", () => {
    expect(mayGrant(PRINCIPALS.alphaAdmin, pa("product:alpha", null))).toBe(
      true,
    );
    expect(
      mayGrant(EXTRA_GRANTERS.alphaMembersShip, pa("product:alpha", null)),
    ).toBe(false);
    // Two narrowed grants that together list every area still do not hold NULL.
    const split = {
      memberId: "m-split",
      grants: [
        {
          role: "product_admin",
          scope: "product:alpha",
          areas: ["members", "ship"],
          source: "grant",
        },
        {
          role: "product_admin",
          scope: "product:alpha",
          areas: [
            "core",
            "license",
            "config",
            "signin",
            "sync",
            "commerce",
            "keys",
            "settings",
          ],
          source: "grant",
        },
      ],
    } as const;
    expect(mayGrant(split, pa("product:alpha", null))).toBe(false);
    // Their union does cover a list inside it.
    expect(mayGrant(split, pa("product:alpha", ["ship", "core"]))).toBe(true);
    // A product-scope NULL plus a products:* NULL is a NULL holder.
    expect(
      mayGrant(
        {
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
        pa("product:zeta", null),
      ),
    ).toBe(true);
  });

  it("a null granter is refused", () => {
    expect(
      mayGrant(null, {
        role: "console_access",
        scope: "platform",
        areas: null,
      }),
    ).toBe(false);
    expect(mayRevoke(undefined, pa("product:alpha", null))).toBe(false);
  });

  it("a Superadmin cannot grant what does not validate", () => {
    expect(mayGrant(PRINCIPALS.root, pa("PRODUCT:alpha", null))).toBe(false);
    expect(
      mayGrant(PRINCIPALS.root, { role: "superadmin", scope: "platform" }),
    ).toBe(false);
  });

  it("only a Superadmin revokes an unreadable binding", () => {
    const bad = { role: "wizard", scope: "platform", areas: null };
    expect(mayRevoke(PRINCIPALS.platformAdmin, bad)).toBe(false);
    expect(mayRevoke(PRINCIPALS.root, bad)).toBe(true);
  });

  it("revoking needs areas covering the binding's", () => {
    const g = EXTRA_GRANTERS.alphaMembersShip;
    expect(mayRevoke(g, pa("product:alpha", ["ship"]))).toBe(true);
    expect(mayRevoke(g, pa("product:alpha", ["ship", "core"]))).toBe(false);
    expect(mayRevoke(g, pa("product:alpha", null))).toBe(false);
  });
});

describe("B1: products:* revoke is Superadmin-only", () => {
  it("a products:* [members, ship] granter cannot revoke products:* [ship]", () => {
    const g = {
      memberId: "m-all-ms",
      grants: [
        {
          role: "product_admin",
          scope: "products:*",
          areas: ["members", "ship"],
          source: "grant",
        },
      ],
    } as const;
    expect(mayRevoke(g, pa("products:*", ["ship"]))).toBe(false);
    expect(mayRevoke(g, pa("product:alpha", ["ship"]))).toBe(true);
    expect(mayRevoke(PRINCIPALS.root, pa("products:*", ["ship"]))).toBe(true);
  });
});

describe("mayChange (N2)", () => {
  const g = EXTRA_GRANTERS.alphaMembersShip;
  it("refuses editing away areas the granter does not hold", () => {
    expect(
      mayChange(
        g,
        pa("product:alpha", ["core", "keys"]),
        pa("product:alpha", ["ship"]),
      ),
    ).toBe(false);
  });
  it("allows a narrowing inside its own areas", () => {
    expect(
      mayChange(
        g,
        pa("product:alpha", ["ship"]),
        pa("product:alpha", ["members"]),
      ),
    ).toBe(true); // a widening, but members is within the granter's own areas
    expect(
      mayChange(
        g,
        pa("product:alpha", ["members", "ship"]),
        pa("product:alpha", ["ship"]),
      ),
    ).toBe(true);
  });
  it("refuses a widening beyond what it can grant", () => {
    expect(
      mayChange(
        g,
        pa("product:alpha", ["ship"]),
        pa("product:alpha", ["core"]),
      ),
    ).toBe(false);
  });
  it("fails closed on null and unreadable input", () => {
    expect(
      mayChange(
        null,
        pa("product:alpha", ["ship"]),
        pa("product:alpha", ["ship"]),
      ),
    ).toBe(false);
    expect(mayChange(g, { role: "x" }, pa("product:alpha", ["ship"]))).toBe(
      false,
    );
  });
});

describe("N1: the system product scope", () => {
  it("a product:<system> grant gives no members edit for console access", () => {
    const g = {
      memberId: "m-sys",
      grants: [
        {
          role: "product_admin",
          scope: "product:polaris-key",
          areas: null,
          source: "grant",
        },
      ],
    } as const;
    expect(
      mayGrant(g, { role: "console_access", scope: "platform", areas: null }),
    ).toBe(false);
  });
});

describe("validateGrant", () => {
  const ok = (v: unknown) => validateGrant(v).ok;
  const reason = (v: unknown) => {
    const r = validateGrant(v);
    return r.ok ? "ok" : r.reason;
  };

  it("normalises areas: deduplicated, in AREAS order", () => {
    const r = validateGrant(
      pa("product:alpha", ["settings", "ship", "ship", "members"]),
    );
    expect(r).toEqual({
      ok: true,
      grant: {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["members", "ship", "settings"],
      },
    });
  });

  it("accepts the three scopes", () => {
    expect(ok(pa("product:alpha", null))).toBe(true);
    expect(ok(pa("product:a-1", ["ship"]))).toBe(true);
    expect(ok(pa("products:*", null))).toBe(true);
    expect(ok({ role: "platform_admin", scope: "platform", areas: null })).toBe(
      true,
    );
  });

  it("refuses scopes that are not exactly lower-case", () => {
    for (const s of [
      "PRODUCT:alpha",
      "Product:alpha",
      "product:Alpha",
      "PRODUCTS:*",
      "Platform",
      "product:",
      "product:-a",
      "product:a b",
      "product:alpha ",
      " platform",
      "products:alpha",
      "product:a/b",
    ])
      expect(ok(pa(s, null))).toBe(false);
    expect(ok({ role: "console_access", scope: "PLATFORM", areas: null })).toBe(
      false,
    );
  });

  it("refuses product:<system>", () => {
    expect(reason(pa("product:polaris-key", null))).toBe("system_product");
    expect(ok(pa("product:polaris-key", ["ship"]))).toBe(false);
  });

  it("refuses a role and scope that disagree", () => {
    expect(ok({ role: "product_admin", scope: "platform", areas: null })).toBe(
      false,
    );
    expect(
      ok({ role: "console_access", scope: "products:*", areas: null }),
    ).toBe(false);
    expect(
      ok({ role: "superadmin", scope: "product:alpha", areas: null }),
    ).toBe(false);
  });

  it("makes every area an explicit choice: a missing field is refused, null is accepted", () => {
    expect(reason({ role: "product_admin", scope: "product:alpha" })).toBe(
      "areas_missing",
    );
    expect(
      reason({
        role: "product_admin",
        scope: "product:alpha",
        areas: undefined,
      }),
    ).toBe("areas_missing");
    expect(ok(pa("product:alpha", null))).toBe(true);
  });

  it("refuses an empty, non-product or malformed area list", () => {
    expect(ok(pa("product:alpha", []))).toBe(false);
    expect(ok(pa("product:alpha", ["platform"]))).toBe(false);
    expect(ok(pa("product:alpha", ["docs"]))).toBe(false);
    expect(ok(pa("product:alpha", ["console"]))).toBe(false);
    expect(ok(pa("product:alpha", ["nope"]))).toBe(false);
    expect(ok(pa("product:alpha", ["ship", 3 as unknown as string]))).toBe(
      false,
    );
    expect(
      ok({ role: "product_admin", scope: "product:alpha", areas: "ship" }),
    ).toBe(false);
  });

  it("refuses areas on any role but Product admin", () => {
    expect(
      ok({ role: "platform_admin", scope: "platform", areas: ["members"] }),
    ).toBe(false);
    expect(
      ok({ role: "console_access", scope: "platform", areas: ["ship"] }),
    ).toBe(false);
    expect(ok({ role: "superadmin", scope: "platform", areas: [] })).toBe(
      false,
    );
  });

  it("refuses non-objects", () => {
    for (const v of [null, undefined, "x", 3, []]) expect(ok(v)).toBe(false);
  });
});

describe("isWidening (G4)", () => {
  const W = (b: unknown, a: unknown) => isWidening(b, a);

  it("a new binding is always a widening", () => {
    expect(
      W(null, { role: "console_access", scope: "platform", areas: null }),
    ).toBe(true);
    expect(W(null, pa("product:alpha", ["ship"]))).toBe(true);
  });

  it("wider areas widen; narrower and equal do not", () => {
    expect(
      W(
        pa("product:alpha", ["ship"]),
        pa("product:alpha", ["ship", "commerce"]),
      ),
    ).toBe(true);
    expect(
      W(pa("product:alpha", ["ship"]), pa("product:alpha", ["core"])),
    ).toBe(true);
    expect(
      W(
        pa("product:alpha", ["ship", "commerce"]),
        pa("product:alpha", ["ship"]),
      ),
    ).toBe(false);
    expect(
      W(pa("product:alpha", ["ship"]), pa("product:alpha", ["ship"])),
    ).toBe(false);
    expect(
      W(
        pa("product:alpha", ["ship", "commerce"]),
        pa("product:alpha", ["commerce", "ship"]),
      ),
    ).toBe(false);
  });

  it("NULL is wider than any list and narrowing out of NULL is not a widening", () => {
    expect(W(pa("product:alpha", ["ship"]), pa("product:alpha", null))).toBe(
      true,
    );
    // NULL also covers future areas, so even the full explicit list narrows it...
    expect(W(pa("product:alpha", null), pa("product:alpha", ["ship"]))).toBe(
      false,
    );
    // ...and moving a full list to NULL is a widening.
    expect(
      W(
        pa("product:alpha", [
          "core",
          "license",
          "config",
          "ship",
          "signin",
          "sync",
          "commerce",
          "keys",
          "settings",
          "members",
        ]),
        pa("product:alpha", null),
      ),
    ).toBe(true);
    expect(W(pa("product:alpha", null), pa("product:alpha", null))).toBe(false);
  });

  it("a different role or scope is a new grant, so a widening", () => {
    expect(W(pa("product:alpha", ["ship"]), pa("product:beta", ["ship"]))).toBe(
      true,
    );
    expect(W(pa("product:alpha", ["ship"]), pa("products:*", ["ship"]))).toBe(
      true,
    );
    expect(
      W(
        { role: "console_access", scope: "platform", areas: null },
        { role: "platform_admin", scope: "platform", areas: null },
      ),
    ).toBe(true);
  });

  it("an unreadable side counts as a widening", () => {
    expect(W(pa("product:alpha", null), pa("PRODUCT:alpha", null))).toBe(true);
    expect(W({ role: "x" }, pa("product:alpha", ["ship"]))).toBe(true);
  });

  it("the same non-product grant is not a widening", () => {
    const c = { role: "console_access", scope: "platform", areas: null };
    expect(W(c, c)).toBe(false);
  });
});

describe("confirmLevel", () => {
  it("is L2 for Superadmin, Platform admin and products:*", () => {
    expect(
      confirmLevel({ role: "superadmin", scope: "platform", areas: null }),
    ).toBe("L2");
    expect(
      confirmLevel({ role: "platform_admin", scope: "platform", areas: null }),
    ).toBe("L2");
    expect(confirmLevel(pa("products:*", null))).toBe("L2");
    expect(confirmLevel(pa("products:*", ["ship"]))).toBe("L2");
  });

  it("is L1 for Console access and a Product admin of one product", () => {
    expect(
      confirmLevel({ role: "console_access", scope: "platform", areas: null }),
    ).toBe("L1");
    expect(confirmLevel(pa("product:alpha", null))).toBe("L1");
    expect(confirmLevel(pa("product:alpha", ["ship"]))).toBe("L1");
  });

  it("is L2 for a target that does not validate (fail closed)", () => {
    expect(confirmLevel(pa("PRODUCT:alpha", null))).toBe("L2");
    expect(confirmLevel(null)).toBe("L2");
  });
});

describe("inviteBootstrapAllowed (SM-6)", () => {
  it("allows Console access and a Product admin of one product", () => {
    expect(
      inviteBootstrapAllowed({
        role: "console_access",
        scope: "platform",
        areas: null,
      }),
    ).toBe(true);
    expect(inviteBootstrapAllowed(pa("product:alpha", null))).toBe(true);
    expect(inviteBootstrapAllowed(pa("product:alpha", ["ship"]))).toBe(true);
  });

  it("refuses Superadmin, Platform admin and products:*", () => {
    expect(
      inviteBootstrapAllowed({
        role: "superadmin",
        scope: "platform",
        areas: null,
      }),
    ).toBe(false);
    expect(
      inviteBootstrapAllowed({
        role: "platform_admin",
        scope: "platform",
        areas: null,
      }),
    ).toBe(false);
    expect(inviteBootstrapAllowed(pa("products:*", null))).toBe(false);
    expect(inviteBootstrapAllowed(pa("products:*", ["ship"]))).toBe(false);
  });

  it("refuses what does not validate, the system product included", () => {
    expect(inviteBootstrapAllowed(pa("PRODUCT:alpha", null))).toBe(false);
    expect(inviteBootstrapAllowed(pa("product:polaris-key", null))).toBe(false);
    expect(
      inviteBootstrapAllowed({ role: "console_access", scope: "platform" }),
    ).toBe(false);
    expect(inviteBootstrapAllowed(undefined)).toBe(false);
  });
});
