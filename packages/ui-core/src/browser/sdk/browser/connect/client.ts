// The browser's Cloud Connect identity client (CC-09.1; WIRE-CONTRACT-V5 §15.2, §15.3, §15.4,
// §15.8), the same rules as the Node client (sdk-node `connect/client.ts`). On first need it makes
// this device's keys (the page's non-extractable `DeviceKeyPort`) and registers them
// (`PUT /<p>/devices/keys`), fetches `GET /<p>/connect/identity` (the roster, this device's
// certificate and K_disc), verifies both with client-core's `peer/cert` against the effective
// product set, and keeps them as `pkey.connect.v1` (state.ts). The relay client follows in CC-09.2
// and reads this state.
//
// Rules this module keeps:
//  - the keys never leave the `DeviceKeyPort`; a memory-only port refuses unless the host opts in
//    (`allowEphemeralKeys`), because every reload would be a key change and the Worker allows 4 a
//    day;
//  - a roster or certificate that does not verify is never stored. A roster that is expired, for
//    another subject or device, certifies other keys than this device's, or would replace the held
//    roster with a lower epoch (stale) or a different subject (foreign) is refused and the held
//    state is unchanged;
//  - K_disc is stored exactly as the latest answer delivered it, never merged with older answers.
//    A previous key is dropped when the roster lost a device or changed a device's keys since the
//    held one, and 24 hours after it was first seen;
//  - an unreadable state record is an error, never replaced; `leave()` clears it;
//  - K_disc is in no return value, error or print except `discoveryKeys()`, which hands out bytes
//    (non-enumerable, so a JSON dump of it shows nothing).

import {
  DeviceKeyUnsupportedError,
  DeviceKeysUnreadableError,
  type DeviceKeyPort,
  type DevicePublicKeys,
} from "@polaris-key/client-core";
import {
  ringExpired,
  verifyPeerCert,
  verifyRing,
  type PeerCert,
  type Ring,
} from "@polaris-key/client-core/peer";
import {
  MAX_RING_DEVICES,
  PEER_CERT_RENEW_SECONDS,
} from "@polaris-key/protocol/connect";
import {
  ErrorCode,
  ERROR_CODE_VALUES,
  Feature,
} from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import { PolarisError, type PolarisErrorCode } from "../../core/types.js";
import type { TrustSet } from "../offline.js";
import {
  CONNECT_STATE_SCHEMA,
  parseConnectState,
  type ConnectStateRecord,
  type ConnectStateStore,
} from "./state.js";

/** The Worker keeps the previous K_disc for 24 hours after a bump (§15.4). */
export const PREV_DISC_KEY_SECONDS = 86_400;

/** What the host sees of the held identity. No K_disc, no private key. */
export interface ConnectIdentity {
  /** The pairwise subject (`ps_…`) the roster belongs to. */
  sub: string;
  deviceId: string;
  /** The roster's epoch. */
  epoch: number;
  /** Every device of the person: id and public keys. */
  devices: Ring["devices"];
  /** This device's `pkey-peer+jws` (shown to peers in a handshake; not secret). */
  certificate: string;
  certificateExpiresAt: number;
  /** The held `pkey-ring+jws`. */
  ring: string;
  ringExpiresAt: number;
}

/** One of the person's devices, display data only (`GET /<p>/connect/devices`). */
export interface ConnectDevice {
  deviceId: string;
  label: string | null;
  platform: string | null;
  lastSeen: number | null;
  self: boolean;
}

/** The discovery keys as bytes, newest first (§15.4). A device advertises under `current` only.
 *  The fields are non-enumerable: `JSON.stringify` and a console print show nothing of them. */
export interface DiscoveryKeys {
  readonly current: Uint8Array;
  readonly previous: Uint8Array | null;
}

/** What the engine needs from its host page. */
export interface ConnectEnv {
  product: string;
  /** Loads what the session needs and answers the device id and whether a token is held. */
  device(): Promise<{ deviceId: string; hasToken: boolean }>;
  /** One authenticated request under `/<p>/`, as the bearer session sends it. */
  request(path: string, init: { method: string }): Promise<Response>;
  /** `PUT /<p>/devices/keys` with the port's keys. */
  registerKeys(
    port: DeviceKeyPort,
    opts: { allowEphemeral: boolean },
  ): Promise<unknown>;
  /** The effective product set (pins plus the signed trust manifest). */
  trust(): TrustSet;
  /** Seconds. */
  now(): number;
  /** The product's discovery document once loaded; null when it could not be. */
  discovery(): Promise<unknown>;
  /** The device keys: the host's, else the page's key store. */
  keys(): DeviceKeyPort | Promise<DeviceKeyPort>;
  allowEphemeralKeys: boolean;
  /** The record's homes: IndexedDB, and memory for a memory-only key store. */
  stores: { durable: () => ConnectStateStore; memory: ConnectStateStore };
}

/** A refusal of the identity answer: `peer-cert-invalid` when a certificate or roster failed
 *  verification, `bad_response` when the answer is not in the contract shape. */
const refuse = (reason: string, cert = true): PolarisError =>
  new PolarisError(
    cert ? ErrorCode.peerCertInvalid : ErrorCode.badResponse,
    `The Cloud Connect identity was refused: ${reason}.`,
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const B64 = /^[A-Za-z0-9_-]{43}$/;

function b64urlBytes(k: string): Uint8Array {
  const bin = atob(k.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const b64urlOf = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A 43-character key that decodes to 32 bytes and re-encodes to itself (canonical). */
function validDiscKey(v: unknown): v is string {
  if (typeof v !== "string" || !B64.test(v)) return false;
  try {
    const b = b64urlBytes(v);
    return b.length === 32 && b64urlOf(b) === v;
  } catch {
    return false;
  }
}

type Member = Ring["devices"][number];
const sameDevice = (a: Member, b: Member): boolean =>
  a.deviceId === b.deviceId &&
  a.signKey === b.signKey &&
  a.agreeKey === b.agreeKey;

const sameDevices = (a: Ring["devices"], b: Ring["devices"]): boolean =>
  a.length === b.length && a.every((d, i) => sameDevice(d, b[i]!));

/** The previous K_disc survives a roster change only while no device left or changed its keys
 *  (§15.4); otherwise only the newest key is kept. */
function keysAfterRing(keys: string[], prior: Ring, next: Ring): string[] {
  if (keys.length !== 2) return keys;
  const intact = prior.devices.every((d) =>
    next.devices.some((n) => sameDevice(n, d)),
  );
  return intact ? keys : [keys[0]!];
}

function hide<T extends object>(o: T): T {
  for (const k of Object.keys(o))
    Object.defineProperty(o, k, { enumerable: false });
  return o;
}

export class ConnectEngine {
  readonly #env: ConnectEnv;
  constructor(env: ConnectEnv) {
    this.#env = env;
  }

  /** The held identity, fetching it first when none is held, when it is nearing its end (the
   *  certificate has less than `PEER_CERT_RENEW_SECONDS` left, or the roster expired), when this
   *  device's keys changed, or when `refresh` is set (which bypasses that short-circuit). */
  async identity(refresh: boolean): Promise<ConnectIdentity> {
    await this.#available();
    const dev = await this.#device();
    const port = await this.#usePort();
    const mine = await this.#ensureKeys(port);
    const now = this.#env.now();
    const store = await this.#store();
    const held = await this.#load(store, dev.deviceId);
    const heldOk = held === null ? null : await this.#verifyHeld(held);
    if (
      !refresh &&
      held &&
      heldOk?.ring &&
      heldOk.cert &&
      this.#fresh(held, { ring: heldOk.ring, cert: heldOk.cert }, mine, now)
    )
      return this.#view(held, heldOk.ring, heldOk.cert);

    const registeredNow = await this.#registerIfNeeded(port, held);
    let res: Response;
    try {
      res = await this.#get("connect/identity");
    } catch (e) {
      if (
        registeredNow ||
        !(e instanceof PolarisError) ||
        (e.wireCode ?? e.code) !== ErrorCode.deviceKeysRequired
      )
        throw e;
      // The Worker forgot the keys (a purge): register once more and ask again.
      await this.#register(port);
      res = await this.#get("connect/identity");
    }
    const answer = parseAnswer(await readBody(res));
    const record = await this.#accept(
      answer,
      mine,
      dev.deviceId,
      heldOk,
      held,
      now,
    );
    try {
      await store.put(JSON.stringify(record.rec));
    } catch (e) {
      throw this.#storeError(e);
    }
    return record.view;
  }

  /** The held identity as it stands, verified again now; null when none is held, it does not
   *  verify any more or its roster expired. Sends nothing and makes no keys. */
  async current(): Promise<ConnectIdentity | null> {
    const dev = await this.#device();
    const held = await this.#load(await this.#store(), dev.deviceId);
    if (held === null) return null;
    const v = await this.#verifyHeld(held);
    return v.ring === null ||
      v.cert === null ||
      ringExpired(v.ring, this.#env.now())
      ? null
      : this.#view(held, v.ring, v.cert);
  }

  /** `GET /<p>/connect/devices`: the person's devices, display data only. */
  async listDevices(): Promise<ConnectDevice[]> {
    await this.#available();
    const dev = await this.#device();
    const port = await this.#usePort();
    const store = await this.#store();
    await this.#registerIfNeeded(port, await this.#load(store, dev.deviceId));
    const body = await readBody(await this.#get("connect/devices"));
    const list = isRecord(body) ? body.devices : null;
    if (!Array.isArray(list) || list.length > MAX_RING_DEVICES)
      throw refuse("the device list is not in the contract shape", false);
    return list.map((d): ConnectDevice => {
      if (
        !isRecord(d) ||
        typeof d.deviceId !== "string" ||
        typeof d.self !== "boolean"
      )
        throw refuse("a device entry is not in the contract shape", false);
      return {
        deviceId: d.deviceId,
        label: typeof d.label === "string" ? d.label : null,
        platform: typeof d.platform === "string" ? d.platform : null,
        lastSeen: Number.isSafeInteger(d.lastSeen)
          ? (d.lastSeen as number)
          : null,
        self: d.self,
      };
    });
  }

  /** K_disc as bytes for the relay client (CC-09.2), or null when none is held. The previous key
   *  is left out once 24 hours have passed since it was first seen. */
  async discoveryKeys(): Promise<DiscoveryKeys | null> {
    const dev = await this.#device();
    const held = await this.#load(await this.#store(), dev.deviceId);
    if (held === null) return null;
    const prev =
      held.discKeys.length === 2 &&
      held.prevUntil !== null &&
      this.#env.now() < held.prevUntil
        ? b64urlBytes(held.discKeys[1]!)
        : null;
    return hide({ current: b64urlBytes(held.discKeys[0]!), previous: prev });
  }

  // ── Identity ────────────────────────────────────────────────────────────────────────────────

  /** Verify the answer and decide what to store. Throws on any refusal; nothing is written before
   *  this returns. */
  async #accept(
    a: { ring: string; certificate: string; discKeys: string[] },
    mine: DevicePublicKeys,
    deviceId: string,
    heldOk: { ring: Ring | null; cert: PeerCert | null } | null,
    held: ConnectStateRecord | null,
    now: number,
  ): Promise<{ rec: ConnectStateRecord; view: ConnectIdentity }> {
    const trust = this.#env.trust();
    const expectedAud = this.#env.product;
    const r = await verifyRing(a.ring, { trust, expectedAud });
    if (!r.ok) throw refuse(`the roster does not verify (${r.reason})`);
    const c = await verifyPeerCert(a.certificate, { trust, expectedAud, now });
    if (!c.ok) throw refuse(`the certificate does not verify (${c.reason})`);
    const ring = r.ring;
    const cert = c.cert;
    if (ringExpired(ring, now)) throw refuse("the roster is expired");
    if (cert.sub !== ring.sub)
      throw refuse("the certificate and roster name different subjects");
    if (cert.deviceId !== deviceId)
      throw refuse("the certificate is for another device");
    if (cert.signKey !== mine.signKey || cert.agreeKey !== mine.agreeKey)
      throw refuse("the certificate certifies other keys than this device's");
    if (cert.ringEpoch !== ring.epoch)
      throw refuse("the certificate and roster are at different epochs");
    if (!ring.devices.some((d) => sameDevice(d, { ...cert })))
      throw refuse("this device is not in the roster");

    // The held roster is replaced only by a newer one of the same subject (§15.3). An expired
    // held roster counts as none. The same epoch may be refreshed, never changed.
    const prior =
      heldOk?.ring && !ringExpired(heldOk.ring, now) ? heldOk.ring : null;
    if (prior !== null) {
      if (prior.sub !== ring.sub)
        throw refuse("the roster is for another subject");
      if (ring.epoch < prior.epoch) throw refuse("the roster is stale");
      if (
        ring.epoch === prior.epoch &&
        !sameDevices(ring.devices, prior.devices)
      )
        throw refuse("the roster differs at the held epoch");
    }

    const keys =
      prior !== null && ring.epoch > prior.epoch
        ? keysAfterRing(a.discKeys, prior, ring)
        : a.discKeys;
    const sameEpochPrev =
      held !== null &&
      prior !== null &&
      prior.epoch === ring.epoch &&
      held.discKeys.length === 2 &&
      held.discKeys[1] === keys[1];
    const prevUntil =
      keys.length === 2
        ? sameEpochPrev && held!.prevUntil !== null
          ? held!.prevUntil
          : now + PREV_DISC_KEY_SECONDS
        : null;
    const rec: ConnectStateRecord = {
      schema: CONNECT_STATE_SCHEMA,
      product: this.#env.product,
      deviceId,
      ring: a.ring,
      certificate: a.certificate,
      discKeys: keys,
      prevUntil,
      epoch: ring.epoch,
      registered: { signKey: mine.signKey, agreeKey: mine.agreeKey },
      storedAt: now,
    };
    return { rec, view: this.#view(rec, ring, cert) };
  }

  /** Whether the held identity can be used as it is (the 3.5-day short-circuit). */
  #fresh(
    held: ConnectStateRecord,
    ok: { ring: Ring; cert: PeerCert },
    mine: DevicePublicKeys,
    now: number,
  ): boolean {
    return (
      held.registered?.signKey === mine.signKey &&
      held.registered.agreeKey === mine.agreeKey &&
      ok.cert.signKey === mine.signKey &&
      ok.cert.agreeKey === mine.agreeKey &&
      !ringExpired(ok.ring, now) &&
      ok.cert.expiresAt - now > PEER_CERT_RENEW_SECONDS &&
      ok.cert.ringEpoch === ok.ring.epoch
    );
  }

  /** Each half of the held record verified on its own: a lapsed certificate must not cost the
   *  roster that the next replacement is judged against. */
  async #verifyHeld(
    held: ConnectStateRecord,
  ): Promise<{ ring: Ring | null; cert: PeerCert | null }> {
    const trust = this.#env.trust();
    const expectedAud = this.#env.product;
    const r = await verifyRing(held.ring, { trust, expectedAud });
    const c = await verifyPeerCert(held.certificate, {
      trust,
      expectedAud,
      now: this.#env.now(),
    });
    return { ring: r.ok ? r.ring : null, cert: c.ok ? c.cert : null };
  }

  #view(rec: ConnectStateRecord, ring: Ring, cert: PeerCert): ConnectIdentity {
    return {
      sub: ring.sub,
      deviceId: rec.deviceId,
      epoch: ring.epoch,
      devices: ring.devices,
      certificate: rec.certificate,
      certificateExpiresAt: cert.expiresAt,
      ring: rec.ring,
      ringExpiresAt: ring.expiresAt,
    };
  }

  // ── Keys, state and transport ───────────────────────────────────────────────────────────────

  /** Connect must be on for this product, per discovery when it is known. */
  async #available(): Promise<void> {
    const doc = await this.#env.discovery();
    if (!isRecord(doc)) return;
    const services = isRecord(doc.services) ? doc.services : null;
    const f: unknown = services?.connect;
    const off = (d: string) =>
      new UnsupportedError(
        {
          supported: false,
          feature: Feature.connectIdentity,
          reason: "product",
          detail: d,
        },
        ErrorCode.connectUnavailable,
      );
    if (!isRecord(f) || f.enabled !== true)
      throw off("this product has Cloud Connect off");
    const ep = isRecord(f.endpoints) ? f.endpoints : null;
    if (ep !== null && ep.identity === null)
      throw off("this product's discovery names no connect identity endpoint");
  }

  async #device(): Promise<{ deviceId: string; hasToken: boolean }> {
    return this.#env.device();
  }

  async #usePort(): Promise<DeviceKeyPort> {
    const dev = await this.#device();
    if (!dev.hasToken)
      throw new PolarisError(
        ErrorCode.noToken,
        "Register or sign in before using Cloud Connect.",
      );
    const port = await this.#env.keys();
    if (
      (await port.persistence?.()) === "memory" &&
      !this.#env.allowEphemeralKeys
    )
      throw new PolarisError(
        ErrorCode.invalidOptions,
        "The device keys are held in memory only, so every reload would register a new pair. Use a durable key store or set allowEphemeralKeys.",
      );
    return port;
  }

  async #ensureKeys(port: DeviceKeyPort): Promise<DevicePublicKeys> {
    try {
      return await port.ensure();
    } catch (e) {
      throw this.#keysError(e);
    }
  }

  /** Register the port's keys unless the held record says this pair was already registered.
   *  True when a registration was sent. */
  async #registerIfNeeded(
    port: DeviceKeyPort,
    held: ConnectStateRecord | null,
  ): Promise<boolean> {
    const mine = await this.#ensureKeys(port);
    if (
      held?.registered?.signKey === mine.signKey &&
      held.registered.agreeKey === mine.agreeKey
    )
      return false;
    await this.#register(port);
    return true;
  }

  async #register(port: DeviceKeyPort): Promise<void> {
    try {
      await this.#env.registerKeys(port, {
        allowEphemeral: this.#env.allowEphemeralKeys,
      });
    } catch (e) {
      throw this.#keysError(e);
    }
  }

  async #get(path: string): Promise<Response> {
    const res = await this.#env.request(path, { method: "GET" });
    if (!res.ok) throw await refusal(res);
    return res;
  }

  async #store(): Promise<ConnectStateStore> {
    const port = await this.#env.keys();
    return (await port.persistence?.()) === "memory"
      ? this.#env.stores.memory
      : this.#env.stores.durable();
  }

  async #load(
    store: ConnectStateStore,
    deviceId: string,
  ): Promise<ConnectStateRecord | null> {
    let raw: string | null;
    try {
      raw = await store.get();
    } catch (e) {
      throw this.#storeError(e);
    }
    if (raw === null) return null;
    const rec = parseConnectState(raw);
    if (rec === null)
      throw new PolarisError(
        ErrorCode.storeFailed,
        "The Cloud Connect state record is unreadable; leave() clears it.",
      );
    // A record for another product or device is not this device's state.
    return rec.product === this.#env.product && rec.deviceId === deviceId
      ? rec
      : null;
  }

  #storeError(e: unknown): PolarisError {
    if (e instanceof PolarisError) return e;
    return new PolarisError(
      ErrorCode.storeFailed,
      "The Cloud Connect state could not be used: store fault",
      undefined,
      undefined,
    );
  }

  #keysError(e: unknown): PolarisError {
    if (e instanceof PolarisError && !(e instanceof DeviceKeysUnreadableError))
      return e;
    if (e instanceof DeviceKeyUnsupportedError)
      return new PolarisError(ErrorCode.invalidOptions, e.message);
    if (e instanceof DeviceKeysUnreadableError)
      return new PolarisError(
        ErrorCode.storeFailed,
        `The device keys could not be used: ${e.message}`,
      );
    throw e;
  }
}

/** The Worker's refusal as a typed error: its wire code is `wireCode`; `code` stays inside the
 *  registry. */
async function refusal(res: Response): Promise<PolarisError> {
  const b = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
  };
  const wire =
    typeof b.error === "string" ? b.error : (b.error?.code ?? "http-error");
  const code = (ERROR_CODE_VALUES as readonly string[]).includes(wire)
    ? (wire as PolarisErrorCode)
    : "http-error";
  return new PolarisError(
    code,
    `connect request failed with status ${res.status}`,
    wire,
    undefined,
    { status: res.status },
  );
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw refuse("the answer is not JSON", false);
  }
}

/** The identity answer's shape: two strings and one or two canonical discovery keys. */
function parseAnswer(body: unknown): {
  ring: string;
  certificate: string;
  discKeys: string[];
} {
  if (
    !isRecord(body) ||
    typeof body.ring !== "string" ||
    typeof body.certificate !== "string" ||
    !Array.isArray(body.discKeys) ||
    body.discKeys.length < 1 ||
    body.discKeys.length > 2 ||
    !body.discKeys.every(validDiscKey) ||
    (body.discKeys.length === 2 && body.discKeys[0] === body.discKeys[1])
  )
    throw refuse("the answer is not in the contract shape", false);
  return {
    ring: body.ring,
    certificate: body.certificate,
    discKeys: body.discKeys as string[],
  };
}
