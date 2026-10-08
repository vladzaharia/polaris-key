// The kit copy catalogs' message format, the ICU subset they are written in (plans/UK-02.md
// §3.1): plain `{name}` arguments, a plural on an integer argument
// (`{n, plural, one {# device} other {# devices}}`, `#` being the number) and a select
// (`{x, select, a {…} other {…}}`). UK-03's ui-core formatter replaces this once the kits read
// the catalogs directly.

export type CopyArgs = Record<string, string | number | undefined>;

const plurals = new Map<string, Intl.PluralRules>();

function pluralCategory(n: number, locale: string): string {
  let rules = plurals.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    plurals.set(locale, rules);
  }
  return rules.select(n);
}

/** The index of the `}` that closes the `{` at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** `one {…} other {…}` as a map of selector to branch. */
function branches(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const key = text.slice(i, open).trim();
    const end = closing(text, open);
    if (end < 0) break;
    out.set(key, text.slice(open + 1, end));
    i = end + 1;
  }
  return out;
}

/**
 * A catalog message with its arguments filled. A missing argument renders as nothing, never as
 * the placeholder.
 */
export function formatCopy(
  template: string,
  args: CopyArgs = {},
  locale = "en",
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const end = closing(template, open);
    if (end < 0) {
      out += template.slice(open);
      break;
    }
    const inner = template.slice(open + 1, end);
    const [name = "", kind, ...rest] = inner.split(",");
    const value = args[name.trim()];
    if (kind === undefined) {
      out += value === undefined ? "" : String(value);
    } else {
      const options = branches(rest.join(","));
      if (kind.trim() === "plural") {
        const n = Number(value);
        const branch =
          options.get(`=${n}`) ??
          options.get(pluralCategory(n, locale)) ??
          options.get("other") ??
          "";
        out += formatCopy(branch.replace(/#/g, String(n)), args, locale);
      } else {
        const branch = options.get(String(value)) ?? options.get("other") ?? "";
        out += formatCopy(branch, args, locale);
      }
    }
    i = end + 1;
  }
  return out;
}
