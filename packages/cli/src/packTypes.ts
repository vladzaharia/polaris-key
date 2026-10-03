/**
 * The publish lints of the v3 pack types (P4-16; CONTENT §4.2), run by `pkey release publish`
 * before anything is signed, with the device's own functions wherever the device has one, so the
 * CLI refuses exactly what a device would:
 *
 *   - `data.json`: every file strict JSON with an object at the top (client-core
 *     `DataJsonHandler`), whatever its name; the declaration states `formatVersion` (the
 *     manifest validator).
 *   - `l10n.table`: every file a PO, CSV or JSON table the plain parsers read, each table's locale
 *     a well-formed BCP-47 tag and the variant's `locale` (client-core `L10nTableHandler`).
 *   - `ml.model`: a `model.json` declaring the runtime and memory needs, naming a file of the
 *     payload (client-core `readModelDescriptor`).
 *   - `audio.bank`: a `bank.json` declaring the middleware and its version, its `banks` naming
 *     files of the payload (the Godot handler's rule; no other SDK holds the type).
 *   - `custom.<name>`: nothing beyond the path rules every tree passes.
 *   - `godot.zip`: one zip of stored entries, read strictly ({@link readGodotZip}), then the
 *     `godot.pck` admission list and data-only scans over its entries (`lintPck`).
 *
 * Content is judged by bytes, never by name, and nothing is evaluated.
 */

import {
  DataJsonHandler,
  L10nTableHandler,
  memorySource,
  readModelDescriptor,
  strictParse,
  type InstalledFile,
  type StagedPack,
} from "@polaris-key/client-core/packs";
import type { PayloadFile } from "./packArtifacts.js";
import { PckError, pckPathOk, type PckDirectory } from "./pck.js";
import type { LintResult } from "./packLint.js";
import { crc32 } from "./zip.js";

/** `bank.json`'s `version`: `major.minor[.patch]`, decimal. */
export const BANK_VERSION_PATTERN = /^[0-9]{1,9}\.[0-9]{1,9}(\.[0-9]{1,9})?$/;
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DESCRIPTOR_BYTES = 65536;

function installed(files: readonly PayloadFile[]): InstalledFile[] {
  return files.map((f) => ({
    path: f.path,
    size: f.size,
    sha256: f.sha256,
    source: memorySource(f.data),
  }));
}

function staged(
  files: readonly PayloadFile[],
  variant: Record<string, string>,
): StagedPack {
  return {
    packId: "",
    record: {} as StagedPack["record"],
    variant: { variant } as StagedPack["variant"],
    location: "",
    files: installed(files),
    payload: null,
  };
}

const DETAIL_TEXT: Record<string, string> = {
  json: "not strict JSON with an object at the top (UTF-8 without a BOM, no duplicate member, trailing comma, comment, NaN or second value)",
  table:
    "not a table the device's plain parsers read (a PO file with a Language header, a CSV file with a key column and locale columns, or a JSON object with locale and messages)",
  locale:
    "a table whose locale is not a well-formed BCP-47 tag, or not the variant's locale",
  size: "above the 16 MiB a device parses",
};

/** The type lint of one tree variant. `variant` is the variant's axes. */
export async function lintTypeTree(
  type: string,
  files: readonly PayloadFile[],
  variant: Record<string, string>,
): Promise<LintResult> {
  const errors: string[] = [];
  if (type === "data.json" || type === "l10n.table") {
    const h =
      type === "data.json" ? new DataJsonHandler() : new L10nTableHandler();
    const r = await h.check(staged(files, variant));
    if (r !== null)
      errors.push(
        `${r.path ?? ""}: ${type} ${DETAIL_TEXT[r.detail] ?? r.detail}${r.message ? ` (${r.message})` : ""}.`,
      );
  } else if (type === "ml.model") {
    const d = await readModelDescriptor(installed(files));
    if (!d.ok)
      errors.push(
        'model.json: an ml.model pack carries a model.json at its root, strict JSON declaring runtime (a lowercase token such as "onnx" or "gguf"), file (exactly a path of the payload) and memBytes (the RAM it needs, a non-negative integer), with optional vramBytes and quantization.',
      );
  } else if (type === "audio.bank") {
    const why = bankDescriptorProblem(files);
    if (why !== null) errors.push(`bank.json: ${why}`);
  }
  return { errors, warnings: [] };
}

/** Why an `audio.bank` payload's `bank.json` is unusable, or null. */
export function bankDescriptorProblem(
  files: readonly PayloadFile[],
): string | null {
  const shape =
    'an audio.bank pack carries a bank.json at its root, strict JSON declaring middleware (a lowercase token such as "fmod" or "wwise"), version ("major.minor" or "major.minor.patch") and optionally banks (the bank files in load order, each exactly a path of the payload)';
  const d = files.find((f) => f.path === "bank.json");
  if (!d || d.size > MAX_DESCRIPTOR_BYTES) return `${shape}.`;
  const parsed = strictParse(d.data);
  const o = parsed?.value;
  if (typeof o !== "object" || o === null || Array.isArray(o))
    return `${shape}.`;
  const m = o as Record<string, unknown>;
  if (typeof m.middleware !== "string" || !TOKEN.test(m.middleware))
    return `${shape}: middleware is missing or not a token.`;
  if (typeof m.version !== "string" || !BANK_VERSION_PATTERN.test(m.version))
    return `${shape}: version is missing or not major.minor[.patch].`;
  if (m.banks !== undefined) {
    const paths = new Set(files.map((f) => f.path));
    if (
      !Array.isArray(m.banks) ||
      m.banks.length === 0 ||
      new Set(m.banks).size !== m.banks.length ||
      !m.banks.every(
        (b) => typeof b === "string" && b !== "bank.json" && paths.has(b),
      )
    )
      return `${shape}: banks names a file the payload does not hold, twice, or bank.json itself.`;
  }
  return null;
}

// ── godot.zip ────────────────────────────────────────────────────────────────────────────

const LFH = 0x04034b50;
const CDH = 0x02014b50;
const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/**
 * A `godot.zip` payload's entries as a PCK-shaped directory, for `lintPck` and the container
 * files index, read strictly from the bytes (the Godot SDK's device check reads the same way):
 *
 *   - the file starts with a local file header at offset 0 and ends exactly at the end of the
 *     end-of-central-directory record (no comment), with the central directory right before it.
 *     Godot tries its PCK reader on every pack whatever the extension, and that reader accepts
 *     a `GDPC` magic at the start or the end: neither can occur in such a zip;
 *   - no ZIP64, no encryption, no data descriptor, no multi-disk archive;
 *   - every file entry STORED (method 0, compressed size = size, CRC-32 matching), its local
 *     header agreeing with its central entry, the data of no two entries overlapping;
 *   - directory entries (a name ending `/`, size 0) are skipped; every other name is a normal
 *     path (`pckPathOk`), listed once.
 *
 * Zips cannot express removals, ignore `replace_files` and cannot be mounted at an offset, so a
 * `godot.pck` is preferred; this is for a third party that requires a zip.
 */
export function readGodotZip(b: Uint8Array, name = "the zip"): PckDirectory {
  const fail = (why: string): never => {
    throw new PckError(`${name}: ${why}`);
  };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (at: number) => dv.getUint16(at, true);
  const u32 = (at: number) => dv.getUint32(at, true);
  if (b.byteLength < 22 + 30) fail("too short to be a zip with an entry.");
  if (u32(0) !== LFH)
    fail(
      "does not start with a local file header: a godot.zip holds nothing before its first entry.",
    );
  const e = b.byteLength - 22;
  if (u32(e) !== EOCD)
    fail(
      "does not end with an end-of-central-directory record without a comment: a godot.zip carries no comment or trailing bytes.",
    );
  if (e >= 20 && u32(e - 20) === ZIP64_LOCATOR)
    fail("is a ZIP64 archive; a godot.zip is a plain zip under 4 GiB.");
  const disk = u16(e + 4);
  const cdDisk = u16(e + 6);
  const onDisk = u16(e + 8);
  const count = u16(e + 10);
  const cdSize = u32(e + 12);
  const cdOffset = u32(e + 16);
  if (u16(e + 20) !== 0) fail("has an archive comment.");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count)
    fail("spans several disks.");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    fail("uses ZIP64 fields.");
  if (count === 0) fail("has no entries.");
  if (cdOffset + cdSize !== e)
    fail(
      "has bytes between its central directory and its end record, or a central directory that does not fit.",
    );
  const entries: PckDirectory["entries"] = [];
  const seen = new Set<string>();
  const ranges: [number, number][] = [];
  const text = new TextDecoder("utf-8", { fatal: true });
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > e || u32(p) !== CDH)
      fail(`central directory entry ${i} is malformed.`);
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const startDisk = u16(p + 34);
    const local = u32(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > e) fail(`central directory entry ${i} runs past the directory.`);
    let entryName: string;
    try {
      entryName = text.decode(b.subarray(p + 46, p + 46 + nameLen));
    } catch {
      return fail(`central directory entry ${i}'s name is not UTF-8.`);
    }
    const label = entryName || `entry ${i}`;
    if (flags & 0x41) fail(`${label}: an encrypted entry.`);
    if (flags & 0x08)
      fail(`${label}: written with a data descriptor; store it without one.`);
    if (csize === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
      fail(`${label}: ZIP64 fields.`);
    if (startDisk !== 0) fail(`${label}: on another disk.`);
    // The local header agrees with the central entry.
    if (local + 30 > cdOffset || u32(local) !== LFH)
      fail(`${label}: its local header is missing.`);
    const lNameLen = u16(local + 26);
    const lExtraLen = u16(local + 28);
    const data = local + 30 + lNameLen + lExtraLen;
    if (
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u32(local + 14) !== crc ||
      u32(local + 18) !== csize ||
      u32(local + 22) !== size ||
      lNameLen !== nameLen ||
      !b
        .subarray(local + 30, local + 30 + nameLen)
        .every((x, k) => x === b[p + 46 + k])
    )
      fail(`${label}: its local header disagrees with its central entry.`);
    if (data + csize > cdOffset)
      fail(`${label}: its data runs into the central directory.`);
    ranges.push([local, data + csize]);
    p = end;
    if (entryName.endsWith("/")) {
      if (size !== 0 || csize !== 0 || method !== 0)
        fail(`${label}: a directory entry with data.`);
      continue;
    }
    if (method !== 0 || csize !== size)
      fail(
        `${label}: a compressed entry (method ${method}); a godot.zip stores every entry (zip -0), and the wire compresses.`,
      );
    if (!pckPathOk(entryName))
      fail(
        `${label}: not a normal path (no leading /, no ., .. or empty segment); the engine would mount it elsewhere.`,
      );
    if (seen.has(entryName)) fail(`${label}: listed twice.`);
    seen.add(entryName);
    if (crc32(b.subarray(data, data + size)) !== crc)
      fail(`${label}: its CRC-32 does not match its data.`);
    entries.push({
      rawPath: entryName,
      path: entryName,
      offset: data,
      size,
      md5: "",
      flags: 0,
    });
  }
  if (p !== e) fail("its central directory holds more than its entries.");
  ranges.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]![0] < ranges[i - 1]![1]) fail("two entries overlap.");
  return {
    header: {
      formatVersion: 0,
      engine: { major: 0, minor: 0, patch: 0 },
      flags: 0,
    },
    entries,
  };
}
