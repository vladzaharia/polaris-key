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
 *      mounts it with `replace_files=true`.
 *
 * Every admitted resource must also carry no code (`embeddedCode`): a text resource with an
 * embedded GDScript sub-resource or `script/source`, or a binary resource holding one, fails with
 * its path (a v1 pack is data-only: S-07 row 13, plans/P4-01.md §3 `contentPolicy`).
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
import { PCK_STRIP_PATHS, type PckDirectory } from "./pck.js";

/** Above this many entries the lint warns (S-05 §4.1: the mount stall grows with the count). */
export const PCK_WARN_ENTRIES = 1000;
/** Above this many entries the lint fails. */
export const PCK_MAX_ENTRIES = 20000;

export interface LintResult {
  errors: string[];
  warnings: string[];
}

const SCRIPT_RE = /\.(gd|gdc|cs)$/i;
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
  for (const m of text.matchAll(
    /^\s*path(?:\.[A-Za-z0-9_-]+)?\s*=\s*"([^"]*)"/gm,
  )) {
    const p = resPath(m[1]!);
    if (p !== null) out.add(p);
  }
  for (const m of text.matchAll(/^\s*dest_files\s*=\s*\[([^\]]*)\]/gm))
    for (const s of m[1]!.matchAll(/"([^"]*)"/g)) {
      const p = resPath(s[1]!);
      if (p !== null) out.add(p);
    }
  return [...out];
}

export interface PckLintOptions {
  /** The deliverable's `handler.prefixes` (`res://…/`). */
  prefixes: readonly string[];
  /** The deliverable's `requires.engine` (`godot-<major>.<minor>`). */
  engine?: string;
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
    .filter((p): p is string => p !== null);
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
  for (const e of dir.entries) {
    const p = e.path;
    if (stripped.has(p)) {
      errors.push(`${p}: --export-pack's ${p} replaces the main pack's copy.`);
      continue;
    }
    if (SCRIPT_RE.test(p)) {
      errors.push(`${p}: a script; a pack carries data only (S-07 row 13).`);
      continue;
    }
    if (isNative(p)) {
      errors.push(
        `${p}: a native library or GDExtension; a pack carries data only.`,
      );
      continue;
    }
    if (p === ".godot/uid_cache.bin") continue;
    const code = embeddedCode(p, bytes.subarray(e.offset, e.offset + e.size));
    if (code !== null) {
      errors.push(`${p}: ${code}; a pack carries data only.`);
      continue;
    }
    if (inPrefix(p)) {
      if (p.endsWith(".remap") || p.endsWith(".import")) {
        const targets = remapTargets(
          text.decode(bytes.subarray(e.offset, e.offset + e.size)),
        );
        const source = p.slice(0, p.lastIndexOf("."));
        const script = targets.find((t) => SCRIPT_RE.test(t));
        if (SCRIPT_RE.test(source) || script !== undefined) {
          errors.push(
            `${p}: remaps a script${script ? ` (${script})` : ""}; a pack carries data only.`,
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

/** Godot's text resource formats: a script can sit inside one as a sub-resource. */
const TEXT_RESOURCE_RE = /\.(tscn|tres|escn)$/i;
/** Godot's binary resource formats. */
const BINARY_RESOURCE_RE = /\.(scn|res)$/i;
/** The Script types whose instances carry code (GDScript source, C# by reference). */
const SCRIPT_TYPES = ["GDScript", "CSharpScript"] as const;

/**
 * Why a resource entry carries code, or null when it carries none (P4-03 review; S-07 row 13: a
 * v1 pack is data-only, `contentPolicy.dataOnly` is `true` and `false` is refused, so this applies
 * to every pack):
 *
 *  - a TEXT resource (`.tscn`, `.tres`, `.escn`) with a section header naming a Script type
 *    (`[sub_resource type="GDScript" …]`, a `[gd_resource type="GDScript" …]`) or a
 *    `script/source` property;
 *  - a BINARY resource (`.scn`, `.res`, or anything under `.godot/exported/`): Godot's
 *    `ResourceFormatSaverBinary` writes every string — each internal resource's type and each
 *    property name of the string table — as a u32 length (the UTF-8 bytes plus a NUL) followed by
 *    the bytes and the NUL, little-endian unless the header's big-endian flag is set. An embedded
 *    script is an internal resource of type `GDScript` (or `CSharpScript`) whose source is the
 *    `script/source` property, so its file must contain one of those length-prefixed strings; the
 *    scan looks for each in both byte orders. This fails closed: a coincidental match refuses a
 *    resource, never admits one. A compressed binary resource (`RSCC`, FileAccessCompressed)
 *    cannot be inspected and is refused, as is a `.scn`/`.res`/exported file that is neither a
 *    binary nor a text resource. The binary scan cannot tell an internal script from an EXTERNAL
 *    reference to one (the external-resource table stores the referenced resource's type string
 *    too), so a binary scene that references an app script is refused as well: it fails closed.
 *    Export such scenes as text (the export preset's "convert text resources to binary" off),
 *    where `[ext_resource type="Script" …]` — code already in the app, not in the pack — passes.
 *    Script files themselves are refused by extension.
 *
 * The scan is chosen by the content's head before the extension (P4-22): any entry starting
 * `RSRC` gets the binary scan, any starting `RSCC` is refused, and any whose head is a text
 * resource header (`[gd_scene`, `[gd_resource`) gets the text scan, whatever its name. The
 * extensions above only ADD scans (a `.tscn` without a header is still scanned as text, and a
 * `.scn`, `.res` or exported file that is neither is refused).
 */
export function embeddedCode(p: string, data: Uint8Array): string | null {
  // What to scan is chosen by the content's head first, never by the extension alone (P4-22):
  // a resource under any name — a `.png` holding `RSRC` bytes, say — gets the scan its
  // content calls for, so renaming a file cannot carry an embedded script past the lint.
  const magic = Buffer.from(data.subarray(0, 4)).toString("latin1");
  if (magic === "RSCC")
    return "a compressed binary resource (RSCC), which cannot be inspected for embedded scripts; export it uncompressed";
  if (magic !== "RSRC") {
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(data.subarray(0, 64))
      .replace(/^\uFEFF/, "");
    if (/^\s*\[gd_(scene|resource)\b/.test(head) || TEXT_RESOURCE_RE.test(p))
      return textResourceCode(data);
    if (BINARY_RESOURCE_RE.test(p) || p.startsWith(".godot/exported/"))
      return "not a Godot resource (no RSRC header), so it cannot be inspected for embedded scripts";
    return null;
  }
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (const s of [...SCRIPT_TYPES, "script/source"]) {
    const str = Buffer.from(`${s}\0`, "utf8");
    for (const le of [true, false]) {
      const len = Buffer.alloc(4);
      if (le) len.writeUInt32LE(str.length);
      else len.writeUInt32BE(str.length);
      if (buf.indexOf(Buffer.concat([len, str])) !== -1)
        return s === "script/source"
          ? "a binary resource with an embedded script's source (script/source)"
          : `a binary resource with an embedded ${s} sub-resource`;
    }
  }
  return null;
}

function textResourceCode(data: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  for (const m of text.matchAll(/^\s*\[([a-z_]+)\b[^\]\n]*\]/gm)) {
    const t = /\btype\s*=\s*"([^"]*)"/.exec(m[0]);
    if (t && (SCRIPT_TYPES as readonly string[]).includes(t[1]!))
      return `an embedded script ([${m[1]} type="${t[1]}"])`;
  }
  if (/^\s*script\/source\s*=/m.test(text))
    return "an embedded script's source (script/source)";
  return null;
}

/** A7 §3.3's path rules over a tree's paths, with the failing path. */
export function lintTreePaths(paths: readonly string[]): LintResult {
  const r = checkPaths(paths);
  return r.ok
    ? { errors: [], warnings: [] }
    : { errors: [`${r.path}: ${r.error}`], warnings: [] };
}
