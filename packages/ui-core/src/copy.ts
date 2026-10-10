// The copy formatter every JS kit renders through (UI-KITS.md §4.7; plans/UK-02.md D5). A view
// names catalog keys and their arguments; this turns them into strings in the active locale.
//
//   lookup   the locale's override, the locale's table, the English override, then English; a
//            locale with no pack is English (ui-matrix.json `i18n` pins the order)
//   format   the catalog's ICU subset: plain `{arg}`; at most one `{n, plural, …}` (by
//            Intl.PluralRules, `#` the integer in plain ASCII digits) or `{formFactor, select, …}`
//            (an unknown value takes `other`)
//
// The tables are injected: the kits pass `@polaris-key/brand/kit-copy`'s generated tables (every
// kit string and the core copy under `core.*`), so this module has no catalog of its own and
// never fetches one. Dates, durations and sizes are formatted by the caller and passed as text.

import { FALLBACK_COPY } from "./errors.js";

export type CopyArgs = Readonly<Record<string, string | number>>;

/** One locale's catalog: key → ICU-subset message. */
export type CopyTable = Readonly<Record<string, string>>;

/** The launch locales (UI-KITS.md owner decisions, 2026-10-05). */
export const LAUNCH_LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "ja",
  "ko",
  "zh-Hans",
] as const;
export type LaunchLocale = (typeof LAUNCH_LOCALES)[number];

/** Map a POSIX or BCP 47 locale onto a launch locale; English when none matches. */
export function resolveLocale(requested?: string | null): LaunchLocale {
  if (!requested) return "en";
  const tag = requested
    .replace(/[.@].*$/, "")
    .replace(/_/g, "-")
    .toLowerCase();
  const exact = LAUNCH_LOCALES.find((l) => l.toLowerCase() === tag);
  if (exact) return exact;
  const [lang, region] = tag.split("-");
  if (lang === "zh")
    // Traditional Chinese has no pack yet: English, never Simplified.
    return region === "tw" ||
      region === "hk" ||
      region === "mo" ||
      region === "hant"
      ? "en"
      : "zh-Hans";
  if (lang === "pt") return "pt-BR";
  return LAUNCH_LOCALES.find((l) => l === lang) ?? "en";
}

type Piece = { text: string } | { arg: string } | { hash: true };
interface Parsed {
  head: Piece[];
  complex?: {
    arg: string;
    kind: "plural" | "select";
    cases: Record<string, Piece[]>;
  };
  tail: Piece[];
}

const parsedCache = new Map<string, Parsed>();

/** Parse one message of the ICU subset. Throws on anything outside it. */
export function parseMessage(src: string): Parsed {
  const hit = parsedCache.get(src);
  if (hit) return hit;
  let i = 0;
  const pieces = (inPlural: boolean, inCase: boolean): Piece[] => {
    const out: Piece[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ text });
      text = "";
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "}") break;
      if (ch === "#" && inPlural) {
        flush();
        out.push({ hash: true });
        i++;
        continue;
      }
      if (ch === "{") {
        const m = /^\{([A-Za-z][A-Za-z0-9]*)(\}|,)/.exec(src.slice(i));
        if (!m) throw new Error(`ui-core copy: a bad argument in "${src}"`);
        if (m[2] === ",") {
          if (inCase)
            throw new Error(
              `ui-core copy: a nested plural or select in "${src}"`,
            );
          break;
        }
        flush();
        out.push({ arg: m[1]! });
        i += m[0].length;
        continue;
      }
      text += ch;
      i++;
    }
    flush();
    return out;
  };
  const head = pieces(false, false);
  let parsed: Parsed = { head, tail: [] };
  if (i < src.length) {
    const m = /^\{([A-Za-z][A-Za-z0-9]*), *(plural|select) *,/.exec(
      src.slice(i),
    );
    if (!m) throw new Error(`ui-core copy: a bad plural or select in "${src}"`);
    i += m[0].length;
    const kind = m[2] as "plural" | "select";
    const cases: Record<string, Piece[]> = {};
    for (;;) {
      while (src[i] === " ") i++;
      if (src[i] === "}") {
        i++;
        break;
      }
      const c = /^([a-z]+) *\{/.exec(src.slice(i));
      if (!c) throw new Error(`ui-core copy: a bad case in "${src}"`);
      i += c[0].length;
      cases[c[1]!] = pieces(kind === "plural", true);
      if (src[i] !== "}")
        throw new Error(`ui-core copy: an unclosed case in "${src}"`);
      i++;
    }
    const tail = pieces(false, false);
    if (i < src.length)
      throw new Error(`ui-core copy: trailing text in "${src}"`);
    parsed = { head, complex: { arg: m[1]!, kind, cases }, tail };
  }
  parsedCache.set(src, parsed);
  return parsed;
}

/** Format one message for `locale`. A missing argument stays visible as `{name}`. */
export function formatMessage(
  src: string,
  args: CopyArgs = {},
  locale: string = "en",
): string {
  const p = parseMessage(src);
  const render = (x: Piece): string =>
    "text" in x
      ? x.text
      : "arg" in x
        ? args[x.arg] === undefined
          ? `{${x.arg}}`
          : String(args[x.arg])
        : String(args[p.complex!.arg]);
  let body: Piece[] = [];
  if (p.complex) {
    const v = args[p.complex.arg];
    let c: string;
    if (p.complex.kind === "plural") {
      c = new Intl.PluralRules(locale).select(Number(v));
      if (!(c in p.complex.cases)) c = "other";
    } else c = typeof v === "string" && v in p.complex.cases ? v : "other";
    body = p.complex.cases[c] ?? [];
  }
  return [...p.head, ...body, ...p.tail].map(render).join("");
}

export interface CopyOptions {
  /** The launch locales' tables; `en` is required and every key falls back to it. */
  tables: Partial<Record<string, CopyTable>> & { en: CopyTable };
  /** The requested locale (BCP 47 or POSIX); unknown or absent is English. */
  locale?: string | null;
  /** `theme.copy`: partial overrides per locale, which fall back key by key. */
  overrides?: Partial<Record<string, Readonly<Record<string, string>>>>;
}

/** One locale's view of the catalog. */
export class Copy {
  /** The locale strings are formatted in: a launch locale with a table, else English. */
  readonly locale: string;
  private readonly tables: CopyOptions["tables"];
  private readonly overrides: NonNullable<CopyOptions["overrides"]>;

  constructor(options: CopyOptions) {
    const wanted = resolveLocale(options.locale);
    this.locale = options.tables[wanted] ? wanted : "en";
    this.tables = options.tables;
    this.overrides = options.overrides ?? {};
  }

  /** The raw message for `key`: the override, the table, the English override, English. */
  raw(key: string): string | undefined {
    return (
      this.overrides[this.locale]?.[key] ??
      this.tables[this.locale]?.[key] ??
      this.overrides.en?.[key] ??
      this.tables.en[key]
    );
  }

  has(key: string): boolean {
    return this.raw(key) !== undefined;
  }

  /**
   * The string for `key`. A `core.codes.*` key the catalog lacks reads as the fallback sentence
   * (DL7); any other unknown key throws, because every visible string is a catalog key (DL8).
   */
  format(key: string, args: CopyArgs = {}): string {
    const src = this.raw(key);
    if (src !== undefined) return formatMessage(src, args, this.locale);
    const code = /^core\.codes\.(.+)\.(title|message)$/.exec(key);
    if (code)
      return this.format(
        code[2] === "title" ? FALLBACK_COPY[0]! : FALLBACK_COPY[1]!,
        { code: code[1]!, ...args },
      );
    throw new Error(`ui-core copy: no catalog string for ${key}`);
  }

  /** Every string a view shows, by key: the plain renderer's `{key, args}` made text. */
  strings(view: {
    copy: readonly string[];
    args: CopyArgs;
  }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of view.copy) out[key] = this.format(key, view.args);
    return out;
  }
}
