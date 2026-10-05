/**
 * THE STORE-AGNOSTIC WRITE GATE ENGINE (A-18a; notes/S-15 §6.2, generalised from A-17a's App
 * Store Connect gate, notes/S-14 §7.5).
 *
 * Every storefront adapter with a Worker plane has ONE rule set (`rules/<store>.ts`) and its client
 * consults this engine BEFORE its token thunk runs: a refused request throws the adapter's
 * `StoreWriteDenied` subclass, so no token is minted and nothing is sent. The gate is
 * deny-by-default and has three parts:
 *
 *   | Part                                      | Store-neutral?         | Home                    |
 *   | ----------------------------------------- | ---------------------- | ----------------------- |
 *   | Engine (this file)                        | yes                    | `gate.ts`               |
 *   | Body matcher                              | no: one per wire style | `match/<style>.ts`      |
 *   | Rule table, deny classification, spec pin | no: one per adapter    | `rules/<store>.ts`      |
 *
 * The engine owns:
 *
 *   - the path policy (the adapter's `validPath`) and the paths refused for every method, reads
 *     included (`forbidden`: personal data, team membership);
 *   - method and path-template match: a write passes only when a rule names its method and its
 *     template exactly (each `{name}` stands for one segment of the rule set's `placeholder`);
 *   - the body, through the rule set's matcher (`match/jsonapi.ts`, `json.ts`, `form.ts`,
 *     `multipart.ts`);
 *   - the confirmation levels `plain`, `typed`, `initial` and `typed-or-initial`: a rule marked
 *     `typed` refuses without `typedConfirmation: true`, so a handler that forgets to compare the
 *     operator's typed phrase cannot send (owner rule: submit, release and price changes are typed
 *     on every store);
 *   - the fixed deny reasons (a refusal never carries a body value);
 *   - the "no `DELETE` rule may exist" assertion (owner rule: never delete), checked when a rule
 *     set is compiled, so a table that names one fails at import, in every test;
 *   - the hook-origin rule for callback URLs (`isOwnHookUrl`): a URL the store will call back is
 *     admitted only on the Worker's own origin, which the handler asserts from its own request.
 *
 * A change to any `rules/*` table is a THREAT-MODEL §9 review trigger.
 */

import type { SpecPin } from "../adapters/contract.js";
import { StoreWriteDenied } from "./errors.js";

export type GateMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A method a rule may allow. Never `DELETE` (and the engine asserts it at compile time). */
export type WriteMethod = Exclude<GateMethod, "GET" | "DELETE">;

/**
 * What a handler asserts about one write, beyond the body. Never sent to the store.
 *
 *   - `typedConfirmation`: the operator typed the confirmation phrase (the app's name as the
 *     store reports it, `confirm.ts`) and the handler compared it before calling.
 *   - `initial`: the handler's natural-key pre-read found no existing object of this kind (the
 *     first price, the first availability), so the write sets rather than changes.
 *   - `hookOrigin`: the Worker's own public origin, from the request the handler is serving. A
 *     callback URL is admitted only on this exact origin; without it, every callback is refused.
 *   - `resourceState`: the store's own state of the object the write targets, from the
 *     handler's pre-read (an App Store version's `appVersionState`). A rule whose meaning depends
 *     on it (a release type that auto-releases a version already in review) treats a missing
 *     state as the most dangerous one.
 */
export interface GateContext {
  typedConfirmation?: boolean;
  initial?: boolean;
  hookOrigin?: string;
  resourceState?: string;
}

/**
 * How a rule is confirmed.
 *
 *   - `plain`             the console's ordinary confirm (no assertion needed here);
 *   - `typed`             `typedConfirmation` required;
 *   - `initial`           `initial` required: the rule is a first-time set only;
 *   - `typed-or-initial`  a first-time set, or a change confirmed by typing (prices).
 */
export type Confirm = "plain" | "typed" | "initial" | "typed-or-initial";

/** The fixed refusal reasons (never a body value). */
export type DenyReason =
  | "not_allowed"
  | "personal_data"
  | "invalid_path"
  | "invalid_body"
  | "wrong_type"
  | "attribute_not_allowed"
  | "relationship_not_allowed"
  | "included_not_allowed"
  | "value_not_allowed"
  | "typed_confirmation_required"
  | "initial_only"
  | "content_type_not_allowed"
  | "too_large";

/** What every rule of every store has; each matcher adds its own body fields. */
export interface GateRule {
  method: WriteMethod;
  /** The store's path template, exactly as its spec spells it (`/v1/betaGroups/{id}`). */
  path: string;
  confirm: Confirm;
  /** Why the operation is on the approved surface, for the reviewer. */
  why: string;
}

/** A body matcher: one per wire style. Answers a refusal reason or null. Pure. */
export type BodyMatcher<R extends GateRule> = (
  rule: R,
  path: string,
  body: unknown,
  ctx: GateContext,
) => DenyReason | null;

/** One adapter's gate: its rules, its classification of the vendor spec, and its policies. */
export interface GateRuleSet<R extends GateRule = GateRule> {
  /** The adapter id (`app-store`). */
  readonly store: string;
  /** The vendor contract the table is classified against; null for a hand-written list. */
  readonly specPin: SpecPin | null;
  /** The approved write surface. Everything else is refused. */
  readonly allow: readonly R[];
  /** Every other write of the pinned spec, by deny group (`"<METHOD> <template>"`). */
  readonly denied: Readonly<Record<string, readonly string[]>>;
  /** Why each deny group is refused. */
  readonly denyReasons: Readonly<Record<string, string>>;
  /** The shape of a path the client may send at all (refused `invalid_path` otherwise). */
  readonly validPath: (path: string) => boolean;
  /** Paths refused for every method, reads included (`personal_data`). */
  readonly forbidden?: (path: string) => boolean;
  /**
   * What a template's `{name}` placeholder matches (a regex source with no anchors or groups that
   * capture); `DEFAULT_PLACEHOLDER` when absent. Play's package names carry dots and its track
   * ids spaces and colons (`wear:beta`), so its rule set widens it.
   */
  readonly placeholder?: string;
  /** The body matcher (method syntax: a rule set of a narrower rule type is still a rule set). */
  match(
    rule: R,
    path: string,
    body: unknown,
    ctx: GateContext,
  ): DenyReason | null;
  /** The adapter's refusal, so a message names the store (`AscWriteDenied`). */
  readonly deny: (
    method: string,
    target: string,
    reason: DenyReason,
  ) => StoreWriteDenied;
}

/** A rule's id: what `Support.rules` names and what the deny lists spell. */
export function ruleId(rule: Pick<GateRule, "method" | "path">): string {
  return `${rule.method} ${rule.path}`;
}

/** One plain path segment: a resource type, a relationship name, or an id. */
export const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What one `{name}` placeholder matches by default: one plain segment (`PATH_SEGMENT`). */
export const DEFAULT_PLACEHOLDER = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";

/**
 * A template's matcher. Every `{name}` (Apple's `{id}`, Google's `{packageName}`, `{editId}`…)
 * stands for one segment of the rule set's `placeholder` shape; everything else is literal, a
 * Google custom-method suffix included (`{editId}:commit`).
 */
function templateRegex(template: string, placeholder: string): RegExp {
  const body = template
    .split("/")
    .map((seg) =>
      seg
        .split(/(\{[A-Za-z]+\})/)
        .map((part) =>
          /^\{[A-Za-z]+\}$/.test(part)
            ? `(?:${placeholder})`
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join(""),
    )
    .join("/");
  return new RegExp(`^${body}$`);
}

/** The confirmation level's own refusal, or null. */
export function checkConfirm(
  confirm: Confirm,
  ctx: GateContext,
): DenyReason | null {
  switch (confirm) {
    case "plain":
      return null;
    case "typed":
      return ctx.typedConfirmation === true
        ? null
        : "typed_confirmation_required";
    case "initial":
      return ctx.initial === true ? null : "initial_only";
    case "typed-or-initial":
      return ctx.initial === true || ctx.typedConfirmation === true
        ? null
        : "typed_confirmation_required";
  }
}

/** A compiled rule set: what a client calls. */
export interface CompiledGate<R extends GateRule> {
  readonly set: GateRuleSet<R>;
  /** The allow rule for one method and request path, or null. */
  find(method: string, path: string): R | null;
  /**
   * Admit or refuse one request. Throws the adapter's `StoreWriteDenied`; returns the matched rule
   * for a write (null for an admitted read). Pure: no I/O, no token.
   */
  check(
    method: string,
    path: string,
    body: unknown,
    ctx?: GateContext,
  ): R | null;
}

/**
 * Compile a rule set. Throws when the table is malformed: a `DELETE` rule (owner rule: never
 * delete), a rule id twice, or a rule the deny lists also name.
 */
export function compileGate<R extends GateRule>(
  set: GateRuleSet<R>,
): CompiledGate<R> {
  const ids = new Set<string>();
  const denied = new Set(Object.values(set.denied).flat());
  for (const rule of set.allow) {
    if (
      (rule.method as string) === "DELETE" ||
      (rule.method as string) === "GET"
    )
      throw new Error(
        `${set.store} gate: a rule may not allow ${rule.method} (${rule.path})`,
      );
    const id = ruleId(rule);
    if (ids.has(id)) throw new Error(`${set.store} gate: ${id} twice`);
    if (denied.has(id))
      throw new Error(`${set.store} gate: ${id} is both allowed and denied`);
    ids.add(id);
  }
  const compiled = set.allow.map((rule) => ({
    rule,
    re: templateRegex(rule.path, set.placeholder ?? DEFAULT_PLACEHOLDER),
  }));
  const find = (method: string, path: string): R | null => {
    for (const { rule, re } of compiled)
      if (rule.method === method && re.test(path)) return rule;
    return null;
  };
  return {
    set,
    find,
    check(method, path, body, ctx = {}) {
      if (!set.validPath(path)) throw set.deny(method, path, "invalid_path");
      if (set.forbidden?.(path)) throw set.deny(method, path, "personal_data");
      if (method === "GET") {
        if (body !== undefined) throw set.deny(method, path, "invalid_body");
        return null;
      }
      const rule = find(method, path);
      if (!rule) throw set.deny(method, path, "not_allowed");
      const reason =
        set.match(rule, path, body, ctx) ?? checkConfirm(rule.confirm, ctx);
      if (reason) throw set.deny(method, rule.path, reason);
      return rule;
    },
  };
}

/** Whether a gate admits a request (for verifiers and the conformance suite). */
export function admits<R extends GateRule>(
  gate: CompiledGate<R>,
  method: string,
  path: string,
  body?: unknown,
  ctx?: GateContext,
): boolean {
  try {
    gate.check(method, path, body, ctx);
    return true;
  } catch (e) {
    if (e instanceof StoreWriteDenied) return false;
    throw e;
  }
}

// ── The hook-origin rule ─────────────────────────────────────────────────────────────────────

/**
 * A URL the Worker itself serves for one product: `https://<host>/<slug>/<suffix>`, no
 * credentials, query, fragment or port other than 443, on exactly the origin the handler asserted
 * as its own (`ctx.hookOrigin`). The gate fixes both the host and the shape, so a URL from anywhere
 * else cannot be registered as a store callback.
 */
export function isOwnHookUrl(
  value: unknown,
  suffix: string,
  hookOrigin: string | undefined,
): boolean {
  if (typeof hookOrigin !== "string" || hookOrigin === "") return false;
  if (typeof value !== "string" || value.length > 512) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.origin === hookOrigin &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    u.search === "" &&
    u.hash === "" &&
    new RegExp(`^/[a-z0-9][a-z0-9-]{0,62}/${suffix}$`).test(u.pathname)
  );
}

// ── Shared body helpers ──────────────────────────────────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function onlyKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** `value` is one of `allowed` (or null, when `nullable`). */
export function oneOf(
  value: unknown,
  allowed: readonly unknown[],
  nullable = false,
): boolean {
  return (nullable && value === null) || allowed.includes(value);
}
