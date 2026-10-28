// `adapter.connect` (CC-09.1, connect.identity): the lean facade. Nothing of the verifier or the
// state record loads until a call needs it, so a page that never uses Connect pays only for this
// file. One call runs at a time (identity, current, listDevices, discoveryKeys and leave queue);
// `leave()` needs no verifier, only the state store.

import { ErrorCode, Feature } from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import { PolarisError } from "../../core/types.js";
import type {
  ConnectDevice,
  ConnectEnv,
  ConnectIdentity,
  DiscoveryKeys,
} from "./client.js";

export type {
  ConnectDevice,
  ConnectEnv,
  ConnectIdentity,
  DiscoveryKeys,
} from "./client.js";

/** `adapter.connect`: this device's Cloud Connect identity. */
export interface ConnectClient {
  /** The held identity, fetched first when none is held, when the certificate has under 3.5 days
   *  left, or when `refresh` is set (which always fetches). Makes and registers this device's
   *  keys on first need. Throws `PolarisError`: `connect-unavailable` (Connect is off here),
   *  `invalid-options` (memory-only keys the host did not allow), `no-token`, `peer-cert-invalid`
   *  (a roster or certificate that does not verify), `bad_response` (a malformed answer),
   *  `store-failed` (an unreadable state record) and the Worker's own refusals. */
  identity(opts?: { refresh?: boolean }): Promise<ConnectIdentity>;
  /** The held identity, verified again now; null when none is held or it lapsed. Sends nothing. */
  current(): Promise<ConnectIdentity | null>;
  /** `GET /<p>/connect/devices`: the person's devices, display data only. */
  listDevices(): Promise<ConnectDevice[]>;
  /** K_disc as bytes for the relay client, or null when none is held. @internal */
  discoveryKeys(): Promise<DiscoveryKeys | null>;
  /** Forget the held roster, certificate and K_disc. The device keys and the Worker's roster stay.
   *  A no-op when nothing is held. */
  leave(): Promise<void>;
}

/** A cookie page holds no device token, so it has no Connect identity. */
export function unsupportedConnect(detail: string): ConnectClient {
  const no = (): never => {
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.connectIdentity,
        reason: "runtime",
        detail,
      },
      ErrorCode.connectUnavailable,
    );
  };
  return {
    identity: async () => no(),
    current: async () => null,
    listDevices: async () => no(),
    discoveryKeys: async () => null,
    leave: async () => undefined,
  };
}

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
    leave: () =>
      serial(async () => {
        try {
          for (const store of [env.stores.memory, env.stores.durable()]) {
            // Nothing held means nothing to forget; an unreadable record is cleared too.
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
