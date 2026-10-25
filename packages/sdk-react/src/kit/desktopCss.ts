// The desktop chrome's stylesheet (UK-06: Windows, GNOME and macOS rules and tokens), its own file in
// the build (scripts/bundle-contract.mjs) so the web gate's entry does not carry it: styles.ts
// imports it on demand when a kit root resolves to a desktop variant.
import { lightDomDesktopCss } from "@polaris-key/elements/contract";

// This file is bundled on its own (scripts/bundle-contract.mjs), so it cannot share a module-level
// flag with styles.ts: it keeps its own, and styles.ts records the result once the import resolves.
const adopted = new WeakSet<Document>();
let sheet: CSSStyleSheet | null = null;

export { lightDomDesktopCss };

/** Adopt the desktop sheet into `doc` once, after the web sheet. */
export function adoptDesktop(doc: Document): void {
  if (adopted.has(doc)) return;
  adopted.add(doc);
  if (
    !("adoptedStyleSheets" in doc) ||
    typeof CSSStyleSheet !== "function" ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return;
  try {
    sheet ??= new CSSStyleSheet();
    if (sheet.cssRules.length === 0) sheet.replaceSync(lightDomDesktopCss());
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    // A document of another realm: it links styles.css.
  }
}
