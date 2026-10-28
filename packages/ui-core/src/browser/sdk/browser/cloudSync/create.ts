// Builds the browser Cloud Sync host for one adapter (U-20.2). Loaded with the host, on the first
// call that needs it, so the adapter itself carries only the lazy client.

import type { ProductCatalog } from "@polaris-key/catalog";
import type { CloudSyncDocument } from "@polaris-key/client-core/cloud-sync";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import type { KeyringClient } from "../../core/keyring.js";
import { Feature } from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import type { BearerSession } from "../bearer/session.js";
import type { CloudSyncClient } from "../../core/cloudSync.js";
import type { LocalConfigEngine } from "../../core/localConfig.js";
import { BrowserCloudSyncApi, clientOf, importMarker } from "./api.js";
import { BrowserCloudSyncHost, type CloudSyncHostOptions } from "./host.js";
import { syncStateStore } from "./store.js";
import { broadcastChannel, webLocks } from "./writer.js";

/**
 * The adapter's own members the host reads (private there; this lazy module takes the adapter
 * as one object so the adapter itself carries no closures for them).
 */
export interface CloudSyncOwner {
  product: string;
  keyring: KeyringClient;
  cloudSyncOptions: CloudSyncHostOptions | undefined;
  catalogOption: ProductCatalog | undefined;
  discovery_: { services?: { sync?: unknown } } | null;
  fetchSchema(): Promise<ProductCatalog | null>;
  store: { get(): { configEntries: Record<string, ManagedEntry> } };
  capabilities: { sync: { enabled: boolean } };
  config: LocalConfigEngine;
  /** The Worker's base URL. */
  base: string;
  /** The signed-in person, null for none, undefined when it could not be read. */
  syncSubject(): Promise<string | null | undefined>;
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
  o: CloudSyncOwner,
  bearer: BearerSession,
  dbName: string,
): Promise<CloudSyncClient> {
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
      product: o.product,
      request: (path, init) => bearer.ringRequest(path, init),
      ring: o.keyring,
      discovery: () =>
        (o.discovery_?.services?.sync as
          | { enabled?: unknown; encryption?: unknown }
          | undefined) ?? null,
      fetchSchema: () => o.fetchSchema(),
      document: () => documentOf(o.store.get().configEntries),
      enabled: () => o.capabilities.sync.enabled,
      store: syncStateStore(dbName),
      locks,
      writerLock: `pkey-sync-writer:${dbName}`,
      stateLock: `pkey-sync-state:${dbName}`,
      channel: broadcastChannel(dbName),
      ...(page ? { page } : {}),
    },
    {
      ...o.cloudSyncOptions,
      ...((o.cloudSyncOptions?.catalog ?? o.catalogOption)
        ? { catalog: (o.cloudSyncOptions?.catalog ?? o.catalogOption)! }
        : {}),
    },
  );
  await host.start();
  const api = new BrowserCloudSyncApi({
    host,
    keyring: o.keyring,
    config: o.config,
    subject: () => o.syncSubject(),
    marker: importMarker(`${dbName}:imported`),
    signInOrigin: new URL(o.base).origin,
  });
  return clientOf(api, host);
}
