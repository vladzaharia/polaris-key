// Scoping the shadow sheet's selectors to a kit root for a light DOM (React, or any host that
// renders the `data-part` DOM itself). Its own module: the React kit's on-demand Cloud Sync sheet
// (`syncCss.ts`) needs only this, not the whole stylesheet.

// ── The light-DOM stylesheet ─────────────────────────────────────────────────────────────────

/** At-rules whose body holds more rules (rewritten); every other block is kept as it is. */
const NESTING = /^@(layer|media|container|supports|starting-style)\b/;

/** Split on top-level commas (not inside `(…)` or `[…]`). */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * One selector of the shadow sheet, anchored to the kit root in a light DOM. The kit root keeps
 * the classes and attributes the shadow root's `.pk-root` has (`data-theme`, `data-motion`), so
 * those selectors land on it; every other selector reads as a descendant of a root through
 * `:where()`, which adds nothing to its specificity, so the cascade inside the kit is the
 * shadow sheet's own.
 */
function scopeSelector(sel: string, root: string): string {
  const host = /^:host(?:\(([^)]*)\))?/.exec(sel);
  if (host) {
    // `:host([bare])` is the element's attribute; on a light-DOM root it is `data-bare`.
    const attr = (host[1] ?? "").replace("[bare]", "[data-bare]");
    return `${root}${attr}${sel.slice(host[0].length)}`;
  }
  if (sel.startsWith(root)) return sel;
  if (
    /^\[data-(theme|motion|preset|shape|density|keyboard|pk-platform)\b/.test(
      sel,
    )
  )
    return `${root}${sel}`;
  return `:where(${root}) ${sel}`;
}

/** Rewrite every rule of `css` (a block body) for a light DOM. */
function scopeRules(css: string, root: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    // A statement at-rule (`@layer a, b;`) before the next block.
    if (
      semi !== -1 &&
      semi < open &&
      css.slice(i, semi).trim().startsWith("@")
    ) {
      out += css.slice(i, semi + 1);
      i = semi + 1;
      continue;
    }
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    const prelude = css.slice(i, open);
    const body = css.slice(open + 1, j - 1);
    const head = prelude.trim();
    const lead = prelude.slice(0, prelude.length - prelude.trimStart().length);
    if (head.startsWith("@"))
      out += NESTING.test(head)
        ? `${lead}${head} {${scopeRules(body, root)}}`
        : `${lead}${head} {${body}}`;
    else
      out += `${lead}${splitList(head)
        .map((s) => scopeSelector(s, root))
        .join(",\n")} {${body}}`;
    i = j;
  }
  return out;
}

/** Rewrite a shadow-root stylesheet for a light DOM whose kit roots match `root`. */
export function scopeCss(css: string, root = ".pk-root"): string {
  // Comments go first: their prose has commas and braces a selector list must not see.
  return scopeRules(css.replace(/\/\*[\s\S]*?\*\//g, ""), root);
}
