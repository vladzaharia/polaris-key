// Builds the browser Cloud Sync host for one adapter (U-20.2). Loaded with the host, on the first
// call that needs it, so the adapter itself carries only the lazy client.

import type { ProductCatalog } from "@polaris-key/catalog";
import type { CloudSyncDocument } from "@polaris-key/client-core/cloud-sync";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import type { KeyringClient } from "../../core/keyring.js";
import { Feature } from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import type { BearerSession } from "../bearer/session.js";
import { BrowserCloudSyncHost, type CloudSyncHostOptions } from "./host.js";
import { syncStateStore } from "./store.js";
import { broadcastChannel, webLocks } from "./writer.js";

export interface BrowserCloudSyncArgs {
  product: string;
  /** The IndexedDB database name, `pkey-sync-<product>`. */
  dbName: string;
  bearer: BearerSession;
  ring: KeyringClient;
  options: CloudSyncHostOptions | undefined;
  /** The catalog the adapter was given (`catalog`), used when `cloudSync.catalog` is not set. */
  mirror: ProductCatalog | undefined;
  /** The loaded discovery document's `services.sync`, or null. */
  discovery: () => { enabled?: unknown; encryption?: unknown } | null;
  fetchSchema: () => Promise<ProductCatalog | null>;
  configEntries: () => Record<string, ManagedEntry>;
  enabled: () => boolean;
}

/** `pagehide` and `pageshow` on the window, or nothing where there is none. */
function pageEvents():
  | { on(type: "pagehide" | "pageshow", fn: () => void): () => void }
  | undefined {
  const w = (globalThis as { window?: EventTarget }).window;
  if (!w || typeof w.addEventListener !== "function") return undefined;
  return {
    on(type, fn) {
      w.addEventListener(type, fn);
      return () => w.removeEventListener(type, fn);
    },
  };
}

/** The document the machine resolves against: the signed config's values and its locked keys. */
export function documentOf(
  entries: Record<string, ManagedEntry>,
): CloudSyncDocument {
  return {
    values: Object.fromEntries(
      Object.entries(entries).map(([k, e]) => [k, e.value]),
    ),
    locked: Object.entries(entries)
      .filter(([, e]) => e.state === "enforced" || e.state === "hidden")
      .map(([k]) => k),
  };
}

/** The started host. Throws the typed unsupported where the browser has no Web Locks: one writer
 *  tab cannot be kept without them, and two writers would double-send. */
export async function createBrowserCloudSync(
  a: BrowserCloudSyncArgs,
): Promise<BrowserCloudSyncHost> {
  const locks = webLocks();
  if (locks === null)
    throw new UnsupportedError({
      supported: false,
      feature: Feature.syncSettings,
      reason: "runtime",
      detail:
        "Cloud Sync keeps one writer tab through Web Locks, and this browser has none.",
    });
  const page = pageEvents();
  const host = new BrowserCloudSyncHost(
    {
      product: a.product,
      request: (path, init) => a.bearer.ringRequest(path, init),
      ring: a.ring,
      discovery: a.discovery,
      fetchSchema: a.fetchSchema,
      document: () => documentOf(a.configEntries()),
      enabled: a.enabled,
      store: syncStateStore(a.dbName),
      locks,
      writerLock: `pkey-sync-writer:${a.dbName}`,
      stateLock: `pkey-sync-state:${a.dbName}`,
      channel: broadcastChannel(a.dbName),
      ...(page ? { page } : {}),
    },
    {
      ...a.options,
      ...((a.options?.catalog ?? a.mirror)
        ? { catalog: (a.options?.catalog ?? a.mirror)! }
        : {}),
    },
  );
  await host.start();
  return host;
}
