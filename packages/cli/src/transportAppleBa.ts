/**
 * `pkey transport apple-ba package|upload` (P5-08; notes/S-01, notes/E1 §E2 and §E5): Apple-hosted
 * Background Assets for a pack release.
 *
 * PACKAGE writes, under `--out` (default `build/pkey-transport/apple-ba`):
 *
 *   <assetPackId>/Manifest.json                     assetPackID, downloadPolicy, fileSelectors,
 *                                                   platforms
 *   <assetPackId>/pkey/<assetPackId>/<assetPackId>.pck (+ .pkey.json)   a container, or the tree
 *                                                   itself with .pkey/pack.json inside
 *   <assetPackId>.aar                               `xcrun ba-package` (macOS only; Apple's Linux
 *                                                   tools sit behind a developer sign-in and are
 *                                                   unverified, S-01 hand-off)
 *   <assetPackId>.inputs.json                       what the archive was built from (pack, release,
 *                                                   record and payload hashes, the manifest's hash):
 *                                                   ba-package output is not byte-reproducible
 *                                                   (packaging time in the archive), so the inputs
 *                                                   are hashed, never the .aar
 *
 * The asset-pack id is `<pack>-c<contentApi>` (`@polaris-key/manifest` `resolveAssetPackIds`):
 * every apple-ba pack of the product is mapped at once, and a collision, a grammar failure or an
 * id over 64 characters fails with a typed error before anything is written. Files live under
 * `pkey/<assetPackId>/` because the system merges every asset pack into one namespace (E1 §E2).
 * The download policy follows the pack's `delivery`: essential and prefetch on first install and
 * subsequent updates, on-demand otherwise.
 *
 * UPLOAD (App Store Connect API 4.5, request shapes from prototype/apple-ba/asc/upload_pack.mjs),
 * with CI's own ASC key from the environment (ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or
 * ASC_KEY_PATH; never the Worker's, never logged): find the asset pack by identifier, or create it
 * (POST /v1/backgroundAssets) on the first upload; POST /v1/backgroundAssetVersions; for the
 * manifest then the archive, POST /v1/backgroundAssetUploadFiles, PUT every upload operation,
 * PATCH {uploaded: true}. The first upload records the asset pack's resource id in the lock file
 * (`.pkey/asset-packs.json`, commit it); every later upload refuses when the asset pack found by
 * identifier is not the recorded one, or when one exists that nothing recorded (notes/S-01
 * §Recommendation). App Store review of a pack version is a reviewSubmissionItems item and
 * external TestFlight review has no API: both stay operator steps. Archiving (irreversible) is
 * never done here; Distribution lists retire candidates.
 */

import { createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAssetPackIds } from "@polaris-key/manifest";
import { defaultSleep, type Sleep } from "./ci.js";
import {
  contentLevel,
  loadTransportPack,
  loadTransportProduct,
  packsOn,
  pickVariants,
  placePayload,
  prettyJson,
  reportTransport,
  requireRouted,
  sha256Hex,
  type TransportCommon,
  type TransportProduct,
} from "./transport.js";

export const ASC_API = "https://api.appstoreconnect.apple.com";
export const DEFAULT_BA_OUT = "build/pkey-transport/apple-ba";
export const DEFAULT_ASSET_PACK_LOCK = ".pkey/asset-packs.json";
export const ASSET_PACK_LOCK_FORMAT = "pkey-asset-packs/1";
export const BA_INPUTS_FORMAT = "pkey-ba-inputs/1";

/** Why an upload was refused before or during the App Store Connect sequence. */
export type AscUploadErrorCode =
  | "asc-credentials-missing"
  | "asc-app-unknown"
  | "asset-pack-resource-mismatch"
  | "asset-pack-unrecorded"
  | "asset-pack-missing"
  | "asset-pack-inputs-mismatch"
  | "asc-http-error";

export class AscUploadError extends Error {
  readonly code: AscUploadErrorCode;
  constructor(code: AscUploadErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AscUploadError";
    this.code = code;
  }
}

// ── The asset-pack id for this product ──────────────────────────────────────────────────────

/** This pack's asset-pack id at `level`, after mapping every apple-ba pack of the product. */
export function assetPackIdFor(
  product: TransportProduct,
  level: number,
): string {
  const all = resolveAssetPackIds(
    [...packsOn(product, "apple-ba"), product.pack.id],
    level,
  );
  return all.get(product.pack.id)!;
}

/** Manifest.json's `downloadPolicy` for a pack's `delivery` (E1 §E2). */
export function downloadPolicy(delivery: string): Record<string, unknown> {
  const events = {
    installationEventTypes: ["firstInstallation", "subsequentUpdate"],
  };
  if (delivery === "essential") return { essential: events };
  if (delivery === "prefetch") return { prefetch: events };
  return { onDemand: {} };
}

// ── package ──────────────────────────────────────────────────────────────────────────────────

export interface BaPackageOptions extends TransportCommon {
  from: string;
  out?: string;
  contentApi?: string;
  variant?: string;
  /** Manifest.json `platforms` (default `["iOS"]`; no package owns a macOS binding yet). */
  platforms?: string[];
  /** Skip `xcrun ba-package` (any OS): write the manifest and the files only. */
  archive?: boolean;
  /** The process seams (tests). */
  exec?: (cmd: string, args: string[], cwd: string) => void;
  platform?: NodeJS.Platform;
}

export interface BaPackageResult {
  assetPackId: string;
  dir: string;
  manifest: Record<string, unknown>;
  aar: string | null;
  inputs: Record<string, unknown>;
}

export async function baPackage(o: BaPackageOptions): Promise<BaPackageResult> {
  const loaded = await loadTransportPack(o, o.from);
  const outlets = requireRouted(loaded, "apple-ba");
  const level = contentLevel(loaded, o.contentApi);
  const assetPackId = assetPackIdFor(loaded, level);
  const [v, ...more] = pickVariants(loaded, o.variant);
  if (more.length || !v)
    throw new Error(
      `${loaded.pack.id} has ${loaded.variants.length} variants; an asset pack carries one: choose it with --variant.`,
    );
  const out = path.resolve(o.cwd, o.out ?? DEFAULT_BA_OUT);
  const dir = path.join(out, assetPackId);
  await rm(dir, { recursive: true, force: true });
  const contentDir = path.join(dir, "pkey", assetPackId);
  await placePayload(loaded, v, contentDir, assetPackId);
  const manifest = {
    assetPackID: assetPackId,
    downloadPolicy: downloadPolicy(loaded.pack.delivery),
    fileSelectors: [{ directory: `pkey/${assetPackId}` }],
    platforms: o.platforms?.length ? o.platforms : ["iOS"],
  };
  const manifestText = prettyJson(manifest);
  await writeFile(path.join(dir, "Manifest.json"), manifestText);
  const inputs = {
    format: BA_INPUTS_FORMAT,
    assetPackId,
    packId: loaded.pack.id,
    version: o.version,
    contentApi: level,
    variant: v.key,
    recordSha256: loaded.recordSha256,
    payloadSha256: v.payload.sha256,
    manifestSha256: sha256Hex(manifestText),
  };
  await writeFile(
    path.join(out, `${assetPackId}.inputs.json`),
    prettyJson(inputs),
  );
  o.stdout.write(
    `Wrote asset pack ${assetPackId} (${loaded.pack.id}@${o.version}, ${Object.keys(manifest.downloadPolicy)[0]}) at ${path.relative(o.cwd, dir) || dir}\n`,
  );

  let aar: string | null = null;
  if (o.archive !== false) {
    if ((o.platform ?? process.platform) !== "darwin")
      throw new Error(
        "xcrun ba-package runs on macOS (Xcode 26 or later). Apple's Linux tools are unverified; run this step on a macOS runner, or pass --no-archive to write the manifest and files only.",
      );
    aar = path.join(out, `${assetPackId}.aar`);
    await rm(aar, { force: true });
    const exec =
      o.exec ??
      ((cmd: string, args: string[], cwd: string) => {
        execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      });
    exec("xcrun", ["ba-package", "package", "Manifest.json", "-o", aar], dir);
    o.stdout.write(`Archived ${path.relative(o.cwd, aar) || aar}\n`);
  }
  await reportTransport(o, loaded, outlets, "pending", {
    assetPackIdentifier: assetPackId,
    contentApi: level,
  });
  return { assetPackId, dir, manifest, aar, inputs };
}

// ── The App Store Connect client ─────────────────────────────────────────────────────────────

interface AscCredentials {
  keyId: string;
  issuerId: string;
  pem: string;
}

async function ascCredentials(o: BaUploadOptions): Promise<AscCredentials> {
  const keyId = o.env.ASC_KEY_ID?.trim();
  const issuerId = o.env.ASC_ISSUER_ID?.trim();
  let pem = o.env.ASC_PRIVATE_KEY?.trim();
  if (!pem && o.env.ASC_KEY_PATH?.trim())
    pem = await readFile(
      path.resolve(o.cwd, o.env.ASC_KEY_PATH.trim()),
      "utf8",
    );
  if (!keyId || !issuerId || !pem)
    throw new AscUploadError(
      "asc-credentials-missing",
      "set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY (or ASC_KEY_PATH) from CI secrets: an App Store Connect API key with the Developer role or higher.",
    );
  return { keyId, issuerId, pem };
}

/** An ES256 token for App Store Connect, 20 minutes (the maximum), minted per request. */
export function ascToken(c: AscCredentials, now = Date.now()): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const head = b64({ alg: "ES256", kid: c.keyId, typ: "JWT" });
  const body = b64({
    iss: c.issuerId,
    iat,
    exp: iat + 1200,
    aud: "appstoreconnect-v1",
  });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: createPrivateKey(c.pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

interface AscResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

class AscApi {
  constructor(
    private readonly creds: AscCredentials,
    private readonly fetchImpl: typeof fetch,
    private readonly sleep: Sleep,
  ) {}

  async call(
    method: string,
    p: string,
    body?: unknown,
  ): Promise<{ data?: AscResource | AscResource[]; included?: AscResource[] }> {
    for (let attempt = 0; ; attempt += 1) {
      const r = await this.fetchImpl(`${ASC_API}${p}`, {
        method,
        headers: {
          authorization: `Bearer ${ascToken(this.creds)}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await this.sleep(2 ** attempt * 5000);
        continue;
      }
      if (!r.ok)
        throw new AscUploadError(
          "asc-http-error",
          `${method} ${p} answered ${r.status}: ${text.slice(0, 500)}`,
        );
      return text ? (JSON.parse(text) as { data?: AscResource }) : {};
    }
  }
}

// ── The lock file ────────────────────────────────────────────────────────────────────────────

interface AssetPackLock {
  format: string;
  assetPacks: Record<
    string,
    { packId: string; resource: string; app: string; recordedAt: string }
  >;
}

async function readLock(file: string): Promise<AssetPackLock> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as AssetPackLock;
    if (
      v?.format !== ASSET_PACK_LOCK_FORMAT ||
      typeof v.assetPacks !== "object"
    )
      throw new Error(`${file} is not a ${ASSET_PACK_LOCK_FORMAT} document.`);
    return v;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { format: ASSET_PACK_LOCK_FORMAT, assetPacks: {} };
    throw e;
  }
}

// ── upload ───────────────────────────────────────────────────────────────────────────────────

export interface BaUploadOptions extends TransportCommon {
  /** The package step's `--out`. */
  dir?: string;
  contentApi?: string;
  /** The asset pack's App Store Connect resource id, when the lock does not hold it yet. */
  expectResource?: string;
  lock?: string;
  /** Poll the version this many minutes for COMPLETE or FAILED (default 0: the connector tracks it). */
  waitMinutes?: number;
  now?: () => number;
}

export interface BaUploadResult {
  assetPackId: string;
  resource: string;
  created: boolean;
  versionId: string;
  ascVersion: number | null;
  state: string | null;
}

/** The App Store Connect app id: ASC_APP_ID, else the apple-ba outlets' `appleId` (one value). */
function appIdOf(
  product: TransportProduct,
  outlets: string[],
  env: TransportCommon["env"],
): string {
  const fromEnv = env.ASC_APP_ID?.trim();
  if (fromEnv) return fromEnv;
  const ids = new Set(
    (product.distribution?.outlets ?? [])
      .filter((o) => outlets.includes(o.id) && o.identity.appleId)
      .map((o) => o.identity.appleId!),
  );
  if (ids.size !== 1)
    throw new AscUploadError(
      "asc-app-unknown",
      ids.size
        ? `the apple-ba outlets name different apps (${[...ids].join(", ")}); set ASC_APP_ID.`
        : "no apple-ba outlet in .pkey/distribution has an appleId; add it or set ASC_APP_ID.",
    );
  return [...ids][0]!;
}

export async function baUpload(o: BaUploadOptions): Promise<BaUploadResult> {
  // Everything that can be refused locally is refused before the first request.
  const product = await loadTransportProduct(o);
  const outlets = requireRouted(product, "apple-ba");
  const level = contentLevel(product, o.contentApi);
  const assetPackId = assetPackIdFor(product, level);
  const dir = path.resolve(o.cwd, o.dir ?? DEFAULT_BA_OUT);
  const aar = path.join(dir, `${assetPackId}.aar`);
  const manifestFile = path.join(dir, assetPackId, "Manifest.json");
  const inputs = JSON.parse(
    await readFile(path.join(dir, `${assetPackId}.inputs.json`), "utf8").catch(
      () => {
        throw new AscUploadError(
          "asset-pack-inputs-mismatch",
          `no ${assetPackId}.inputs.json under ${path.relative(o.cwd, dir) || dir}: run pkey transport apple-ba package first.`,
        );
      },
    ),
  ) as Record<string, unknown>;
  if (
    inputs.packId !== product.pack.id ||
    inputs.version !== o.version ||
    inputs.contentApi !== level ||
    inputs.manifestSha256 !== sha256Hex(await readFile(manifestFile))
  )
    throw new AscUploadError(
      "asset-pack-inputs-mismatch",
      `${path.relative(o.cwd, dir) || dir} holds ${String(inputs.packId)}@${String(inputs.version)} at level ${String(inputs.contentApi)}, not ${product.pack.id}@${o.version} at level ${level} (or its Manifest.json changed since packaging).`,
    );
  await stat(aar).catch(() => {
    throw new AscUploadError(
      "asset-pack-inputs-mismatch",
      `${path.relative(o.cwd, aar)} is missing: package on macOS (without --no-archive) first.`,
    );
  });
  const appId = appIdOf(product, outlets, o.env);
  const lockFile = path.resolve(o.cwd, o.lock ?? DEFAULT_ASSET_PACK_LOCK);
  const lock = await readLock(lockFile);
  const recorded = lock.assetPacks[assetPackId];
  if (recorded && recorded.packId !== product.pack.id)
    throw new AscUploadError(
      "asset-pack-resource-mismatch",
      `${path.relative(o.cwd, lockFile)} records asset pack ${assetPackId} for ${recorded.packId}, not ${product.pack.id}.`,
    );
  if (recorded && o.expectResource && recorded.resource !== o.expectResource)
    throw new AscUploadError(
      "asset-pack-resource-mismatch",
      `--expect-resource ${o.expectResource} differs from the recorded resource ${recorded.resource} of ${assetPackId}.`,
    );
  const expected = recorded?.resource ?? o.expectResource;
  const creds = await ascCredentials(o);
  const api = new AscApi(creds, o.fetchImpl ?? fetch, o.sleep ?? defaultSleep);

  // 1. The asset pack: found by identifier and checked, or created on the very first upload.
  const found = await api.call(
    "GET",
    `/v1/apps/${encodeURIComponent(appId)}/backgroundAssets?filter[assetPackIdentifier]=${encodeURIComponent(assetPackId)}`,
  );
  const hit = (Array.isArray(found.data) ? found.data : []).filter(
    (r) => r.attributes?.assetPackIdentifier === assetPackId,
  );
  let resource: string;
  let created = false;
  if (hit.length) {
    resource = hit[0]!.id;
    if (expected === undefined)
      throw new AscUploadError(
        "asset-pack-unrecorded",
        `App Store Connect already has asset pack ${assetPackId} (resource ${resource}), but ${path.relative(o.cwd, lockFile)} records none. Confirm in App Store Connect that it is ${product.pack.id}'s, then pass --expect-resource ${resource}.`,
      );
    if (resource !== expected)
      throw new AscUploadError(
        "asset-pack-resource-mismatch",
        `asset pack ${assetPackId} is resource ${resource}, but ${expected} is recorded: refusing to upload into another pack's asset pack.`,
      );
  } else {
    if (expected !== undefined)
      throw new AscUploadError(
        "asset-pack-missing",
        `resource ${expected} is recorded for ${assetPackId}, but App Store Connect has no asset pack by that identifier (archived ids are never reused): refusing to create a new one.`,
      );
    const r = await api.call("POST", "/v1/backgroundAssets", {
      data: {
        type: "backgroundAssets",
        attributes: { assetPackIdentifier: assetPackId },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    });
    resource = (r.data as AscResource).id;
    created = true;
    o.stdout.write(
      `Created asset pack ${assetPackId} (resource ${resource})\n`,
    );
  }
  if (!recorded) {
    lock.assetPacks[assetPackId] = {
      packId: product.pack.id,
      resource,
      app: appId,
      recordedAt: new Date(o.now?.() ?? Date.now()).toISOString(),
    };
    lock.assetPacks = Object.fromEntries(
      Object.entries(lock.assetPacks).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, prettyJson(lock));
    o.stdout.write(
      `Recorded ${assetPackId} → ${resource} in ${path.relative(o.cwd, lockFile)}: commit it, so later uploads can prove the asset pack is this pack's.\n`,
    );
  }

  // 2. A version, then the manifest and the archive.
  const v = await api.call("POST", "/v1/backgroundAssetVersions", {
    data: {
      type: "backgroundAssetVersions",
      relationships: {
        backgroundAsset: { data: { type: "backgroundAssets", id: resource } },
      },
    },
  });
  const version = v.data as AscResource;
  const ascVersion =
    typeof version.attributes?.version === "number"
      ? version.attributes.version
      : typeof version.attributes?.version === "string" &&
          /^[0-9]+$/.test(version.attributes.version)
        ? Number(version.attributes.version)
        : null;
  o.stdout.write(
    `Created version ${ascVersion ?? "?"} of ${assetPackId} (${version.id})\n`,
  );
  await uploadFile(api, o, version.id, manifestFile, "MANIFEST");
  await uploadFile(api, o, version.id, aar, "ASSET");

  // 3. Optionally wait for processing; the connector tracks it either way.
  let state: string | null = null;
  const until = (o.now?.() ?? Date.now()) + (o.waitMinutes ?? 0) * 60_000;
  while ((o.waitMinutes ?? 0) > 0) {
    const r = await api.call(
      "GET",
      `/v1/backgroundAssetVersions/${version.id}`,
    );
    state = String((r.data as AscResource).attributes?.state ?? "");
    if (state === "COMPLETE" || state === "FAILED") break;
    if ((o.now?.() ?? Date.now()) >= until) break;
    await (o.sleep ?? defaultSleep)(30_000);
  }
  if (state) o.stdout.write(`Version ${version.id}: ${state}\n`);
  if (state === "FAILED")
    throw new AscUploadError(
      "asc-http-error",
      `App Store Connect failed to process ${assetPackId} version ${version.id}; see its stateDetails in App Store Connect.`,
    );

  const ref = {
    assetPackIdentifier: assetPackId,
    ascBackgroundAssetId: resource,
    ascBackgroundAssetVersionId: version.id,
    ...(ascVersion !== null ? { ascVersion } : {}),
    contentApi: level,
  };
  const kinds = new Map(
    (product.distribution?.outlets ?? []).map((x) => [x.id, x.kind]),
  );
  const testflight = outlets.filter((id) => kinds.get(id) === "testflight");
  const store = outlets.filter((id) => kinds.get(id) !== "testflight");
  if (testflight.length)
    await reportTransport(o, product, testflight, "processing", ref);
  if (store.length) await reportTransport(o, product, store, "pending", ref);
  o.stdout.write(
    "Next: internal TestFlight testers get the version once it is processed. External TestFlight review is submitted in App Store Connect (no API); App Store review goes with a review submission.\n",
  );
  return {
    assetPackId,
    resource,
    created,
    versionId: version.id,
    ascVersion,
    state,
  };
}

async function uploadFile(
  api: AscApi,
  o: BaUploadOptions,
  versionId: string,
  file: string,
  assetType: "MANIFEST" | "ASSET",
): Promise<void> {
  const bytes = new Uint8Array(await readFile(file));
  const r = await api.call("POST", "/v1/backgroundAssetUploadFiles", {
    data: {
      type: "backgroundAssetUploadFiles",
      attributes: {
        assetType,
        fileName: path.basename(file),
        fileSize: bytes.byteLength,
      },
      relationships: {
        backgroundAssetVersion: {
          data: { type: "backgroundAssetVersions", id: versionId },
        },
      },
    },
  });
  const upload = r.data as AscResource;
  const ops = (upload.attributes?.uploadOperations ?? []) as {
    method: string;
    url: string;
    offset: number;
    length: number;
    requestHeaders?: { name: string; value: string }[];
  }[];
  const fetchImpl = o.fetchImpl ?? fetch;
  for (const op of ops) {
    const part = bytes.subarray(op.offset, op.offset + op.length);
    if (part.byteLength !== op.length)
      throw new AscUploadError(
        "asc-http-error",
        `upload operation at ${op.offset}+${op.length} is outside ${path.basename(file)} (${bytes.byteLength} bytes).`,
      );
    // The part URLs are pre-signed: no App Store Connect token goes with them.
    const put = await fetchImpl(op.url, {
      method: op.method,
      headers: Object.fromEntries(
        (op.requestHeaders ?? []).map((h) => [h.name, h.value]),
      ),
      body: part,
    });
    if (!put.ok)
      throw new AscUploadError(
        "asc-http-error",
        `uploading ${path.basename(file)} at ${op.offset}+${op.length} answered ${put.status}.`,
      );
  }
  await api.call("PATCH", `/v1/backgroundAssetUploadFiles/${upload.id}`, {
    data: {
      type: "backgroundAssetUploadFiles",
      id: upload.id,
      attributes: { uploaded: true },
    },
  });
  o.stdout.write(
    `Uploaded ${assetType.toLowerCase()} ${path.basename(file)} (${bytes.byteLength} bytes, ${ops.length} part${ops.length === 1 ? "" : "s"})\n`,
  );
}
