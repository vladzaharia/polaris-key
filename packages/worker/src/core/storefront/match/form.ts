/**
 * The form-parameter body matcher (the Steam Web API's `application/x-www-form-urlencoded`
 * methods; notes/S-15 §6.2). No adapter uses it yet (A-18g adds the first rule table).
 *
 * The client hands the gate the parameters it will encode, as a flat object of strings. Every
 * parameter must be declared; a declared parameter takes either any string up to its length, an
 * integer, or one of a fixed set. The rule's `check` runs last, so a rule can say, for instance,
 * that `betakey` may be `public` only under a typed confirmation.
 */

import {
  isPlainObject,
  type DenyReason,
  type GateContext,
  type GateRule,
} from "../gate.js";

export type FormParam =
  | { kind: "string"; max: number }
  | { kind: "integer" }
  | { kind: "enum"; values: readonly string[] };

export interface FormRule extends GateRule {
  params: Readonly<Record<string, FormParam>>;
  /** Parameters that must be present. */
  required?: readonly string[];
  check?: (
    params: Readonly<Record<string, string>>,
    ctx: GateContext,
  ) => DenyReason | null;
}

/** The form matcher. */
export function matchForm(
  rule: FormRule,
  _path: string,
  body: unknown,
  ctx: GateContext,
): DenyReason | null {
  if (!isPlainObject(body)) return "invalid_body";
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(rule.params, k)) return "attribute_not_allowed";
    if (typeof v !== "string") return "invalid_body";
    const p = rule.params[k]!;
    if (p.kind === "string" && v.length > p.max) return "value_not_allowed";
    if (p.kind === "integer" && !/^(0|[1-9][0-9]{0,17})$/.test(v))
      return "value_not_allowed";
    if (p.kind === "enum" && !p.values.includes(v)) return "value_not_allowed";
    params[k] = v;
  }
  for (const k of rule.required ?? [])
    if (!Object.hasOwn(params, k)) return "invalid_body";
  return rule.check ? rule.check(params, ctx) : null;
}
