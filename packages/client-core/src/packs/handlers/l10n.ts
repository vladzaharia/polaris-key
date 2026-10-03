// `l10n.table` payloads (CONTENT §4.2; P4-16): PO, CSV or JSON tables, read by plain parsers.
// Nothing here evaluates a byte: a table is text split into messages, never a script, a resource
// or an object graph. Under content-key delegation (plans/P4-19.md §8.5) an `l10n.table` is
// effectively text, because `.translation` fails the data-only allow-list; this handler never
// loads a `.translation` resource at all.
//
// The format of a file is judged by its bytes, never its name: after a UTF-8 BOM and ASCII
// whitespace, `{` is a JSON table, `#`, `msgid` or `msgctxt` a PO file, anything else CSV. Every
// SDK ports these rules against `test/fixtures/pack-type-cases.json`.

import { strictParse } from "../files.js";
import { compareBytes } from "../variant.js";

/** One message of a table. `strings` has one entry, or one per plural form (PO `msgstr[N]`). */
export interface L10nMessage {
  context: string | null;
  id: string;
  plural: string | null;
  strings: string[];
}

/** One locale's messages from one file (a CSV file with N locale columns gives N tables). */
export interface L10nTable {
  path: string;
  /** The canonical tag (`_` written as `-`, case kept). */
  locale: string;
  messages: L10nMessage[];
}

const BCP47_RE =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/;
const TAG_CHARS_RE = /^[A-Za-z0-9-]{2,35}$/;

/**
 * A locale as a well-formed BCP-47 tag (RFC 5646 `langtag` and private use; no grandfathered
 * tags), with `_` accepted as Godot writes it (`pt_BR`) and written `-`; null when it is not one.
 * Case is kept; comparisons are ASCII-case-insensitive.
 */
export function bcp47Canonical(tag: string): string | null {
  const canonical = tag.replace(/_/g, "-");
  if (!TAG_CHARS_RE.test(canonical)) return null;
  return BCP47_RE.test(canonical.toLowerCase()) ? canonical : null;
}

const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Whether two tags name the same locale (ASCII-case-insensitive, after canonicalisation). */
export function sameLocale(a: string, b: string): boolean {
  return asciiLower(a.replace(/_/g, "-")) === asciiLower(b.replace(/_/g, "-"));
}

export type L10nParse =
  | { ok: true; tables: L10nTable[] }
  | { ok: false; detail: "table" | "locale" };

const fail = { ok: false, detail: "table" } as const;

/** Parse one file of an `l10n.table` payload (rules 2–5 of the check; the size rule is the
 *  handler's). Locales are canonicalised and checked for well-formedness here; the variant match
 *  is the handler's. */
export function parseL10nFile(path: string, bytes: Uint8Array): L10nParse {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail;
  }
  if (text.includes("\u0000")) return fail;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let at = 0;
  while (at < body.length && " \t\n\r".includes(body[at]!)) at++;
  if (at === body.length) return fail;
  let raw: { locale: string; messages: L10nMessage[] }[] | null;
  if (body[at] === "{") raw = parseJsonTable(body);
  else if (
    body.startsWith("#", at) ||
    body.startsWith("msgid", at) ||
    body.startsWith("msgctxt", at)
  )
    raw = parsePo(body);
  else raw = parseCsv(body);
  if (raw === null) return fail;
  const tables: L10nTable[] = [];
  for (const t of raw) {
    const locale = bcp47Canonical(t.locale);
    if (locale === null) return { ok: false, detail: "locale" };
    tables.push({ path, locale, messages: t.messages });
  }
  return { ok: true, tables };
}

// ── JSON ───────────────────────────────────────────────────────────────────────────────────

function parseJsonTable(
  text: string,
): { locale: string; messages: L10nMessage[] }[] | null {
  const parsed = strictParse(new TextEncoder().encode(text));
  if (parsed === null) return null;
  const v = parsed.value;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.locale !== "string") return null;
  const m = o.messages;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  // Member order is not portable (JavaScript lists integer-like keys first; some parsers keep no
  // order at all), so a JSON table's messages are in UTF-8 byte order of their ids.
  const messages: L10nMessage[] = [];
  for (const id of Object.keys(m).sort(compareBytes)) {
    const s = (m as Record<string, unknown>)[id];
    if (typeof s !== "string") return null;
    messages.push({ context: null, id, plural: null, strings: [s] });
  }
  return [{ locale: o.locale, messages }];
}

// ── PO ─────────────────────────────────────────────────────────────────────────────────────

const PO_KEYWORD_RE =
  /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d{1,2})\])?)[ \t]+([\s\S]*)$/;

/** A PO string literal (`"…"` and trailing spaces or tabs), unescaped; null when malformed. */
function poString(s: string): string | null {
  if (s[0] !== '"') return null;
  let out = "";
  let i = 1;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = s[++i];
    if (e === "\\") out += "\\";
    else if (e === '"') out += '"';
    else if (e === "n") out += "\n";
    else if (e === "t") out += "\t";
    else if (e === "r") out += "\r";
    else return null;
  }
  if (i >= s.length) return null;
  for (let j = i + 1; j < s.length; j++)
    if (s[j] !== " " && s[j] !== "\t") return null;
  return out;
}

interface PoEntry {
  context: string | null;
  id: string | null;
  plural: string | null;
  /** `msgstr` (no index) as index -1, else `msgstr[N]` by N, in order. */
  strings: string[];
  indexed: boolean | null;
}

function parsePo(
  text: string,
): { locale: string; messages: L10nMessage[] }[] | null {
  const entries: PoEntry[] = [];
  let cur: PoEntry | null = null;
  // Which string a continuation line extends: "ctxt", "id", "plural", or "str".
  let last: "ctxt" | "id" | "plural" | "str" | null = null;
  const complete = (e: PoEntry) => e.id !== null && e.strings.length > 0;
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (/^[ \t]*$/.test(line)) {
      last = null;
      continue;
    }
    if (line.startsWith("#")) {
      last = null;
      continue;
    }
    if (line.startsWith('"')) {
      const s = poString(line);
      if (s === null || cur === null || last === null) return null;
      if (last === "ctxt") cur.context += s;
      else if (last === "id") cur.id += s;
      else if (last === "plural") cur.plural += s;
      else cur.strings[cur.strings.length - 1] += s;
      continue;
    }
    const m = PO_KEYWORD_RE.exec(line);
    if (!m) return null;
    const kw = m[1]!;
    const s = poString(m[3]!);
    if (s === null) return null;
    if (kw === "msgctxt" || kw === "msgid") {
      // A new entry starts at msgctxt, or at msgid when the current one has none open.
      const opensNew =
        cur === null ||
        complete(cur) ||
        (kw === "msgid" && cur.id !== null) ||
        kw === "msgctxt";
      if (opensNew) {
        if (cur !== null && !complete(cur)) return null;
        if (cur !== null) entries.push(cur);
        cur = {
          context: null,
          id: null,
          plural: null,
          strings: [],
          indexed: null,
        };
      }
      if (kw === "msgctxt") {
        cur!.context = s;
        last = "ctxt";
      } else {
        cur!.id = s;
        last = "id";
      }
      continue;
    }
    if (cur === null || cur.id === null) return null;
    if (kw === "msgid_plural") {
      if (cur.plural !== null || cur.strings.length > 0) return null;
      cur.plural = s;
      last = "plural";
      continue;
    }
    // msgstr or msgstr[N]
    const index = m[2];
    if (index === undefined) {
      if (cur.plural !== null || cur.strings.length > 0) return null;
      cur.indexed = false;
    } else {
      if (cur.plural === null) return null;
      if (Number(index) !== cur.strings.length) return null;
      cur.indexed = true;
    }
    cur.strings.push(s);
    last = "str";
  }
  if (cur !== null) {
    if (!complete(cur)) return null;
    entries.push(cur);
  }
  let locale: string | null = null;
  let headers = 0;
  const messages: L10nMessage[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.id === "" && e.context === null) {
      if (++headers > 1 || e.plural !== null) return null;
      for (const l of e.strings[0]!.split("\n")) {
        const mm = /^Language:([\s\S]*)$/.exec(l);
        if (mm && locale === null)
          locale = mm[1]!.replace(/^[ \t]+|[ \t]+$/g, "");
      }
      continue;
    }
    const key = `${e.context === null ? "0" : `1${e.context}`}\u0000${e.id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    messages.push({
      context: e.context,
      id: e.id!,
      plural: e.plural,
      strings: e.strings,
    });
  }
  if (headers === 0 || locale === null || locale === "") return null;
  return [{ locale, messages }];
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180 records (comma only); null when a quote is malformed. */
function csvRecords(text: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const n = text.length;
  // Whether the current record has any characters (an empty line is no record).
  let started = false;
  while (i < n) {
    let field = "";
    if (text[i] === '"') {
      started = true;
      i++;
      for (;;) {
        if (i >= n) return null;
        const c = text[i]!;
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += c;
        i++;
      }
      if (
        i < n &&
        text[i] !== "," &&
        text[i] !== "\n" &&
        !(text[i] === "\r" && text[i + 1] === "\n")
      )
        return null;
    } else {
      while (
        i < n &&
        text[i] !== "," &&
        text[i] !== "\n" &&
        !(text[i] === "\r" && text[i + 1] === "\n")
      ) {
        if (text[i] === '"') return null;
        field += text[i];
        i++;
      }
      if (field.length > 0) started = true;
    }
    record.push(field);
    if (i >= n) break;
    if (text[i] === ",") {
      started = true;
      i++;
      if (i >= n) record.push("");
      continue;
    }
    // A record end.
    i += text[i] === "\r" ? 2 : 1;
    if (started) records.push(record);
    record = [];
    started = false;
  }
  if (started) records.push(record);
  return records;
}

function parseCsv(
  text: string,
): { locale: string; messages: L10nMessage[] }[] | null {
  const records = csvRecords(text);
  if (records === null || records.length === 0) return null;
  const header = records[0]!;
  if (header.length < 2) return null;
  const locales = header.slice(1);
  const lower = new Set<string>();
  for (const l of locales) {
    const k = asciiLower(l.replace(/_/g, "-"));
    if (lower.has(k)) return null;
    lower.add(k);
  }
  const tables = locales.map((locale) => ({
    locale,
    messages: [] as L10nMessage[],
  }));
  const keys = new Set<string>();
  for (const r of records.slice(1)) {
    if (r.length !== header.length) return null;
    const key = r[0]!;
    if (key === "" || keys.has(key)) return null;
    keys.add(key);
    for (let c = 1; c < r.length; c++)
      tables[c - 1]!.messages.push({
        context: null,
        id: key,
        plural: null,
        strings: [r[c]!],
      });
  }
  return tables;
}
