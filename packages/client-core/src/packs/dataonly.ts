// The data-only rule for delegated installs (plans/P4-19.md §2.5, WIRE-CONTRACT-V4 §2.8). A pack
// release signed by a delegated content key may hold only files this rule admits. The extension
// allow-list is the real control (Godot chooses its resource loader by extension); the head and
// tail sniffs are defence in depth that fail closed. The engine runs the extension rule over the
// files index before any payload object is fetched and both sniffs on each file's decoded bytes as
// the applier writes it; the CLI runs the same function before signing, and the Worker's ingest
// runs the extension rule. Release-signed packs keep their own rules. Pure; never throws.

import {
  DATA_ONLY_HEAD_BYTES,
  DATA_ONLY_TAIL_BYTES,
} from "@polaris-key/protocol/core";
import { DATA_ONLY_EXTENSIONS } from "@polaris-key/protocol/packs";
import { pathSafe } from "./files.js";
import type { TreeSink } from "./ports.js";

/** Which rule refused a file (`pack-not-data-only`'s detail). */
export type DataOnlyRule = "extension" | "content";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** The refused heads (rule 3), after a UTF-8 BOM and ASCII whitespace are skipped: Godot
 *  resource, pack and script formats; archives and native code; scripts. 20 entries, with
 *  `extends` and `class_name` each followed by a space or a tab. */
const HEADS: readonly (readonly number[])[] = [
  // Godot.
  ascii("RSRC"),
  ascii("RSCC"),
  ascii("GDPC"),
  ascii("GDEC"),
  ascii("GCPF"),
  ascii("GDSC"),
  ascii("[gd_"),
  // Archives and native code.
  [0x50, 0x4b, 0x03, 0x04],
  [0x7f, 0x45, 0x4c, 0x46],
  ascii("MZ"),
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0x00, 0x61, 0x73, 0x6d],
  // Scripts.
  ascii("#!"),
  ascii("@tool"),
];
const WORD_HEADS: readonly (readonly number[])[] = [
  ascii("extends"),
  ascii("class_name"),
];

/** `PK\x05\x06`: a zip end-of-central-directory record (rule 4). */
const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06];
const GDPC = ascii("GDPC");

const isWs = (b: number): boolean => b === 0x20 || (b >= 0x09 && b <= 0x0d);

function startsWith(
  bytes: Uint8Array,
  at: number,
  magic: readonly number[],
): boolean {
  if (at + magic.length > bytes.length) return false;
  for (let k = 0; k < magic.length; k++)
    if (bytes[at + k] !== magic[k]) return false;
  return true;
}

/** True when the window ends inside `magic` read from `at`: what is visible is its prefix. */
function straddles(
  bytes: Uint8Array,
  at: number,
  magic: readonly number[],
): boolean {
  if (at + magic.length <= bytes.length) return false;
  for (let k = at; k < bytes.length; k++)
    if (bytes[k] !== magic[k - at]) return false;
  return true;
}

/** The extensions whose files are text a VariantParser reader could parse (plans/P4-19.md
 *  Amendment A1): the whole decoded file passes the text rule. */
export const DATA_ONLY_TEXT_EXTENSIONS: readonly string[] = [
  "json",
  "csv",
  "tsv",
  "po",
  "txt",
];

/** The script markers a text file may not hold (plans/P4-19.md Amendment A1): the script types,
 *  then the properties that hold a script's source. The same list as P4-08's `packLint`
 *  `SCRIPT_MARKERS`, restated so client-core stays self-contained. */
export const DATA_ONLY_SCRIPT_MARKERS: readonly string[] = [
  "GDScript",
  "CSharpScript",
  "ScriptExtension",
  "script/source",
  "source_code",
];

/**
 * Rule 5 (Amendment A1), over a text file's whole decoded bytes: `content` when the bytes are not
 * valid UTF-8 or hold a NUL; when the text, or the text with every backslash removed, holds a
 * script marker; or when it holds any `\u` or `\U` escape. A VariantParser reader
 * (`str_to_var`, `ConfigFile`, `JSON.to_native` with objects) builds an inline
 * `Object(GDScript, "script/source": …)`, which compiles when set; this refuses every spelling of
 * one, failing closed. Null when admitted.
 */
export function dataOnlyTextRefusal(bytes: Uint8Array): "content" | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "content";
  }
  if (text.includes("\u0000")) return "content";
  if (/\\[uU]/.test(text)) return "content";
  const bare = text.replaceAll("\\", "");
  for (const m of DATA_ONLY_SCRIPT_MARKERS)
    if (text.includes(m) || bare.includes(m)) return "content";
  return null;
}

/** Rule 2: the final segment's text after its last `.`, ASCII-lowercased; null without one. */
export function dataOnlyExtension(path: string): string | null {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot < 0) return null;
  return last.slice(dot + 1).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Rules 1 and 2 alone, over a path: `extension` when the path is not already normalised (it
 *  fails the files index's path rules) or its extension is not in `DATA_ONLY_EXTENSIONS`. */
export function dataOnlyPathRefusal(path: string): "extension" | null {
  if (typeof path !== "string" || !pathSafe(path)) return "extension";
  const ext = dataOnlyExtension(path);
  if (
    ext === null ||
    !(DATA_ONLY_EXTENSIONS as readonly string[]).includes(ext)
  )
    return "extension";
  return null;
}

/**
 * The data-only rule over one file (plans/P4-19.md §2.5): `path` its index path, `head` its first
 * `DATA_ONLY_HEAD_BYTES` decoded bytes (fewer for a shorter file), `tail` its last
 * `DATA_ONLY_TAIL_BYTES` (fewer for a shorter file; the two may overlap). In order:
 *
 *  1. the path is already normalised (the files index's path rules: no empty, `.` or `..`
 *     segment, nothing Godot's `simplify_path()` would change), else `extension`;
 *  2. its extension is in `DATA_ONLY_EXTENSIONS`, else `extension`;
 *  3. after a UTF-8 BOM and then ASCII whitespace inside `head`, what remains starts with none of
 *     the refused heads, else `content`;
 *     When `head` is a full window (it may cut the file), the skip reaching its end, or a refused
 *     head that the window's end cuts (a prefix of it, or a word head whose following byte lies
 *     beyond the window), is `content` too (Amendment A1: Godot's text-resource loader and the
 *     GDScript tokenizer skip any amount of leading whitespace);
 *  4. `tail` does not end with `GDPC` and holds no `PK\x05\x06`, else `content`;
 *  5. a text file (`DATA_ONLY_TEXT_EXTENSIONS`) passes `dataOnlyTextRefusal` over `full`, its
 *     whole decoded bytes (Amendment A1). Without `full` such a file is refused (`content`).
 *
 * Null when the file is admitted. Never throws.
 */
export function dataOnlyRefusal(
  path: string,
  head: Uint8Array,
  tail: Uint8Array,
  full?: Uint8Array,
): DataOnlyRule | null {
  const p = dataOnlyPathRefusal(path);
  if (p !== null) return p;
  const h = head.subarray(0, DATA_ONLY_HEAD_BYTES);
  let at = 0;
  if (h[0] === 0xef && h[1] === 0xbb && h[2] === 0xbf) at = 3;
  while (at < h.length && isWs(h[at]!)) at++;
  // A full window may cut the file: what it cannot see is refused (fails closed).
  const cut = h.length === DATA_ONLY_HEAD_BYTES;
  if (cut && at === h.length) return "content";
  for (const m of HEADS)
    if (startsWith(h, at, m) || (cut && straddles(h, at, m))) return "content";
  for (const m of WORD_HEADS)
    if (startsWith(h, at, m)) {
      const next = h[at + m.length];
      if (next === 0x20 || next === 0x09) return "content";
      if (next === undefined && cut) return "content";
    } else if (cut && straddles(h, at, m)) return "content";
  const t =
    tail.length > DATA_ONLY_TAIL_BYTES
      ? tail.subarray(tail.length - DATA_ONLY_TAIL_BYTES)
      : tail;
  if (t.length >= 4 && startsWith(t, t.length - 4, GDPC)) return "content";
  for (let k = 0; k + 4 <= t.length; k++)
    if (t[k] === 0x50 && startsWith(t, k, ZIP_EOCD)) return "content";
  if (DATA_ONLY_TEXT_EXTENSIONS.includes(dataOnlyExtension(path)!))
    return full === undefined ? "content" : dataOnlyTextRefusal(full);
  return null;
}

/** `dataOnlyRefusal` over a whole file's decoded bytes. */
export function dataOnlyFileRefusal(
  path: string,
  bytes: Uint8Array,
): DataOnlyRule | null {
  return dataOnlyRefusal(
    path,
    bytes.subarray(0, DATA_ONLY_HEAD_BYTES),
    bytes.subarray(Math.max(0, bytes.length - DATA_ONLY_TAIL_BYTES)),
    bytes,
  );
}

/** A refusal the data-only tree sink saw: the first file it refused. */
export interface DataOnlyRefusalSeen {
  path: string;
  rule: DataOnlyRule;
}

/**
 * Wrap a tree sink so every file a delegated install writes passes `dataOnlyRefusal` before it
 * reaches the sink. The first refusal is recorded in `seen` and the write throws, which fails the
 * applier; the engine then aborts the plan with `pack-not-data-only`.
 */
export function dataOnlyTreeSink(
  inner: TreeSink,
  seen: { refusal: DataOnlyRefusalSeen | null },
): TreeSink {
  return {
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      const rule = dataOnlyFileRefusal(path, bytes);
      if (rule !== null) {
        seen.refusal ??= { path, rule };
        throw new Error(`pack-not-data-only: ${path} (${rule})`);
      }
      await inner.writeFile(path, bytes);
    },
  };
}
