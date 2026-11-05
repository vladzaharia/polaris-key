/**
 * `accessFor()` (LX-36.1): who gets which tier and add-ons, from a product's access policy and
 * the facts of one sign-in. Pure: no Db, no Env, no I/O, and nothing here has a caller yet.
 *
 * The policy is `Nobody`, `Everyone` -> a tier, or rules `{when, target, label}` whose `when` is
 * ST-32's ClaimMatcher object, unchanged (`core/rbac/claimMatcher.ts`), plus an optional
 * `anonymousTier` that is the only home of an anonymous entry.
 *
 * D36-3: when several rules match, the result is the highest-rank tier among them (the first rule
 * wins a tie) plus every matching add-on.
 *
 * Fails closed throughout. A malformed policy, a rule whose target tier is not one of the
 * product's tiers, a link or fact of the wrong shape: each grants nothing. Group and claim rules
 * are bound to their connection (the issuer), and a domain rule needs an address the identity
 * provider asserted on that same connection, on a domain verified and enforced for it. An address
 * confirmed only by email code never counts.
 */

import {
  MAX_ACCESS_RULES,
  MAX_RULE_LABEL,
  matches,
  parseClaimMatcher,
  type ClaimMatcher,
  type DomainFacts,
  type LinkFacts,
} from "../rbac/claimMatcher.js";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TARGET_RE = /^(tier|addon):([a-z0-9][a-z0-9._-]{0,63})$/;

export type AccessTarget = `tier:${string}` | `addon:${string}`;

export interface AccessPolicyRule {
  when: ClaimMatcher;
  target: AccessTarget;
  label: string;
}

export type AccessPolicy = {
  /** The tier an anonymous entry gets. Absent: anonymous entry grants nothing. */
  anonymousTier?: string;
} & (
  | { mode: "nobody" }
  | { mode: "everyone"; tier: string }
  | { mode: "rules"; rules: AccessPolicyRule[] }
);

export type PolicyParse =
  | { ok: true; policy: AccessPolicy }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKey(o: Record<string, unknown>, allowed: string[]) {
  return Object.keys(o).find((k) => !allowed.includes(k));
}

/** Parse a stored policy. The whole document is refused on the first problem. */
export function parseAccessPolicy(value: unknown): PolicyParse {
  if (!isObject(value))
    return { ok: false, reason: "policy must be an object" };
  const mode = value.mode;
  const common = ["mode", "anonymousTier"];
  let anonymousTier: string | undefined;
  if (value.anonymousTier !== undefined) {
    if (
      typeof value.anonymousTier !== "string" ||
      !ID_RE.test(value.anonymousTier)
    )
      return { ok: false, reason: "anonymousTier is malformed" };
    anonymousTier = value.anonymousTier;
  }
  const anon = anonymousTier === undefined ? {} : { anonymousTier };
  if (mode === "nobody") {
    const bad = unknownKey(value, common);
    if (bad) return { ok: false, reason: `unknown key: ${bad}` };
    return { ok: true, policy: { mode, ...anon } };
  }
  if (mode === "everyone") {
    const bad = unknownKey(value, [...common, "tier"]);
    if (bad) return { ok: false, reason: `unknown key: ${bad}` };
    if (typeof value.tier !== "string" || !ID_RE.test(value.tier))
      return { ok: false, reason: "tier is malformed" };
    return { ok: true, policy: { mode, tier: value.tier, ...anon } };
  }
  if (mode !== "rules") return { ok: false, reason: "mode is unknown" };
  const bad = unknownKey(value, [...common, "rules"]);
  if (bad) return { ok: false, reason: `unknown key: ${bad}` };
  if (!Array.isArray(value.rules))
    return { ok: false, reason: "rules must be a list" };
  if (value.rules.length > MAX_ACCESS_RULES)
    return { ok: false, reason: `at most ${MAX_ACCESS_RULES} rules` };
  const rules: AccessPolicyRule[] = [];
  for (const [i, raw] of value.rules.entries()) {
    const at = `rules[${i}]`;
    if (!isObject(raw)) return { ok: false, reason: `${at} must be an object` };
    const k = unknownKey(raw, ["when", "target", "label"]);
    if (k) return { ok: false, reason: `${at} has an unknown key: ${k}` };
    const when = parseClaimMatcher(raw.when);
    if (!when.ok) return { ok: false, reason: `${at}: ${when.reason}` };
    if (typeof raw.target !== "string" || !TARGET_RE.test(raw.target))
      return { ok: false, reason: `${at}.target is malformed` };
    if (
      typeof raw.label !== "string" ||
      [...raw.label].length > MAX_RULE_LABEL ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(raw.label)
    )
      return { ok: false, reason: `${at}.label is malformed` };
    rules.push({
      when: when.matcher,
      target: raw.target as AccessTarget,
      label: raw.label,
    });
  }
  return { ok: true, policy: { mode, rules, ...anon } };
}

/** How an address was verified: by email code, by the provider, or by `connection:<id>`. */
export type EmailVia = "code" | "provider" | `connection:${string}`;

/** One strong sign-in link through one connection. */
export interface SignInLink {
  connection: string;
  groups: readonly string[];
  claims: Readonly<Record<string, unknown>>;
  email: { address: string; via: EmailVia } | null;
}

/** The only input to `accessFor()` besides the policy and the tiers. */
export interface SignInFacts {
  /** An entry with no sign-in: only `anonymousTier` applies. */
  anonymous: boolean;
  /** The authentication method (the `amr`); informational, no rule reads it yet. */
  method?: string;
  links: readonly SignInLink[];
  /** Per connection, the domains DNS-verified and enforced on it (lower-case). */
  verifiedDomains: DomainFacts;
}

export interface TierRank {
  id: string;
  rank: number;
}

export interface AccessResult {
  /** The granted tier id, or null. */
  tier: string | null;
  /** Every granted add-on id, in rule order, without repeats. */
  addons: string[];
  /** The labels of the rules that matched, in rule order. */
  matched: string[];
}

const none = (): AccessResult => ({ tier: null, addons: [], matched: [] });

/**
 * The address a link may be matched on: asserted by the provider or by this link's own
 * connection. An email-code address, or one verified through another connection, is dropped.
 */
function assertedEmail(l: SignInLink): string | null {
  const e = l.email;
  if (!isObject(e) || typeof e.address !== "string") return null;
  if (e.via === "provider" || e.via === `connection:${l.connection}`)
    return e.address;
  return null;
}

function toLinkFacts(l: unknown): LinkFacts | null {
  if (!isObject(l) || typeof l.connection !== "string") return null;
  const link = l as unknown as SignInLink;
  const groups = Array.isArray(link.groups)
    ? link.groups.filter((g): g is string => typeof g === "string")
    : [];
  return {
    connection: link.connection,
    groups,
    claims: isObject(link.claims) ? link.claims : {},
    email: assertedEmail(link),
  };
}

/**
 * What a sign-in is granted. `policy` is unvalidated input (a stored document): it is parsed here
 * and a malformed one grants nothing. `tiers` is the product's tier table; a tier the policy
 * names that is not in it grants nothing.
 */
export function accessFor(
  policy: unknown,
  facts: SignInFacts,
  tiers: readonly TierRank[],
): AccessResult {
  const parsed = parseAccessPolicy(policy);
  if (!parsed.ok) return none();
  const p = parsed.policy;
  const rank = new Map<string, number>();
  for (const t of tiers)
    if (typeof t.id === "string" && Number.isFinite(t.rank))
      rank.set(t.id, t.rank);

  if (!isObject(facts)) return none();
  if (facts.anonymous === true) {
    return p.anonymousTier !== undefined && rank.has(p.anonymousTier)
      ? { tier: p.anonymousTier, addons: [], matched: [] }
      : none();
  }
  if (p.mode === "nobody") return none();
  if (p.mode === "everyone")
    return rank.has(p.tier)
      ? { tier: p.tier, addons: [], matched: [] }
      : none();

  const links = (Array.isArray(facts.links) ? facts.links : [])
    .map(toLinkFacts)
    .filter((l): l is LinkFacts => l !== null);
  const domains: DomainFacts =
    facts.verifiedDomains instanceof Map ? facts.verifiedDomains : new Map();
  let best: string | null = null;
  const addons: string[] = [];
  const matched: string[] = [];
  for (const rule of p.rules) {
    if (!links.some((l) => matches(rule.when, l, domains))) continue;
    const m = TARGET_RE.exec(rule.target)!;
    const id = m[2]!;
    if (m[1] === "tier") {
      const r = rank.get(id);
      if (r === undefined) continue;
      matched.push(rule.label);
      if (best === null || r > rank.get(best)!) best = id;
    } else {
      matched.push(rule.label);
      if (!addons.includes(id)) addons.push(id);
    }
  }
  return { tier: best, addons, matched };
}
