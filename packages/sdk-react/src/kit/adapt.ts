// What the drop-in changes in a view before it draws (never the models: ui-core owns every
// state). Two kinds of change, both only where the host drives the part (the gate with the SDK,
// a part with `onInput`), so a fixture state still draws exactly as the corpus says:
//
//   * a step keeps its context: Activate keeps its title, lede and Paste while the key is
//     typed, parsed, refused or busy; Devices and Settings keep their title and list while a
//     row is renamed, confirmed or saved;
//   * a refusal is shown once, under the field that caused it.

import { viewOf, type UiInput, type View } from "@polaris-key/ui-core";

const union = (...lists: readonly (readonly string[])[]): string[] => [
  ...new Set(lists.flat()),
];

/** The same view with `copy` and `decisions` replaced. */
function patched(v: View, over: Partial<View>): View {
  return { ...v, ...over, decisions: { ...v.decisions, ...over.decisions } };
}

const ACTIVATE_KEEPS = new Set([
  "typing",
  "parsed",
  "cut-short",
  "rejected",
  "busy",
]);

/** The gate's Activate step: one title, the lede, the field, Paste, whatever the key's state. */
export function adaptActivate(view: View): View {
  if (view.component !== "Activate" || !ACTIVATE_KEEPS.has(view.state))
    return view;
  const keeps = [
    "activate.title",
    "activate.lede",
    "part.keyField.label",
    "part.keyField.placeholder",
    "common.paste",
  ];
  if (view.state === "rejected")
    return patched(view, {
      // The refusal once, under the field: its message, not its title.
      copy: union(
        keeps,
        view.copy.filter(
          (k) => !/^core\.(activation|codes)\..*\.title$/.test(k),
        ),
      ),
      // A key that does not exist is an input that is wrong: the danger stroke.
      decisions: { ...view.decisions, tone: "danger" },
    });
  return patched(view, { copy: union(keeps, view.copy) });
}

/** The gate's StatusScreen: revoked says "signed out", so it offers Sign in, not Sign out. */
export function adaptStatus(view: View, input: UiInput): View {
  if (view.component !== "StatusScreen" || view.state !== "revoked")
    return view;
  if (input.capabilities?.signIn === false) return view;
  return patched(view, {
    copy: union(
      ["welcome.signIn"],
      view.copy.filter((k) => k !== "common.signOut"),
    ),
    decisions: { ...view.decisions, primary: "welcome.signIn" },
  });
}

/** A pane whose transient state (rename, confirm, save, error) keeps its title and its rows. */
export function adaptPane(view: View, input: UiInput): View {
  if (view.component === "Devices") {
    const transient = ["renaming", "confirming", "error"].includes(view.state);
    if (!transient || !input.devices?.length) return view;
    if (view.state === "error" && input.edit === undefined) return view;
    const base = viewOf("Devices", {
      ...input,
      edit: undefined,
      error: undefined,
      loading: undefined,
      browserMode: undefined,
    });
    return patched(view, { copy: union(base.copy, view.copy) });
  }
  if (view.component === "Settings") {
    const transient = ["saving", "dirty", "locked", "error"].includes(
      view.state,
    );
    const rows = input.config ?? [];
    if (!transient || rows.length === 0) return view;
    if (view.state === "error" && input.edit?.kind !== "value") return view;
    const base = viewOf("Settings", {
      ...input,
      config: rows.map((r) => ({ ...r, locked: false })),
      edit: undefined,
      error: undefined,
      loading: undefined,
      pending: undefined,
      saved: undefined,
    });
    return patched(view, { copy: union(base.copy, view.copy) });
  }
  if (view.component === "About" && input.saved)
    return patched(view, {
      copy: union(view.copy, ["about.diagnosticsCopied"]),
    });
  return view;
}
