/**
 * A CSP-safe drop-in for `react-style-singleton` (aliased in vite.config.ts).
 *
 * Radix overlays lock background scroll through `react-remove-scroll`, which injects its CSS with
 * `react-style-singleton`: a `<style>` element. The Worker serves the SPAs with
 * `style-src 'self'`, which blocks inline `<style>`, so every dialog, menu, popover and drawer
 * logged a violation and the scroll lock silently did nothing.
 *
 * This module keeps the package's API and semantics (reference counted: the CSS is applied when
 * the first user mounts and removed when the last unmounts; `dynamic` re-applies on change) but
 * applies the CSS through the CSSOM, which CSP does not treat as inline style:
 *
 * 1. a constructable stylesheet (`new CSSStyleSheet()`, `replaceSync`, `adoptedStyleSheets`);
 * 2. only where those are unavailable, `insertRule` into an existing same-origin stylesheet, with
 *    the inserted rules tracked and deleted on removal.
 *
 * It never creates a `<style>` element. (ADMIN.md §7.2 chunk 2 notes; AGENTS.md conventions.)
 */

import * as React from "react";

export interface StyleSheetSingleton {
  add(style: string): void;
  remove(): void;
}

/** Split a stylesheet into its top-level rules (for `insertRule`, which takes one at a time). */
export function splitRules(css: string): string[] {
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const rule = css.slice(start, i + 1).trim();
        if (rule) rules.push(rule);
        start = i + 1;
      }
    }
  }
  return rules;
}

function constructable(): boolean {
  try {
    return (
      typeof CSSStyleSheet === "function" &&
      typeof CSSStyleSheet.prototype.replaceSync === "function" &&
      typeof document !== "undefined" &&
      Array.isArray(document.adoptedStyleSheets)
    );
  } catch {
    return false;
  }
}

/** A same-origin stylesheet whose rules we may edit, for the fallback path. */
function writableSheet(): CSSStyleSheet | null {
  if (typeof document === "undefined") return null;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      void sheet.cssRules; // throws on a cross-origin sheet
      return sheet;
    } catch {
      // not ours to edit
    }
  }
  return null;
}

interface Applied {
  undo(): void;
}

function apply(css: string): Applied | null {
  if (typeof document === "undefined") return null;
  if (constructable()) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(css);
    } catch {
      return null;
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return {
      undo() {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (s) => s !== sheet,
        );
      },
    };
  }
  const sheet = writableSheet();
  if (!sheet) return null;
  const inserted: CSSRule[] = [];
  for (const rule of splitRules(css)) {
    try {
      const index = sheet.insertRule(rule, sheet.cssRules.length);
      inserted.push(sheet.cssRules[index]!);
    } catch {
      // a rule this engine does not parse: skip it, as a <style> would
    }
  }
  return {
    undo() {
      for (const rule of inserted) {
        const index = Array.from(sheet.cssRules).indexOf(rule);
        if (index !== -1) sheet.deleteRule(index);
      }
    },
  };
}

/** The package's `stylesheetSingleton`: one applied stylesheet, reference counted. */
export function stylesheetSingleton(): StyleSheetSingleton {
  let counter = 0;
  let applied: Applied | null = null;
  return {
    add(style: string) {
      if (counter === 0) applied = apply(style);
      counter++;
    },
    remove() {
      counter--;
      if (counter === 0 && applied) {
        applied.undo();
        applied = null;
      }
    },
  };
}

/** The package's `styleHookSingleton`. */
export function styleHookSingleton(): (
  styles: string,
  isDynamic?: boolean,
) => void {
  const sheet = stylesheetSingleton();
  return (styles, isDynamic) => {
    React.useEffect(() => {
      sheet.add(styles);
      return () => {
        sheet.remove();
      };
      // Same dependency as the package: re-apply on change only when dynamic.
    }, [styles && isDynamic]);
  };
}

/** The package's `styleSingleton`: a component that applies `styles` while mounted. */
export function styleSingleton(): React.FC<{
  styles: string;
  dynamic?: boolean;
}> {
  const useStyle = styleHookSingleton();
  const Sheet: React.FC<{ styles: string; dynamic?: boolean }> = ({
    styles,
    dynamic,
  }) => {
    useStyle(styles, dynamic);
    return null;
  };
  return Sheet;
}
