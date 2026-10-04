/**
 * The JSON:API body matcher (App Store Connect; A-17a's matcher, moved unchanged by A-18a into the
 * store-agnostic gate, notes/S-15 §6.2).
 *
 * A write passes only when its body matches the rule: the resource type, every attribute key,
 * every relationship name and the type of every identifier it names, the `included` resource
 * types, and the rule's own value checks. A linkage path (`…/relationships/<name>`) takes
 * identifiers of the rule's type only. A `PATCH` body must name the path's own object.
 */

import {
  isPlainObject,
  onlyKeys,
  type DenyReason,
  type GateContext,
  type GateRule,
} from "../gate.js";

export interface JsonApiIdentifier {
  type: string;
  id: string;
}

export interface JsonApiData {
  type: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data: JsonApiIdentifier | JsonApiIdentifier[] }
  >;
}

/** A rule's extra check on the request's `data` object: a refusal reason, or null. */
export type JsonApiDataCheck = (
  data: JsonApiData,
  ctx: GateContext,
) => DenyReason | null;

/** One JSON:API allow rule. */
export interface JsonApiRule extends GateRule {
  /** The JSON:API resource type of `data` (or of each identifier, for a linkage path). */
  type: string;
  /** Attribute keys the body may carry. */
  attributes: readonly string[];
  /** Relationship name → the identifier type it must name. */
  relationships: Readonly<Record<string, string>>;
  /** Resource types an `included` array may carry (inline creates: prices, territories). */
  included?: readonly string[];
  check?: JsonApiDataCheck;
}

/** The attributes of a `data` object (empty when absent). */
export const attrs = (d: JsonApiData): Record<string, unknown> =>
  d.attributes ?? {};

const ID = /^[A-Za-z0-9${}._:-]{1,128}$/;

function isIdentifier(v: unknown, type: string): boolean {
  return (
    isPlainObject(v) &&
    onlyKeys(v, ["type", "id"]) &&
    v.type === type &&
    typeof v.id === "string" &&
    ID.test(v.id)
  );
}

/** Check a linkage body (`/relationships/<name>`): identifiers of the rule's type only. */
function checkLinkage(rule: JsonApiRule, body: unknown): DenyReason | null {
  if (!isPlainObject(body) || !onlyKeys(body, ["data"])) return "invalid_body";
  const d = body.data;
  const ids = Array.isArray(d) ? d : [d];
  if (ids.length === 0 || ids.length > 200) return "invalid_body";
  return ids.every((i) => isIdentifier(i, rule.type)) ? null : "wrong_type";
}

function checkResource(
  rule: JsonApiRule,
  path: string,
  body: unknown,
  ctx: GateContext,
): DenyReason | null {
  if (!isPlainObject(body)) return "invalid_body";
  const topKeys = rule.included ? ["data", "included"] : ["data"];
  if (!onlyKeys(body, topKeys)) return "included_not_allowed";
  const data = body.data;
  if (!isPlainObject(data)) return "invalid_body";
  if (!onlyKeys(data, ["type", "id", "attributes", "relationships"]))
    return "invalid_body";
  if (data.type !== rule.type) return "wrong_type";
  if (rule.method === "PATCH") {
    // The body's id must be the path's: a PATCH cannot name one object and change another.
    const pathId = path.split("/").at(-1);
    if (data.id !== pathId) return "invalid_body";
  } else if ("id" in data) {
    return "invalid_body";
  }
  if ("attributes" in data) {
    if (!isPlainObject(data.attributes)) return "invalid_body";
    if (!onlyKeys(data.attributes, rule.attributes))
      return "attribute_not_allowed";
  }
  if ("relationships" in data) {
    const rels = data.relationships;
    if (!isPlainObject(rels)) return "invalid_body";
    for (const [name, rel] of Object.entries(rels)) {
      const type = Object.hasOwn(rule.relationships, name)
        ? rule.relationships[name]
        : undefined;
      if (type === undefined) return "relationship_not_allowed";
      if (!isPlainObject(rel) || !onlyKeys(rel, ["data"]))
        return "invalid_body";
      const ids = Array.isArray(rel.data) ? rel.data : [rel.data];
      if (ids.length > 200) return "invalid_body";
      if (!ids.every((i) => isIdentifier(i, type))) return "wrong_type";
    }
  }
  if ("included" in body) {
    const inc = body.included;
    if (!Array.isArray(inc) || inc.length > 200) return "invalid_body";
    for (const r of inc)
      if (
        !isPlainObject(r) ||
        typeof r.type !== "string" ||
        !rule.included!.includes(r.type)
      )
        return "included_not_allowed";
  }
  return rule.check ? rule.check(data as unknown as JsonApiData, ctx) : null;
}

/** The JSON:API matcher: a linkage body for a `/relationships/` template, a resource otherwise. */
export function matchJsonApi(
  rule: JsonApiRule,
  path: string,
  body: unknown,
  ctx: GateContext,
): DenyReason | null {
  return rule.path.includes("/relationships/")
    ? checkLinkage(rule, body)
    : checkResource(rule, path, body, ctx);
}
