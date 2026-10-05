/**
 * The CI command allow-list as the CLI enforces it (A-18h; notes/S-15 §6.2, THREAT-MODEL control
 * (b)): the same check as the Worker's `core/storefront/ci.ts`, over the generated copy of the
 * same declaration (`ciPlane.generated.ts`). The CLI refuses a command before the vendor tool
 * starts; the Worker refuses it again when the step is reported back, so neither side trusts the
 * other's copy. `test/storefronts.test.ts` runs the conformance cases over this implementation.
 */

import { CI_PLANE } from "./ciPlane.generated.js";
import type {
  CiAllowList,
  CiIdentityBinding,
  CiParam,
  CiPlaneAdapter,
  CiPlaneStore,
} from "./types.js";

export type CiRefusal =
  | "not_allowed"
  | "value_not_allowed"
  | "identity_required"
  | "identity_mismatch";

export type CiIdentity = Readonly<Record<string, unknown>>;

/** A CI-plane store by id (`itch`, `snap`, `steam`, `msstore`, `epic`), or null. */
export function ciStore(store: string): CiPlaneStore | null {
  return CI_PLANE.stores.find((s) => s.store === store) ?? null;
}

/** A CI-plane storefront adapter by id (`itch`, `snap`), or null. */
export function ciAdapter(id: string): CiPlaneAdapter | null {
  return CI_PLANE.adapters.find((a) => a.id === id) ?? null;
}

export function ciStoreIds(): string[] {
  return CI_PLANE.stores.map((s) => s.store);
}

/** The values an identity field offers: a string, a list's strings, or a map's values. */
export function identityValues(identity: CiIdentity, field: string): string[] {
  const v = identity[field];
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object")
    return Object.values(v).filter((x): x is string => typeof x === "string");
  return [];
}

function bindingHolds(
  b: CiIdentityBinding,
  value: string,
  identity: CiIdentity,
): boolean {
  const values = identityValues(identity, b.field);
  if (values.length === 0) return false;
  const sep = b.separator ?? "";
  switch (b.match) {
    case "equal":
      return values.includes(value);
    case "prefix":
      return values.some((v) => value.startsWith(`${v}${sep}`));
    case "each": {
      const parts = sep ? value.split(sep) : [value];
      return parts.length > 0 && parts.every((p) => values.includes(p));
    }
  }
}

/** Whether `argv` (the tool excluded) is the declared command `id`; null when it is. */
export function checkCiCommand(
  list: CiAllowList,
  id: string,
  argv: readonly string[],
  identity?: CiIdentity,
): CiRefusal | null {
  if (!Object.hasOwn(list.commands, id)) return "not_allowed";
  const rule = list.commands[id]!;
  if (argv.length !== rule.argv.length) return "not_allowed";
  let bound = false;
  for (let i = 0; i < argv.length; i++) {
    const want = rule.argv[i]!;
    const got = argv[i]!;
    if (typeof want === "string") {
      if (got !== want) return "not_allowed";
      continue;
    }
    const prefix = want.prefix ?? "";
    if (!got.startsWith(prefix)) return "not_allowed";
    if (!new RegExp(`^(?:${want.pattern})$`).test(got.slice(prefix.length)))
      return "value_not_allowed";
    if (want.identity) bound = true;
  }
  if (!bound) return null;
  if (!identity) return "identity_required";
  for (let i = 0; i < argv.length; i++) {
    const want = rule.argv[i]!;
    if (typeof want === "string" || !want.identity) continue;
    const value = argv[i]!.slice((want.prefix ?? "").length);
    if (!bindingHolds(want.identity, value, identity))
      return "identity_mismatch";
  }
  return null;
}

/** The declared command `argv` is (identity aside), or null: the never-list check. */
export function matchCiCommand(
  list: CiAllowList,
  argv: readonly string[],
): string | null {
  for (const id of Object.keys(list.commands)) {
    const r = checkCiCommand(list, id, argv, {});
    if (r === null || r === "identity_mismatch" || r === "identity_required")
      return id;
  }
  return null;
}

/** A parameter's value in `argv` for command `id` (after its prefix), or undefined. */
export function ciParamValue(
  list: CiAllowList,
  id: string,
  argv: readonly string[],
  param: string,
): string | undefined {
  const rule = list.commands[id];
  if (!rule) return undefined;
  const i = rule.argv.findIndex(
    (a) => typeof a !== "string" && a.param === param,
  );
  if (i < 0 || argv[i] === undefined) return undefined;
  return argv[i]!.slice(((rule.argv[i] as CiParam).prefix ?? "").length);
}

/** Every literal token a list could run, prefixes included. */
export function ciLiterals(list: CiAllowList): string[] {
  return Object.values(list.commands).flatMap((c) =>
    c.argv.flatMap((a) =>
      typeof a === "string" ? [a] : a.prefix ? [a.prefix] : [],
    ),
  );
}

/** Whether a command is bound to the outlet identity (it then needs `--outlet`). */
export function bindsIdentity(list: CiAllowList, id: string): boolean {
  return (list.commands[id]?.argv ?? []).some(
    (a) => typeof a !== "string" && a.identity !== undefined,
  );
}

/** A human message for a refusal. */
export function refusalMessage(
  store: CiPlaneStore,
  command: string,
  argv: readonly string[],
  refusal: CiRefusal,
): string {
  const line = `${store.list.tool} ${argv.join(" ")}`;
  const why: Record<CiRefusal, string> = {
    not_allowed: `is not ${command} as ${store.label}'s allow-list declares it`,
    value_not_allowed: `has a value ${store.label}'s allow-list refuses for ${command}`,
    identity_required: `is bound to the outlet's identity, and no outlet was given`,
    identity_mismatch: `names a target or channel the outlet's identity does not declare`,
  };
  return `Refused by the CI allow-list: ${line} ${why[refusal]}.`;
}
