import { describe, expect, it } from "vitest";
import {
  accessFor,
  parseAccessPolicy,
  type SignInFacts,
  type SignInLink,
} from "../../src/core/licensing/access.js";

const tiers = [
  { id: "free", rank: 0 },
  { id: "pro", rank: 10 },
  { id: "team", rank: 20 },
];
const link = (o: Partial<SignInLink> = {}): SignInLink => ({
  connection: "corp",
  groups: [],
  claims: {},
  email: null,
  ...o,
});
const facts = (
  links: SignInLink[],
  domains: Record<string, string[]> = {},
): SignInFacts => ({
  anonymous: false,
  links,
  verifiedDomains: new Map(
    Object.entries(domains).map(([k, v]) => [k, new Set(v)]),
  ),
});
const rule = (when: object, target: string, label = "r") => ({
  when,
  target,
  label,
});
const rules = (...r: object[]) => ({ mode: "rules", rules: r });

describe("accessFor", () => {
  const domainRule = rules(
    rule({ connection: "corp", domain: "acme.com" }, "tier:pro"),
  );
  it("grants a domain rule only for an asserted, verified address", () => {
    const d = { corp: ["acme.com"] };
    const ok = facts(
      [link({ email: { address: "a@acme.com", via: "provider" } })],
      d,
    );
    expect(accessFor(domainRule, ok, tiers).tier).toBe("pro");
    const viaCode = facts(
      [link({ email: { address: "a@acme.com", via: "code" } })],
      d,
    );
    expect(accessFor(domainRule, viaCode, tiers).tier).toBeNull();
    const otherConn = facts(
      [link({ email: { address: "a@acme.com", via: "connection:evil" } })],
      d,
    );
    expect(accessFor(domainRule, otherConn, tiers).tier).toBeNull();
    const unverifiedDomain = facts(
      [link({ email: { address: "a@acme.com", via: "provider" } })],
      {},
    );
    expect(accessFor(domainRule, unverifiedDomain, tiers).tier).toBeNull();
  });

  it("binds groups and claims to their issuer", () => {
    const p = rules(
      rule({ connection: "corp", group: "staff" }, "tier:pro"),
      rule(
        { connection: "corp", claim: { name: "plan", equals: "x" } },
        "addon:beta",
      ),
    );
    const other = facts([
      link({ connection: "other", groups: ["staff"], claims: { plan: "x" } }),
    ]);
    expect(accessFor(p, other, tiers)).toMatchObject({
      tier: null,
      addons: [],
    });
    const own = facts([link({ groups: ["staff"], claims: { plan: ["x"] } })]);
    expect(accessFor(p, own, tiers)).toMatchObject({
      tier: "pro",
      addons: ["beta"],
    });
  });

  it("fails closed on a malformed policy", () => {
    const f = facts([link({ groups: ["staff"] })]);
    const good = rule({ connection: "corp", group: "staff" }, "tier:pro");
    for (const bad of [
      null,
      "everyone",
      [],
      {},
      { mode: "rules" },
      { mode: "rules", rules: "x" },
      { mode: "everyone" },
      { mode: "everyone", tier: "pro", extra: 1 },
      { mode: "nobody", extra: 1 },
      rules(good, { ...good, target: "role:admin" }),
      rules({ ...good, label: undefined }),
      rules({ ...good, extra: 1 }),
      rules({ ...good, when: { connection: "corp" } }),
      rules({
        ...good,
        when: { connection: "corp", group: "a", domain: "b.com" },
      }),
      { ...rules(good), anonymousTier: 5 },
    ])
      expect(accessFor(bad, f, tiers)).toEqual({
        tier: null,
        addons: [],
        matched: [],
      });
    expect(parseAccessPolicy(rules(good)).ok).toBe(true);
  });

  it("grants nothing under Nobody, and an unknown tier grants nothing", () => {
    const f = facts([link({ groups: ["staff"] })]);
    expect(accessFor({ mode: "nobody" }, f, tiers).tier).toBeNull();
    expect(
      accessFor({ mode: "everyone", tier: "ghost" }, f, tiers).tier,
    ).toBeNull();
    expect(accessFor({ mode: "everyone", tier: "pro" }, f, tiers).tier).toBe(
      "pro",
    );
    const r = rules(rule({ connection: "corp", group: "staff" }, "tier:ghost"));
    expect(accessFor(r, f, tiers).tier).toBeNull();
  });

  it("takes the highest-rank tier, first on a tie, and every add-on", () => {
    const g = (n: string, t: string) =>
      rule({ connection: "corp", group: n }, t, n);
    const p = rules(
      g("a", "tier:pro"),
      g("b", "tier:team"),
      g("c", "addon:x"),
      g("d", "addon:x"),
      g("e", "addon:y"),
    );
    const f = facts([link({ groups: ["a", "b", "c", "d", "e"] })]);
    expect(accessFor(p, f, tiers)).toEqual({
      tier: "team",
      addons: ["x", "y"],
      matched: ["a", "b", "c", "d", "e"],
    });
    const tie = accessFor(p, facts([link({ groups: ["a"] })]), [
      { id: "pro", rank: 5 },
      { id: "team", rank: 5 },
    ]);
    expect(tie.tier).toBe("pro");
    expect(
      accessFor(p, facts([link({ groups: ["zzz"] })]), tiers).tier,
    ).toBeNull();
  });

  it("gives an anonymous entry only the anonymous tier", () => {
    const p = { mode: "everyone", tier: "team", anonymousTier: "free" };
    const anon: SignInFacts = { ...facts([]), anonymous: true };
    expect(accessFor(p, anon, tiers).tier).toBe("free");
    expect(
      accessFor({ mode: "everyone", tier: "team" }, anon, tiers).tier,
    ).toBeNull();
    expect(
      accessFor({ ...p, anonymousTier: "ghost" }, anon, tiers).tier,
    ).toBeNull();
    expect(accessFor(p, facts([]), tiers).tier).toBe("team");
  });

  it("does not throw or over-grant on hostile facts (property)", () => {
    let seed = 12345;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    const conns = ["corp", "other", "__proto__", ""];
    const strs = ["staff", "acme.com", "x", "", "constructor", "A@acme.com"];
    const p = rules(
      rule({ connection: "corp", group: "staff" }, "tier:pro"),
      rule({ connection: "corp", domain: "acme.com" }, "tier:team"),
      rule(
        { connection: "corp", claim: { name: "plan", equals: "x" } },
        "addon:beta",
      ),
    );
    for (let i = 0; i < 500; i++) {
      const links = Array.from({ length: Math.floor(rnd() * 4) }, () => {
        const via = pick<string>([
          "code",
          "provider",
          "connection:corp",
          "connection:other",
          "zz",
        ]);
        return {
          connection: pick(conns),
          groups:
            rnd() < 0.2
              ? ("staff" as unknown as string[])
              : [pick(strs), pick(strs)],
          claims: pick<Record<string, unknown>>([
            {},
            { plan: "x" },
            { plan: [1, "x"] },
            { plan: 5 },
            { constructor: "x" },
          ]),
          email:
            rnd() < 0.7
              ? {
                  address: pick(strs) + (rnd() < 0.5 ? "@acme.com" : ""),
                  via: via as never,
                }
              : null,
        } satisfies SignInLink;
      });
      const f = facts(links, rnd() < 0.5 ? { corp: ["acme.com"] } : {});
      const out = accessFor(p, f, tiers);
      // Nothing the corp connection did not say can grant.
      const corp = links.filter((l) => l.connection === "corp");
      if (corp.length === 0)
        expect(out).toEqual({ tier: null, addons: [], matched: [] });
      // The domain rule never fires from a code-verified or foreign-verified address alone.
      const domainOk = corp.some(
        (l) =>
          l.email &&
          (l.email.via === "provider" || l.email.via === "connection:corp") &&
          /^[^@]+@acme\.com$/i.test(l.email.address),
      );
      const groupOk = corp.some(
        (l) => Array.isArray(l.groups) && l.groups.includes("staff"),
      );
      const expected =
        domainOk && f.verifiedDomains.size > 0
          ? "team"
          : groupOk
            ? "pro"
            : null;
      expect(out.tier).toBe(expected);
      // Deterministic.
      expect(accessFor(p, f, tiers)).toEqual(out);
    }
  });
});
