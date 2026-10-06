// The string lint (UI-KITS.md §4.7, §7.3): every visible string is a catalog key, and the same
// state shows the same copy in every kit and on every mockup board, allowing only the documented
// platform variants (a key's `variants` in packages/brand/kit-copy/en.json).
//
// A visible string is matched in this order:
//   1. a catalog message (kit copy or core copy), with ICU arguments matched as wildcards, plural
//      branches and select branches expanded; a `variants` entry matches only on its platform;
//   2. a fixture or platform string from strings.allow.json (product names, devices, dates, the
//      host app around the kit), each entry with its reason;
//   3. nothing: the string is reported, with the nearest catalog message when one is close
//      (copy drift: "Retry" where the catalog says "Try again").
// The cross-board half then compares, per state, which keys each board shows against the
// components.json copy list, and fails when one key renders differently on two boards beyond its
// documented variants.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CatalogMessage {
  key: string;
  value: string;
  role?: string;
  /** Platform → replacement value (the catalog's documented variants). */
  variants: Record<string, string>;
}

export interface Matcher {
  key: string;
  platform: string | null;
  source: string;
  patterns: Pattern[];
  /** How specific the message is: literal characters, so "Sign in" beats "{product}". */
  weight: number;
}

export interface Allow {
  text?: string;
  pattern?: string;
  boards?: string[];
  reason: string;
}

export interface StringFinding {
  board: string;
  state: string;
  text: string;
  target: string;
  detail: string;
}

export function loadCatalog(root: string): CatalogMessage[] {
  const kit = JSON.parse(
    readFileSync(resolve(root, "packages/brand/kit-copy/en.json"), "utf8"),
  ) as {
    messages: Record<
      string,
      { value: string; role?: string; variants?: Record<string, string> }
    >;
  };
  const out: CatalogMessage[] = Object.entries(kit.messages).map(
    ([key, m]) => ({
      key,
      value: m.value,
      role: m.role,
      variants: m.variants ?? {},
    }),
  );
  const core = JSON.parse(
    readFileSync(resolve(root, "conformance/parity/copy.en.json"), "utf8"),
  ) as Record<string, unknown>;
  const walk = (node: unknown, path: string[]) => {
    if (typeof node === "string") {
      out.push({ key: `core.${path.join(".")}`, value: node, variants: {} });
      return;
    }
    if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(core))
    if (!k.startsWith("$") && k !== "copyVersion" && k !== "locale")
      walk(v, [k]);
  return out;
}

/** Normalise what a renderer may legitimately change: whitespace, quotes and the ellipsis. */
export function normalise(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\.\.\./g, "…")
    .replace(/[\s   ]+/g, " ")
    .trim();
}

/** Split an ICU message into literal text and {…} blocks (nested braces kept whole). */
function tokens(msg: string): Array<{ lit?: string; arg?: string }> {
  const out: Array<{ lit?: string; arg?: string }> = [];
  let depth = 0;
  let cur = "";
  for (const ch of msg) {
    if (ch === "{") {
      if (depth === 0 && cur) {
        out.push({ lit: cur });
        cur = "";
      }
      depth++;
      if (depth === 1) continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        out.push({ arg: cur });
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur) out.push({ lit: cur });
  return out;
}

/** A message as glob segments: literal text, or null for one argument (any non-empty text). */
export type Pattern = Array<string | null>;

/**
 * The ICU subset the catalog allows (plain arguments, plural, select) as glob patterns, one per
 * combination of plural and select branches. Matching is a linear glob scan, never a regex with
 * a group per argument: those backtrack polynomially on strings that do not match.
 */
export function icuToPatterns(msg: string): {
  patterns: Pattern[];
  weight: number;
} {
  let weight = 0;
  const conv = (m: string): Pattern[] => {
    let acc: Pattern[] = [[]];
    for (const t of tokens(m)) {
      let alts: Pattern[];
      if (t.lit !== undefined) {
        weight += (t.lit.match(/\p{L}/gu) ?? []).length;
        alts = [[t.lit.replace(/\s+/g, " ")]];
      } else {
        const arg = t.arg ?? "";
        const m2 = arg.match(/^\s*(\w+)\s*,\s*(plural|select)\s*,(.*)$/s);
        if (!m2) alts = [[null]];
        else {
          alts = [];
          const re = /(=?\w+)\s*\{/g;
          const body = m2[3] ?? "";
          let i = 0;
          while (i < body.length) {
            re.lastIndex = i;
            const hit = re.exec(body);
            if (!hit) break;
            let depth = 1;
            let j = hit.index + hit[0].length;
            const start = j;
            while (j < body.length && depth) {
              if (body[j] === "{") depth++;
              if (body[j] === "}") depth--;
              j++;
            }
            const branch = body.slice(start, j - 1);
            alts.push(
              ...conv(
                m2[2] === "plural" ? branch.replace(/#/g, "{n}") : branch,
              ),
            );
            i = j;
          }
        }
      }
      const next: Pattern[] = [];
      for (const a of acc) for (const b of alts) next.push([...a, ...b]);
      acc = next.slice(0, 256);
    }
    return acc;
  };
  const patterns = conv(msg).map(merge);
  return { patterns, weight };
}

/** Join adjacent literals and collapse adjacent wildcards. */
function merge(p: Pattern): Pattern {
  const out: Pattern = [];
  for (const t of p) {
    const last = out[out.length - 1];
    if (t === null) {
      if (last !== null || out.length === 0) out.push(null);
    } else if (typeof last === "string") out[out.length - 1] = last + t;
    else out.push(t);
  }
  return out;
}

/** Glob match: literals in order, each wildcard at least one character. Leftmost-greedy is exact. */
export function globMatch(text: string, p: Pattern): boolean {
  let pos = 0;
  let i = 0;
  // Leading literal anchors at 0.
  if (typeof p[0] === "string") {
    if (!text.startsWith(p[0])) return false;
    pos = p[0].length;
    i = 1;
  }
  if (i >= p.length) return pos === text.length;
  // Trailing literal anchors at the end.
  const tail = p[p.length - 1];
  let end = text.length;
  let last = p.length;
  if (typeof tail === "string" && p.length - 1 >= i) {
    if (!text.endsWith(tail) || text.length - tail.length < pos) return false;
    end = text.length - tail.length;
    last = p.length - 1;
  }
  let pendingWild = false;
  for (; i < last; i++) {
    const t = p[i] as string | null;
    if (t === null) {
      pendingWild = true;
      continue;
    }
    const at = text.indexOf(t, pos + (pendingWild ? 1 : 0));
    if (at < 0 || at + t.length > end) return false;
    pos = at + t.length;
    pendingWild = false;
  }
  return pendingWild ? end - pos >= 1 : end === pos;
}

export function compile(catalog: CatalogMessage[]): Matcher[] {
  const out: Matcher[] = [];
  const add = (key: string, platform: string | null, value: string) => {
    const { patterns, weight } = icuToPatterns(normalise(value));
    out.push({ key, platform, source: value, patterns, weight });
  };
  for (const m of catalog) {
    add(m.key, null, m.value);
    for (const [p, v] of Object.entries(m.variants)) add(m.key, p, v);
    // §1.5 rule 11: macOS buttons, menu items and window titles are title case. That casing is
    // the one variant every button key carries without listing it.
    if (m.role === "button" && !m.variants.macos)
      add(m.key, "macos", titleCase(m.value));
  }
  // Most specific first, so a literal message wins over an all-argument one.
  return out.sort((a, b) => b.weight - a.weight);
}

const SMALL = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Apple-style title case, leaving ICU blocks alone. */
export function titleCase(value: string): string {
  let depth = 0;
  let word = 0;
  return value.replace(/\{|\}|[\p{L}'’]+/gu, (w) => {
    if (w === "{") depth++;
    else if (w === "}") depth--;
    else if (depth === 0) {
      const first = word++ === 0;
      if (!first && SMALL.has(w.toLowerCase())) return w;
      return w[0]!.toUpperCase() + w.slice(1);
    }
    return w;
  });
}

export interface Match {
  key: string;
  /** The value the board showed differs from the base value only by a documented variant. */
  variant: string | null;
}

/**
 * Match one visible string. A variant matches only on its own platform; the base value matches
 * everywhere (a platform with a variant may still show the base, e.g. macOS before title case).
 */
export function matchString(
  matchers: Matcher[],
  text: string,
  platform: string,
): Match | null {
  const t = normalise(text);
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  for (const m of matchers) {
    // A message that is mostly arguments ("{store} key", "{product} · {term}") says little about
    // copy: it matches only when its own words are at least a quarter of the string's letters.
    if (m.weight < 2 || m.weight < letters * 0.25) continue;
    if (m.platform && m.platform !== platform) continue;
    if (m.patterns.some((p) => globMatch(t, p)))
      return { key: m.key, variant: m.platform };
  }
  return null;
}

export function loadAllow(file: string): Allow[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { allow: Allow[] };
  for (const a of raw.allow)
    if (!a.reason)
      throw new Error(
        `${file}: every allow entry needs a reason (${a.text ?? a.pattern})`,
      );
  return raw.allow;
}

export function allowed(allow: Allow[], text: string, board: string): boolean {
  const t = normalise(text);
  return allow.some(
    (a) =>
      (!a.boards || a.boards.includes(board)) &&
      ((a.text !== undefined && normalise(a.text) === t) ||
        (a.pattern !== undefined &&
          new RegExp(`^(?:${a.pattern})$`, "u").test(t))),
  );
}

/** Levenshtein distance, for "did you mean" on copy drift. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(
        d[j]! + 1,
        d[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return d[b.length]!;
}

export function nearest(
  catalog: CatalogMessage[],
  text: string,
): CatalogMessage | null {
  const t = normalise(text).toLowerCase();
  let best: CatalogMessage | null = null;
  let score = Infinity;
  for (const m of catalog) {
    if (/[{}]/.test(m.value)) continue;
    const v = normalise(m.value).toLowerCase();
    const dist = distance(t, v);
    if (dist < score) {
      score = dist;
      best = m;
    }
  }
  return best && score <= Math.max(2, Math.floor(t.length * 0.35))
    ? best
    : null;
}

export interface BoardStrings {
  board: string;
  platform: string;
  strings: Array<{ scope: string; target: string; text: string }>;
}

/** The state a shot shows: its name without the size or variant suffix ("sign-in-390" → "sign-in"). */
export function stateOf(scope: string): string {
  return scope.replace(/-(390|deck|1080|720|\d+)$/, "");
}

export function lintStrings(
  catalog: CatalogMessage[],
  allow: Allow[],
  boards: BoardStrings[],
): {
  findings: StringFinding[];
  keysByState: Map<string, Map<string, Set<string>>>;
} {
  const matchers = compile(catalog);
  const findings: StringFinding[] = [];
  // state → key → the distinct normalised texts it rendered as (with their board)
  const rendered = new Map<string, Map<string, Map<string, string[]>>>();
  const keysByState = new Map<string, Map<string, Set<string>>>();
  for (const b of boards) {
    for (const s of b.strings) {
      const state = stateOf(s.scope);
      const m = matchString(matchers, s.text, b.platform);
      if (m) {
        const k = keysByState.get(state) ?? new Map<string, Set<string>>();
        keysByState.set(state, k);
        const ks = k.get(b.board) ?? new Set<string>();
        k.set(b.board, ks);
        ks.add(m.key);
        const byKey = rendered.get(state) ?? new Map();
        rendered.set(state, byKey);
        const texts = byKey.get(m.key) ?? new Map<string, string[]>();
        byKey.set(m.key, texts);
        const norm = m.variant ? `variant:${m.variant}` : "base";
        texts.set(norm, [...(texts.get(norm) ?? []), b.board]);
        continue;
      }
      if (allowed(allow, s.text, b.board)) continue;
      const near = nearest(catalog, s.text);
      findings.push({
        board: b.board,
        state,
        text: s.text,
        target: s.target,
        detail: near
          ? `not a catalog string; the catalog says "${near.value}" (${near.key})`
          : "not a catalog string, a documented platform variant or an allowed fixture string",
      });
    }
  }
  return { findings, keysByState };
}
