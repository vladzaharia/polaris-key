/**
 * The ClaimMatcher and the `console.access` rule document (ST-28 plan §2.4; built by ST-32.1).
 *
 * A rule says "a person who signed in through this connection and carries this group, domain or
 * claim gets this grant". LX-36's `license.access` reuses the `when` object unchanged, which is
 * why this lives in Core.
 *
 * Pure: no Db, no Env, no I/O. The caller supplies the stored link claims and the verified domains.
 * `evaluate` is the one function the preview and per-request evaluation both call, so the two
 * cannot disagree. Everything fails closed: a malformed document is refused whole, and a link or
 * fact that is missing or the wrong shape matches nothing.
 *
 * Matching rules:
 *   - `connection`: exact. A link through any other connection never matches the rule.
 *   - `group`: exact and case-sensitive, as the IdP spelled it. One of the link's groups.
 *   - `claim`: the claim name is exact; `equals` is compared exactly (case-sensitive) with the
 *     claim's string value, or with one element of a string array.
 *   - `domain`: case-insensitive, the whole domain (no subdomain match). The address must be one
 *     the IdP asserted (`LinkFacts.email`) and the domain must be on `domainFacts` for the
 *     connection: verified and enforced. An address confirmed only by email code is not passed.
 */

import { PRODUCT_SLUG_RE, SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { PRODUCT_AREAS, isAreaId, type AreaId } from "./areas.js";
import type { Grant, GrantScope, Role } from "./can.js";

/** At most this many rules in one document. */
export const MAX_ACCESS_RULES = 50;
/** A rule label is at most this many characters. */
export const MAX_RULE_LABEL = 80;
/** The roles a rule may grant. Superadmin and Platform admin never come from a rule. */
export const RULE_ROLES = ["product_admin", "console_access"] as const;

const RULE_ID_RE = /^r_[0-9a-f]{6,32}$/;
const CONNECTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_MATCH_VALUE = 256;
const MAX_CLAIM_NAME = 128;

export type ClaimMatcher = {
  connection: string;
} & (
  | { group: string }
  | { domain: string }
  | { claim: { name: string; equals: string } }
);

export interface RuleGrant {
  role: (typeof RULE_ROLES)[number];
  scope: "platform" | `product:${string}`;
  /** `product_admin` only: a non-empty list in `AREAS` order. Absent for `console_access`. */
  areas?: AreaId[];
}

export interface AccessRule {
  id: string;
  label?: string;
  when: ClaimMatcher;
  grant: RuleGrant;
}

export interface AccessRulesDoc {
  rules: AccessRule[];
}

export type ParseResult =
  | { ok: true; doc: AccessRulesDoc }
  | { ok: false; reason: string };

export interface ParseOptions {
  /**
   * Write path. A rule with no `id` gets `mintId()`. A rule that names an `id` must be one of
   * `knownIds` (the ids already stored), so a caller cannot choose its own. Absent on the read
   * path, where every rule must already carry a well-formed id.
   */
  mintId?: () => string;
  knownIds?: ReadonlySet<string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function extraKeys(
  o: Record<string, unknown>,
  allowed: string[],
): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return k;
  return null;
}

/** A matcher value: a non-empty string with no control characters, at most 256 characters. */
function matchString(v: unknown, max = MAX_MATCH_VALUE): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  return v;
}

/** Parse one `when` object. Exactly one of `group`, `domain`, `claim`. */
export function parseClaimMatcher(
  v: unknown,
): { ok: true; matcher: ClaimMatcher } | { ok: false; reason: string } {
  if (!isObject(v)) return { ok: false, reason: "when must be an object" };
  const bad = extraKeys(v, ["connection", "group", "domain", "claim"]);
  if (bad) return { ok: false, reason: `when has an unknown key: ${bad}` };
  const connection = v.connection;
  if (typeof connection !== "string" || !CONNECTION_RE.test(connection))
    return { ok: false, reason: "when.connection is missing or malformed" };
  const kinds = ["group", "domain", "claim"].filter((k) => k in v);
  if (kinds.length !== 1)
    return {
      ok: false,
      reason: "when needs exactly one of group, domain or claim",
    };
  if (kinds[0] === "group") {
    const group = matchString(v.group);
    if (!group) return { ok: false, reason: "when.group is malformed" };
    return { ok: true, matcher: { connection, group } };
  }
  if (kinds[0] === "domain") {
    const domain =
      typeof v.domain === "string" ? v.domain.trim().toLowerCase() : "";
    if (!DOMAIN_RE.test(domain))
      return { ok: false, reason: "when.domain is not a domain name" };
    return { ok: true, matcher: { connection, domain } };
  }
  const claim = v.claim;
  if (!isObject(claim)) return { ok: false, reason: "when.claim is malformed" };
  const badClaim = extraKeys(claim, ["name", "equals"]);
  if (badClaim)
    return { ok: false, reason: `when.claim has an unknown key: ${badClaim}` };
  const name = matchString(claim.name, MAX_CLAIM_NAME);
  const equals = matchString(claim.equals);
  if (!name || !equals)
    return { ok: false, reason: "when.claim needs a name and an equals" };
  return { ok: true, matcher: { connection, claim: { name, equals } } };
}

function parseGrant(
  v: unknown,
): { ok: true; grant: RuleGrant } | { ok: false; reason: string } {
  if (!isObject(v)) return { ok: false, reason: "grant must be an object" };
  const bad = extraKeys(v, ["role", "scope", "areas"]);
  if (bad) return { ok: false, reason: `grant has an unknown key: ${bad}` };
  const role = v.role;
  if (role !== "product_admin" && role !== "console_access")
    return {
      ok: false,
      reason: "a rule grants only product_admin or console_access",
    };
  const scope = v.scope;
  if (typeof scope !== "string")
    return { ok: false, reason: "grant.scope is missing" };
  if (role === "console_access") {
    if (scope !== "platform")
      return {
        ok: false,
        reason: "console_access takes the platform scope",
      };
    if (v.areas !== undefined)
      return { ok: false, reason: "console_access takes no areas" };
    return { ok: true, grant: { role, scope: "platform" } };
  }
  if (!scope.startsWith("product:"))
    return { ok: false, reason: "product_admin takes a product:<slug> scope" };
  const slug = scope.slice("product:".length);
  if (!PRODUCT_SLUG_RE.test(slug) || slug === SYSTEM_PRODUCT_SLUG)
    return { ok: false, reason: "grant.scope names no product" };
  if (!Array.isArray(v.areas) || v.areas.length === 0)
    return { ok: false, reason: "grant.areas must be a non-empty list" };
  const wanted = new Set<string>();
  for (const a of v.areas) {
    if (!isAreaId(a) || !PRODUCT_AREAS.includes(a))
      return { ok: false, reason: "grant.areas names an unknown area" };
    wanted.add(a);
  }
  return {
    ok: true,
    grant: {
      role,
      scope: scope as `product:${string}`,
      areas: PRODUCT_AREAS.filter((a) => wanted.has(a)),
    },
  };
}

/**
 * Parse a `console.access` document: `{ rules: [...] }`. The whole document is refused on the
 * first problem. Ids are unique and `r_` plus 6 to 32 hex characters.
 */
export function parseAccessRules(
  value: unknown,
  opts: ParseOptions = {},
): ParseResult {
  if (!isObject(value))
    return { ok: false, reason: "document must be an object" };
  const badDoc = extraKeys(value, ["rules"]);
  if (badDoc) return { ok: false, reason: `unknown key: ${badDoc}` };
  if (!Array.isArray(value.rules))
    return { ok: false, reason: "rules must be a list" };
  if (value.rules.length > MAX_ACCESS_RULES)
    return { ok: false, reason: `at most ${MAX_ACCESS_RULES} rules` };
  const rules: AccessRule[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of value.rules.entries()) {
    const at = `rules[${i}]`;
    if (!isObject(raw)) return { ok: false, reason: `${at} must be an object` };
    const bad = extraKeys(raw, ["id", "label", "when", "grant"]);
    if (bad) return { ok: false, reason: `${at} has an unknown key: ${bad}` };
    let id = raw.id;
    if (id === undefined || id === null) {
      if (!opts.mintId) return { ok: false, reason: `${at}.id is missing` };
      id = opts.mintId();
    } else if (opts.knownIds && !opts.knownIds.has(id as string)) {
      return { ok: false, reason: `${at}.id is assigned by the server` };
    }
    if (typeof id !== "string" || !RULE_ID_RE.test(id))
      return { ok: false, reason: `${at}.id is malformed` };
    if (ids.has(id)) return { ok: false, reason: `${at}.id is repeated` };
    ids.add(id);
    let label: string | undefined;
    if (raw.label !== undefined) {
      if (
        typeof raw.label !== "string" ||
        [...raw.label].length > MAX_RULE_LABEL
      )
        return {
          ok: false,
          reason: `${at}.label is at most ${MAX_RULE_LABEL} characters`,
        };
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(raw.label))
        return { ok: false, reason: `${at}.label has control characters` };
      label = raw.label;
    }
    const when = parseClaimMatcher(raw.when);
    if (!when.ok) return { ok: false, reason: `${at}: ${when.reason}` };
    const grant = parseGrant(raw.grant);
    if (!grant.ok) return { ok: false, reason: `${at}: ${grant.reason}` };
    rules.push({
      id,
      ...(label !== undefined ? { label } : {}),
      when: when.matcher,
      grant: grant.grant,
    });
  }
  return { ok: true, doc: { rules } };
}

/**
 * What evaluation reads off one strong OIDC link through an operator connection. The caller has
 * already applied the `asserted_at` freshness and the operator-connection check; a link that
 * fails either is simply not passed.
 */
export interface LinkFacts {
  connection: string;
  groups: readonly string[];
  /** The stored claims. A value is a string, or an array of strings; anything else matches nothing. */
  claims: Readonly<Record<string, unknown>>;
  /** The address the IdP asserted for this link, or null. Never an email-code address. */
  email: string | null;
}

/** Per connection, the domains that are DNS-verified and enforced on it (lower-case). */
export type DomainFacts = ReadonlyMap<string, ReadonlySet<string>>;

/** Whether one matcher holds for one link. */
export function matches(
  when: ClaimMatcher,
  link: LinkFacts,
  domainFacts: DomainFacts,
): boolean {
  if (link.connection !== when.connection) return false;
  if ("group" in when) {
    return Array.isArray(link.groups) && link.groups.includes(when.group);
  }
  if ("claim" in when) {
    if (!link.claims || !Object.hasOwn(link.claims, when.claim.name))
      return false;
    const v = link.claims[when.claim.name];
    if (typeof v === "string") return v === when.claim.equals;
    return Array.isArray(v) && v.some((x) => x === when.claim.equals);
  }
  const email = link.email;
  if (typeof email !== "string") return false;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0] === "") return false;
  const domain = parts[1]!.toLowerCase();
  if (domain !== when.domain.toLowerCase()) return false;
  return domainFacts.get(when.connection)?.has(domain) === true;
}

export interface RuleMatch {
  ruleId: string;
  connection: string;
  grant: Grant;
}

/**
 * Every rule that matches any link, with the grant it gives. Superadmin and Platform admin are
 * never returned, whatever the document says.
 */
export function evaluate(
  links: readonly LinkFacts[],
  rules: readonly AccessRule[],
  domainFacts: DomainFacts,
): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const rule of rules) {
    if (
      rule.grant.role !== "product_admin" &&
      rule.grant.role !== "console_access"
    )
      continue;
    if (!links.some((l) => matches(rule.when, l, domainFacts))) continue;
    out.push({
      ruleId: rule.id,
      connection: rule.when.connection,
      grant: {
        role: rule.grant.role as Role,
        scope: rule.grant.scope as GrantScope,
        areas: rule.grant.areas ? [...rule.grant.areas] : null,
        source: "rule",
      },
    });
  }
  return out;
}
