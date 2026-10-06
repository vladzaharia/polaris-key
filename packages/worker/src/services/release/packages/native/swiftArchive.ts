/**
 * The manifests of a Swift source archive (F-22: `swift package-registry publish`).
 *
 * SwiftPM resolves a registry package by fetching its `Package.swift` (and any
 * `Package@swift-<v>.swift`) from the registry (SE-0292 §4.3), so a registry must serve the
 * manifests of every release. The CLI path (`pkey release publish`) uploads them beside the
 * archive, from the publish scratch directory. A native publish sends only the archive, so this
 * module reads them out of it — the ONE place the Worker reads inside a package (THREAT-MODEL
 * §3, "Native-client publish"), held to these bounds:
 *
 *   - only the central directory and the manifest entries are read, never any other entry;
 *   - a manifest is a top-level `Package.swift` or `Package@swift-<version>.swift`, or one in the
 *     archive's single top-level directory (SwiftPM's archives have one); at most 32 of them;
 *   - each is stored or deflated, unencrypted, at most `MAX_MANIFEST_BYTES` uncompressed, both
 *     as declared and as inflated (the inflater is stopped the moment it passes the cap), and its
 *     CRC-32 must match the directory's;
 *   - ZIP64 archives, split archives and anything malformed are refused.
 *
 * The bytes served are exactly the bytes in the archive SwiftPM checksums and the publisher
 * signed (a signed release carries the manifest signatures inside each manifest), so what a client
 * fetches is what it would find in the archive.
 */

/** One manifest read out of the archive. */
export interface ArchiveManifest {
  /** `Package.swift` or `Package@swift-<version>.swift`. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifests: readonly ArchiveManifest[] }
  | { readonly ok: false; readonly message: string };

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFESTS = 32;
const MAX_ENTRIES = 65_535;
const MANIFEST_RE = /^Package(@swift-[0-9]+(?:\.[0-9]+){0,2})?\.swift$/;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Inflate raw DEFLATE, stopping (and failing) once more than `max` bytes come out. */
async function inflateRaw(
  data: Uint8Array,
  max: number,
): Promise<Uint8Array | null> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(data).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  localOffset: number;
}

/** The manifests of the zip `archive` (see the file comment for the bounds). */
export async function swiftArchiveManifests(
  archive: Uint8Array,
): Promise<ManifestResult> {
  const bad = (message: string): ManifestResult => ({ ok: false, message });
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const len = archive.byteLength;
  // The end-of-central-directory record: within the last 22 + 65,535 bytes.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return bad("the source archive is not a zip file");
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0)
    return bad("split zip archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    return bad("ZIP64 source archives are not supported");
  if (cdOffset + cdSize > eocd || count > MAX_ENTRIES)
    return bad("the source archive's central directory is malformed");
  const entries: Entry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50)
      return bad("the source archive's central directory is malformed");
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > eocd)
      return bad("the source archive's central directory is malformed");
    entries.push({
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressed: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
      name: decoder.decode(archive.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // SwiftPM's archives hold one top-level directory; the manifests sit in it (or at the root).
  const tops = new Set(entries.map((e) => e.name.split("/")[0]));
  const prefix =
    tops.size === 1 && entries.every((e) => e.name.includes("/"))
      ? `${[...tops][0]}/`
      : "";
  const wanted = entries.filter(
    (e) =>
      e.name.startsWith(prefix) &&
      MANIFEST_RE.test(e.name.slice(prefix.length)),
  );
  if (!wanted.some((e) => e.name.slice(prefix.length) === "Package.swift"))
    return bad("the source archive has no Package.swift");
  if (wanted.length > MAX_MANIFESTS)
    return bad(`the source archive has more than ${MAX_MANIFESTS} manifests`);
  const manifests: ArchiveManifest[] = [];
  for (const e of wanted) {
    const name = e.name.slice(prefix.length);
    if (e.flags & 0x1) return bad(`${name} is encrypted`);
    if (e.size > MAX_MANIFEST_BYTES || e.compressed > len)
      return bad(`${name} is over ${MAX_MANIFEST_BYTES} bytes`);
    const lh = e.localOffset;
    if (lh + 30 > len || view.getUint32(lh, true) !== 0x04034b50)
      return bad(`${name}'s local header is malformed`);
    const start =
      lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
    const end = start + e.compressed;
    if (end > len) return bad(`${name} runs past the end of the archive`);
    const data = archive.subarray(start, end);
    let bytes: Uint8Array | null;
    if (e.method === 0) bytes = data;
    else if (e.method === 8) bytes = await inflateRaw(data, MAX_MANIFEST_BYTES);
    else return bad(`${name} uses an unsupported compression method`);
    if (bytes === null || bytes.byteLength !== e.size)
      return bad(`${name} does not inflate to its declared size`);
    if (crc32(bytes) !== e.crc) return bad(`${name} fails its CRC-32`);
    manifests.push({ name, bytes });
  }
  manifests.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, manifests };
}
