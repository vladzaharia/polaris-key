// What every view model answers: the component and its state, the catalog keys the state shows,
// the actions its controls perform, the arguments its strings take, and the design language's
// decisions for that state (UI-KITS.md DL4, DL6, DL7, DL9, DL14) as data, so every JS kit renders
// the same decision. A view is plain, serialisable data: a Node main process can send it over a
// bridge, and a renderer draws it from `{key, args}` alone.

import type { Context } from "./input.js";
import { coarsePointer, platformClass } from "./input.js";
import type { LinkVerdict } from "./link.js";
import { ACTION_KEYS, type Action, type ComponentName } from "./vocabulary.js";

/**
 * The tone of a refusal or an error (DL6, DL7):
 *
 *   neutral   a refusal the person can resolve (device limit, revoked, expired, a version or
 *             channel the license does not cover, all licenses full, the key-entry limit): a
 *             callout in default text on the sunken surface, no danger colour, no error glyph,
 *             and its fix is the one primary
 *   danger    an input that is itself wrong, or a step that failed: the danger stroke, the
 *             message announced under the control that caused it
 */
export type Tone = "neutral" | "danger";

/** The design language's decisions for one state (UI-KITS.md, design language v2). */
export interface Decisions {
  /** DL4: the copy key of the one filled control, or `null` when the state has none. */
  primary: string | null;
  /** DL6: the tone of the state's refusal or error, or `null` when it shows neither. */
  tone: Tone | null;
  /**
   * DL7: where the message sits: the copy key of the control or field that caused it (the key
   * field's label, Sign in, a row's control), or `"screen"` for a failed load, which is an error
   * state of its own. `null` when the state shows no message.
   */
  errorSlot: string | null;
  /**
   * DL9: what takes focus when the state appears: a control's or a field's copy key, or
   * `"heading"`. `null` when the view never takes focus (a banner, a toast, progress, the app).
   */
  focus: string | null;
  /** DL14: the state's link, validated, and whether it may be opened or drawn as a QR. */
  link: LinkVerdict | null;
  /** DL14: true when this state may draw a QR at all (a TV or console code, an offline request). */
  qr: boolean;
}

/** One rendered state of one component. */
export interface View<C extends ComponentName = ComponentName, S = string> {
  component: C;
  state: S;
  /** The catalog keys of the strings this state shows (kit keys and `core.*`), sorted. */
  copy: string[];
  /** What the state's controls do, sorted (`vocabulary.actions`). */
  actions: Action[];
  /** The arguments the copy's messages take (`{product}`, `{count}`, …). */
  args: Record<string, string | number>;
  decisions: Decisions;
}

/** The copy keys of fields: never focused on appear under a coarse pointer (DL9). */
const FIELDS = new Set([
  "part.keyField.label",
  "devices.renameLabel",
  "offlineActivation.paste",
]);

/** Controls that open a browser: never the first focus on a TV or a pad-only screen (DL9). */
const OPENERS = new Set([
  ...ACTION_KEYS["open-card"],
  ...ACTION_KEYS["open-browser"],
  ...ACTION_KEYS["open-manage-url"],
]);

/** A view's actions: those its copy's controls perform, plus any with no copy key. */
export function actionsFor(
  copy: readonly string[],
  extra: readonly Action[] = [],
): Action[] {
  const out = new Set<Action>(extra);
  for (const [action, keys] of Object.entries(ACTION_KEYS) as [
    Action,
    readonly string[],
  ][])
    if (keys.some((k) => copy.includes(k))) out.add(action);
  return [...out].sort();
}

export interface ViewSpec<S> {
  state: S;
  copy: readonly (string | false | null | undefined)[];
  /** Actions with no copy key of their own (`replace-in-browser`). */
  extraActions?: readonly Action[];
  args?: Record<string, string | number | undefined>;
  primary?: string | null;
  tone?: Tone | null;
  errorSlot?: string | null;
  /** Leave out to focus the primary, or the heading when there is none. */
  focus?: string | null;
  link?: LinkVerdict | null;
  qr?: boolean;
}

/** Build a view: copy de-duplicated and sorted, actions derived, focus resolved (DL9). */
export function makeView<C extends ComponentName, S extends string>(
  ctx: Context,
  component: C,
  spec: ViewSpec<S>,
): View<C, S> {
  const copy = [
    ...new Set(spec.copy.filter((k): k is string => typeof k === "string")),
  ].sort();
  const args: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(spec.args ?? {}))
    if (v !== undefined) args[k] = v;
  const primary = spec.primary ?? null;
  return {
    component,
    state: spec.state,
    copy,
    actions: actionsFor(copy, spec.extraActions),
    args,
    decisions: {
      primary,
      tone: spec.tone ?? null,
      errorSlot: spec.errorSlot ?? null,
      focus: focusFor(
        ctx,
        spec.focus === undefined ? (primary ?? "heading") : spec.focus,
      ),
      link: spec.link ?? null,
      qr: spec.qr ?? spec.link?.qr ?? false,
    },
  };
}

/** DL9: a field is never focused on appear under a coarse pointer, and a TV or pad-only screen
 *  never focuses a control that opens a browser; both fall back to the heading. */
function focusFor(ctx: Context, target: string | null): string | null {
  if (target === null) return null;
  if (FIELDS.has(target) && coarsePointer(ctx.platform)) return "heading";
  const c = platformClass(ctx.platform);
  if ((c === "tv" || c === "console") && OPENERS.has(target)) return "heading";
  return target;
}

/** The `hidden` view: the component's service is off, so the drop-in renders nothing. */
export function hiddenView<C extends ComponentName>(
  ctx: Context,
  component: C,
): View<C, "hidden"> {
  return makeView(ctx, component, { state: "hidden", copy: [], focus: null });
}

// ── Identity, as the copy needs it ───────────────────────────────────────────────────────────

/** Who the screens are about, for their strings (`{product}`, `{developer}`). The accent and the
 *  icon's colour are the theme's (`@polaris-key/ui-core/theme`). */
export interface IdentityText {
  /** The product's name, full: titles use it. */
  name: string;
  /** For inline sentences: the integrator's short name when set, else the name. */
  inlineName: string;
  /** "by <Developer>" shows only with a developer name (UI-KITS.md §1.2). */
  developer: string | null;
  /** True when an icon is drawn; otherwise the monogram tile (still the product's icon). */
  icon: boolean;
}

/** UI-KITS.md §1.2's order: the integrator, then the presentation, then the bundle. */
export function identityText(ctx: Context): IdentityText {
  const i = ctx.input.integrator ?? {};
  const p = ctx.input.presentation ?? null;
  const b = ctx.input.bundle;
  const name = i.name ?? p?.name ?? b?.name ?? b?.slug ?? "";
  return {
    name,
    inlineName: i.shortName ?? name,
    developer: i.developer ?? p?.developerName ?? null,
    icon: i.icon === true || p?.icon === true,
  };
}
