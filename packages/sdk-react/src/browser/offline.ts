// Offline bundle import for the browser transport (wire contract v3 §7, P1b-07).
//
// A browser has no hardware fingerprint and no keyring (PARITY §7), so its device identity is a
// RANDOM id minted once and kept in IndexedDB, and its offline cache is a small IndexedDB record
// beside it: the verified bundle's trust manifest and inner documents, plus `importedBundle`.
// An operator mints a bundle against that id; the page imports it with no network at all.
//
// ── THE SAME RULES AS EVERY OTHER SDK ───────────────────────────────────────────────────────
//
//   * Steps 1–4 are `@polaris-key/client-core`'s `inspectBundle`, the verifier the corpus's
//     `bundleCases` pin byte-for-byte in every SDK. A refusal names the step and writes NOTHING.
//   * Step 5, the write, REPLACES the record: importing a bundle is a re-provisioning.
//   * What is stored is SIGNED ARTIFACTS ONLY (`CacheRecordV3`), re-verified on every load —
//     the trust manifest against the PINS, each document against the effective set, bound to
//     the stored device id, on the reload profile (`checkFreshness: false`; `graceUntil` is the
//     gate's job, against the monotonic floor). A slice that no longer verifies is dropped.
//     Nothing decoded is ever trusted from storage, so editing IndexedDB by hand can delete an
//     activation but never invent one.
//
// No token is created: `activation: "bundle"` is what the gate reads instead, and an
// authenticated session (the browser's `"token"`) supersedes it (§7).

import {
  CACHE_VERSION,
  highWaterMark,
  inspectBundle,
  mergeTrust,
  verifyConfigDoc,
  verifyLicenseDoc,
  verifyTrustManifest,
  type BundleOptions,
  type BundleRefusalReason,
  type CacheRecordV3,
} from "@polaris-key/client-core";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { ErrorCode } from "../constants.generated.js";
import { PolarisError, type ImportBundleResult } from "../core/types.js";

/** The pinned keys (kid → raw Ed25519 public key, base64url) — `@polaris-key/jws`'s `TrustSet`. */
export type TrustSet = BundleOptions["pinned"];

/** What the browser keeps per product: its device id and, once a bundle is imported, the
 *  signed artifacts that came in it. */
export interface OfflineRecord {
  deviceId: string;
  cache?: CacheRecordV3;
}

/** Where the record lives. IndexedDB in a browser; anything with the same two calls in a test. */
export interface OfflineStore {
  read(product: string): Promise<OfflineRecord | null>;
  write(product: string, record: OfflineRecord): Promise<void>;
}

/** The re-verified offline state: what a projection reads. */
export interface OfflineState {
  deviceId: string;
  license: LicenseDoc | null;
  config: ConfigDoc | null;
  importedBundle: { bundleId: string; importedAt: number } | null;
  /** §4.2 — `max(issuedAt)` over the manifest and both documents. */
  highWaterMark: number;
  /** Epoch MILLIseconds of the newest signed `issuedAt`, as the Node cache derives it. */
  lastVerifiedAt: number | null;
}

const DB_NAME = "polaris-key";
const STORE_NAME = "offline";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * The IndexedDB-backed store: one database, one object store, one record per product slug.
 * Returns `null` where IndexedDB does not exist (a server render, a locked-down webview); the
 * adapter then reports bundle import as unsupported rather than pretending to persist.
 */
export function indexedDbOfflineStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB,
): OfflineStore | null {
  if (!factory) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!db) {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME))
          req.result.createObjectStore(STORE_NAME);
      };
      db = request(req);
      // A failed open must not poison every later call.
      db.catch(() => {
        db = null;
      });
    }
    return db;
  };
  return {
    async read(product) {
      const tx = (await open()).transaction(STORE_NAME, "readonly");
      const value = await request(tx.objectStore(STORE_NAME).get(product));
      return isRecord(value) ? value : null;
    },
    async write(product, record) {
      const tx = (await open()).transaction(STORE_NAME, "readwrite");
      await request(tx.objectStore(STORE_NAME).put(record, product));
    },
  };
}

function isRecord(v: unknown): v is OfflineRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as OfflineRecord).deviceId === "string" &&
    (v as OfflineRecord).deviceId !== ""
  );
}

/** A fresh device id: 24 random bytes as 32 base64url characters, the §6 device-id shape. */
export function newDeviceId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read the record, minting and persisting a device id the first time. */
export async function ensureRecord(
  store: OfflineStore,
  product: string,
): Promise<OfflineRecord> {
  const existing = await store.read(product);
  if (existing) return existing;
  const record: OfflineRecord = { deviceId: newDeviceId() };
  await store.write(product, record);
  return record;
}

/** Re-verify a stored record (the reload profile). Never throws; a slice that fails is absent. */
export async function loadOffline(
  record: OfflineRecord,
  opts: { pinned: TrustSet; product: string; now: number },
): Promise<OfflineState> {
  const out: OfflineState = {
    deviceId: record.deviceId,
    license: null,
    config: null,
    importedBundle: null,
    highWaterMark: 0,
    lastVerifiedAt: null,
  };
  const rec = record.cache;
  // §4.1 — another cache version is discarded, never migrated.
  if (!rec || rec.v !== CACHE_VERSION) return out;
  const dated: { issuedAt: number }[] = [];
  let trust = opts.pinned;
  if (rec.trustJws) {
    const manifest = await verifyTrustManifest(rec.trustJws, {
      pinned: opts.pinned,
      expectedAud: opts.product,
      now: opts.now,
      checkFreshness: false,
    });
    if (manifest.doc) {
      trust = mergeTrust(opts.pinned, manifest.discovered);
      dated.push(manifest.doc);
    }
  }
  const reload = {
    trust,
    expectedAud: opts.product,
    deviceId: record.deviceId,
    now: opts.now,
    checkFreshness: false as const,
  };
  let newest = 0;
  if (rec.docs?.license) {
    out.license = await verifyLicenseDoc(rec.docs.license, reload);
    if (out.license) {
      dated.push(out.license);
      newest = Math.max(newest, out.license.issuedAt);
    }
  }
  if (rec.docs?.config) {
    out.config = await verifyConfigDoc(rec.docs.config, reload);
    if (out.config) {
      dated.push(out.config);
      newest = Math.max(newest, out.config.issuedAt);
    }
  }
  // The marker means something only with a document behind it that still verifies.
  if (rec.importedBundle && (out.license || out.config))
    out.importedBundle = rec.importedBundle;
  out.highWaterMark = highWaterMark(dated);
  out.lastVerifiedAt = newest > 0 ? newest * 1000 : null;
  return out;
}

/** Human-readable causes, as `@polaris-key/node` gives them, so a UI can say WHICH thing is
 *  wrong with the file it was handed. The machine-readable form is `wireCode`. */
const MESSAGES: Record<BundleRefusalReason, string> = {
  "bundle-jws-rejected":
    "The bundle's signature, type or size was not acceptable.",
  "bundle-claims-rejected":
    "The bundle is not addressed to this device, or its import window has closed.",
  "bundle-trust-rejected":
    "The trust manifest inside the bundle was rejected against the pinned keys.",
  "inner-doc-rejected":
    "A document inside the bundle failed verification; nothing was imported.",
};

/**
 * §7 steps 1–5: verify `jws` for this device and, only if every step passed, replace the stored
 * cache with what it carried. Throws `bundle-rejected` (`wireCode` = the step) and writes nothing
 * on any refusal.
 */
export async function importOfflineBundle(
  store: OfflineStore,
  product: string,
  jws: string,
  opts: { pinned: TrustSet; now: number },
): Promise<ImportBundleResult> {
  const record = await ensureRecord(store, product);
  const result = await inspectBundle(jws, {
    pinned: opts.pinned,
    product,
    deviceId: record.deviceId,
    now: opts.now,
  });
  if (!result.ok)
    throw new PolarisError(
      ErrorCode.bundleRejected,
      MESSAGES[result.reason],
      result.reason,
    );
  const { bundle } = result;
  const imported: ImportBundleResult["imported"] = [];
  if (bundle.docs.license) imported.push("license");
  if (bundle.docs.config) imported.push("config");
  // The update slices (`feeds`, `releaseRecords`) are not part of the bundle: they carry over,
  // so re-provisioning never resets a channel's `seq` floor.
  const prior = record.cache;
  await store.write(product, {
    deviceId: record.deviceId,
    cache: {
      v: CACHE_VERSION,
      ...(prior?.feeds ? { feeds: prior.feeds } : {}),
      ...(prior?.releaseRecords
        ? { releaseRecords: prior.releaseRecords }
        : {}),
      trustJws: bundle.trustJws,
      docs: {
        ...(bundle.docs.license ? { license: bundle.docs.license.jws } : {}),
        ...(bundle.docs.config ? { config: bundle.docs.config.jws } : {}),
      },
      importedBundle: { bundleId: bundle.bundleId, importedAt: opts.now },
    },
  });
  return { bundleId: bundle.bundleId, imported };
}
