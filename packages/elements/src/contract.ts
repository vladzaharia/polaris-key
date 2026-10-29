// The DOM contract the two web renderers share (UI-KITS.md §3.2, §7.1): where each view's keys go
// (`LAYOUTS`), which controls leave the app (`OPENS`), the theme and copy resolution, the
// stylesheet, and its light-DOM form.
// React (`@polaris-key/react`) imports this subpath and renders the same `pk-*` classes and
// `data-part` names, so one state drawn by either renderer is the same pixels. No Lit, no DOM.

import { ACTION_KEYS, type Action, type View } from "@polaris-key/ui-core";

import { isTitleKey, type Layout } from "./layout.js";

import { desktopStylesCss, stylesCss, webStylesCss } from "./styles.js";

export {
  HOLDER_LAYOUTS,
  KIT_LAYOUTS,
  LAYOUTS,
  SYNC_LAYOUTS,
  TAGS,
  dialogControls,
  isTitleKey,
  type Kind,
  type Layout,
} from "./layout.js";
export { stylesCss, morph, canMorph } from "./styles.js";
export { tokenCss } from "./tokens.js";
// DL14's QR, for the states that may draw one (a TV or console code, an offline request).
export { encodeQr } from "@polaris-key/node/qr";
// DL5: the monogram's letter, past a name's bidi isolates.
export { monogramOf } from "./monogram.js";
export { spellOut } from "./spell.js";
// The Settings pane's typed controls, decided once.
export {
  outOfRange,
  settingKind,
  settingLabel,
  settingText,
  sliderStep,
  type SettingKind,
  type SettingsRow,
} from "./settings.js";
// DL8: platform names, never a raw id.
export { platformLabel } from "./platforms.js";
// The one sign-in form's steps (SIGN-IN.md §3.17): the body each snapshot draws, the travel order.
export { FORM_ORDER, formStep, type FormInput, type FormStep } from "./form.js";
// The theme and copy resolution both renderers run (§1.2, §3.1, §4.7): one copy table per locale
// on the page, one identity path through ui-core.
export {
  copyFor,
  ensureLocale,
  onCopyLoaded,
  preloadCopy,
  copyPending,
  provideTable,
} from "./copy.js";
export {
  decodeIcon,
  groundPrefersDark,
  inputWithIdentity,
  mergeThemes,
  osPrefersDark,
  osReducedMotion,
  resolveFor,
  themeVars,
  watchGround,
  watchProductIdentity,
  type ElementsTheme,
  type Resolved,
} from "./theme.js";

/** Controls that leave the app: drawn with the new-window glyph (DL6, §1.5 rule 11). */
export const OPENS: ReadonlySet<string> = new Set([
  ...ACTION_KEYS["open-card"],
  ...ACTION_KEYS["open-browser"],
  ...ACTION_KEYS["open-manage-url"],
  "status.renew",
  "status.update",
  "update.appStore",
  "update.googlePlay",
  "update.steam",
  "update.openStore",
  "paywall.portal",
  "signin.none.get",
  // The link conflict's Help page (not a model action: the matrix rows pin those).
  "signin.linkOffer.join",
  "common.manage",
  "about.licenses",
  // Replace a device opens the license's page (PX-W8) as Activate's fix, like DeviceLimit's.
  "deviceLimit.title",
]);

/** The vocabulary action a control performs, or `null` (a kit-local control). */
export function actionOf(key: string): Action | null {
  for (const [action, keys] of Object.entries(ACTION_KEYS) as [
    Action,
    readonly string[],
  ][])
    if (keys.includes(key)) return action;
  return null;
}

// ── Where a view's keys go ───────────────────────────────────────────────────────────────────

/** Sort keys: the layout's order first, then core titles before the rest, then by name. */
function ordered(keys: string[], layout: Layout): string[] {
  const rank = (k: string) => {
    const i = layout.order?.indexOf(k) ?? -1;
    if (i >= 0) return i;
    if (k.endsWith(".title")) return 100;
    if (k.endsWith(".message")) return 101;
    return 200;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Split a view's copy into the places the layout gives each key. The view's primary is the one
 * filled control (DL4), drawn as a control wherever the layout would otherwise put its key: a
 * busy control keeps its label, a capability-limited Welcome keeps its one path, a link or a
 * title key that is the state's fix (Activate's Replace a device, LicenseChoice's key) is filled.
 * A primary the component draws inside its own content (a row's Remove) stays there, and one the
 * layout keeps `quiet` stays a link.
 */
export function placeKeys(view: View, layout: Layout) {
  const all = view.copy.filter((k) => !k.startsWith("a11y."));
  const content = new Set(layout.content ?? []);
  const primary = view.decisions.primary;
  const controls = layout.controls.filter(
    (k) => all.includes(k) || (k === primary && !content.has(k)),
  );
  const quiet = new Set(layout.quiet ?? []);
  if (
    primary !== null &&
    all.includes(primary) &&
    !content.has(primary) &&
    !quiet.has(primary) &&
    !controls.includes(primary)
  )
    controls.unshift(primary);
  const links = (layout.links ?? []).filter(
    (k) => all.includes(k) && (k !== primary || quiet.has(k)),
  );
  const placed = new Set([...controls, ...links, ...content]);
  const rest = all.filter((k) => !placed.has(k));
  const titles = ordered(
    rest.filter((k) => isTitleKey(k, layout)),
    layout,
  );
  const meta = rest.filter((k) => layout.meta?.includes(k));
  const footnote = rest.filter((k) => layout.footnote?.includes(k));
  const body = ordered(
    rest.filter(
      (k) => !titles.includes(k) && !meta.includes(k) && !footnote.includes(k),
    ),
    layout,
  );
  return { controls, links, titles, meta, body, footnote };
}

import { scopeCss } from "./scopeCss.js";

export { scopeCss };

/**
 * The shared stylesheet for a light DOM (React, or any host that renders the `data-part` DOM
 * itself): the shadow sheet with every selector anchored to `.pk-root`, so nothing reaches the
 * host page, and all of it, tokens included, in `@layer polaris-key`, so a host's own rule wins
 * without `!important`. No custom property is set on `:root` (§3.2).
 */
export function lightDomCss(): string {
  return scopeCss(stylesCss());
}

/** `lightDomCss()` without the desktop chrome (UK-06): what a web page draws. */
export function lightDomWebCss(): string {
  return scopeCss(webStylesCss());
}

/** The desktop chrome's part of `lightDomCss()`, to adopt after `lightDomWebCss()`. */
export function lightDomDesktopCss(): string {
  return scopeCss(desktopStylesCss());
}
