// Offline bundle import for the browser transport (WIRE-CONTRACT-V4 §7, P1b-07).
//
// A browser has no hardware fingerprint and no keyring (PARITY §7), so its device identity is a
// RANDOM id minted once and kept in IndexedDB, and its offline cache is a small IndexedDB record
// beside it: the verified bundle's trust manifest and inner documents, plus the bundle's own
// signed JWS (`bundle`) and the evidence for any revoked pin (`pinRevocations`). An operator
// mints a bundle against that id; the page imports it with no network at all.
//
// ── THE SAME RULES AS EVERY OTHER SDK ───────────────────────────────────────────────────────
//
//   * Steps 1–4 are `@polaris-key/client-core`'s `inspectBundle`, the verifier the corpus's
//     `bundleCases` pin byte-for-byte in every SDK. A refusal names the step and writes NOTHING.
//   * Step 5, the write, REPLACES the record: importing a bundle is a re-provisioning.
//   * Each inner document must be strictly newer than the verified cached one of its type (the
//     per-type floors), and a byte-identical re-import is a success with no write.
//   * What is stored is SIGNED ARTIFACTS ONLY (`CacheRecordV3`), re-verified on every load —
//     the pin evidence against the pins, the trust manifest against the USABLE pins, each
//     document against the effective set, bound to the stored device id, on the reload profile
//     (`checkFreshness: false`; `graceUntil` is the gate's job, against the monotonic floor), and
//     the bundle itself on the bundle RELOAD profile (no import window), counting only while its
//     documents are the cached ones byte for byte. A slice that no longer verifies is dropped.
//     Nothing decoded is ever trusted from storage, so editing IndexedDB by hand can delete an
//     activation but never invent one.
//
// No token is created: `activation: "bundle"` is what the gate reads instead, and an
// authenticated session (the browser's `"token"`) supersedes it (§7).

import {
  CACHE_VERSION,
  compareKidBytes,
  highWaterMark,
  inspectBundle,
  loadPinRevocations,
  mergeTrust,
  usablePins,
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
  /** The cached bundle, when it re-verified on the reload profile. `activates`: it carried a
   *  licence document byte-identical to the cached one, which is `activation: "bundle"` (no
   *  session held). */
  bundle: CachedBundle | null;
  /** The tombstoned pins, re-derived from `pinRevocations` (§1, §4.1). */
  tombstones: string[];
  /** The evidence that re-verified, kid → revoking manifest. */
  pinRevocations: Record<string, string>;
  /** The verified trust manifest's `issuedAt`, when one is held. */
  trustIssuedAt: number | null;
  /** §4.2 — `max(issuedAt)` over the manifest and both documents. */
  highWaterMark: number;
  /** Epoch MILLIseconds of the newest signed `issuedAt`, as the Node cache derives it. */
  lastVerifiedAt: number | null;
}

const DB_NAME = "polaris-key";
const STORE_NAME = "offline";
/** The device token (bearer mode, `./bearer/store.ts`). A separate object store, so importing a
 *  bundle — which REPLACES the offline record (§7 step 5) — never drops the token, as in Node. */
export const TOKEN_STORE_NAME = "tokens";
/** Version 2 added `tokens`; the upgrade creates whichever store is missing. */
const DB_VERSION = 2;

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

const openers = new WeakMap<IDBFactory, () => Promise<IDBDatabase>>();

/** The one `polaris-key` database for a factory, opened once and shared by the offline and
 *  token stores. A failed open is forgotten, so it does not poison every later call. */
export function openPolarisDb(factory: IDBFactory): Promise<IDBDatabase> {
  let open = openers.get(factory);
  if (!open) {
    let db: Promise<IDBDatabase> | null = null;
    open = () => {
      if (!db) {
        const req = factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          for (const name of [STORE_NAME, TOKEN_STORE_NAME])
            if (!req.result.objectStoreNames.contains(name))
              req.result.createObjectStore(name);
        };
        db = request(req);
        db.catch(() => {
          db = null;
        });
      }
      return db;
    };
    openers.set(factory, open);
  }
  return open();
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
  return {
    async read(product) {
      const tx = (await openPolarisDb(factory)).transaction(
        STORE_NAME,
        "readonly",
      );
      const value = await request(tx.objectStore(STORE_NAME).get(product));
      return isRecord(value) ? value : null;
    },
    async write(product, record) {
      const tx = (await openPolarisDb(factory)).transaction(
        STORE_NAME,
        "readwrite",
      );
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
    bundle: null,
    tombstones: [],
    pinRevocations: {},
    trustIssuedAt: null,
    highWaterMark: 0,
    lastVerifiedAt: null,
  };
  const rec = record.cache;
  // §4.1 — another cache version is discarded, never migrated.
  if (!rec || rec.v !== CACHE_VERSION) return out;
  // §4.1 — the pin evidence first: everything below verifies against the usable pins.
  const evidence = await loadPinRevocations(rec.pinRevocations, {
    pinned: opts.pinned,
    expectedAud: opts.product,
  });
  out.tombstones = evidence.tombstones;
  out.pinRevocations = evidence.kept;
  const dated: { issuedAt: number }[] = [];
  let trust = usablePins(opts.pinned, out.tombstones);
  if (rec.trustJws) {
    const manifest = await verifyTrustManifest(rec.trustJws, {
      pinned: opts.pinned,
      tombstones: out.tombstones,
      expectedAud: opts.product,
      now: opts.now,
      checkFreshness: false,
    });
    if (manifest.doc) {
      for (const kid of manifest.revokedPins)
        out.pinRevocations[kid] = rec.trustJws;
      out.tombstones = [...out.tombstones, ...manifest.revokedPins].sort(
        compareKidBytes,
      );
      trust = mergeTrust(
        usablePins(opts.pinned, out.tombstones),
        manifest.discovered,
      );
      out.trustIssuedAt = manifest.doc.issuedAt;
      dated.push(manifest.doc);
    }
  }
  const reload = {
    trust,
    expectedAud: opts.product,
    deviceId: record.deviceId,
    now: opts.now,
    // Reload: no floor (explicit).
    lastAcceptedIssuedAt: null,
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
  out.bundle = await reloadBundle(rec, {
    pinned: opts.pinned,
    tombstones: out.tombstones,
    product: opts.product,
    deviceId: record.deviceId,
    now: opts.now,
    license: out.license ? rec.docs?.license : undefined,
  });
  out.highWaterMark = highWaterMark(dated);
  out.lastVerifiedAt = newest > 0 ? newest * 1000 : null;
  return out;
}

/** A cached bundle that re-verified: what it carried, and whether it activates. */
export interface CachedBundle {
  bundleId: string;
  docs: ("license" | "config")[];
  activates: boolean;
}

/**
 * WIRE-CONTRACT-V4 §4.1, §7: the cached bundle (`rec.bundle`) on the RELOAD profile, against the
 * usable pins. It activates only while the licence document it carries is the cached one that
 * verified, byte for byte (`license` is that cached JWS, or undefined when absent or failed): a
 * stale bundle cannot vouch for a licence it never carried.
 */
export async function reloadBundle(
  rec: CacheRecordV3,
  opts: {
    pinned: TrustSet;
    tombstones: readonly string[];
    product: string;
    deviceId: string;
    now: number;
    license: string | undefined;
  },
): Promise<CachedBundle | null> {
  if (typeof rec.bundle !== "string") return null;
  const result = await inspectBundle(rec.bundle, {
    pinned: opts.pinned,
    tombstones: opts.tombstones,
    product: opts.product,
    deviceId: opts.deviceId,
    now: opts.now,
    floors: { license: null, config: null },
    profile: "reload",
  });
  if (!result.ok) return null;
  const { docs } = result.bundle;
  return {
    bundleId: result.bundle.bundleId,
    docs: [
      ...(docs.license ? (["license"] as const) : []),
      ...(docs.config ? (["config"] as const) : []),
    ],
    activates: docs.license !== undefined && docs.license.jws === opts.license,
  };
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
 * on any refusal. A byte-identical re-import of the bundle this page runs on succeeds without a
 * write.
 */
export async function importOfflineBundle(
  store: OfflineStore,
  product: string,
  jws: string,
  opts: { pinned: TrustSet; now: number },
): Promise<ImportBundleResult> {
  const record = await ensureRecord(store, product);
  // What the device holds now, re-verified: the floors, the tombstones, the held manifest.
  const held = await loadOffline(record, {
    pinned: opts.pinned,
    product,
    now: opts.now,
  });
  if (held.bundle !== null && record.cache?.bundle === jws)
    return { bundleId: held.bundle.bundleId, imported: [...held.bundle.docs] };
  const result = await inspectBundle(jws, {
    pinned: opts.pinned,
    tombstones: held.tombstones,
    product,
    deviceId: record.deviceId,
    now: opts.now,
    floors: {
      license: held.license?.issuedAt ?? null,
      config: held.config?.issuedAt ?? null,
    },
    profile: "import",
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
  // so re-provisioning never resets a channel's `seq` floor. So does the pin evidence, joined by
  // any the bundle's own manifest adds; and the held manifest when it is newer (§7 step 5).
  const prior = record.cache;
  const evidence = { ...held.pinRevocations };
  for (const kid of bundle.revokedPins) evidence[kid] = bundle.trustJws;
  const keepHeld =
    held.trustIssuedAt !== null &&
    held.trustIssuedAt > bundle.trustIssuedAt &&
    typeof prior?.trustJws === "string";
  await store.write(product, {
    deviceId: record.deviceId,
    cache: {
      v: CACHE_VERSION,
      ...(prior?.feeds ? { feeds: prior.feeds } : {}),
      ...(prior?.releaseRecords
        ? { releaseRecords: prior.releaseRecords }
        : {}),
      ...(Object.keys(evidence).length > 0 ? { pinRevocations: evidence } : {}),
      trustJws: keepHeld ? prior!.trustJws! : bundle.trustJws,
      docs: {
        ...(bundle.docs.license ? { license: bundle.docs.license.jws } : {}),
        ...(bundle.docs.config ? { config: bundle.docs.config.jws } : {}),
      },
      bundle: jws,
    },
  });
  return { bundleId: bundle.bundleId, imported };
}
