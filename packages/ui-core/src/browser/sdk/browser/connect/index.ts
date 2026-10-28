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
import type { RingAdoption, TrustApplication } from "./channel.js";
import type { RelayGrant } from "./errors.js";
import type { RelaySource } from "./relay.js";
import type {
  CloudConnect,
  CloudConnectOptions,
  CloudConnectStatus,
  CloudPeer,
} from "./cloud.js";
import type { ConnectNotice } from "./channel.js";
import type { ConnectSession } from "./session.js";
import { setSignOutStop } from "./signout.js";
import { LanError } from "./errors.js";
import type { Unsupported } from "@polaris-key/client-core";

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
  /** What the relay reads, every call queued behind the others. @internal */
  relaySource(): RelaySource;
  /** `POST /<p>/connect/relay/ticket`. @internal */
  relayTicket(): Promise<RelayGrant>;
  /** The record's Web Lock name; the relay lock is derived from it. @internal */
  readonly lockName: string;
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
    lockName: "pkey-connect:unsupported",
    relaySource: () => no(),
    relayTicket: async () => no(),
  };
}

/**
 * The page's `connect`, before its engine is loaded: every call loads `create.ts` (the engine's
 * wiring and its stores) first, so a page that never uses Connect pays only for this facade.
 * `now` and `lockName` are the sync members the relay reads.
 */
export function lazyConnect(
  host: { now: () => number; lockName: string },
  load: () => Promise<ConnectClient>,
): ConnectClient {
  let client: Promise<ConnectClient> | null = null;
  const ready = (): Promise<ConnectClient> =>
    (client ??= load().catch((e: unknown) => {
      client = null;
      throw e;
    }));
  return {
    lockName: host.lockName,
    identity: async (opts) => (await ready()).identity(opts),
    current: async () => (await ready()).current(),
    listDevices: async () => (await ready()).listDevices(),
    discoveryKeys: async () => (await ready()).discoveryKeys(),
    relayTicket: async () => (await ready()).relayTicket(),
    leave: async () => (await ready()).leave(),
    relaySource: () => ({
      now: host.now,
      load: async () => (await ready()).relaySource().load(),
      refresh: async () => (await ready()).relaySource().refresh?.(),
      adoptRing: async (jws) => (await ready()).relaySource().adoptRing!(jws),
      applyTrust: async (jws) => (await ready()).relaySource().applyTrust!(jws),
      ticket: async () => (await ready()).relaySource().ticket(),
    }),
  };
}

// ── Cloud Connect over the relay (CC-09.2) ───────────────────────────────────────────────────

export type {
  CloudConnectOptions,
  CloudPeer,
  CloudConnectStatus,
} from "./cloud.js";
export type { ConnectNotice } from "./channel.js";
export type {
  RelayOptions,
  RelaySocket,
  RelayState,
  RelayStatus,
} from "./relay.js";
export {
  RelayError,
  LanError,
  RELAY_MODES,
  assertRelayMode,
} from "./errors.js";
export type { RelayErrorReason, RelayGrant } from "./errors.js";
export type {
  ConnectSession,
  SessionClosed,
  SessionMessage,
  SessionPath,
} from "./session.js";

/** `adapter.cloudConnect`: Cloud Connect over the relay, the only path a page has. */
export interface CloudConnectClient {
  /** Why Connect is unavailable on this transport, or null when it runs. */
  readonly unsupported: Unsupported | null;
  /** Get the identity (making and registering the device keys on first use) and connect to the
   *  relay. Throws what `connect.identity()` throws. */
  start(opts?: CloudConnectOptions): Promise<void>;
  /** Close the sessions and the relay socket. Safe to call more than once. */
  stop(): Promise<void>;
  /** The person's other devices online in the relay room now. */
  peers(): CloudPeer[];
  refreshPeers(): Promise<CloudPeer[]>;
  /** `GET /<p>/connect/devices`: display data only. */
  devices(): Promise<ConnectDevice[]>;
  /** A session to one of the person's devices over the relay (`LanError` `not_started` before
   *  `start()`; a typed `RelayError` otherwise). */
  open(deviceId: string): Promise<ConnectSession>;
  /** Called with each session another device opened to this one. */
  onChannel(fn: (s: ConnectSession) => void): () => void;
  /** Called when a roster or trust manifest a peer pushed is stored, applied or refused. */
  onNotice(fn: (n: ConnectNotice) => void): () => void;
  status(): CloudConnectStatus;
  /** Called when the relay's state or the online devices change (what a UI re-renders on). */
  onChange(fn: () => void): () => void;
}

/** A cookie page or a host without sockets: every verb that needs the relay is the typed N/A. */
export function unsupportedCloudConnect(
  reason: "runtime" | "version",
  detail: string,
): CloudConnectClient {
  const unsupported: Unsupported = {
    supported: false,
    feature: Feature.connectApp,
    reason,
    detail,
  };
  const no = (): never => {
    throw new UnsupportedError(unsupported, ErrorCode.connectUnavailable);
  };
  return {
    unsupported,
    onChange: () => () => undefined,
    start: async () => no(),
    stop: async () => undefined,
    peers: () => [],
    refreshPeers: async () => no(),
    devices: async () => no(),
    open: async () => no(),
    onChannel: () => () => undefined,
    onNotice: () => () => undefined,
    status: () => ({
      running: false,
      lan: "off",
      lanError: null,
      relay: "off",
      relayError: null,
    }),
  };
}

/** The lean facade. The relay, the Noise session code and the wire codec load on `start()`; a
 *  page that never starts Connect pays only for this file. */
export function createCloudConnect(connect: ConnectClient): CloudConnectClient {
  const channel = new Set<(s: ConnectSession) => void>();
  const notice = new Set<(n: ConnectNotice) => void>();
  const change = new Set<() => void>();
  let engine: CloudConnect | null = null;
  let loading: Promise<CloudConnect> | null = null;
  const load = (): Promise<CloudConnect> =>
    (loading ??= import("./cloud.js").then(
      (m) =>
        (engine = new m.CloudConnect(connect, {
          channel: (s) => {
            for (const f of [...channel]) f(s);
            return channel.size > 0;
          },
          notice: (n) => {
            for (const f of [...notice]) f(n);
          },
          change: () => {
            for (const f of [...change]) f();
          },
        })),
    ));
  const client: CloudConnectClient = {
    unsupported: null,
    onChange: (fn) => {
      change.add(fn);
      return () => change.delete(fn);
    },
    start: async (opts) => (await load()).start(opts),
    stop: async () => {
      // Never loaded means never started.
      if (loading !== null) await (await loading).stop();
    },
    peers: () => engine?.peers() ?? [],
    refreshPeers: async () => (engine ? engine.refreshPeers() : []),
    devices: () => connect.listDevices(),
    open: async (id) => {
      if (engine === null)
        throw new LanError("not_started", "Cloud Connect is not started.");
      return engine.open(id);
    },
    onChannel: (fn) => {
      channel.add(fn);
      return () => channel.delete(fn);
    },
    onNotice: (fn) => {
      notice.add(fn);
      return () => notice.delete(fn);
    },
    status: () =>
      engine?.status() ?? {
        running: false,
        lan: "off",
        lanError: null,
        relay: "off",
        relayError: null,
      },
  };
  // Never loaded means never started: nothing to stop at sign-out.
  setSignOutStop(client, async () => {
    if (loading !== null) await (await loading).stopForSignOut();
  });
  return client;
}
