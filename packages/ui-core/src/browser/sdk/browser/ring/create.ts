// Builds the browser's key ring engine. The adapter loads this module on the first ring call
// (`lazyKeyring`), so the engine, its crypto, the root vault stay
// out of the initial load of a page that never opens the ring.
import type { BearerSession } from "../bearer/session.js";
import type { BrowserAdapterOptions } from "../browserAdapter.js";
import { RingEngine } from "./engine.js";
import { indexedDbRootVault } from "./rootVault.js";

export function createRingEngine(a: {
  product: string;
  bearer: BearerSession;
  options: NonNullable<BrowserAdapterOptions["keyring"]> & {
    deviceKeys: NonNullable<
      NonNullable<BrowserAdapterOptions["keyring"]>["deviceKeys"]
    >;
  };
}): RingEngine {
  const { product, bearer: b, options: o } = a;
  const keys = o.deviceKeys;
  return new RingEngine({
    product,
    deviceId: () => b.deviceId,
    transport: { request: (path, init) => b.ringRequest(path, init) },
    keys,
    ensureKeysRegistered: async () => {
      await b.registerKeys(keys);
    },
    vault: o.vault ?? indexedDbRootVault(`pkey-sync-ring-${product}`),
    ...(o.sessionRootSeconds !== undefined
      ? { sessionRootSeconds: o.sessionRootSeconds }
      : {}),
  });
}
