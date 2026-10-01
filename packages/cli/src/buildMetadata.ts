/**
 * Build metadata extraction (P2b-05): the facts the storefront feeds need from inside a payload,
 * read in CI because the Worker never unzips an archive. `pkey release publish` puts them in the
 * release descriptor's optional `builds[].metadata`, which `@polaris-key/manifest` validates.
 *
 *   - IPA (`iosBuildMetadata`): `Payload/<App>.app/Info.plist` gives `CFBundleIdentifier`,
 *     `CFBundleShortVersionString`, `CFBundleVersion`, `MinimumOSVersion` and the privacy strings
 *     (`NS…UsageDescription`); the entitlements come from the code signature of the main
 *     executable and of every app extension (`PlugIns/*.appex`), the union AltStore checks an
 *     install against, without `application-identifier` and
 *     `com.apple.developer.team-identifier` (AltStore's own rule, notes/E1 §B1).
 *   - APK (`androidBuildMetadata`): the binary `AndroidManifest.xml` gives `package`,
 *     `versionCode`, `versionName`, `minSdkVersion` and `targetSdkVersion`; `lib/<abi>/*.so`
 *     gives `nativecode`; the signer is the SHA-256 of the first certificate of the first signer,
 *     taken — in fdroidserver's order — from a v1 signature (`META-INF/*.RSA|DSA|EC`), else the
 *     APK Signing Block's v2 block, else its v3 block.
 *
 * Every parser here reads bytes from an archive CI built, but parses them defensively anyway:
 * bounds-checked offsets, capped counts, no recursion on input-controlled depth beyond a cap.
 */

import { createHash } from "node:crypto";
import {
  ANDROID_ABIS,
  type AndroidBuildMetadata,
  type IosBuildMetadata,
} from "@polaris-key/manifest";
import { parsePlist, type PlistValue } from "./plist.js";
import { withZip, type ZipReader } from "./zip.js";

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function dict(v: PlistValue | undefined): { [k: string]: PlistValue } | null {
  return v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v)
    ? (v as { [k: string]: PlistValue })
    : null;
}

// ── iOS ──────────────────────────────────────────────────────────────────────────────────────

/** Entitlements AltStore excludes from `appPermissions.entitlements`. */
const EXCLUDED_ENTITLEMENTS = new Set([
  "application-identifier",
  "com.apple.developer.team-identifier",
]);

const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xfade7171;

/**
 * The entitlements plist embedded in a Mach-O's code signature, or `null` when it has none. A
 * universal (fat) binary is read through its first slice: every slice carries the same signing
 * identity and entitlements.
 */
export function machoEntitlements(
  bin: Buffer,
): { [k: string]: PlistValue } | null {
  if (bin.length < 32) return null;
  let base = 0;
  const fat = bin.readUInt32BE(0);
  if (fat === 0xcafebabe || fat === 0xcafebabf) {
    const n = bin.readUInt32BE(4);
    if (n === 0 || n > 32) return null;
    base =
      fat === 0xcafebabf
        ? Number(bin.readBigUInt64BE(16))
        : bin.readUInt32BE(16);
    if (base <= 0 || base >= bin.length) return null;
  }
  const magic = bin.readUInt32LE(base);
  const is64 = magic === 0xfeedfacf;
  if (!is64 && magic !== 0xfeedface) return null;
  const ncmds = bin.readUInt32LE(base + 16);
  let p = base + (is64 ? 32 : 28);
  for (let i = 0; i < ncmds && i < 4096; i++) {
    if (p + 8 > bin.length) return null;
    const cmd = bin.readUInt32LE(p);
    const size = bin.readUInt32LE(p + 4);
    if (size < 8) return null;
    if (cmd === LC_CODE_SIGNATURE) {
      const off = base + bin.readUInt32LE(p + 8);
      const len = bin.readUInt32LE(p + 12);
      if (off + len > bin.length || len < 12) return null;
      if (bin.readUInt32BE(off) !== CSMAGIC_EMBEDDED_SIGNATURE) return null;
      const count = bin.readUInt32BE(off + 8);
      for (let j = 0; j < count && j < 64; j++) {
        const entry = off + 12 + j * 8;
        if (entry + 8 > off + len) return null;
        const blob = off + bin.readUInt32BE(entry + 4);
        if (blob + 8 > off + len) return null;
        if (bin.readUInt32BE(blob) !== CSMAGIC_EMBEDDED_ENTITLEMENTS) continue;
        const blobLen = bin.readUInt32BE(blob + 4);
        if (blobLen < 8 || blob + blobLen > off + len) return null;
        return dict(parsePlist(bin.subarray(blob + 8, blob + blobLen)));
      }
      return null;
    }
    p += size;
  }
  return null;
}

/** The `.app` directory inside `Payload/`, e.g. `Payload/Diceroll.app/`. */
function appRoot(zip: ZipReader): string {
  const roots = new Set<string>();
  for (const e of zip.entries) {
    const m = /^Payload\/([^/]+\.app)\//.exec(e.name);
    if (m) roots.add(`Payload/${m[1]}/`);
  }
  if (roots.size !== 1)
    throw new MetadataError(
      `the IPA must hold exactly one Payload/<App>.app (found ${roots.size})`,
    );
  return [...roots][0]!;
}

async function readPlistEntry(
  zip: ZipReader,
  name: string,
): Promise<{ [k: string]: PlistValue }> {
  const entry = zip.entry(name);
  if (!entry) throw new MetadataError(`${name} is missing`);
  const plist = dict(parsePlist(await zip.read(entry)));
  if (!plist) throw new MetadataError(`${name} is not a dictionary`);
  return plist;
}

async function bundleEntitlements(
  zip: ZipReader,
  root: string,
  info: { [k: string]: PlistValue },
): Promise<string[]> {
  const exe = info.CFBundleExecutable;
  if (typeof exe !== "string" || !exe || exe.includes("/"))
    throw new MetadataError(`${root}Info.plist has no CFBundleExecutable`);
  const entry = zip.entry(`${root}${exe}`);
  if (!entry) throw new MetadataError(`${root}${exe} is missing`);
  const ents = machoEntitlements(await zip.read(entry));
  return ents ? Object.keys(ents) : [];
}

/** An IPA's `IosBuildMetadata`. */
export async function iosBuildMetadata(ipa: string): Promise<IosBuildMetadata> {
  return withZip(ipa, async (zip) => {
    const root = appRoot(zip);
    const info = await readPlistEntry(zip, `${root}Info.plist`);
    const str = (k: string): string => {
      const v = info[k];
      if (typeof v !== "string" || !v)
        throw new MetadataError(`${root}Info.plist has no ${k}`);
      return v;
    };
    const entitlements = new Set(await bundleEntitlements(zip, root, info));
    // Every app extension's entitlements too (each one costs a free Apple ID an App ID).
    const appexes = new Set<string>();
    for (const e of zip.entries) {
      const m = new RegExp(
        `^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}PlugIns/([^/]+\\.appex)/Info\\.plist$`,
      ).exec(e.name);
      if (m) appexes.add(`${root}PlugIns/${m[1]}/`);
    }
    for (const ext of [...appexes].sort()) {
      const extInfo = await readPlistEntry(zip, `${ext}Info.plist`);
      for (const k of await bundleEntitlements(zip, ext, extInfo))
        entitlements.add(k);
    }
    const privacy: Record<string, string> = {};
    for (const [k, v] of Object.entries(info).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ))
      if (
        /^NS[A-Za-z0-9]{1,100}UsageDescription$/.test(k) &&
        typeof v === "string"
      )
        privacy[k] = v;
    const minOS = info.MinimumOSVersion;
    return {
      bundleIdentifier: str("CFBundleIdentifier"),
      version: str("CFBundleShortVersionString"),
      buildVersion: str("CFBundleVersion"),
      ...(typeof minOS === "string" && minOS ? { minOSVersion: minOS } : {}),
      appPermissions: {
        entitlements: [...entitlements]
          .filter((e) => !EXCLUDED_ENTITLEMENTS.has(e))
          .sort(),
        privacy,
      },
    };
  });
}

// ── Android: the binary manifest ─────────────────────────────────────────────────────────────

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const UTF8_FLAG = 0x100;

/** The framework attribute resource ids (`android.R.attr`). */
const ATTR = {
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
} as const;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

interface AxmlAttr {
  name: string;
  resId: number | null;
  /** The literal string, when the value is one. */
  string: string | null;
  /** The integer, when the value is one. */
  int: number | null;
}

interface AxmlElement {
  name: string;
  attrs: AxmlAttr[];
}

function readStringPool(buf: Buffer, at: number): string[] {
  const headerSize = buf.readUInt16LE(at + 2);
  const count = buf.readUInt32LE(at + 8);
  const flags = buf.readUInt32LE(at + 16);
  const stringsStart = at + buf.readUInt32LE(at + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  if (count > 1_000_000)
    throw new MetadataError("AndroidManifest.xml: string pool too large");
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = stringsStart + buf.readUInt32LE(at + headerSize + i * 4);
    if (utf8) {
      let p = off;
      // UTF-16 length, then UTF-8 byte length; each one or two bytes.
      p += buf[p]! & 0x80 ? 2 : 1;
      let len = buf[p]!;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1]!;
        p += 2;
      } else p += 1;
      out.push(buf.toString("utf8", p, p + len));
    } else {
      let len = buf.readUInt16LE(off);
      let p = off + 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(off + 2);
        p += 2;
      }
      out.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return out;
}

/** The start elements of a compiled (AXML) XML document, in document order. */
export function parseAxml(buf: Buffer): AxmlElement[] {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE)
    throw new MetadataError(
      "AndroidManifest.xml is not a compiled XML document",
    );
  let strings: string[] = [];
  let resIds: number[] = [];
  const out: AxmlElement[] = [];
  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length)
      throw new MetadataError("AndroidManifest.xml: a chunk runs past the end");
    if (type === RES_STRING_POOL_TYPE) strings = readStringPool(buf, p);
    else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const header = buf.readUInt16LE(p + 2);
      resIds = [];
      for (let q = p + header; q + 4 <= p + size; q += 4)
        resIds.push(buf.readUInt32LE(q));
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const ext = p + buf.readUInt16LE(p + 2);
      const name = strings[buf.readUInt32LE(ext + 4)] ?? "";
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs: AxmlAttr[] = [];
      for (let i = 0; i < attrCount && i < 1024; i++) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > p + size) break;
        const nameIdx = buf.readUInt32LE(a + 4);
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15]!;
        const data = buf.readUInt32LE(a + 16);
        attrs.push({
          name: strings[nameIdx] ?? "",
          resId: nameIdx < resIds.length ? resIds[nameIdx]! : null,
          string:
            dataType === TYPE_STRING
              ? (strings[data] ?? null)
              : raw !== 0xffffffff
                ? (strings[raw] ?? null)
                : null,
          int:
            dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX
              ? data | 0
              : null,
        });
      }
      out.push({ name, attrs });
    }
    p += size;
  }
  return out;
}

function attr(
  el: AxmlElement | undefined,
  name: string,
  resId: number | null,
): AxmlAttr | undefined {
  return el?.attrs.find(
    (a) => (resId !== null && a.resId === resId) || a.name === name,
  );
}

function intOf(a: AxmlAttr | undefined): number | undefined {
  if (!a) return undefined;
  if (a.int !== null) return a.int;
  if (a.string !== null && /^\d+$/.test(a.string)) return Number(a.string);
  return undefined;
}

// ── Android: the signer ──────────────────────────────────────────────────────────────────────

const APK_SIG_BLOCK_MAGIC = "APK Sig Block 42";
const APK_SIGNATURE_SCHEME_V2_BLOCK_ID = 0x7109871a;
const APK_SIGNATURE_SCHEME_V3_BLOCK_ID = 0xf05368c0;

/** A length-prefixed (u32 LE) sequence of length-prefixed items. */
function lpItems(buf: Buffer, at: number, end: number): Buffer[] {
  const out: Buffer[] = [];
  let p = at;
  while (p + 4 <= end) {
    const len = buf.readUInt32LE(p);
    if (p + 4 + len > end)
      throw new MetadataError("APK Signing Block: truncated item");
    out.push(buf.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return out;
}

/** The first signer's first certificate (DER) in a v2 or v3 scheme block. */
function schemeBlockCertificate(block: Buffer): Buffer | null {
  if (block.length < 4) return null;
  const signers = lpItems(block, 4, 4 + block.readUInt32LE(0));
  const signer = signers[0];
  if (!signer || signer.length < 4) return null;
  const signedData = signer.subarray(4, 4 + signer.readUInt32LE(0));
  if (signedData.length < 4) return null;
  const digestsLen = signedData.readUInt32LE(0);
  const certsAt = 4 + digestsLen;
  if (certsAt + 4 > signedData.length) return null;
  const certs = lpItems(
    signedData,
    certsAt + 4,
    certsAt + 4 + signedData.readUInt32LE(certsAt),
  );
  return certs[0] ?? null;
}

async function signingBlockCertificate(zip: ZipReader): Promise<Buffer | null> {
  const cd = zip.centralDirectoryOffset;
  if (cd < 32) return null;
  const footer = await zip.readRaw(cd - 24, 24);
  if (footer.toString("latin1", 8, 24) !== APK_SIG_BLOCK_MAGIC) return null;
  const size = Number(footer.readBigUInt64LE(0));
  if (size < 24 || size + 8 > cd) return null;
  const block = await zip.readRaw(cd - size - 8, size + 8);
  const pairs = new Map<number, Buffer>();
  let p = 8;
  const end = block.length - 24;
  while (p + 12 <= end) {
    const len = Number(block.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > end) break;
    pairs.set(block.readUInt32LE(p + 8), block.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  for (const id of [
    APK_SIGNATURE_SCHEME_V2_BLOCK_ID,
    APK_SIGNATURE_SCHEME_V3_BLOCK_ID,
  ]) {
    const b = pairs.get(id);
    const cert = b ? schemeBlockCertificate(b) : null;
    if (cert) return cert;
  }
  return null;
}

/** A DER element at `at`: its tag, where its contents start, and where it ends. */
function der(
  buf: Buffer,
  at: number,
): { tag: number; start: number; end: number } {
  if (at + 2 > buf.length) throw new MetadataError("DER: truncated");
  const tag = buf[at]!;
  let len = buf[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > buf.length)
      throw new MetadataError("DER: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
    start += n;
  }
  if (start + len > buf.length) throw new MetadataError("DER: truncated");
  return { tag, start, end: start + len };
}

/**
 * The first certificate (DER) of a PKCS#7 `SignedData` — a v1 JAR signature's
 * `META-INF/<NAME>.RSA|DSA|EC`.
 */
export function pkcs7FirstCertificate(buf: Buffer): Buffer | null {
  const ci = der(buf, 0); // ContentInfo SEQUENCE
  if (ci.tag !== 0x30) return null;
  const oid = der(buf, ci.start);
  const explicit = der(buf, oid.end); // [0] EXPLICIT
  if (explicit.tag !== 0xa0) return null;
  const sd = der(buf, explicit.start); // SignedData SEQUENCE
  if (sd.tag !== 0x30) return null;
  let p = der(buf, sd.start).end; // version
  p = der(buf, p).end; // digestAlgorithms SET
  p = der(buf, p).end; // encapContentInfo
  const certs = der(buf, p);
  if (certs.tag !== 0xa0) return null; // [0] IMPLICIT certificates
  const first = der(buf, certs.start);
  return buf.subarray(certs.start, first.end);
}

async function v1Certificate(zip: ZipReader): Promise<Buffer | null> {
  const sig = zip.entries
    .filter((e) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  return sig ? pkcs7FirstCertificate(await zip.read(sig)) : null;
}

/** The SHA-256 (lower-case hex) of the signing certificate of a signed APK or JAR, or `null`. */
export async function apkSignerSha256(zip: ZipReader): Promise<string | null> {
  const cert =
    (await v1Certificate(zip)) ?? (await signingBlockCertificate(zip));
  return cert ? sha256(cert) : null;
}

/** An APK's `AndroidBuildMetadata`. */
export async function androidBuildMetadata(
  apk: string,
): Promise<AndroidBuildMetadata> {
  return withZip(apk, async (zip) => {
    const entry = zip.entry("AndroidManifest.xml");
    if (!entry) throw new MetadataError("AndroidManifest.xml is missing");
    const elements = parseAxml(await zip.read(entry));
    const manifest = elements.find((e) => e.name === "manifest");
    const usesSdk = elements.find((e) => e.name === "uses-sdk");
    const packageName = attr(manifest, "package", null)?.string;
    if (!packageName) throw new MetadataError("the manifest names no package");
    const versionCode = intOf(attr(manifest, "versionCode", ATTR.versionCode));
    if (versionCode === undefined || versionCode < 1)
      throw new MetadataError(
        "the manifest has no literal android:versionCode",
      );
    const versionName = attr(manifest, "versionName", ATTR.versionName)?.string;
    if (!versionName)
      throw new MetadataError(
        "the manifest has no literal android:versionName (a resource reference is not resolved)",
      );
    const minSdk = intOf(attr(usesSdk, "minSdkVersion", ATTR.minSdkVersion));
    const targetSdk = intOf(
      attr(usesSdk, "targetSdkVersion", ATTR.targetSdkVersion),
    );
    const abis: readonly string[] = ANDROID_ABIS;
    const nativecode = [
      ...new Set(
        zip.entries
          .map((e) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(e.name)?.[1])
          .filter((a): a is string => !!a && abis.includes(a)),
      ),
    ].sort();
    const signerSha256 = await apkSignerSha256(zip);
    if (!signerSha256) throw new MetadataError("the APK is not signed");
    return {
      packageName,
      versionCode,
      versionName,
      ...(minSdk !== undefined ? { minSdk } : {}),
      ...(targetSdk !== undefined ? { targetSdk } : {}),
      ...(nativecode.length ? { nativecode } : {}),
      signerSha256,
    };
  });
}

/** The metadata of one build's payload, by platform; `null` for a platform with none. */
export async function buildMetadataFor(
  platform: string,
  format: string,
  file: string,
): Promise<IosBuildMetadata | AndroidBuildMetadata | null> {
  if (platform === "ios" && format === "ipa") return iosBuildMetadata(file);
  if (platform === "android" && format === "apk")
    return androidBuildMetadata(file);
  return null;
}
