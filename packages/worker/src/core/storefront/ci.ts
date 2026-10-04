/**
 * The CI-plane command allow-list (A-18a; notes/S-15 §6.2, THREAT-MODEL control (b)). A-18a
 * defines the TYPE and its check; no adapter declares one yet (A-18h fills them: steamcmd, butler,
 * snapcraft, BuildPatchTool, msstore).
 *
 * The publish action runs a store's vendor CLI only as one of its adapter's declared commands. A
 * command is an argv template: literal tokens, and parameters whose value must match a pattern
 * (an outlet identity's channel, a named branch). Anything else is refused, the way the Worker
 * gate refuses an undeclared request. Pure data and JSON-serialisable (patterns are regex
 * sources), so the CLI reads the same declaration (S-15 §6.1).
 */

import type { Confirm } from "./gate.js";

/** One argv token: a literal, or a named parameter whose value must match `pattern`. */
export type CiArg =
  | string
  | { readonly param: string; readonly pattern: string };

export interface CiCommandRule {
  readonly argv: readonly CiArg[];
  readonly confirm: Confirm;
  readonly why: string;
}

export interface CiAllowList {
  /** The vendor CLI (`steamcmd`, `butler`, `snapcraft`). */
  readonly tool: string;
  /** Command id → its argv template. `Support.commands` names these ids. */
  readonly commands: Readonly<Record<string, CiCommandRule>>;
}

export type CiRefusal = "not_allowed" | "value_not_allowed";

/**
 * Whether `argv` (the tool's arguments, the tool itself excluded) is the declared command `id`.
 * Answers null when it is, the refusal otherwise.
 */
export function checkCiCommand(
  list: CiAllowList,
  id: string,
  argv: readonly string[],
): CiRefusal | null {
  if (!Object.hasOwn(list.commands, id)) return "not_allowed";
  const rule = list.commands[id]!;
  if (argv.length !== rule.argv.length) return "not_allowed";
  for (let i = 0; i < argv.length; i++) {
    const want = rule.argv[i]!;
    const got = argv[i]!;
    if (typeof want === "string") {
      if (got !== want) return "not_allowed";
    } else if (!new RegExp(`^(?:${want.pattern})$`).test(got)) {
      return "value_not_allowed";
    }
  }
  return null;
}

/** Every literal token a list could ever run (for the never-list check). */
export function ciLiterals(list: CiAllowList): string[] {
  return Object.values(list.commands).flatMap((c) =>
    c.argv.filter((a): a is string => typeof a === "string"),
  );
}
