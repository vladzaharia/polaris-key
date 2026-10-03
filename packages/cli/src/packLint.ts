/**
 * The publish lint of a pack payload, by type (P4-03; notes/S-05 §5 (f), measured in §4.6).
 *
 * ── `godot.pck`: THE ADMISSION LIST ──────────────────────────────────────────────────────────
 *
 * A `godot.pck` payload, after the strip step (`pck.ts`), may contain only:
 *
 *   1. entries under one of the deliverable's `handler.prefixes` (`res://assets/kaykit/` admits
 *      `assets/kaykit/…`), including their `.remap` and `.import` files;
 *   2. the `.godot/exported/…` and `.godot/imported/…` files that those in-prefix `.remap` and
 *      `.import` files point to (their `path=`, `path.<x>=` and `dest_files` values);
 *   3. `.godot/uid_cache.bin`, which makes the pack's `uid://` references resolve once P4-08
 *      mounts it with `replace_files=true` — and only when every path it names is in the pack
 *      (P4-08 review N6: a 4.4/4.5 exporter writes the whole project's cache, and a foreign
 *      entry re-points one of the app's own UIDs at the pack's file).
 *
 * Every path must already be normal (P4-08 review B1, `pckPathOk`): no `..`, `.` or empty
 * segment and no trailing `/`, because the engine simplifies a path at mount and would land the
 * entry somewhere other than the prefix the lint matched. `readPck` refuses such a directory
 * before the lint runs. A `.remap` or `.import` target outside the pack (the base game's
 * `.godot/imported/…`, say) fails too: a pack loads only its own files.
 *
 * Every admitted resource must also carry no code (`embeddedCode`, fail-closed content rules
 * since the P4-08 validator audit: any script marker in a text or binary resource, a NUL, invalid
 * UTF-8 or a `\u` escape in a text one), and every in-prefix `.remap`/`.import` must read the
 * same to every parser (`remapProblem`); a refusal names its path (a v1 pack is data-only: S-07
 * row 13, plans/P4-01.md §3 `contentPolicy`).
 *
 * Everything else fails with its path, in particular `project.binary`,
 * `.godot/global_script_class_cache.cfg`, scripts (`.gd`, `.gdc`, `.cs`, and a `.remap` that
 * points to one, or remaps one), native libraries (`.so`, `.dll`, `.dylib`, `.wasm`, a
 * `.framework` or `.xcframework`) and `.gdextension` files — under a prefix or not. A
 * `.godot/exported/` or `.godot/imported/` file no in-prefix `.remap` or `.import` names fails
 * too: nothing in the pack could load it. P4-08's device-side directory check applies the same
 * list over the same fixture PCKs (`test/packFixtures.ts`), so the two cannot drift.
 *
 * Also: the header's engine `major.minor` must equal `requires.engine` (`godot-4.7`); more than
 * {@link PCK_WARN_ENTRIES} entries warns and more than {@link PCK_MAX_ENTRIES} fails, because
 * the mount stall grows with the entry count (S-05 §4.1).
 *
 * ── `files.tree` ─────────────────────────────────────────────────────────────────────────────
 *
 * A7 §3.3's path rules through client-core's `checkPaths` (the function every applier runs, so
 * the CLI refuses exactly what a device would), and no symbolic links (the walk in
 * `packArtifacts.ts` reports them).
 */

import { checkPaths } from "@polaris-key/client-core/packs";
import { PCK_STRIP_PATHS, pckPathOk, type PckDirectory } from "./pck.js";
import { rsccBody, rsccBodyIsResource, type RsccBudget } from "./rscc.js";

/** Above this many entries the lint warns (S-05 §4.1: the mount stall grows with the count). */
export const PCK_WARN_ENTRIES = 1000;
/** Above this many entries the lint fails. */
export const PCK_MAX_ENTRIES = 20000;

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const SCRIPT_RE = /\.(gd|gdc|cs)$/i;

/**
 * The script markers the scans refuse (P4-08 audit GAP 1, GAP 3, GAP 5), in order: the script
 * types, then the properties that hold a script's source. The device adds every class its engine
 * says inherits `Script` (`ClassDB.get_inheriters_from_class`); the CLI cannot ask an engine, so
 * an app with another script language passes its type names as `PckLintOptions.scriptTypes`.
 */
export const SCRIPT_MARKERS: readonly string[] = [
  "GDScript",
  "CSharpScript",
  "ScriptExtension",
  "script/source",
  "source_code",
];

interface ScriptKinds {
  exts: ReadonlySet<string>;
  markers: readonly string[];
}

function scriptKinds(opts: {
  scriptExtensions?: readonly string[];
  scriptTypes?: readonly string[];
}): ScriptKinds {
  const markers = [...SCRIPT_MARKERS];
  for (const t of [...(opts.scriptTypes ?? [])].sort())
    if (!markers.includes(t)) markers.push(t);
  return {
    exts: new Set((opts.scriptExtensions ?? []).map((x) => x.toLowerCase())),
    markers,
  };
}

function isScript(p: string, kinds: ScriptKinds): boolean {
  if (SCRIPT_RE.test(p)) return true;
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  return dot > slash && kinds.exts.has(p.slice(dot + 1).toLowerCase());
}
const NATIVE_RE = /\.(so|dll|dylib|wasm|gdextension)$|\.so\.\d+(\.\d+)*$/i;
const NATIVE_DIR_RE = /\.(framework|xcframework)$/i;

function isNative(path: string): boolean {
  if (NATIVE_RE.test(path)) return true;
  return path.split("/").some((s) => NATIVE_DIR_RE.test(s));
}

/** Strip `res://` from a Godot path; null when it does not start with it. */
function resPath(p: string): string | null {
  return p.startsWith("res://") ? p.slice("res://".length) : null;
}

/**
 * The files a `.remap` or `.import` points to, as index paths: every `path="res://…"` and
 * `path.<x>="res://…"` value, and every string in a `dest_files=[…]` array. `source_file` is the
 * import's input, not something the pack loads, so it is not a target.
 */
export function remapTargets(text: string): string[] {
  const out = new Set<string>();
  for (const v of remapValues(text)) {
    const p = resPath(v);
    if (p !== null) out.add(p);
  }
  return [...out];
}

// Whitespace is an explicit class in every pattern (never `\s` or `\v`, which JS and PCRE2 read
// differently), and lines are split by hand after CR → LF, never with the `m` flag (JS breaks
// lines at CR, U+2028 and U+2029 too) — P4-08 audit GAP 2, GAP 6.
/**
 * A `path` key anywhere in a line (P4-08 audit GAP B: the engine's tag parser needs no line
 * start). A key preceded by `/`, `.` or `-` is another key (`import_script/path` in every scene
 * import's [params], GAP C), so those characters do not start one.
 */
const PATH_ANY_RE =
  /(^|[^A-Za-z0-9_/.-])"?path(\.[A-Za-z0-9_-]+)*"?[ \t\f\x0B]*=/;
const PATH_LINE_RE =
  /^[ \t\f\x0B]*path(?:\.[A-Za-z0-9_-]+)?[ \t\f\x0B]*=[ \t\f\x0B]*"([^"\\]*)"[ \t\f\x0B]*$/;
const DEST_LINE_RE =
  /^[ \t\f\x0B]*dest_files[ \t\f\x0B]*=[ \t\f\x0B]*\[([^\]]*)\]/;

function lines(text: string): string[] {
  return text.replace(/\r/g, "\n").split("\n");
}

/**
 * Every value a `.remap` or `.import` points the engine at, raw (`path=`, `path.<x>=` and the
 * strings of `dest_files=[…]`), in order, without duplicates. Each non-empty one must be a
 * normalised `res://` path of the pack itself (P4-08 review B1, N6).
 */
export function remapValues(text: string): string[] {
  const out = new Set<string>();
  const ls = lines(text);
  for (const l of ls) {
    const m = PATH_LINE_RE.exec(l);
    if (m) out.add(m[1]!);
  }
  for (const l of ls) {
    const m = DEST_LINE_RE.exec(l);
    if (m) for (const q of m[1]!.matchAll(/"([^"]*)"/g)) out.add(q[1]!);
  }
  return [...out];
}

/**
 * Why a `.remap` or `.import` cannot be read the way the engine would read it, or null (P4-08
 * audit GAP 4, GAP 6, GAP B): a NUL byte, any other control byte but TAB, LF and CR, any
 * backslash, invalid UTF-8 or a byte-order mark, or a line with a `path` key anywhere in it
 * (quoted or not) that is not exactly `path[.<x>] = "<plain literal>"` (no StringName `&`,
 * NodePath `^` or escape, no second key segment). Dictionary entries (`metadata={…}`) use `:`.
 */
export function remapProblem(data: Uint8Array): string | null {
  if (data.includes(0)) return "a .remap or .import with a NUL byte";
  for (const b of data)
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)
      return "a .remap or .import with a control byte";
  if (data.includes(0x5c)) return "a .remap or .import with a backslash";
  if (!utf8Valid(data)) return "a .remap or .import that is not valid UTF-8";
  if (
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).indexOf(BOM) !==
    -1
  )
    return "a .remap or .import with a byte-order mark";
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
  for (const l of lines(text))
    if (PATH_ANY_RE.test(l) && !PATH_LINE_RE.test(l))
      return `a path line the engine could read differently (${l})`;
  return null;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Strict UTF-8 (the Unicode table: no overlong form, no surrogate, nothing above U+10FFFF), the
 * same explicit validator the device runs, so the two never decode the same bytes differently.
 */
export function utf8Valid(b: Uint8Array): boolean {
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      i += 1;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c === 0xe0) {
      need = 2;
      lo = 0xa0;
    } else if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) need = 2;
    else if (c === 0xed) {
      need = 2;
      hi = 0x9f;
    } else if (c === 0xf0) {
      need = 3;
      lo = 0x90;
    } else if (c >= 0xf1 && c <= 0xf3) need = 3;
    else if (c === 0xf4) {
      need = 3;
      hi = 0x8f;
    } else return false;
    if (i + need >= n) return false;
    const x = b[i + 1]!;
    if (x < lo || x > hi) return false;
    for (let k = 2; k <= need; k++) {
      const y = b[i + k]!;
      if (y < 0x80 || y > 0xbf) return false;
    }
    i += need + 1;
  }
  return true;
}

/**
 * Why a `.godot/uid_cache.bin` is refused, or null (P4-08 review N6): every path it names must be
 * a file of this pack (itself, or its `.remap` or `.import`), so a pack registers only its own
 * UIDs and never re-points one the game or another pack owns. Layout: u32 count, then per entry
 * an i64 id, a u32 length and the path.
 */
export function uidCacheProblem(
  data: Uint8Array,
  inPack: ReadonlySet<string>,
): string | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 4) return "a malformed uid cache";
  const n = dv.getUint32(0, true);
  let p = 4;
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (let i = 0; i < n; i++) {
    if (p + 12 > data.byteLength) return "a malformed uid cache";
    const ln = dv.getUint32(p + 8, true);
    if (p + 12 + ln > data.byteLength) return "a malformed uid cache";
    const rawBytes = data.subarray(p + 12, p + 12 + ln);
    if (rawBytes.includes(0)) return "names a path with a NUL byte";
    const raw = dec.decode(rawBytes);
    p += 12 + ln;
    const t = resPath(raw);
    if (
      t === null ||
      !pckPathOk(t) ||
      !(inPack.has(t) || inPack.has(`${t}.remap`) || inPack.has(`${t}.import`))
    )
      return `names a path outside the pack (${raw})`;
  }
  if (p !== data.byteLength) return "a malformed uid cache";
  return null;
}

export interface PckLintOptions {
  /** The deliverable's `handler.prefixes` (`res://…/`). */
  prefixes: readonly string[];
  /** The deliverable's `requires.engine` (`godot-<major>.<minor>`). */
  engine?: string;
  /**
   * Extensions refused as scripts beside `.gd`, `.gdc` and `.cs` (P4-08 audit GAP 5): the device
   * also refuses every extension its engine's loaders recognise for `Script`, so an app with a
   * GDExtension script language lists that language's extensions here for CI to match.
   */
  scriptExtensions?: readonly string[];
  /** Script class names refused as markers beside `SCRIPT_MARKERS` (the language's types). */
  scriptTypes?: readonly string[];
}

/** The admission list, the engine check and the entry-count limits over a stripped PCK. */
export function lintPck(
  dir: PckDirectory,
  bytes: Uint8Array,
  opts: PckLintOptions,
): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prefixes = opts.prefixes
    .map((p) => resPath(p))
    .filter((p): p is string => p !== null && p !== "");
  const inPrefix = (p: string) => prefixes.some((x) => p.startsWith(x));
  const { major, minor } = dir.header.engine;
  if (opts.engine !== undefined && opts.engine !== `godot-${major}.${minor}`)
    errors.push(
      `the PCK header says engine ${major}.${minor}.${dir.header.engine.patch}, outside requires.engine ${opts.engine}.`,
    );
  const count = dir.entries.length;
  if (count > PCK_MAX_ENTRIES)
    errors.push(
      `${count} entries; a pack is at most ${PCK_MAX_ENTRIES} (the mount stall grows with the entry count, S-05 §4.1). Split the pack.`,
    );
  else if (count > PCK_WARN_ENTRIES)
    warnings.push(
      `${count} entries, above ${PCK_WARN_ENTRIES}: mounting it stalls longer (S-05 §4.1); consider splitting the pack.`,
    );

  const stripped = new Set<string>(PCK_STRIP_PATHS);
  const named = new Set<string>();
  const deferred: string[] = [];
  const text = new TextDecoder("utf-8", { fatal: false });
  const inPack = new Set(dir.entries.map((e) => e.path));
  const kinds = scriptKinds(opts);
  // The pack's RSCC decompression budget, counted in directory order (P4-27).
  const budget: RsccBudget = { used: 0 };
  for (const e of dir.entries) {
    const p = e.path;
    if (stripped.has(p)) {
      errors.push(`${p}: --export-pack's ${p} replaces the main pack's copy.`);
      continue;
    }
    if (isScript(p, kinds)) {
      errors.push(`${p}: a script; a pack carries data only (S-07 row 13).`);
      continue;
    }
    if (isNative(p)) {
      errors.push(
        `${p}: a native library or GDExtension; a pack carries data only.`,
      );
      continue;
    }
    if (p === ".godot/uid_cache.bin") {
      const why = uidCacheProblem(
        bytes.subarray(e.offset, e.offset + e.size),
        inPack,
      );
      if (why !== null)
        errors.push(`${p}: ${why}; a pack registers only its own UIDs.`);
      continue;
    }
    const code = embeddedCode(
      p,
      bytes.subarray(e.offset, e.offset + e.size),
      kinds.markers,
      budget,
    );
    if (code !== null) {
      errors.push(`${p}: ${code}; a pack carries data only.`);
      continue;
    }
    if (inPrefix(p)) {
      if (p.endsWith(".remap") || p.endsWith(".import")) {
        const problem = remapProblem(
          bytes.subarray(e.offset, e.offset + e.size),
        );
        if (problem !== null) {
          errors.push(`${p}: ${problem}; a pack loads only its own files.`);
          continue;
        }
        const targets = remapTargets(
          text.decode(bytes.subarray(e.offset, e.offset + e.size)),
        );
        const source = p.slice(0, p.lastIndexOf("."));
        const script = targets.find((t) => isScript(t, kinds));
        if (isScript(source, kinds) || script !== undefined) {
          errors.push(
            `${p}: remaps a script${script ? ` (${script})` : ""}; a pack carries data only.`,
          );
          continue;
        }
        // Every value must be a normalised path of THIS pack: nothing in the base game, no
        // absolute path, nothing the engine would rewrite into another prefix.
        const outside = remapValues(
          text.decode(bytes.subarray(e.offset, e.offset + e.size)),
        ).find((v) => {
          if (v === "") return false;
          const t = resPath(v);
          return t === null || !pckPathOk(t) || !inPack.has(t);
        });
        if (outside !== undefined) {
          errors.push(
            `${p}: remaps a path outside the pack (${outside}); a pack loads only its own files.`,
          );
          continue;
        }
        for (const t of targets) named.add(t);
      }
      continue;
    }
    if (p.startsWith(".godot/exported/") || p.startsWith(".godot/imported/")) {
      deferred.push(p);
      continue;
    }
    errors.push(
      `${p}: outside the handler prefixes (${opts.prefixes.join(", ")}).`,
    );
  }
  for (const p of deferred)
    if (!named.has(p))
      errors.push(
        `${p}: no in-prefix .remap or .import names it, so nothing in the pack could load it.`,
      );
  return { errors, warnings };
}

// ── Code embedded in a resource ──────────────────────────────────────────────

/** The text-resource extensions the scan reads as text whatever the head says. */
const TEXT_RESOURCE_RE = /\.(tscn|tres|escn)$/i;
/** Godot's binary resource formats. */
const BINARY_RESOURCE_RE = /\.(scn|res)$/i;

/**
 * Why a resource entry carries code, or null when it carries none (P4-03 review; S-07 row 13: a
 * v1 pack is data-only, `contentPolicy.dataOnly` is `true` and `false` is refused, so this applies
 * to every pack). Hardened by the P4-08 audit into fail-closed CONTENT rules that do not depend on
 * how Godot's parsers read a file:
 *
 *  - an `RSCC` resource (FileAccessCompressed), whatever its name, is decompressed under the
 *    bounds in `rscc.ts` (zstd only, a capped total, every block exactly its declared size; any
 *    other shape refused, P4-27; `budget` is the pack's running count of declared bytes); its body is a binary resource without the `RSRC` magic (the
 *    saver writes the magic only uncompressed) and gets the same marker rule as an `RSRC` one;
 *  - an `RSRC` resource, whatever its name (Godot's binary loader takes `.res`, `.scn` and every
 *    resource type's own extension, `.material`, `.mesh`, `.anim`…), is refused when the raw UTF-8
 *    bytes of any script marker (`SCRIPT_MARKERS`) occur anywhere in it — without the u32 length
 *    prefix, since the engine's string reader stops at the first NUL (GAP 3);
 *  - a text resource (a `.tscn`, `.tres` or `.escn` name, or, as a defensive extra, any entry with
 *    a `[gd_scene` / `[gd_resource` head) is refused when it holds a NUL byte, is not valid UTF-8,
 *    names any script marker anywhere, or holds a `\u` / `\U` escape (GAP 1, GAP 6): Godot's
 *    VariantParser reads newlines as whitespace and fields as Variants (StringName `&"…"`,
 *    escapes, an inline `Object(GDScript, …)`), so no section regex is relied on;
 *  - a `.scn`/`.res`/exported file that is neither binary nor text is refused.
 *
 * Coincidental matches refuse a resource, never admit one. A reference to a script already in
 * the app (`[ext_resource type="Script" path="res://…gd"]`, or the binary external-resource table
 * typed `Script`) names no marker and passes in both formats: that is a residual, not code in the
 * pack (docs/security/THREAT-MODEL.md, "Pack bytes on the device"). Script files themselves are
 * refused by extension.
 */
export function embeddedCode(
  p: string,
  data: Uint8Array,
  markers: readonly string[] = SCRIPT_MARKERS,
  budget: RsccBudget = { used: 0 },
): string | null {
  const magic = Buffer.from(data.subarray(0, 4)).toString("latin1");
  if (magic === "RSCC") {
    // P4-27: bounded decompression (rscc.ts), then the RSRC rules on the body.
    const r = rsccBody(data, undefined, budget);
    if ("why" in r) return `a compressed binary resource (RSCC) ${r.why}`;
    if (!rsccBodyIsResource(r.body))
      return "a compressed binary resource (RSCC) whose body is not a binary resource";
    const m = marker(r.body, markers);
    return m === null
      ? null
      : `a compressed binary resource (RSCC) that names ${m} (an embedded script or its source)`;
  }
  if (magic === "RSRC") {
    const m = marker(data, markers);
    return m === null
      ? null
      : `a binary resource that names ${m} (an embedded script or its source)`;
  }
  if (sniffsTextResource(data) || TEXT_RESOURCE_RE.test(p))
    return textResourceCode(data, markers);
  if (BINARY_RESOURCE_RE.test(p) || p.startsWith(".godot/exported/"))
    return "not a Godot resource (no RSRC header), so it cannot be inspected for embedded scripts";
  return null;
}

/** A `[gd_scene` or `[gd_resource` head in the first 64 bytes (Latin-1, NUL read as a space). */
function sniffsTextResource(data: Uint8Array): boolean {
  // A leading UTF-8 byte-order mark is skipped first (P4-22 review): more scanning, fail-closed.
  const from =
    data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
      ? 3
      : 0;
  const head = Buffer.from(data.subarray(from, from + 64))
    .toString("latin1")
    .replace(/\0/g, " ");
  return /^[ \t\n\r\f\x0B]*\[gd_(scene|resource)\b/.test(head);
}

/** The first marker (list order) whose UTF-8 bytes occur anywhere in `data`, or null. */
function marker(data: Uint8Array, markers: readonly string[]): string | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (const m of markers)
    if (buf.indexOf(Buffer.from(m, "utf8")) !== -1) return m;
  return null;
}

function textResourceCode(
  data: Uint8Array,
  markers: readonly string[],
): string | null {
  if (data.includes(0))
    return "a text resource with a NUL byte, which cannot be inspected for embedded scripts";
  if (!utf8Valid(data))
    return "a text resource that is not valid UTF-8, which cannot be inspected for embedded scripts";
  const m = marker(data, markers);
  if (m !== null)
    return `a text resource that names ${m} (an embedded script or its source)`;
  // GAP A: the parser keeps the character after an unknown escape (`"GD\Script"` reads as
  // GDScript), so search again with every backslash removed. Fails closed.
  if (data.includes(0x5c)) {
    const bare = data.filter((b) => b !== 0x5c);
    const m2 = marker(bare, markers);
    if (m2 !== null)
      return `a text resource that names ${m2} behind escapes (an embedded script or its source)`;
  }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.indexOf("\\u") !== -1 || buf.indexOf("\\U") !== -1)
    return "a text resource with a \\u escape, which can spell a script type";
  return null;
}

/** A7 §3.3's path rules over a tree's paths, with the failing path. */
export function lintTreePaths(paths: readonly string[]): LintResult {
  const r = checkPaths(paths);
  return r.ok
    ? { errors: [], warnings: [] }
    : { errors: [`${r.path}: ${r.error}`], warnings: [] };
}
