// What the drop-in changes in a view before it draws (never the models: ui-core owns every
// state). Two kinds of change, both only where the host drives the part (the gate with the SDK,
// a part with `onInput`), so a fixture state still draws exactly as the corpus says:
//
//   * a step keeps its context: Devices and Settings keep their title and list while a
//     row is renamed, confirmed or saved;
//   * a refusal is shown once, under the field that caused it.

import {
  formatBytes,
  viewOf,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

import { patched, union } from "./adaptBase.js";

export { adaptHandoff, HANDOFF_WAITING } from "./adaptBase.js";

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

/** The sign-in form's methods step: no "or" divider over the providers (DL4), no "Sign in…" link
 *  on the sign-in step itself. Drawing only; the model's copy list is the corpus's. */
export function adaptMethods(view: View): View {
  if (view.component !== "SignIn") return view;
  if (view.state !== "methods" && view.state !== "error") return view;
  return patched(view, {
    copy: view.copy.filter(
      (k) => k !== "signin.provider.group" && k !== "signin.menu.signIn",
    ),
  });
}

/** The Replace step confirms on its own button: its "Replace a device" openers are gone. */
export function adaptReplace(view: View): View {
  if (view.component !== "LicenseChoice" || view.state !== "replace-open")
    return view;
  return patched(view, {
    copy: view.copy.filter(
      (k) => k !== "signin.replace.open" && k !== "signin.replace.openSystem",
    ),
  });
}

export const ORIGIN_KEY: Readonly<Record<string, string>> = {
  store: "signin.choice.origin.store",
  key: "signin.choice.origin.keyAdded",
  free: "signin.choice.origin.free",
  developer: "signin.choice.origin.developer",
  signin: "signin.choice.origin.signIn",
};

const CHOICE_STATES = new Set([
  "mixed",
  "current",
  "keep",
  "new",
  "create",
  "raced",
  "one",
  "many",
  "all-full",
]);

/** The license step's base anatomy in every state (the review's "additive" rule): title, lede,
 *  list, Cancel and the key option, whatever the state adds. Each full license draws its own
 *  Replace a device when every license is full. Drawing only; the model's copy is the corpus's. */
export function adaptChoice(
  view: View,
  input: UiInput,
  has: (key: string) => boolean,
): View {
  const ch = input.choices;
  if (
    view.component !== "LicenseChoice" ||
    !ch ||
    !CHOICE_STATES.has(view.state)
  )
    return view;
  const rowKeys = ch.choices.flatMap((r) => [
    ...(ORIGIN_KEY[r.origin] ? [ORIGIN_KEY[r.origin]!] : []),
    r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until",
  ]);
  const keyInstead =
    input.capabilities?.keyEntry !== false && ch.getLicense?.keyEntry !== false;
  const lede =
    view.state === "all-full" || view.state === "raced"
      ? []
      : [
          view.state === "new"
            ? "signin.choice.ledeNew"
            : input.platform?.os === "web"
              ? "signin.choice.ledeBrowser"
              : "signin.choice.lede",
        ];
  const rowReplace =
    view.state === "all-full" &&
    ch.choices.some((r) => r.state !== "free" && r.replace?.allowed);
  const base = union(
    view.copy,
    [
      "signin.choice.title",
      ...lede,
      "signin.choice.group",
      "signin.choice.meta",
      "signin.choice.devices",
      "signin.choice.tag.current",
      "signin.choice.tag.full",
      ...rowKeys,
      "common.cancel",
      ...(keyInstead ? ["signin.choice.keyInstead"] : []),
    ].filter(has),
  );
  const gone = new Set<string>([
    // One lede: the browser's, where the form runs in one.
    ...(base.includes("signin.choice.ledeBrowser")
      ? ["signin.choice.lede"]
      : []),
    // A full license draws its own Replace; Keep and Create are list rows, not buttons.
    ...(rowReplace ? ["signin.replace.open"] : []),
    ...(view.state === "all-full"
      ? []
      : ["signin.choice.keep", "signin.choice.create"]),
  ]);
  const primary = view.decisions.primary;
  return patched(view, {
    copy: base.filter((k) => !gone.has(k)),
    decisions: {
      ...view.decisions,
      primary: rowReplace && primary === "signin.replace.open" ? null : primary,
    },
  });
}

/** The sign-in form's frame: Done ends on a heading and one Start; every other step of a sheet
 *  can be backed out of (DL2). */
export function adaptSignIn(
  view: View,
  input: UiInput,
  sheet: boolean,
  has: (key: string) => boolean,
): View {
  if (view.component !== "SignIn") return view;
  if (view.state === "done") {
    if (input.services && !input.services.includes("license")) return view;
    return patched(view, {
      copy: union(
        view.copy,
        ["signin.return.signedInShort", "signin.done.start"].filter(has),
      ),
      decisions: { ...view.decisions, primary: "signin.done.start" },
    });
  }
  return view.state === "methods" && !sheet
    ? view
    : patched(view, { copy: union(view.copy, ["common.cancel"]) });
}

/** An available update offers one verb, Update now, and Later: "Restart when ready" belongs to
 *  the download in flight (it queues the restart), never to a prompt that has not started one. */
export function oneVerb(view: View): View {
  if (view.component !== "UpdatePrompt" || view.state !== "available")
    return view;
  if (!view.copy.includes("update.restartWhenReady")) return view;
  return patched(view, {
    copy: view.copy.filter((k) => k !== "update.restartWhenReady"),
  });
}

/** The web's update prompt: the person downloads the new version (the page cannot install it),
 *  so one Download action and Later, a title that says so, and the installed version without the
 *  size of a download that is not theirs to wait for. */
export function adaptUpdate(view: View): View {
  if (view.component !== "UpdatePrompt" || view.state !== "available")
    return view;
  const gone = new Set([
    "update.title",
    "update.restartWhenReady",
    "update.skipVersion",
  ]);
  return patched(view, {
    copy: union(
      ["update.availableTitle"],
      view.copy.filter((k) => !gone.has(k)),
    ),
  });
}

/** A pane's title says what its list is; the Devices lede repeats it. */
export function withoutLede(view: View): View {
  return view.component === "Devices" && view.copy.includes("devices.lede")
    ? patched(view, { copy: view.copy.filter((k) => k !== "devices.lede") })
    : view;
}

/** `update.progress` for UpdateProgress from the bytes a desktop host reports
 *  (`installUpdate(decision, { onProgress })`). A known total gives the fraction and both sizes;
 *  an unknown one (`null`) gives neither a fraction nor a total, so the bar is indeterminate
 *  and no percentage is made up. */
export function installProgressInput(
  done: number,
  total: number | null,
  locale?: string,
): NonNullable<NonNullable<UiInput["update"]>["progress"]> {
  const counted = total !== null && total > 0 && total >= done;
  return {
    phase: "download",
    ...(counted ? { fraction: done / total } : {}),
    size: formatBytes(done, locale),
    ...(counted ? { total: formatBytes(total, locale) } : {}),
  };
}
