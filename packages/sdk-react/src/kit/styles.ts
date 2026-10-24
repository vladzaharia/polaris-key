// The shared stylesheet in the page (UI-KITS.md §3.2): the elements' sheet in its light-DOM form,
// adopted once per document through `adoptedStyleSheets`, which a strict CSP allows (no inline
// `<style>`, no `style-src 'unsafe-inline'`). A server-rendered page links
// `@polaris-key/react/styles.css` instead, so the first paint is already styled; adopting the same
// rules again changes nothing.

import { lightDomWebCss } from "./contract.js";

let css: string | null = null;
let sheet: CSSStyleSheet | null = null;
const done = new WeakSet<Document>();

/** The light-DOM stylesheet's text a web page draws with: `@polaris-key/react/styles.css` without
 *  the desktop chrome (Windows, GNOME and macOS rules), which `adoptDesktopStyles` adds on demand. */
export function kitStylesCss(): string {
  return (css ??= lightDomWebCss());
}

export const desktopDone = new WeakSet<Document>();

/** Whether `doc` has the desktop chrome's rules (or needs none: no constructable sheets, so the
 *  host links `styles.css`, which has them). */
export function hasDesktopStyles(doc: Document | undefined): boolean {
  return !doc || desktopDone.has(doc);
}

/** Add the desktop chrome's sheet to `doc` after the web sheet (a later sheet wins at equal
 *  specificity, as the rules did when they were one sheet). Resolves when it is in. */
export function adoptDesktopStyles(doc: Document | undefined): Promise<void> {
  if (!doc || desktopDone.has(doc)) return Promise.resolve();
  return import("./desktopCss.js").then(
    (m) => {
      m.adoptDesktop(doc);
      desktopDone.add(doc);
    },
    () => void desktopDone.add(doc), // never arrives: the kit keeps the web chrome
  );
}

/** Put the kit's stylesheet in `doc` once, through `adoptedStyleSheets` only: never a `<style>`
 *  element, which a strict CSP refuses. A browser without constructable sheets (none current)
 *  draws the kit from `@polaris-key/react/styles.css`, which the host then links. */
export function adoptKitStyles(doc: Document | undefined): void {
  if (!doc || done.has(doc)) return;
  done.add(doc);
  if (
    !("adoptedStyleSheets" in doc) ||
    typeof CSSStyleSheet !== "function" ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return;
  try {
    sheet ??= new CSSStyleSheet();
    if (sheet.cssRules.length === 0) sheet.replaceSync(kitStylesCss());
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    // A document of another realm (an iframe's) refuses this realm's sheet: it links styles.css.
  }
}
