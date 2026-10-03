/**
 * P4-28: what a `godot.pck` pack's resources may reference outside the pack, so a data pack
 * cannot attach a script the app ships (a debug or tool script, any class with `_init` or
 * `_ready` side effects) and configure it with exported property values of its choosing.
 *
 * The app lists what packs may attach (`deliverables.app.content.attachable` in `.pkey/release`,
 * `PKeyOptions.pack_attachable` on the device). An entry is a script path (`res://scripts/die.gd`),
 * a directory of scripts (`res://scripts/dice/`) or a UID (`uid://c3x…`). The default, an empty
 * list, attaches nothing: every reference to a script outside the pack is refused, and so is
 * every `uid://` reference the pack's own uid cache does not resolve.
 *
 * A reference is an external resource the engine loads for the resource that names it: a text
 * resource's `[ext_resource]` tag and a binary resource's external-resource table entry. Each
 * has a type, a path and optionally a UID, and the engine uses the UID when it resolves and the
 * path otherwise, so both are judged:
 *
 *  - the UID must be in the pack's own `.godot/uid_cache.bin` (which names only files of the
 *    pack) or on the list;
 *  - the path must be a normal `res://` path (the PCK path rules, already normal: no `.`, `..` or
 *    empty segment) or a `uid://`, never a `.remap` or `.import` file; a path in the pack (itself,
 *    or its `.remap` or `.import`) passes, because the pack's own entries are checked one by
 *    one; a path outside the pack that is a script (a script extension, or the type `Script` or
 *    a script class) must be on the list (exactly, or under a listed directory).
 *
 * Anything the check cannot read the way the engine would is refused rather than guessed
 * (Godot 4.4.1 and 4.7.2 `resource_format_text.cpp`, `resource_format_binary.cpp` and
 * `variant_parser.cpp`, read for this):
 *
 *  - text: every line that contains `ext_resource` must be exactly one strict tag,
 *    `[ext_resource key="plain literal" …]` with the keys `type`, `uid`, `path` and `id` (each at
 *    most once; `type`, `path` and `id` present), so no tag spans lines, hides behind a comment or
 *    a StringName, or repeats a key (the parser keeps the last); and the inline constructor
 *    `Resource("…")`, which loads any path or UID directly, is refused wherever it could parse
 *    (`Resource`, then whitespace or `;` comments, then `(`; not `ExtResource` or `SubResource`);
 *  - binary (`RSRC`, or an `RSCC` body): the header, string table, external and internal
 *    resource tables and every internal resource's properties are walked exactly as the loader
 *    reads them; a big-endian file, a format above 6, a string or count past the end, a
 *    sub-resource path that is not `local://` (the loader would reuse any cached resource of
 *    that path), the pre-4.0 inline external reference (`OBJECT_EXTERNAL_RESOURCE`, a path the
 *    loader loads directly) and an unknown value type are refused.
 *
 * Also refused (P4-28 audit): a resource that sets `resource_path` (a text resource naming it
 * anywhere, a binary property named so), which would enter the resource cache under an app path;
 * and binary internal-resource offsets that are not strictly ascending after the tables with each
 * walk ending by the next one (no byte walked twice).
 *
 * The Godot SDK's `PKeyPck` (`sdks/godot/addons/polaris_key/packs/pck.gd`) applies the same rules
 * with the same words; `godotFixtures.test.ts` pins both to one set of verdicts. The device adds
 * two lookups the CLI cannot make: an app resource's real type (a GDScript saved as `.tres` is a
 * script whatever the reference's `type` hint) and an app UID's path (`ResourceUID`), so the
 * device admits a non-script app resource reached by UID that this lint refuses unlisted.
 */

import { pckPathOk } from "./pck.js";

/** What the app lets a pack attach, parsed. */
export interface Attachable {
  /** Exact `res://` script paths. */
  paths: ReadonlySet<string>;
  /** `res://…/` directories: any script under one. */
  dirs: readonly string[];
  /** UIDs, as ids. */
  uids: ReadonlySet<bigint>;
}

export const NOTHING_ATTACHABLE: Attachable = {
  paths: new Set(),
  dirs: [],
  uids: new Set(),
};

/** Godot's UID alphabet (`ResourceUID::uuid_characters`): `a`–`y` then `0`–`8`, base 34. */
const UID_CHARS = "abcdefghijklmnopqrstuvwxy012345678";
const UID_MAX = 0x7fffffffffffffffn;

/** `ResourceUID::id_to_text`. */
export function uidText(id: bigint): string {
  if (id < 0n) return "uid://<invalid>";
  let out = "";
  let v = id;
  do {
    out = UID_CHARS[Number(v % 34n)]! + out;
    v /= 34n;
  } while (v > 0n);
  return `uid://${out}`;
}

/**
 * The id of a `uid://` text in its canonical form only (`uidText(id) === text`: 1–13 characters
 * of the alphabet, no leading `a` but for `uid://a`, at most 2^63 − 1); null otherwise. The engine
 * folds other spellings (`z`, `9`, overflow) onto ids, so they are refused as ambiguous.
 */
export function canonicalUid(text: string): bigint | null {
  if (!text.startsWith("uid://")) return null;
  const s = text.slice(6);
  if (s.length < 1 || s.length > 13) return null;
  let v = 0n;
  for (const ch of s) {
    const d = UID_CHARS.indexOf(ch);
    if (d < 0 || ch.length !== 1) return null;
    if (v > (UID_MAX - BigInt(d)) / 34n) return null;
    v = v * 34n + BigInt(d);
  }
  return uidText(v) === text ? v : null;
}

/** Why one attachable entry is malformed, or null. */
export function attachableEntryProblem(s: string): string | null {
  if (s.startsWith("uid://"))
    return canonicalUid(s) === null ? "not a canonical uid://" : null;
  if (!s.startsWith("res://")) return "neither res:// nor uid://";
  const rest = s.slice(6);
  const path = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  return pckPathOk(path) ? null : "not a normal res:// path";
}

/** Parse an attachable list; throws on a malformed entry (a configuration error, loudly). */
export function parseAttachable(list: readonly string[] = []): Attachable {
  const paths = new Set<string>();
  const dirs: string[] = [];
  const uids = new Set<bigint>();
  for (const s of list) {
    const why = attachableEntryProblem(s);
    if (why !== null)
      throw new Error(
        `attachable entry ${JSON.stringify(s)} is ${why}: an entry is a res:// script path, a res://…/ directory or a canonical uid://.`,
      );
    if (s.startsWith("uid://")) uids.add(canonicalUid(s)!);
    else if (s.endsWith("/")) dirs.push(s);
    else paths.add(s);
  }
  return { paths, dirs, uids };
}

/** One external reference: its declared type (null when none), path and UID. */
export interface ResourceRef {
  type: string | null;
  path: string;
  /** A text UID (as written), a binary id, or null when the reference has none. */
  uid: string | bigint | null;
}

export interface RefContext {
  /** Every entry path of the pack (no `res://`). */
  inPack: ReadonlySet<string>;
  /** The ids the pack's own uid cache registers. */
  packUids: ReadonlySet<bigint>;
  attachable: Attachable;
  /** Whether an index path names a script (the lint's script extensions). */
  isScript: (path: string) => boolean;
  /** The script type names (`Script` is always one). */
  scriptTypes: readonly string[];
}

const AMBIGUOUS = ", so the device cannot tell what it loads";

/**
 * Why a resource that sets `resource_path` is refused (P4-28 audit GAP A): `Resource.set_path`
 * registers a sub-resource in the resource cache under that path when nothing is cached there yet
 * (the loader re-paths only the main resource), so a later `load()` of an app path returns the
 * pack's object. The engine never stores the property (editor usage only).
 */
export const RESOURCE_PATH_WHY =
  "sets resource_path, which can put it in the resource cache under an app path";
const RESOURCE_PATH = Buffer.from("resource_path");

function uidProblem(u: bigint | null, raw: string, ctx: RefContext) {
  if (u === null || u < 0n)
    return `references ${raw}, which is not a canonical uid://${AMBIGUOUS}`;
  if (ctx.packUids.has(u) || ctx.attachable.uids.has(u)) return null;
  return `references ${uidText(u)}, outside the pack's uid cache, which the app does not list as attachable`;
}

/** Why one reference is refused, or null (the UID first, then the path). */
export function refProblem(ref: ResourceRef, ctx: RefContext): string | null {
  // A binary entry without a UID stores -1 (`ResourceUID::INVALID_ID`).
  if (typeof ref.uid === "string") {
    const why = uidProblem(canonicalUid(ref.uid), ref.uid, ctx);
    if (why !== null) return why;
  } else if (ref.uid !== null && ref.uid !== -1n) {
    const why = uidProblem(ref.uid, uidText(ref.uid), ctx);
    if (why !== null) return why;
  }
  const p = ref.path;
  if (p.startsWith("uid://")) return uidProblem(canonicalUid(p), p, ctx);
  if (!p.startsWith("res://") || !pckPathOk(p.slice(6)))
    return `references ${p}, which is not a normal res:// path or uid://${AMBIGUOUS}`;
  const rest = p.slice(6);
  if (rest.endsWith(".remap") || rest.endsWith(".import"))
    return `references ${p}, a .remap or .import file${AMBIGUOUS}`;
  if (
    ctx.inPack.has(rest) ||
    ctx.inPack.has(`${rest}.remap`) ||
    ctx.inPack.has(`${rest}.import`)
  )
    return null;
  const script =
    ctx.isScript(rest) ||
    (ref.type !== null &&
      (ref.type === "Script" || ctx.scriptTypes.includes(ref.type)));
  if (!script) return null;
  if (
    ctx.attachable.paths.has(p) ||
    ctx.attachable.dirs.some((d) => p.startsWith(d))
  )
    return null;
  return `references the app script ${p}, which the app does not list as attachable`;
}

// ── Text resources ───────────────────────────────────────────────────────────

const EXT_LINE_RE = /^[ \t]*\[ext_resource((?: [a-z_]+="[^"\\]*")+)\][ \t]*$/;
const EXT_ATTR_RE = / ([a-z_]+)="([^"\\]*)"/g;
const EXT_KEYS = ["type", "uid", "path", "id"];

/**
 * A text resource's references, or why it is refused. `text` is valid UTF-8 without NUL (the
 * embedded-code rule ran first).
 */
export function textRefs(
  text: string,
): { refs: ResourceRef[] } | { why: string } {
  const t = text.replace(/\r/g, "\n");
  // GAP A: the property name anywhere, as written or behind escapes (fails closed).
  if (
    t.includes("resource_path") ||
    t.replace(/\\/g, "").includes("resource_path")
  )
    return { why: RESOURCE_PATH_WHY };
  const lines = t.split("\n");
  const refs: ResourceRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.includes("ext_resource")) continue;
    const bad = {
      why: `has an ext_resource tag on line ${i + 1} the engine could read differently${AMBIGUOUS}`,
    };
    const m = EXT_LINE_RE.exec(l);
    if (!m) return bad;
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(EXT_ATTR_RE)) {
      if (!EXT_KEYS.includes(a[1]!) || attrs.has(a[1]!)) return bad;
      attrs.set(a[1]!, a[2]!);
    }
    if (!attrs.has("type") || !attrs.has("path") || !attrs.has("id"))
      return bad;
    refs.push({
      type: attrs.get("type")!,
      path: attrs.get("path")!,
      uid: attrs.get("uid") ?? null,
    });
  }
  // `Resource(…)`: the identifier, then whitespace (≤ 0x20) or `;` comments, then `(`.
  let at = t.indexOf("Resource");
  while (at !== -1) {
    const before = t.slice(Math.max(0, at - 3), at);
    if (before !== "Ext" && before !== "Sub") {
      let j = at + 8;
      for (;;) {
        while (j < t.length && t.charCodeAt(j) <= 0x20) j++;
        if (t[j] === ";") {
          while (j < t.length && t[j] !== "\n") j++;
          continue;
        }
        break;
      }
      if (t[j] === "(")
        return {
          why: `loads a resource by path inline (Resource(...))${AMBIGUOUS}`,
        };
    }
    at = t.indexOf("Resource", at + 1);
  }
  return { refs };
}

// ── Binary resources ─────────────────────────────────────────────────────────

/** `ResourceFormatSaverBinary::FORMAT_VERSION` in 4.4.1 and 4.7.2. */
export const BINARY_FORMAT_MAX = 6;
const FLAG_UIDS = 2;
const FLAG_REAL64 = 4;
const FLAG_SCRIPT_CLASS = 8;
const RESERVED_FIELDS = 11;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

class Stop {
  constructor(readonly why: string) {}
}

/**
 * A binary resource's references, or why it is refused. `b` is the whole stream the loader reads
 * (an `RSRC` file, or an `RSCC` body), `start` where its header words begin (4 after `RSRC`, 0 in
 * a body); internal resource offsets are stream positions.
 */
export function binaryRefs(
  b: Uint8Array,
  start: number,
): { refs: ResourceRef[] } | { why: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pos = start;
  let part = "header";
  // Reads stop here: the stream's end, then (GAP B) each internal resource's successor.
  let limit = b.byteLength;
  const fail = () =>
    new Stop(`is a binary resource whose ${part} cannot be read${AMBIGUOUS}`);
  const need = (n: number) => {
    if (n < 0 || pos + n > limit) throw fail();
  };
  const u32 = () => {
    need(4);
    const v = dv.getUint32(pos, true);
    pos += 4;
    return v;
  };
  const skip = (n: number) => {
    need(n);
    pos += n;
  };
  const str = () => {
    const n = u32();
    need(n);
    const s = b.subarray(pos, pos + n);
    pos += n;
    return s;
  };
  /** A string as the loader decodes it: up to the first NUL, valid UTF-8 without a BOM, or refused. */
  const text = (s: Uint8Array) => {
    const z = s.indexOf(0);
    const cut = z === -1 ? s : s.subarray(0, z);
    // The engine drops a leading byte-order mark; one anywhere is refused rather than matched.
    if (Buffer.from(cut).indexOf(BOM) !== -1) throw fail();
    try {
      return dec.decode(cut);
    } catch {
      throw fail();
    }
  };
  try {
    if (u32() !== 0)
      return { why: `is a big-endian binary resource${AMBIGUOUS}` };
    u32(); // real64 (unused by the loader)
    u32(); // major
    u32(); // minor
    const format = u32();
    if (format > BINARY_FORMAT_MAX)
      return {
        why: `is a binary resource in format ${format}, above ${BINARY_FORMAT_MAX}${AMBIGUOUS}`,
      };
    str(); // type
    skip(8); // import metadata offset
    const flags = u32();
    skip(8); // uid
    if (flags & FLAG_SCRIPT_CLASS) str();
    skip(4 * RESERVED_FIELDS);
    part = "reference tables";
    const nstr = u32();
    // GAP A: the string-table entries that name `resource_path` (a property may use one).
    const rpNames = new Set<number>();
    for (let i = 0; i < nstr; i++) if (isResourcePath(str())) rpNames.add(i);
    const refs: ResourceRef[] = [];
    const next = u32();
    for (let i = 0; i < next; i++) {
      const type = text(str());
      const path = text(str());
      let uid: bigint | null = null;
      if (flags & FLAG_UIDS) {
        need(8);
        uid = dv.getBigInt64(pos, true);
        pos += 8;
      }
      refs.push({ type, path, uid });
    }
    const nint = u32();
    const offsets: number[] = [];
    let tableEnd = 0;
    for (let i = 0; i < nint; i++) {
      const path = text(str());
      need(8);
      const lo = dv.getUint32(pos, true);
      const hi = dv.getUint32(pos + 4, true);
      pos += 8;
      if (i < nint - 1 && !path.startsWith("local://"))
        return {
          why: `has a sub-resource path that is not local:// (${path})${AMBIGUOUS}`,
        };
      offsets.push(hi > 0x1fffff ? -1 : hi * 4294967296 + lo);
    }
    tableEnd = pos;
    part = "properties";
    const real = flags & FLAG_REAL64 ? 8 : 4;
    /** A string id: a table index, or (bit 31) an inline string; `prop`: a property's name. */
    const name = (prop: boolean) => {
      const id = u32();
      if (id & 0x80000000) {
        const n = id & 0x7fffffff;
        need(n);
        const inline = b.subarray(pos, pos + n);
        pos += n;
        if (prop && isResourcePath(inline)) throw new Stop(RESOURCE_PATH_WHY);
      } else if (id >= nstr) throw fail();
      else if (prop && rpNames.has(id)) throw new Stop(RESOURCE_PATH_WHY);
    };
    // GAP B: the saver writes the internal resources in order after the tables, so each offset
    // must follow the tables and its predecessor, and each walk end by its successor's offset:
    // no byte is walked twice. The walked total is held to the stream length as a backstop.
    let walked = 0;
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!;
      const prev = i === 0 ? tableEnd - 1 : offsets[i - 1]!;
      if (off < 0 || off <= prev || off > b.byteLength) throw fail();
      limit =
        i + 1 < offsets.length
          ? Math.max(off, Math.min(offsets[i + 1]!, b.byteLength))
          : b.byteLength;
      pos = off;
      str(); // the class
      const pc = u32();
      for (let j = 0; j < pc; j++) {
        name(true);
        let pending = 1;
        while (pending > 0) {
          pending--;
          const tag = u32();
          switch (tag) {
            case 1: // NIL
            case 42: // CALLABLE
            case 43: // SIGNAL
              break;
            case 2: // BOOL
            case 3: // INT
            case 23: // RID
              skip(4);
              break;
            case 40: // INT64
            case 41: // DOUBLE
              skip(8);
              break;
            case 4: // FLOAT
              skip(real);
              break;
            case 5: // STRING
            case 44: // STRING_NAME
              str();
              break;
            case 10: // VECTOR2
              skip(2 * real);
              break;
            case 45: // VECTOR2I
              skip(8);
              break;
            case 11: // RECT2
            case 50: // VECTOR4
            case 13: // PLANE
            case 14: // QUATERNION
              skip(4 * real);
              break;
            case 46: // RECT2I
            case 51: // VECTOR4I
            case 20: // COLOR (always single precision)
              skip(16);
              break;
            case 12: // VECTOR3
              skip(3 * real);
              break;
            case 47: // VECTOR3I
              skip(12);
              break;
            case 15: // AABB
            case 18: // TRANSFORM2D
              skip(6 * real);
              break;
            case 16: // BASIS
              skip(9 * real);
              break;
            case 17: // TRANSFORM3D
              skip(12 * real);
              break;
            case 52: // PROJECTION
              skip(16 * real);
              break;
            case 22: {
              // NODE_PATH: u16 names, u16 subnames (bit 15: absolute), then each a string id.
              need(4);
              const names = dv.getUint16(pos, true);
              let subs = dv.getUint16(pos + 2, true) & 0x7fff;
              pos += 4;
              if (format < 3) subs += 1;
              for (let k = 0; k < names + subs; k++) name(false);
              break;
            }
            case 24: {
              // OBJECT: empty, inline external (pre-4.0), internal index, external index.
              const kind = u32();
              if (kind === 1)
                return {
                  why: `has an inline external reference (the pre-4.0 binary form)${AMBIGUOUS}`,
                };
              if (kind === 2 || kind === 3) skip(4);
              else if (kind !== 0) throw fail();
              break;
            }
            case 26: // DICTIONARY (bit 31: shared)
              pending += 2 * (u32() & 0x7fffffff);
              break;
            case 30: // ARRAY (bit 31: shared)
              pending += u32() & 0x7fffffff;
              break;
            case 31: {
              // PACKED_BYTE_ARRAY, padded to 4
              const n = u32();
              skip(n + ((4 - (n % 4)) % 4));
              break;
            }
            case 32: // PACKED_INT32_ARRAY
            case 33: // PACKED_FLOAT32_ARRAY
              skip(u32() * 4);
              break;
            case 48: // PACKED_INT64_ARRAY
            case 49: // PACKED_FLOAT64_ARRAY
              skip(u32() * 8);
              break;
            case 34: {
              // PACKED_STRING_ARRAY
              const n = u32();
              for (let k = 0; k < n; k++) str();
              break;
            }
            case 37: // PACKED_VECTOR2_ARRAY
              skip(u32() * 2 * real);
              break;
            case 35: // PACKED_VECTOR3_ARRAY
              skip(u32() * 3 * real);
              break;
            case 36: // PACKED_COLOR_ARRAY (always single precision)
              skip(u32() * 16);
              break;
            case 53: // PACKED_VECTOR4_ARRAY
              skip(u32() * 4 * real);
              break;
            default:
              return {
                why: `has a value of unknown type ${tag}${AMBIGUOUS}`,
              };
          }
        }
      }
      walked += pos - off;
      if (walked > b.byteLength) throw fail();
    }
    return { refs };
  } catch (e) {
    if (e instanceof Stop) return { why: e.why };
    throw e;
  }
}

/**
 * Whether string bytes decode to `resource_path` as the loader reads them: up to the first NUL,
 * a leading byte-order mark dropped.
 */
function isResourcePath(s: Uint8Array): boolean {
  const z = s.indexOf(0);
  let cut = z === -1 ? s : s.subarray(0, z);
  if (cut.length >= 3 && cut[0] === 0xef && cut[1] === 0xbb && cut[2] === 0xbf)
    cut = cut.subarray(3);
  return Buffer.from(cut).equals(RESOURCE_PATH);
}

/** The ids a uid cache registers (u32 count; per entry i64 id, u32 length, path); [] if malformed. */
export function uidCacheIds(data: Uint8Array): bigint[] {
  if (data.byteLength < 4) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getUint32(0, true);
  const out: bigint[] = [];
  let p = 4;
  for (let i = 0; i < n; i++) {
    if (p + 12 > data.byteLength) return [];
    const ln = dv.getUint32(p + 8, true);
    if (p + 12 + ln > data.byteLength) return [];
    out.push(dv.getBigInt64(p, true));
    p += 12 + ln;
  }
  return out;
}
