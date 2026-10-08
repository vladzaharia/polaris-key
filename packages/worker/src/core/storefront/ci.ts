/**
 * The CI-plane command allow-list (A-18a's type, filled by A-18h; notes/S-15 §6.2, THREAT-MODEL
 * control (b)).
 *
 * The publish action runs a store's vendor CLI only as one of its declared commands. A command is
 * an argv template: literal tokens, and parameters whose value must match a pattern (a path, a
 * version) and, where the store binds it, a value of the outlet's identity (itch's `user/game`
 * target, a snap's channels). Anything else is refused, the way the Worker gate refuses an
 * undeclared request. The declarations are pure data and JSON-serialisable (patterns are regex
 * sources), so the CLI reads the same declaration from a generated copy (S-15 §6.1;
 * `packages/cli/src/storefronts/ciPlane.generated.ts`, written by
 * `pnpm gen:storefront-ci` from `ciPlane.ts`).
 *
 * The check runs twice: in the CLI before the tool starts, and in the Worker when the step is
 * reported back into `store_operations` (`services/distribution/storeSteps.ts`), so a ledger row
 * never records a command the allow-list refuses.
 */

import type { Confirm } from "./gate.js";

/**
 * How a parameter is bound to the outlet's identity (`.pkey/distribution`):
 *
 *   - `equal`: the value is the identity field;
 *   - `prefix`: the value starts with the identity field and `separator` (`user/game:<channel>`);
 *   - `each`: the value is a `separator`-joined list, each member one of the field's values (a
 *     string field, or the values of a channel map such as a snap's `channels`).
 */
export interface CiIdentityBinding {
  readonly field: string;
  readonly match: "equal" | "prefix" | "each";
  readonly separator?: string;
}

/** A named parameter: `prefix` is literal (`--release=`), the rest must match `pattern`. */
export interface CiParam {
  readonly param: string;
  readonly pattern: string;
  readonly prefix?: string;
  readonly identity?: CiIdentityBinding;
}

/** One argv token: a literal, or a named parameter. */
export type CiArg = string | CiParam;

/**
 * A check on a file a parameter names, run by the CLI before the tool starts (the Worker never sees
 * the file). `steam-vdf-setlive-named`: a SteamPipe app build script whose `setlive`, if any,
 * names a branch other than `default` and `public` (S-15 §6.2; owner decision 5).
 */
export type CiFileCheck = "steam-vdf-setlive-named";

export interface CiCommandRule {
  readonly argv: readonly CiArg[];
  readonly confirm: Confirm;
  readonly why: string;
  /**
   * Refused while the ledger shows a Worker-plane draft of this store for the product: a row of one
   * of `opens` (done, pending or ambiguous) with no later done row of one of `closes`. Checked by
   * the Worker when the step's `pending` report opens its row, so it needs report-back (S-15 §6.2:
   * msstore never `publish` while a Worker-staged draft exists).
   */
  readonly unlessWorkerStaged?: {
    /**
     * The Worker-plane adapter whose ledger rows hold the draft, when its id differs from the CI
     * store's (msstore's drafts are staged by A-18f's `microsoft-store` adapter). Default: this store.
     */
    readonly workerStore?: string;
    readonly opens: readonly string[];
    readonly closes: readonly string[];
  };
  readonly fileChecks?: readonly {
    readonly param: string;
    readonly check: CiFileCheck;
  }[];
}

export interface CiAllowList {
  /** The vendor CLI (`steamcmd`, `butler`, `snapcraft`). */
  readonly tool: string;
  /** Command id → its argv template. `Support.commands` names these ids. */
  readonly commands: Readonly<Record<string, CiCommandRule>>;
}

export type CiRefusal =
  | "not_allowed"
  | "value_not_allowed"
  | "identity_required"
  | "identity_mismatch";

/** An outlet identity as the check reads it: strings, string lists, or channel maps. */
export type CiIdentity = Readonly<Record<string, unknown>>;

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

/**
 * Whether `argv` (the tool's arguments, the tool itself excluded) is the declared command `id`.
 * Answers null when it is, the refusal otherwise. A command with an identity-bound parameter needs
 * `identity` (the outlet's), and each bound value must hold against it.
 */
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
    const value = got.slice(prefix.length);
    if (!new RegExp(`^(?:${want.pattern})$`).test(value))
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

/**
 * The declared command `argv` is, ignoring identity bindings (the never-list check: a never
 * command must match no template at all), or null.
 */
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

/** Every literal token a list could ever run (for the never-list check), prefixes included. */
export function ciLiterals(list: CiAllowList): string[] {
  return Object.values(list.commands).flatMap((c) =>
    c.argv.flatMap((a) =>
      typeof a === "string" ? [a] : a.prefix ? [a.prefix] : [],
    ),
  );
}
