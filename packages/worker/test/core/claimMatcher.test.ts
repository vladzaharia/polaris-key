import { describe, expect, it } from "vitest";
import {
  evaluate,
  parseAccessRules,
  parseClaimMatcher,
  type AccessRule,
  type DomainFacts,
  type LinkFacts,
} from "../../src/core/rbac/claimMatcher.js";

const grant = { role: "console_access", scope: "platform" };
const rule = (when: unknown, g: unknown = grant, extra = {}) => ({
  id: "r_9f2c4a",
  when,
  grant: g,
  ...extra,
});
const parse = (rules: unknown[], opts = {}) =>
  parseAccessRules({ rules }, opts);
const refused = (rules: unknown[], opts = {}) => {
  const r = parse(rules, opts);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};
const group = { connection: "console-idp", group: "tonebox-release" };

describe("parseAccessRules", () => {
  it("accepts the plan's example and normalises areas", () => {
    const r = parseAccessRules({
      rules: [
        {
          id: "r_9f2c4a",
          label: "Tonebox release managers",
          when: group,
          grant: {
            role: "product_admin",
            scope: "product:tonebox",
            areas: ["commerce", "ship", "ship"],
          },
        },
      ],
    });
    expect(r.ok && r.doc.rules[0]!.grant.areas).toEqual(["ship", "commerce"]);
  });
  it("accepts an empty document and exactly 50 rules", () => {
    expect(parse([]).ok).toBe(true);
    const many = Array.from({ length: 50 }, (_, i) =>
      rule(group, grant, { id: `r_${(i + 1).toString(16).padStart(6, "0")}` }),
    );
    expect(parse(many).ok).toBe(true);
  });
  it("refuses more than 50 rules", () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      rule(group, grant, { id: `r_${(i + 1).toString(16).padStart(6, "0")}` }),
    );
    expect(refused(many)).toMatch(/50/);
  });
  it("refuses a bad document shape and unknown keys", () => {
    for (const v of [null, [], "x", { rules: {} }, { rules: [], x: 1 }])
      expect(parseAccessRules(v).ok).toBe(false);
    expect(refused([rule(group, grant, { extra: 1 })])).toMatch(/unknown/);
    expect(refused([null])).toMatch(/object/);
  });
  it("limits the label to 80 characters", () => {
    expect(parse([rule(group, grant, { label: "x".repeat(80) })]).ok).toBe(
      true,
    );
    expect(refused([rule(group, grant, { label: "x".repeat(81) })])).toMatch(
      /80/,
    );
    expect(refused([rule(group, grant, { label: 5 })])).toMatch(/label/);
    expect(refused([rule(group, grant, { label: "a\nb" })])).toMatch(/control/);
  });
  it("ids: required on read, minted or known on write, unique, well formed", () => {
    expect(refused([{ when: group, grant }])).toMatch(/missing/);
    expect(refused([rule(group, grant, { id: "x_123456" })])).toMatch(
      /malformed/,
    );
    expect(refused([rule(group, grant, { id: 7 })])).toMatch(/malformed/);
    expect(refused([rule(group), rule(group)])).toMatch(/repeated/);
    const minted = parse([{ when: group, grant }], {
      mintId: () => "r_abcdef",
    });
    expect(minted.ok && minted.doc.rules[0]!.id).toBe("r_abcdef");
    const known = new Set(["r_9f2c4a"]);
    expect(parse([rule(group)], { knownIds: known }).ok).toBe(true);
    expect(
      refused([rule(group, grant, { id: "r_000001" })], { knownIds: known }),
    ).toMatch(/server/);
  });
  it("grants only product_admin or console_access", () => {
    for (const role of ["superadmin", "platform_admin", "root", 1, undefined])
      expect(refused([rule(group, { role, scope: "platform" })])).toMatch(
        /only product_admin or console_access/,
      );
    expect(refused([rule(group, null)])).toMatch(/grant/);
    expect(refused([rule(group, { ...grant, x: 1 })])).toMatch(/unknown/);
  });
  it("scopes: console_access is platform only, product_admin names a product", () => {
    expect(
      refused([rule(group, { role: "console_access", scope: "product:a" })]),
    ).toMatch(/platform/);
    expect(refused([rule(group, { ...grant, areas: ["ship"] })])).toMatch(
      /areas/,
    );
    const pa = (scope: unknown, areas: unknown = ["ship"]) =>
      rule(group, { role: "product_admin", scope, areas });
    expect(refused([pa("platform")])).toMatch(/product:/);
    expect(refused([pa("products:*")])).toMatch(/product:/);
    expect(refused([pa("product:Bad Slug")])).toMatch(/no product/);
    expect(refused([pa("product:polaris-key")])).toMatch(/no product/);
    expect(refused([pa(5)])).toMatch(/scope/);
    expect(refused([pa("product:tonebox", [])])).toMatch(/non-empty/);
    expect(refused([pa("product:tonebox", "ship")])).toMatch(/non-empty/);
  });
  it("areas must be product areas in AREAS", () => {
    const pa = (areas: unknown) =>
      rule(group, { role: "product_admin", scope: "product:tonebox", areas });
    for (const a of [["nope"], ["platform"], ["docs"], [3]])
      expect(refused([pa(a)])).toMatch(/unknown area/);
    expect(parse([pa(["members", "core"])]).ok).toBe(true);
  });
});

describe("parseClaimMatcher", () => {
  const ok = (v: unknown) => expect(parseClaimMatcher(v).ok).toBe(true);
  const bad = (v: unknown, re: RegExp) => {
    const r = parseClaimMatcher(v);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(re);
  };
  it("accepts each kind", () => {
    ok(group);
    ok({ connection: "console-idp", domain: "Example.COM" });
    ok({
      connection: "c_1a2b",
      claim: { name: "department", equals: "games" },
    });
  });
  it("lower-cases a domain and keeps group and claim as written", () => {
    const d = parseClaimMatcher({ connection: "x", domain: " Example.COM " });
    expect(d.ok && d.matcher).toEqual({
      connection: "x",
      domain: "example.com",
    });
    const g = parseClaimMatcher({ connection: "x", group: "Admins" });
    expect(g.ok && g.matcher).toEqual({ connection: "x", group: "Admins" });
  });
  it("refuses zero or several matcher kinds", () => {
    bad({ connection: "x" }, /exactly one/);
    bad({ connection: "x", group: "g", domain: "a.com" }, /exactly one/);
    bad(
      { connection: "x", group: "g", claim: { name: "a", equals: "b" } },
      /exactly one/,
    );
    bad(
      {
        connection: "x",
        group: "g",
        domain: "a.com",
        claim: { name: "a", equals: "b" },
      },
      /exactly one/,
    );
  });
  it("refuses a missing or malformed connection and unknown keys", () => {
    bad({ group: "g" }, /connection/);
    bad({ connection: "", group: "g" }, /connection/);
    bad({ connection: "a b", group: "g" }, /connection/);
    bad({ connection: 4, group: "g" }, /connection/);
    bad({ connection: "x", group: "g", extra: 1 }, /unknown/);
    bad("x", /object/);
  });
  it("refuses bad group, domain and claim values", () => {
    bad({ connection: "x", group: "" }, /group/);
    bad({ connection: "x", group: "a\u0000b" }, /group/);
    bad({ connection: "x", group: "g".repeat(257) }, /group/);
    for (const d of [
      "",
      "localhost",
      "a@b.com",
      "*.a.com",
      "a..com",
      "-a.com",
      5,
    ])
      bad({ connection: "x", domain: d }, /domain/);
    bad({ connection: "x", claim: "a" }, /claim/);
    bad({ connection: "x", claim: { name: "a" } }, /name and an equals/);
    bad(
      { connection: "x", claim: { name: "", equals: "b" } },
      /name and an equals/,
    );
    bad(
      { connection: "x", claim: { name: "a", equals: 1 } },
      /name and an equals/,
    );
    bad(
      { connection: "x", claim: { name: "a", equals: "b", x: 1 } },
      /unknown/,
    );
  });
});

const link = (over: Partial<LinkFacts> = {}): LinkFacts => ({
  connection: "console-idp",
  groups: [],
  claims: {},
  email: null,
  ...over,
});
const facts: DomainFacts = new Map([["acme", new Set(["example.com"])]]);
const r = (when: unknown, g: unknown = grant): AccessRule => {
  const p = parse([rule(when, g)]);
  if (!p.ok) throw new Error(p.reason);
  return p.doc.rules[0]!;
};

describe("evaluate", () => {
  it("matches a group exactly, case-sensitively, on the named connection only", () => {
    const rules = [r(group)];
    expect(
      evaluate([link({ groups: ["tonebox-release"] })], rules, facts),
    ).toHaveLength(1);
    expect(
      evaluate([link({ groups: ["Tonebox-Release"] })], rules, facts),
    ).toHaveLength(0);
    expect(
      evaluate([link({ groups: ["tonebox-release-x"] })], rules, facts),
    ).toHaveLength(0);
    expect(
      evaluate(
        [link({ connection: "other", groups: ["tonebox-release"] })],
        rules,
        facts,
      ),
    ).toHaveLength(0);
  });
  it("an unknown connection matches nothing", () => {
    const rules = [r({ connection: "nope", group: "g" })];
    expect(evaluate([link({ groups: ["g"] })], rules, facts)).toEqual([]);
  });
  it("matches an exact claim, string or array element", () => {
    const rules = [
      r({
        connection: "console-idp",
        claim: { name: "department", equals: "games" },
      }),
    ];
    const e = (claims: Record<string, unknown>) =>
      evaluate([link({ claims })], rules, facts).length;
    expect(e({ department: "games" })).toBe(1);
    expect(e({ department: ["ops", "games"] })).toBe(1);
    expect(e({ department: "Games" })).toBe(0);
    expect(e({ department: "games-eu" })).toBe(0);
    expect(e({ department: 1 })).toBe(0);
    expect(e({ other: "games" })).toBe(0);
    expect(e({})).toBe(0);
    expect(e(Object.create({ department: "games" }))).toBe(0);
  });
  it("domain: case-insensitive, whole domain, verified and enforced only", () => {
    const rules = [r({ connection: "acme", domain: "example.com" })];
    const e = (email: string | null, f: DomainFacts = facts) =>
      evaluate([link({ connection: "acme", email })], rules, f).length;
    expect(e("ann@example.com")).toBe(1);
    expect(e("Ann@EXAMPLE.com")).toBe(1);
    expect(e("ann@sub.example.com")).toBe(0);
    expect(e("ann@notexample.com")).toBe(0);
    expect(e("ann@example.com.evil.io")).toBe(0);
    expect(e("a@b@example.com")).toBe(0);
    expect(e("@example.com")).toBe(0);
    expect(e(null)).toBe(0);
    // not verified and enforced on this connection (e.g. an address confirmed only by email code)
    expect(e("ann@example.com", new Map())).toBe(0);
    expect(e("ann@example.com", new Map([["acme", new Set()]]))).toBe(0);
    expect(
      e("ann@example.com", new Map([["other", new Set(["example.com"])]])),
    ).toBe(0);
  });
  it("returns each matching rule once with a rule-sourced grant", () => {
    const rules = [
      r(group, {
        role: "product_admin",
        scope: "product:tonebox",
        areas: ["ship"],
      }),
      r({ connection: "console-idp", group: "other" }),
      r({ connection: "console-idp", group: "staff" }),
    ].map((x, i) => ({ ...x, id: `r_00000${i + 1}` }));
    const out = evaluate(
      [
        link({ groups: ["tonebox-release", "staff"] }),
        link({ groups: ["staff"] }),
      ],
      rules,
      facts,
    );
    expect(out.map((m) => m.ruleId)).toEqual(["r_000001", "r_000003"]);
    expect(out[0]!.grant).toEqual({
      role: "product_admin",
      scope: "product:tonebox",
      areas: ["ship"],
      source: "rule",
    });
    expect(out[1]!.grant).toMatchObject({
      role: "console_access",
      areas: null,
    });
  });
  it("never yields superadmin or platform admin, even from a hand-built rule", () => {
    for (const role of ["superadmin", "platform_admin"]) {
      const bad = {
        id: "r_000001",
        when: group,
        grant: { role, scope: "platform" },
      } as unknown as AccessRule;
      expect(
        evaluate([link({ groups: ["tonebox-release"] })], [bad], facts),
      ).toEqual([]);
    }
  });
  it("no links or no rules gives nothing", () => {
    expect(evaluate([], [r(group)], facts)).toEqual([]);
    expect(
      evaluate([link({ groups: ["tonebox-release"] })], [], facts),
    ).toEqual([]);
  });
});
