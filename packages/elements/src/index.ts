// @polaris-key/elements: the Polaris Key UI kit as web components on Lit 3 (UI-KITS.md §1.3, §5.1).
//
//   (a) drop-in   <pk-gate> runs every screen the license calls for and renders the app inside
//   (b) parts     every §4.1 component as its own pk-* element, with ::part, slots and pk-* events
//   (c) headless  @polaris-key/elements/headless re-exports ui-core's models (viewOf, SignInModel)
//
// Importing this module registers the elements. Theme: `PolarisKey.theme({…})`, `<pk-provider>`
// or an element's `theme` property (§3.1). The shared stylesheet is `styles.css` (React reuses it).

import { defineElements } from "./components.js";
import { setFontBase } from "./fonts.js";
import { setTheme, type ElementsTheme } from "./theme.js";

export { defineElements, ELEMENTS, PkGate, PkProvider } from "./components.js";
export { PkElement, type PkActionDetail } from "./element.js";
export { LAYOUTS, TAGS, type Kind, type Layout } from "./layout.js";
export { stylesCss, sharedSheet } from "./styles.js";
export { tokenCss } from "./tokens.js";
export { provideTable } from "./copy.js";
export type { ElementsTheme } from "./theme.js";

/** The page-wide entry points (UI-KITS.md §3.2: `PolarisKey.theme({…})`). */
export const PolarisKey = {
  /** Set the theme every element starts from. */
  theme(theme: ElementsTheme): void {
    setTheme(theme);
  },
  /** Where the kit's fonts.css lives, or `false` when the host loads Rubik itself. */
  fonts(base: string | false): void {
    setFontBase(base);
  },
};

if (typeof customElements !== "undefined") defineElements();
