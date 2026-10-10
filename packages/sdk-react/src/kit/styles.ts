// The shared stylesheet in the page (UI-KITS.md §3.2): the elements' sheet in its light-DOM form,
// adopted once per document through `adoptedStyleSheets`, which a strict CSP allows (no inline
// `<style>`, no `style-src 'unsafe-inline'`). A server-rendered page links
// `@polaris-key/react/styles.css` instead, so the first paint is already styled; adopting the same
// rules again changes nothing.

import { lightDomCss } from "./contract.js";

let css: string | null = null;
let sheet: CSSStyleSheet | null = null;
const done = new WeakSet<Document>();

/** The light-DOM stylesheet's text (what `@polaris-key/react/styles.css` holds). */
export function kitStylesCss(): string {
  return (css ??= lightDomCss());
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
