// The Cloud Connect identity client (CC-08.1; WIRE-CONTRACT-V5 §15.2, §15.3, §15.4, §15.8):
// `client.connect`. On first need it makes this device's keys and registers them
// (`devices.registerKeys`), fetches `GET /<p>/connect/identity` (the roster, this device's
// certificate and K_disc), verifies both documents with client-core against the effective product
// set, and keeps them as `pkey.connect.v1` in the state directory (state.ts). The LAN, TCP and
// relay halves follow in CC-08.2 and CC-08.3 and read this state.
//
// Rules this module keeps:
//  - the keys never leave the `DeviceKeyPort`; a memory-only port refuses unless the host opts in
//    (`allowEphemeralKeys`), because every restart would be a key change and the Worker allows 4 a
//    day;
//  - a roster or certificate that does not verify is never stored. A roster that is expired, for
//    another subject or device, certifies other keys than this device's, or would replace the held
//    roster with a lower epoch (stale) or a different subject (foreign) is refused and the held
//    state is unchanged;
//  - K_disc is stored exactly as the latest answer delivered it, never merged with older answers,
//    and a previous key is dropped when the roster lost a device or changed a device's keys since
//    the held one (the Worker drops it for a leave; this is the same rule on the client), and when
//    24 hours have passed since it was first seen;
//  - K_disc is not in any return value, error or print except `discoveryKeys()`, which hands out
//    bytes for the advert code.

import {
  DeviceKeyUnsupportedError,
  DeviceKeysUnreadableError,
  PolarisError,
  UnsupportedError,
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
  base64UrlDecode,
  isCanonicalB64url,
  type TrustSet,
} from "@polaris-key/jws";
import {
  MAX_RING_DEVICES,
  PEER_CERT_RENEW_SECONDS,
} from "@polaris-key/protocol/connect";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { readJson, responseError } from "../core/http.js";
import { printAs } from "../core/redact.js";
import type { TokenManager } from "../core/token.js";
import type { DevicesClient } from "../devices/client.js";
import {
  DeviceKeyStoreError,
  type NodeDeviceKeyStorage,
} from "../devices/deviceKeys.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import { LanService, type LanOptions, type LanSource } from "./lan.js";
import { LanError } from "./session.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  connectStorage,
  parseConnectState,
  CONNECT_STATE_FILE,
  CONNECT_STATE_SCHEMA,
  type ConnectStateRecord,
} from "./state.js";

/** The Worker keeps the previous K_disc for 24 hours after a bump (§15.4). */
export const PREV_DISC_KEY_SECONDS = 86_400;

export interface ConnectOptions {
  /** This device's keys. Default: the file store in the state directory (the same file
   *  `createNodeDeviceKeyStore` uses), or `keyring.deviceKeys` when the host gave that one. */
  deviceKeys?: DeviceKeyPort;
  /** Allow a memory-only key store. Off by default: its keys die with the process, so every
   *  restart would register a new pair. */
  allowEphemeralKeys?: boolean;
}

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
  /** The held `pkey-ring+jws` (sent to a peer that asks for `RING`). */
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

/** The discovery keys as bytes, newest first (§15.4). A device advertises under `current` only. */
export interface DiscoveryKeys {
  current: Uint8Array;
  previous: Uint8Array | null;
}

export interface ConnectDeps {
  devices: DevicesClient;
  /** The effective product set (pins plus the signed trust manifest). */
  trust: () => TrustSet;
  discovery: () => Promise<ProductDiscoveryDocument | null>;
  /** The device key store used when the host gave none (the file store `createNodeDeviceKeyStore`
   *  makes for this product and state directory). */
  defaultKeys: () => DeviceKeyPort;
}

const refuse = (reason: string): PolarisError =>
  new PolarisError(
    ErrorCode.badResponse,
    `The Cloud Connect identity was refused: ${reason}.`,
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function discKeyBytes(k: string): Uint8Array {
  return base64UrlDecode(k);
}

function validDiscKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  if (!isCanonicalB64url(v)) return false;
  return base64UrlDecode(v).length === 32;
}

const sameDevice = (
  a: Ring["devices"][number],
  b: Ring["devices"][number],
): boolean =>
  a.deviceId === b.deviceId &&
  a.signKey === b.signKey &&
  a.agreeKey === b.agreeKey;

const sameDevices = (a: Ring["devices"], b: Ring["devices"]): boolean =>
  a.length === b.length && a.every((d, i) => sameDevice(d, b[i]!));

export class ConnectClient {
  #tail: Promise<unknown> = Promise.resolve();
  #storage: NodeDeviceKeyStorage | null = null;
  #port: DeviceKeyPort | null;
  readonly #allowEphemeral: boolean;

  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly deps: ConnectDeps,
    opts: ConnectOptions = {},
  ) {
    this.#port = opts.deviceKeys ?? null;
    this.#allowEphemeral = opts.allowEphemeralKeys === true;
    printAs(this, () => ({ connect: "CloudConnect" }));
  }

  /** Use these device keys from now on. */
  useDeviceKeys(keys: DeviceKeyPort): void {
    this.#port = keys;
    this.#storage = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────────────────────

  /**
   * The held identity, fetching it first when none is held, when it is nearing its end (the
   * certificate has less than `PEER_CERT_RENEW_SECONDS` left, or the roster expired), when this
   * device's keys changed, or when `refresh` is set. Makes and registers the device keys on first
   * need. Throws `PolarisError`: `service-unavailable` (Connect off here), `invalid-options` (a
   * memory-only key store the host did not allow), `no-token`, the Worker's own refusals
   * (`account_required`, `device_keys_required`, `ring_too_large`, …) and `bad_response` for an
   * answer that fails verification.
   */
  identity(opts: { refresh?: boolean } = {}): Promise<ConnectIdentity> {
    return this.#serial(() => this.#identity(opts.refresh === true));
  }

  /** The held identity as it stands, verified again now; null when none is held, it does not
   *  verify any more or its roster expired. Sends nothing and makes no keys. */
  current(): Promise<ConnectIdentity | null> {
    return this.#serial(async () => {
      const held = await this.#load();
      if (held === null) return null;
      const v = await this.#verifyHeld(held);
      return v.ring === null ||
        v.cert === null ||
        ringExpired(v.ring, this.ctx.now())
        ? null
        : this.#view(held, v.ring, v.cert);
    });
  }

  /** `GET /<p>/connect/devices`: the person's devices, display data only. */
  listDevices(): Promise<ConnectDevice[]> {
    return this.#serial(async () => {
      await this.#available();
      this.#requireToken();
      const port = await this.#usePort();
      await this.#registerIfNeeded(port, await this.#load());
      const res = await this.#get("connect/devices", "connect devices");
      const body = await readJson<unknown>(res, "connect devices");
      const list = isRecord(body) ? body.devices : null;
      if (!Array.isArray(list) || list.length > MAX_RING_DEVICES)
        throw refuse("the device list is not in the contract shape");
      return list.map((d): ConnectDevice => {
        if (
          !isRecord(d) ||
          typeof d.deviceId !== "string" ||
          typeof d.self !== "boolean"
        )
          throw refuse("a device entry is not in the contract shape");
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
    });
  }

  /**
   * K_disc as bytes for the advert code (CC-08.2), or null when none is held. The previous key is
   * left out once 24 hours have passed since it was first seen. @internal
   */
  discoveryKeys(): Promise<DiscoveryKeys | null> {
    return this.#serial(async () => {
      const held = await this.#load();
      if (held === null) return null;
      const now = this.ctx.now();
      const prev =
        held.discKeys.length === 2 &&
        held.prevUntil !== null &&
        now < held.prevUntil
          ? discKeyBytes(held.discKeys[1]!)
          : null;
      return { current: discKeyBytes(held.discKeys[0]!), previous: prev };
    });
  }

  /**
   * Start the LAN half (CC-08.2): listen on TCP, advertise this device under the account
   * instance name, browse for the person's other devices. Needs a held identity (`identity()`
   * first); throws `LanError` (`no_identity`, `no_keys`) without one. Stop it with `stop()`.
   */
  async lan(opts: LanOptions = {}): Promise<LanService> {
    return LanService.start(this.lanSource(), opts);
  }

  /** What the LAN service reads: the held identity, K_disc and the device's key operations. @internal */
  lanSource(): LanSource {
    return {
      now: () => this.ctx.now(),
      refresh: async () => {
        await this.identity({ refresh: true });
      },
      load: async () => {
        const id = await this.current();
        if (id === null)
          throw new LanError(
            "no_identity",
            "No Cloud Connect identity is held; call identity() first.",
          );
        const keys = await this.discoveryKeys();
        const port = this.#port;
        const pub = port === null ? null : await port.publicKeys();
        if (keys === null || port === null || pub === null)
          throw new LanError(
            "no_keys",
            "The device keys or K_disc are not held.",
          );
        return {
          slug: this.ctx.product,
          trust: this.deps.trust(),
          sub: id.sub,
          deviceId: id.deviceId,
          certJws: id.certificate,
          certExpiresAt: id.certificateExpiresAt,
          ringJws: id.ring,
          ringEpoch: id.epoch,
          roster: id.devices.map((d) => d.deviceId),
          keys,
          agreePublic: base64UrlDecode(pub.agreeKey),
          dh: (p) => port.dh(p),
        };
      },
    };
  }

  /** Forget the held roster, certificate and K_disc (sign-out, leaving the person's devices).
   *  The device keys are untouched, and so is the Worker's roster. */
  leave(): Promise<void> {
    return this.#serial(async () => {
      try {
        const store = await this.#store();
        // Nothing on disk means nothing to forget: do not make the directory or a lock for it.
        if (
          store.persistence === "durable" &&
          !existsSync(join(this.ctx.dirs.state, CONNECT_STATE_FILE))
        )
          return;
        await store.clear();
      } catch (e) {
        throw this.#storeError(e);
      }
    });
  }

  // ── Identity ────────────────────────────────────────────────────────────────────────────────

  async #identity(refresh: boolean): Promise<ConnectIdentity> {
    await this.#available();
    this.#requireToken();
    const port = await this.#usePort();
    const mine = await this.#ensureKeys(port);
    const now = this.ctx.now();
    const held = await this.#load();
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
      res = await this.#get("connect/identity", "connect identity");
    } catch (e) {
      if (
        registeredNow ||
        !(e instanceof PolarisError) ||
        e.code !== ErrorCode.deviceKeysRequired
      )
        throw e;
      // The Worker forgot the keys (a purge): register once more and ask again.
      await this.#register(port);
      res = await this.#get("connect/identity", "connect identity");
    }
    const body = await readJson<unknown>(res, "connect identity");
    const answer = parseAnswer(body);
    const record = await this.#accept(answer, mine, heldOk, held, now);
    try {
      await (
        await this.#store()
      ).update(() => Buffer.from(JSON.stringify(record.rec), "utf8"));
    } catch (e) {
      throw this.#storeError(e);
    }
    return record.view;
  }

  /** Verify the answer and decide what to store. Throws `bad_response` on any refusal; nothing is
   *  written before this returns. */
  async #accept(
    a: { ring: string; certificate: string; discKeys: string[] },
    mine: DevicePublicKeys,
    heldOk: { ring: Ring | null; cert: PeerCert | null } | null,
    held: ConnectStateRecord | null,
    now: number,
  ): Promise<{ rec: ConnectStateRecord; view: ConnectIdentity }> {
    const trust = this.deps.trust();
    const expectedAud = this.ctx.product;
    const r = await verifyRing(a.ring, { trust, expectedAud });
    if (!r.ok) throw refuse(`the roster does not verify (${r.reason})`);
    const c = await verifyPeerCert(a.certificate, { trust, expectedAud, now });
    if (!c.ok) throw refuse(`the certificate does not verify (${c.reason})`);
    const ring = r.ring;
    const cert = c.cert;
    if (ringExpired(ring, now)) throw refuse("the roster is expired");
    if (cert.sub !== ring.sub)
      throw refuse("the certificate and roster name different subjects");
    if (cert.deviceId !== this.ctx.deviceId)
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

    let keys = a.discKeys;
    if (keys.length === 2 && prior !== null && ring.epoch > prior.epoch) {
      // A leave, or a device that changed its keys, takes the previous key away (§15.4).
      const intact = prior.devices.every((d) =>
        ring.devices.some((n) => sameDevice(n, d)),
      );
      if (!intact) keys = [keys[0]!];
    }
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
      product: this.ctx.product,
      deviceId: this.ctx.deviceId,
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

  /** Whether the held identity can be used as it is. */
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
    const trust = this.deps.trust();
    const expectedAud = this.ctx.product;
    const r = await verifyRing(held.ring, { trust, expectedAud });
    const c = await verifyPeerCert(held.certificate, {
      trust,
      expectedAud,
      now: this.ctx.now(),
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
    const doc = await this.deps.discovery();
    if (doc === null) return;
    const f: unknown = doc.services?.connect;
    const detail = (d: string) =>
      new UnsupportedError(
        {
          supported: false,
          feature: Feature.connectIdentity,
          reason: "product",
          detail: d,
        },
        ErrorCode.serviceUnavailable,
      );
    if (!isRecord(f) || f.enabled !== true)
      throw detail("this product has Cloud Connect off");
    const ep = isRecord(f.endpoints) ? f.endpoints : null;
    if (ep !== null && ep.identity === null)
      throw detail(
        "this product's discovery names no connect identity endpoint",
      );
  }

  async #usePort(): Promise<DeviceKeyPort> {
    if (this.#port === null) this.#port = this.deps.defaultKeys();
    const port = this.#port;
    if ((await port.persistence?.()) === "memory" && !this.#allowEphemeral)
      throw new PolarisError(
        ErrorCode.invalidOptions,
        "The device keys are held in memory only, so every restart would register a new pair. Use a durable key store or set allowEphemeralKeys.",
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
      await this.deps.devices.registerKeys(port, {
        allowEphemeral: this.#allowEphemeral,
      });
    } catch (e) {
      throw this.#keysError(e);
    }
  }

  #requireToken(): string {
    const token = this.tokens.current;
    if (!token)
      throw new PolarisError(
        ErrorCode.noToken,
        "Register or sign in before using Cloud Connect.",
      );
    return token;
  }

  async #get(path: string, what: string): Promise<Response> {
    const token = this.#requireToken();
    const res = await this.ctx.request(
      this.ctx.url(path),
      { headers: this.ctx.headers({ authorization: `Bearer ${token}` }) },
      what,
    );
    if (!res.ok) throw await responseError(res, what);
    return res;
  }

  async #store(): Promise<NodeDeviceKeyStorage> {
    if (this.#storage !== null) return this.#storage;
    const port = this.#port;
    const persistence =
      port !== null && (await port.persistence?.()) === "memory"
        ? "memory"
        : "durable";
    this.#storage = connectStorage(this.ctx.dirs.state, persistence);
    return this.#storage;
  }

  async #load(): Promise<ConnectStateRecord | null> {
    let raw: Buffer | null;
    try {
      raw = await (await this.#store()).get();
    } catch (e) {
      throw this.#storeError(e);
    }
    if (raw === null) return null;
    try {
      const rec = parseConnectState(raw);
      if (rec === null)
        throw new PolarisError(
          ErrorCode.storeFailed,
          "The Cloud Connect state record is unreadable; leave() clears it.",
        );
      // A record for another product or device is not this device's state.
      return rec.product === this.ctx.product &&
        rec.deviceId === this.ctx.deviceId
        ? rec
        : null;
    } finally {
      raw.fill(0);
    }
  }

  #storeError(e: unknown): PolarisError {
    if (e instanceof PolarisError) return e;
    const what = e instanceof DeviceKeyStoreError ? e.message : "store fault";
    return new PolarisError(
      ErrorCode.storeFailed,
      `The Cloud Connect state could not be used: ${what}`,
      { cause: e },
    );
  }

  #keysError(e: unknown): PolarisError {
    if (e instanceof PolarisError) return e;
    if (e instanceof DeviceKeyUnsupportedError)
      return new PolarisError(ErrorCode.invalidOptions, e.message, {
        cause: e,
      });
    if (
      e instanceof DeviceKeysUnreadableError ||
      e instanceof DeviceKeyStoreError
    )
      return new PolarisError(
        ErrorCode.storeFailed,
        `The device keys could not be used: ${e.message}`,
        { cause: e },
      );
    throw e;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => undefined);
    return run;
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
    throw refuse("the answer is not in the contract shape");
  return {
    ring: body.ring,
    certificate: body.certificate,
    discKeys: body.discKeys as string[],
  };
}
