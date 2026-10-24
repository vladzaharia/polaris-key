// The small part of adapt.ts the gate itself uses (the sign-in code step), apart from the rest: a
// module's used exports all travel together, so what the lazy parts use (adapt.ts) must not share
// a file with what the gate's entry uses, or the gate's entry carries all of it.

import type { View } from "@polaris-key/ui-core";

export const union = (...lists: readonly (readonly string[])[]): string[] => [
  ...new Set(lists.flat()),
];

/** The same view with `copy` and `decisions` replaced. */
export function patched(v: View, over: Partial<View>): View {
  return { ...v, ...over, decisions: { ...v.decisions, ...over.decisions } };
}

/** The code step: how long the code lasts and a Cancel to leave by. */
export function adaptHandoff(view: View): View {
  if (view.component !== "SignInHandoff" || view.state !== "code") return view;
  const add: string[] = [];
  if (view.args.time !== undefined) add.push("signin.handoff.expires");
  add.push("common.cancel");
  return patched(view, { copy: union(view.copy, add) });
}

/** What the code step says while it waits (a status, not the ticking countdown). */
export const HANDOFF_WAITING = "cli.signin.waitingCode";
