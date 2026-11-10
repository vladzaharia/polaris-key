// Builds the browser's key ring engine. The adapter loads this module on the first ring call
// (`lazyKeyring`), so the engine, its crypto, the root vault stay
// out of the initial load of a page that never opens the ring.
import type { BearerSession } from "../bearer/session.js";
import type { BrowserAdapterOptions } from "../browserAdapter.js";
import { watchingAccountRequired } from "../cloudSync/accountRequired.js";
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
  /** A ring route answered `account_required`: Cloud Sync is told, with the answer's `signInUrl`
   *  and the person signed in when the call started. */
  onAccountRequired?: (
    signInUrl: string | null,
    forSubject: string | null,
  ) => void;
  /** The Worker's origin: only its own answer counts. */
  origin: string;
}): RingEngine {
  const { product, bearer: b, options: o } = a;
  const keys = o.deviceKeys;
  return new RingEngine({
    product,
    deviceId: () => b.deviceId,
    transport: {
      request: watchingAccountRequired(
        (path: string, init: { method: string; body?: string }) =>
          b.ringRequest(path, init),
        a.onAccountRequired,
        { origin: a.origin, subject: () => b.account },
      ),
    },
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
