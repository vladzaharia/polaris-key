// The terminal kit's copy (docs/design/UI-KITS.md §4.7; plans/UK-02.md §3): every visible string
// is a key in the generated kit copy tables (`kitCopy.generated.ts`, written by `pnpm gen brand`
// from packages/brand/kit-copy/ and the core copy), looked up in the active locale with a per-key
// fallback to English, and formatted with the catalog's ICU subset:
//
//   {arg}                                   a pre-formatted string or number
//   {n, plural, one {# device} other {…}}   one plural per message, on an integer argument
//   {formFactor, select, iphone {…} …}      select, on formFactor only
//
// Dates, durations and sizes are formatted by the caller (Intl) and passed as strings. The
// locale comes from the theme (`copy.locale`), else LC_ALL / LC_MESSAGES / LANG, else English.

import {
  KIT_COPY,
  KIT_COPY_LOCALES,
  type KitCopyLocale,
} from "../kitCopy.generated.js";

export type CopyArgs = Readonly<Record<string, string | number>>;

/** `theme.copy`: a locale, and partial overrides per locale that fall back key by key. */
export interface CopyOptions {
  locale?: string;
  overrides?: Partial<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Spell the catalog's typographic symbols in ASCII ("…" as "...", "·" as "-"): the terminal's
   * ASCII symbol set (TERM=dumb, --ascii) applies to copy too.
   */
  ascii?: boolean;
}

/** Map a POSIX or BCP 47 locale onto a launch locale; English when none matches. */
export function resolveLocale(requested?: string | null): KitCopyLocale {
  if (!requested) return "en";
  const tag = requested
    .replace(/[.@].*$/, "")
    .replace(/_/g, "-")
    .toLowerCase();
  if (tag === "c" || tag === "posix" || tag === "") return "en";
  const exact = KIT_COPY_LOCALES.find((l) => l.toLowerCase() === tag);
  if (exact) return exact;
  const [lang, region] = tag.split("-");
  if (lang === "zh")
    return region === "tw" ||
      region === "hk" ||
      region === "mo" ||
      region === "hant"
      ? "en"
      : "zh-Hans";
  if (lang === "pt") return "pt-BR";
  const base = KIT_COPY_LOCALES.find((l) => l === lang);
  return base ?? "en";
}

/** The locale the environment asks for (LC_ALL, LC_MESSAGES, LANG, LANGUAGE). */
export function localeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return (
    env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE?.split(":")[0]
  );
}

interface Piece {
  text?: string;
  arg?: string;
  hash?: true;
}

interface Parsed {
  pieces: Piece[];
  complex?: {
    index: number;
    arg: string;
    kind: "plural" | "select";
    cases: Record<string, Piece[]>;
  };
}

const cache = new Map<string, Parsed>();

/** Parse one ICU-subset message. Throws on anything outside the subset. */
export function parseMessage(src: string): Parsed {
  const hit = cache.get(src);
  if (hit) return hit;
  let i = 0;
  const readText = (inCase: boolean): Piece[] => {
    const out: Piece[] = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ text: buf });
      buf = "";
    };
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "}" && inCase) break;
      if (ch === "#" && inCase) {
        flush();
        out.push({ hash: true });
        i++;
        continue;
      }
      if (ch === "{") {
        const close = src.indexOf("}", i);
        const inner = src.slice(i + 1, close);
        if (close < 0) throw new Error(`unclosed { in "${src}"`);
        if (inner.includes(",")) {
          if (inCase) throw new Error(`nested plural or select in "${src}"`);
          break;
        }
        flush();
        out.push({ arg: inner.trim() });
        i = close + 1;
        continue;
      }
      buf += ch;
      i++;
    }
    flush();
    return out;
  };
  const head = readText(false);
  const parsed: Parsed = { pieces: head };
  if (i < src.length && src[i] === "{") {
    i++;
    const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*,\s*(plural|select)\s*,/.exec(
      src.slice(i),
    );
    if (!m) throw new Error(`bad plural or select in "${src}"`);
    i += m[0].length;
    const cases: Record<string, Piece[]> = {};
    for (;;) {
      const c = /^\s*([A-Za-z0-9=]+)\s*\{/.exec(src.slice(i));
      if (!c) break;
      i += c[0].length;
      cases[c[1]!] = readText(true);
      if (src[i] !== "}") throw new Error(`unclosed case in "${src}"`);
      i++;
    }
    const end = /^\s*\}/.exec(src.slice(i));
    if (!end) throw new Error(`unclosed plural or select in "${src}"`);
    i += end[0].length;
    parsed.complex = {
      index: head.length,
      arg: m[1]!,
      kind: m[2] as "plural" | "select",
      cases,
    };
    parsed.pieces = [...head, ...readText(false)];
  }
  cache.set(src, parsed);
  return parsed;
}

function render(pieces: Piece[], args: CopyArgs, hash?: string): string {
  return pieces
    .map((p) =>
      p.text !== undefined
        ? p.text
        : p.hash
          ? (hash ?? "#")
          : String(args[p.arg!] ?? `{${p.arg}}`),
    )
    .join("");
}

/** Format an ICU-subset message for `locale`. A missing argument stays as `{name}`. */
export function formatMessage(
  src: string,
  args: CopyArgs = {},
  locale = "en",
): string {
  const p = parseMessage(src);
  if (!p.complex) return render(p.pieces, args);
  const { index, arg, kind, cases } = p.complex;
  let chosen: Piece[] | undefined;
  let hash: string | undefined;
  if (kind === "plural") {
    const n = Number(args[arg] ?? 0);
    hash = new Intl.NumberFormat(locale).format(n);
    const exact = cases[`=${n}`];
    chosen =
      exact ?? cases[new Intl.PluralRules(locale).select(n)] ?? cases.other;
  } else {
    chosen = cases[String(args[arg] ?? "other")] ?? cases.other;
  }
  return (
    render(p.pieces.slice(0, index), args) +
    render(chosen ?? [], args, hash) +
    render(p.pieces.slice(index), args)
  );
}

/** The catalog's typographic symbols in ASCII (the terminal's ASCII mode). */
export function asciiSymbols(text: string): string {
  return text
    .replace(/…/g, "...")
    .replace(/·/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/** One locale's view of the catalog, with the integrator's overrides on top. */
export class KitCopy {
  readonly locale: KitCopyLocale;
  private readonly overrides: CopyOptions["overrides"];
  private readonly ascii: boolean;

  constructor(opts: CopyOptions = {}) {
    this.locale = resolveLocale(opts.locale);
    this.overrides = opts.overrides;
    this.ascii = opts.ascii === true;
  }

  /** The raw ICU text for `key`: override, locale, English override, English. */
  raw(key: string): string | undefined {
    const o = this.overrides;
    return (
      o?.[this.locale]?.[key] ??
      KIT_COPY[this.locale][key] ??
      o?.en?.[key] ??
      KIT_COPY.en[key]
    );
  }

  has(key: string): boolean {
    return this.raw(key) !== undefined;
  }

  /** The formatted string. An unknown key throws: every visible string is a catalog key. */
  t(key: string, args: CopyArgs = {}): string {
    const src = this.raw(key);
    if (src === undefined) throw new Error(`no kit copy for ${key}`);
    const out = formatMessage(src, args, this.locale);
    return this.ascii ? asciiSymbols(out) : out;
  }

  /** The core copy for an error code (`core.codes.*`, else the fallback with the code). */
  code(code: string, part: "title" | "message"): string {
    const key = `core.codes.${code}.${part}`;
    return this.has(key)
      ? this.t(key)
      : this.t(`core.fallback.${part}`, { code });
  }
}
