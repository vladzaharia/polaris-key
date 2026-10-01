// Representability: can this operator value ride inside a signed document that every wire-v4
// verifier accepts? (plans/P3-01.md §2.2, "Keeping the signer total"; WIRE-CONTRACT-V4 §1.2.)
//
// The Worker's signer refuses a document that breaks the strict-JSON rules (`signJws` throws
// `StrictJsonError`). Operator data reaches signed documents through catalog-typed values,
// admin handlers, OIDC sign-in and the manifest sync, so each of those refuses or drops a
// value this function flags BEFORE it is stored, and the catalog prune drops one stored before
// the check existed. One function decides it everywhere, so no write path checks less than
// another.
//
// The five rules, each stricter than or equal to the verifier's own:
//
//   lone-surrogate           a lone UTF-16 surrogate in any string, member names included
//                            (V4 §1.2 rule 5). `JSON.stringify` writes one as the ASCII escape
//                            `\ud800`, which survives in D1's JSON-text columns.
//   nul-in-member-name       U+0000 in a member name (rule 7). Values keep V3 §10's limit.
//   equivalent-member-names  two sibling names that differ but are equal after NFC. The
//                            verifier accepts them (rule 6 compares scalar values), but Swift's
//                            `JSONValue` keeps only the first, so no document may carry them.
//   number-out-of-range      a number `JSON.stringify` writes outside rule 8's range: not zero
//                            and below 10^-307 or at least 10^308 in magnitude, or not finite.
//   too-deep                 more than MAX_VALUE_DEPTH levels inside the value. A document
//                            wraps at most three levels around an operator value
//                            (`entitlements.<key>.value`), so 32 stays inside rule 9's 64.

/** The five representability rules (plans/P3-01.md §2.2). */
export type RepresentabilityRule =
  | "lone-surrogate"
  | "nul-in-member-name"
  | "equivalent-member-names"
  | "number-out-of-range"
  | "too-deep";

export interface RepresentabilityIssue {
  readonly rule: RepresentabilityRule;
  /** RFC 6901 pointer into the value: the string, member or number that breaks the rule. */
  readonly path: string;
}

/**
 * The most object or array levels an operator value may nest, counting the value itself as
 * level 1 when it is a container. Scalars add no level.
 */
export const MAX_VALUE_DEPTH = 32;

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** True when `s` holds a UTF-16 surrogate that is not half of a well-formed pair. */
export function hasLoneSurrogate(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const u = s.charCodeAt(k);
    if (u >= 0xd800 && u <= 0xdbff) {
      const n = s.charCodeAt(k + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        k++;
        continue;
      }
      return true;
    }
    if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

/**
 * V4 §1.2 rule 8 for a JavaScript number, judged on the token `JSON.stringify` writes for it
 * (the shortest round-trip spelling), so the answer is the strict verifier's own: zero, or a
 * decimal exponent from −307 to 307. A non-finite number has no JSON token at all.
 */
export function numberInWireRange(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  if (n === 0) return true;
  const token = String(Math.abs(n));
  const m = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-])([0-9]+))?$/.exec(token);
  if (!m) return false;
  const int = m[1]!;
  const digits = int + (m[2] ?? "");
  const first = digits.search(/[1-9]/);
  const exp = (m[3] === "-" ? -1 : 1) * Number(m[4] ?? "0");
  const power = int.length - 1 - first + exp;
  return power >= -307 && power <= 307;
}

/**
 * The first rule `value` breaks, with the pointer to where, or `null` when every wire-v4
 * verifier would accept it inside a signed document. Never throws, and never walks deeper than
 * `MAX_VALUE_DEPTH + 1` levels, so a hostile value costs at most one pass over its own size.
 * Types JSON cannot carry (`undefined`, functions, `bigint`) are the catalog schema's to refuse,
 * not this function's.
 */
export function representabilityIssue(
  value: unknown,
): RepresentabilityIssue | null {
  return walk(value, "", 0);
}

function walk(
  value: unknown,
  path: string,
  depth: number,
): RepresentabilityIssue | null {
  if (typeof value === "string") {
    return hasLoneSurrogate(value) ? { rule: "lone-surrogate", path } : null;
  }
  if (typeof value === "number") {
    return numberInWireRange(value)
      ? null
      : { rule: "number-out-of-range", path };
  }
  if (value === null || typeof value !== "object") return null;
  if (depth + 1 > MAX_VALUE_DEPTH) return { rule: "too-deep", path };
  if (Array.isArray(value)) {
    for (let k = 0; k < value.length; k++) {
      const issue = walk(value[k], `${path}/${k}`, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  const seen = new Map<string, string>();
  for (const [name, member] of Object.entries(value)) {
    const memberPath = `${path}/${escapePointer(name)}`;
    if (hasLoneSurrogate(name))
      return { rule: "lone-surrogate", path: memberPath };
    if (name.includes("\u0000"))
      return { rule: "nul-in-member-name", path: memberPath };
    const nfc = name.normalize("NFC");
    const earlier = seen.get(nfc);
    if (earlier !== undefined && earlier !== name)
      return { rule: "equivalent-member-names", path: memberPath };
    seen.set(nfc, name);
    const issue = walk(member, memberPath, depth + 1);
    if (issue) return issue;
  }
  return null;
}

/** One line naming the rule and where, for a `fields` entry or a log. */
export function describeRepresentabilityIssue(
  issue: RepresentabilityIssue,
  label = "value",
): string {
  return `${label}${issue.path} is not representable in a signed document (${issue.rule})`;
}

/**
 * The member-name projection of a catalog (`{ entries: [{ key, kind, … }] }`, the shape of
 * `product_schema.catalog_json`): the first representability issue among its entry keys, with
 * the pointer `/entries/<i>/key`, or `null`.
 *
 * A catalog key is a string VALUE inside the catalog but a MEMBER NAME in every document that
 * carries it (`config.<key>`, `secrets.<key>`, `entitlements.<key>` for a flag), so walking the
 * catalog with `representabilityIssue` sees only half of it. This applies the member-name rules
 * to the keys: a lone surrogate, U+0000, and two keys of the same kind that differ but are equal
 * after NFC (they land in the same document object). Anything that is not a catalog shape
 * answers `null`; the catalog's own validation refuses it.
 */
export function catalogKeyIssue(
  catalog: unknown,
): RepresentabilityIssue | null {
  if (catalog === null || typeof catalog !== "object") return null;
  const entries = (catalog as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const seen = new Map<string, Map<string, string>>();
  for (let i = 0; i < entries.length; i++) {
    const entry: unknown = entries[i];
    if (entry === null || typeof entry !== "object") continue;
    const { key, kind } = entry as { key?: unknown; kind?: unknown };
    if (typeof key !== "string") continue;
    const path = `/entries/${i}/key`;
    if (hasLoneSurrogate(key)) return { rule: "lone-surrogate", path };
    if (key.includes("\u0000")) return { rule: "nul-in-member-name", path };
    const bucket = String(kind);
    let names = seen.get(bucket);
    if (!names) seen.set(bucket, (names = new Map()));
    const nfc = key.normalize("NFC");
    const earlier = names.get(nfc);
    if (earlier !== undefined && earlier !== key)
      return { rule: "equivalent-member-names", path };
    names.set(nfc, key);
  }
  return null;
}
