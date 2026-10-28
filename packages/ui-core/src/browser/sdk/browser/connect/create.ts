// The Cloud Connect engine's wiring. The adapter loads this module on the first Connect call
// (`lazyConnect`), so the engine, its state stores and their IndexedDB code stay out of the
// initial load of a page that never uses Connect.
import { PolarisError } from "../../core/types.js";
import { ErrorCode } from "../../constants.generated.js";
import { storeNamespace } from "../../core/storeNamespace.js";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import type { BearerSession } from "../bearer/session.js";
import type { BrowserAdapterOptions } from "../browserAdapter.js";
import type { RingAdoption, TrustApplication } from "./channel.js";
import type { ConnectEnv } from "./client.js";
import type { ConnectClient } from "./index.js";
import { indexedDbConnectState, memoryConnectState } from "./state.js";

export function createConnect(env: ConnectEnv): ConnectClient {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = tail.then(f, f);
    tail = run.catch(() => undefined);
    return run;
  };
  let engine: Promise<import("./client.js").ConnectEngine> | null = null;
  const load = (): Promise<import("./client.js").ConnectEngine> =>
    (engine ??= import("./client.js").then((m) => new m.ConnectEngine(env)));
  return {
    identity: (opts = {}) =>
      serial(async () => (await load()).identity(opts.refresh === true)),
    current: () => serial(async () => (await load()).current()),
    listDevices: () => serial(async () => (await load()).listDevices()),
    discoveryKeys: () => serial(async () => (await load()).discoveryKeys()),
    relayTicket: () => serial(async () => (await load()).relayTicket()),
    relaySource: () => ({
      now: () => env.now(),
      load: () => serial(async () => (await load()).peerIdentity()),
      refresh: async () => {
        await serial(async () => (await load()).identity(true));
      },
      adoptRing: (jws: string): Promise<RingAdoption> =>
        serial(async () => (await load()).adoptRing(jws)),
      applyTrust: (jws: string): Promise<TrustApplication> =>
        serial(async () => (await load()).applyTrust(jws)),
      ticket: () => serial(async () => (await load()).relayTicket()),
    }),
    leave: () =>
      serial(async () => {
        try {
          for (const store of [env.stores.memory, env.stores.durable()]) {
            // Nothing held means nothing to forget; an unreadable record is cleared too. A store
            // that cannot hold anything is not opened, so no empty database appears.
            if ((await store.mayHold?.()) === false) continue;
            if ((await store.get()) !== null) await store.clear();
          }
        } catch (e) {
          throw e instanceof PolarisError
            ? e
            : new PolarisError(
                ErrorCode.storeFailed,
                "The Cloud Connect state could not be cleared.",
              );
        }
      }),
  };
}

/** The page's `connect`: the engine over the bearer session. */
export function createBrowserConnect(a: {
  product: string;
  base: string;
  bearer: BearerSession;
  options: NonNullable<BrowserAdapterOptions["connect"]>;
  now: () => number;
  discovery: () => Promise<Record<string, unknown> | null>;
  deviceKeys: () => Promise<DeviceKeyPort>;
}): ConnectClient {
  const { bearer: b, options: o } = a;
  const name = `pkey-connect-${storeNamespace(a.product, a.base)}`;
  let durable: ReturnType<typeof indexedDbConnectState> | null = null;
  return createConnect({
    product: a.product,
    baseUrl: a.base,
    applyTrust: (jws) => b.acceptPeerTrust(jws),
    device: async () => {
      await b.init();
      return { deviceId: b.deviceId, hasToken: b.hasToken };
    },
    request: (path, init) => b.ringRequest(path, init),
    registerKeys: (port, opts) => b.registerKeys(port, opts),
    trust: () => b.effectiveTrust(),
    now: a.now,
    discovery: a.discovery,
    keys: async () => o.deviceKeys ?? a.deviceKeys(),
    allowEphemeralKeys: o.allowEphemeralKeys === true,
    stores: {
      durable: () => (durable ??= indexedDbConnectState(name)),
      memory: memoryConnectState(),
    },
  });
}
