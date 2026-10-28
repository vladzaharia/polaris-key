// The Cloud Sync key ring client (U-38.1; WIRE-CONTRACT-V5 §13.10, §13.11): create the ring, hold its
// root `R`, wrap `R` to another device, set the recovery code and recover from it, reset, adopt, and
// seal and open values with the root's keys. Node runs client-core's sync crypto on WebCrypto
// (`webCryptoSyncPort`), which is `node:crypto` underneath.
//
// Rules this module keeps:
//  - `R` lives in this object's memory only. It is never written to disk, returned, logged, put in
//    an error, or printed (`console.log`, `util.inspect`, `JSON.stringify` show a marker). A restart
//    gets it back through `unlock()`: the Worker keeps this device's wrap, and only the device's own
//    agreement key opens it. The host decides what else may carry a root (platform backup, nearby
//    approval); this module offers the primitives.
//  - The device's agreement key never leaves its `DeviceKeyPort`: the wrap is opened through
//    the port's `dh`, so no private half is read here.
//  - The recovery code is returned once, to the caller, and kept nowhere.
//  - A wrap is accepted only when `kid(R)` equals the ring's `rootKid`.
//  - The first root this client acquires (create, recover, unlock) pins `{ringId, epoch, rootKid}` in
//    the state directory (`keyring-pin.json`, owner-only; no secret). A served ring or wrap that
//    differs is never opened: `unlock()` answers `ring-changed`, and only the recovery code
//    (`recover`) or an explicit `acceptRingChange()` re-pins. Sign-out (`forget()`) drops the pin.

import { PolarisError, type DeviceKeyPort } from "@polaris-key/client-core";
import {
  HPKE_KEM_X25519,
  RECOVERY_CODE_INVALID,
  SYNC_KID_BYTES,
  SYNC_ROOT_BYTES,
  blind,
  deriveKid,
  encodeRecoveryCode,
  newRecoveryCode,
  openAdopt,
  openValue,
  openValueAnyName,
  parseRecoveryCode,
  sealAdopt,
  sealValue,
  unwrapRecovery,
  unwrapRoot,
  webCryptoSyncPort,
  wrapRecovery,
  wrapRoot,
  type BlindKind,
  type OpenedValue,
  type SyncCryptoPort,
  type SyncJson,
  type SyncWrap,
} from "@polaris-key/client-core/sync";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { ErrorCode } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { readJson, responseError } from "../core/http.js";
import {
  readJson as readJsonFile,
  removeJson,
  writeJson,
} from "../core/jsonFile.js";
import { printAs } from "../core/redact.js";
import type { TokenManager } from "../core/token.js";
import { join } from "node:path";

/** The `kem` an older Worker sent for DHKEM X25519: read, never written (the contract's integer is 32). */
export const KEM_WIRE_X25519 = "x25519";

/** The machine side of the unlock: client-core's Cloud Sync machine takes the root as a flag. */
export interface RootListener {
  setRoot(present: boolean): void;
}

export interface KeyringOptions {
  /** This device's keys. Without it, anything that needs the agreement key refuses. */
  deviceKeys?: DeviceKeyPort;
  /** The crypto port. Default: client-core's WebCrypto port (`node:crypto` underneath). */
  crypto?: SyncCryptoPort;
}

export interface KeyringRing {
  ringId: string;
  epoch: number;
  rootKid: string;
  state: string;
  createdAt: number;
  recovery: { set: boolean; createdAt?: number };
  adopted: { ringId: string; epoch: number; kid: string; ct: string }[];
  previous?: { ringId: string; kid: string; until: number };
}

export interface KeyringWrapInfo {
  epoch: number;
  kid: string;
  kem: string | number;
  enc: string;
  ct: string;
  by?: string;
}

export interface KeyringState {
  ring: KeyringRing | null;
  wrap: KeyringWrapInfo | null;
}

/** What this client pinned when it first acquired a root. It holds no secret. */
export interface RingPin {
  ringId: string;
  epoch: number;
  rootKid: string;
}

export type UnlockResult =
  | { kind: "unlocked"; ringId: string; epoch: number }
  | { kind: "locked"; reason: "no-ring" | "no-wrap" | "unusable-wrap" }
  /** The served ring is not the pinned one. Nothing was opened or replaced; confirm with the
   *  person, then `recover(code)` or `acceptRingChange()`. `by` is the device that wrapped. */
  | {
      kind: "ring-changed";
      pinned: RingPin;
      served: RingPin & { createdAt: number; by?: string };
    };

export interface CreatedRing {
  ringId: string;
  epoch: number;
  rootKid: string;
  /** The recovery code, shown once, when the ring was created with one. */
  recoveryCode?: string;
}

export interface RecoveryBlob {
  ct: string;
  epoch: number;
  kid: string;
}

/** A refusal that is the client's own (no root, a bad code, a bad argument). */
export class KeyringError extends PolarisError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "KeyringError";
  }
}

/** What the E2E machine's host seals and opens with. It holds no key itself: every call reads the
 *  ring's current root, and refuses with `sync-locked` once the ring is locked. */
export interface SyncCodec {
  /** The current root's `kid`, lowercase hex; null while locked. */
  readonly kid: string | null;
  readonly locked: boolean;
  seal(collection: string, name: string, value: SyncJson): Promise<Uint8Array>;
  /** Tries the current root, then any adopted root whose `kid` the envelope names. */
  open(
    collection: string,
    name: string,
    envelope: Uint8Array,
    aliases?: readonly string[],
  ): Promise<OpenedValue>;
  /** Opens an envelope whose name is inside it (a blinded open key or merge member), with the
   *  same root loop as `open`. The caller checks the name it gets back (`HostCodec`). */
  openAny(collection: string, envelope: Uint8Array): Promise<OpenedValue>;
  blind(kind: BlindKind, ctx: string, name: string): Promise<string>;
}

const HEX = /^[0-9a-f]+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const RING_ID = /^rg_[A-Za-z0-9_-]{22}$/;

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array | null =>
  s.length % 2 === 0 && HEX.test(s)
    ? Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16))
    : null;
const unb64 = (s: unknown, bytes?: number): Uint8Array | null => {
  if (typeof s !== "string" || s === "" || !B64URL.test(s)) return null;
  try {
    const out = base64UrlDecode(s);
    if (base64UrlEncodeBytes(out) !== s) return null;
    return bytes === undefined || out.length === bytes ? out : null;
  } catch {
    return null;
  }
};
const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const locked = (): KeyringError =>
  new KeyringError(
    ErrorCode.syncLocked,
    "This device holds no root for the key ring; unlock it first.",
  );
const badArg = (what: string): KeyringError =>
  new KeyringError(ErrorCode.invalidArgument, what);

/** The device's agreement key as an `X25519Port`: the private half stays in the key port. */
function devicePort(
  base: SyncCryptoPort,
  keys: DeviceKeyPort,
  publicKey: Uint8Array,
): SyncCryptoPort {
  return {
    ...base,
    x25519: {
      publicKey: async () => publicKey,
      dh: (_unused, peer) => keys.dh(peer),
    },
  };
}

interface Held {
  ringId: string;
  epoch: number;
  kid: Uint8Array;
  root: Uint8Array;
}

export class KeyringClient {
  /** The current root; zeroed on `lock()`. */
  #held: Held | null = null;
  /** Roots of earlier or merged rings, to open data sealed under them. */
  #others: Held[] = [];
  #ring: KeyringRing | null = null;
  #listeners = new Set<RootListener>();
  readonly #crypto: SyncCryptoPort;
  #keys: DeviceKeyPort | undefined;
  readonly codec: SyncCodec;
  readonly #pinFile: string;

  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    opts: KeyringOptions = {},
  ) {
    this.#crypto = opts.crypto ?? webCryptoSyncPort;
    this.#keys = opts.deviceKeys;
    this.codec = this.#makeCodec();
    this.#pinFile = join(ctx.dirs.state, "keyring-pin.json");
    printAs(this, () => ({
      unlocked: this.#held !== null,
      ringId: this.#held?.ringId ?? null,
    }));
  }

  /** Use these device keys from now on (the same port `devices.registerKeys` takes). */
  useDeviceKeys(keys: DeviceKeyPort): void {
    this.#keys = keys;
  }

  /** Feed the machine: it is told now, and on every unlock and lock. Returns a detach function. */
  attach(machine: RootListener): () => void {
    this.#listeners.add(machine);
    machine.setRoot(this.#held !== null);
    return () => {
      this.#listeners.delete(machine);
    };
  }

  /** Whether this device holds a root right now. */
  get unlocked(): boolean {
    return this.#held !== null;
  }

  /** Forget every root held in memory (sign-out, quit). Server rows and wraps are untouched. */
  lock(): void {
    this.#held?.root.fill(0);
    for (const h of this.#others) h.root.fill(0);
    this.#held = null;
    this.#others = [];
    this.#ring = null;
    this.#notify();
  }

  /**
   * Sign-out: forget every root in memory and drop the pin, so the next person on this device
   * starts clean. The identity and licence sign-out paths call it.
   */
  async forget(): Promise<void> {
    this.lock();
    await removeJson(this.#pinFile);
  }

  /** The pinned ring, or null before this client first acquired a root. */
  async pin(): Promise<RingPin | null> {
    const v = await readJsonFile<Record<string, unknown> | null>(
      this.#pinFile,
      null,
    );
    if (
      !isRecord(v) ||
      v.product !== this.ctx.product ||
      typeof v.ringId !== "string" ||
      typeof v.epoch !== "number" ||
      typeof v.rootKid !== "string"
    )
      return null;
    // The pin never depends on the subject the Worker serves: only `forget()` drops it.
    return { ringId: v.ringId, epoch: v.epoch, rootKid: v.rootKid };
  }

  async #writePin(p: RingPin): Promise<void> {
    await writeJson(this.#pinFile, { product: this.ctx.product, ...p });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────

  /** `GET /<p>/devices/keyring`: the ring, and this device's own wrap. */
  async read(): Promise<KeyringState> {
    const res = await this.#request("GET", "devices/keyring");
    const body = await readJson<unknown>(res, "key ring");
    const out = parseState(body);
    if (out === null)
      throw new PolarisError(
        ErrorCode.badResponse,
        "The key ring answer is not in the contract shape.",
        { status: res.status },
      );
    this.#ring = out.ring;
    return out;
  }

  /**
   * Open this device's wrap and hold the root. A device with no ring, no wrap, or a wrap it cannot
   * use stays locked (a result, not an error); a network or server failure throws.
   */
  async unlock(): Promise<UnlockResult> {
    return this.#unlock(null);
  }

  /**
   * The person confirmed that the ring they were shown (`served` of a `ring-changed` answer) is
   * theirs: open this device's wrap for it and pin it. `confirmed` is that ring; if the Worker
   * now serves another, the answer is `ring-changed` again. Call it only from confirmed UI. A wrap
   * that does not open leaves the pin as it was.
   */
  async acceptRingChange(confirmed: RingPin): Promise<UnlockResult> {
    return this.#unlock(confirmed);
  }

  async #unlock(accept: RingPin | null): Promise<UnlockResult> {
    const { ring, wrap } = await this.read();
    if (ring === null) return { kind: "locked", reason: "no-ring" };
    const pinned = await this.pin();
    // An accept holds only for the ring the person was shown; a ring that moved since is
    // reported again, not adopted.
    const expected = accept ?? pinned;
    if (
      expected !== null &&
      (expected.ringId !== ring.ringId ||
        expected.epoch !== ring.epoch ||
        expected.rootKid !== ring.rootKid)
    )
      return {
        kind: "ring-changed",
        pinned: pinned ?? expected,
        served: {
          ringId: ring.ringId,
          epoch: ring.epoch,
          rootKid: ring.rootKid,
          createdAt: ring.createdAt,
          ...(wrap?.by !== undefined ? { by: wrap.by } : {}),
        },
      };
    if (wrap === null) return { kind: "locked", reason: "no-wrap" };
    const keys = this.#keys;
    const kid = unhex(ring.rootKid);
    const enc = unb64(wrap.enc, 32);
    const ct = unb64(wrap.ct);
    if (
      !keys ||
      kid === null ||
      enc === null ||
      ct === null ||
      wrap.kid !== ring.rootKid ||
      wrap.epoch !== ring.epoch ||
      !(wrap.kem === KEM_WIRE_X25519 || wrap.kem === HPKE_KEM_X25519)
    )
      return { kind: "locked", reason: "unusable-wrap" };
    const mine = await keys.publicKeys();
    const agree = mine ? unb64(mine.agreeKey, 32) : null;
    if (agree === null) return { kind: "locked", reason: "unusable-wrap" };
    const root = await unwrapRoot(
      devicePort(this.#crypto, keys, agree),
      new Uint8Array(32),
      this.#wrapContext(ring.ringId, ring.epoch),
      kid,
      { kem: HPKE_KEM_X25519, enc, ct },
    );
    if (root === null || !same(await deriveKid(this.#crypto, root), kid)) {
      root?.fill(0);
      return { kind: "locked", reason: "unusable-wrap" };
    }
    await this.#hold({ ringId: ring.ringId, epoch: ring.epoch, kid, root });
    return { kind: "unlocked", ringId: ring.ringId, epoch: ring.epoch };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Make the ring: a fresh root, a wrap to this device, and (by default) a recovery blob. The root
   * is held on success. `keyring_conflict` (a ring exists) leaves nothing held: `unlock()` instead.
   */
  async create(opts: { recovery?: boolean } = {}): Promise<CreatedRing> {
    return this.#makeRing("devices/keyring", opts.recovery !== false);
  }

  /**
   * Start over: a new ring and root, optionally a new recovery code. The server keeps the old ring
   * as `previous` for 30 days; a root this device held is kept in memory for `adopt()`.
   */
  async reset(opts: { recovery?: boolean } = {}): Promise<CreatedRing> {
    return this.#makeRing("devices/keyring/reset", opts.recovery !== false);
  }

  /**
   * Wrap the root to another device of the same person (`PUT .../wraps/{deviceId}`). `agreeKey` is
   * that device's X25519 key, from the nearby approval (R-9): the host decides when to call this,
   * the Worker accepts a wrap only from a device that holds a wrap itself.
   */
  async wrapTo(deviceId: string, agreeKey: Uint8Array | string): Promise<void> {
    const h = this.#need();
    if (deviceId === "" || /[/?#\s]/.test(deviceId))
      throw badArg("A device id is required.");
    const pub =
      typeof agreeKey === "string" ? unb64(agreeKey, 32) : agreeKey.slice();
    if (pub === null || pub.length !== 32)
      throw badArg("The agreement key must be 32 bytes.");
    const w = await wrapRoot(
      this.#crypto,
      pub,
      this.#wrapContext(h.ringId, h.epoch, deviceId),
      h.kid,
      h.root,
    );
    await this.#send(
      "PUT",
      `devices/keyring/wraps/${encodeURIComponent(deviceId)}`,
      {
        epoch: h.epoch,
        kid: hex(h.kid),
        ...wireWrap(w),
      },
    );
  }

  /** `DELETE .../wraps/{deviceId}`: the Worker removes a device's own wrap only. */
  async removeWrap(deviceId: string): Promise<void> {
    if (deviceId === "" || /[/?#\s]/.test(deviceId))
      throw badArg("A device id is required.");
    await this.#send(
      "DELETE",
      `devices/keyring/wraps/${encodeURIComponent(deviceId)}`,
    );
  }

  /**
   * Make a new recovery code, seal the root under it and store the blob. The previous code stops
   * working. Returns the code to show the person; it is kept nowhere.
   */
  async setRecoveryCode(): Promise<string> {
    const h = this.#need();
    const code = newRecoveryCode(this.#crypto);
    try {
      const blob = await wrapRecovery(
        this.#crypto,
        code,
        h.ringId,
        h.epoch,
        h.kid,
        h.root,
      );
      await this.#send("PUT", "devices/keyring/recovery", {
        ct: base64UrlEncodeBytes(blob),
        epoch: h.epoch,
        kid: hex(h.kid),
      });
      return await encodeRecoveryCode(this.#crypto, code);
    } finally {
      code.fill(0);
    }
  }

  /** `GET .../recovery`: the sealed blob (5 reads a day per device; the account is emailed). */
  async recoveryBlob(): Promise<RecoveryBlob> {
    const res = await this.#request("GET", "devices/keyring/recovery");
    const body = await readJson<unknown>(res, "recovery blob");
    if (
      !isRecord(body) ||
      typeof body.ct !== "string" ||
      typeof body.epoch !== "number" ||
      typeof body.kid !== "string"
    )
      throw new PolarisError(
        ErrorCode.badResponse,
        "The recovery answer is not in the contract shape.",
        { status: res.status },
      );
    return { ct: body.ct, epoch: body.epoch, kid: body.kid };
  }

  /**
   * Recover the root from the typed or pasted recovery code. The code is checked before any
   * request; a bad checksum or a failed unwrap is `recovery-code-invalid`. On success the root is
   * held, and this device deposits its own wrap so the next start unlocks without the code
   * (`wrapDeposited`: false when the Worker refused or a wrap already stood).
   */
  async recover(
    codeText: string,
  ): Promise<{ ringId: string; epoch: number; wrapDeposited: boolean }> {
    const invalid = (): KeyringError =>
      new KeyringError(
        RECOVERY_CODE_INVALID,
        "The recovery code is not valid for this key ring.",
      );
    const code = await parseRecoveryCode(this.#crypto, codeText);
    if (code === null) throw invalid();
    try {
      const { ring } = await this.read();
      if (ring === null || !ring.recovery.set)
        throw new PolarisError(
          ErrorCode.notFound,
          "There is no recovery code for this key ring.",
        );
      const kid = unhex(ring.rootKid);
      if (kid === null)
        throw new PolarisError(ErrorCode.badResponse, "Bad ring kid.");
      const blob = await this.recoveryBlob();
      const bytes = unb64(blob.ct);
      if (blob.epoch !== ring.epoch || blob.kid !== ring.rootKid)
        throw new PolarisError(
          ErrorCode.badResponse,
          "The recovery blob does not belong to the current ring.",
        );
      if (bytes === null) throw invalid();
      const root = await unwrapRecovery(
        this.#crypto,
        code,
        ring.ringId,
        ring.epoch,
        kid,
        bytes,
      );
      if (root === null || !same(await deriveKid(this.#crypto, root), kid)) {
        root?.fill(0);
        throw invalid();
      }
      await this.#hold({ ringId: ring.ringId, epoch: ring.epoch, kid, root });
      return {
        ringId: ring.ringId,
        epoch: ring.epoch,
        wrapDeposited: await this.#depositOwnWrap(),
      };
    } finally {
      code.fill(0);
    }
  }

  /**
   * Adopt an earlier or merged root under the current one (`POST .../adopt`). Give the id of a
   * ring whose root this client holds (kept by `reset()` or `openAdopted()`), or `{ringId, epoch,
   * root}` for a root the host has. The root is sealed under `K_adopt` of the current root.
   */
  async adopt(
    from: string | { ringId: string; epoch: number; root: Uint8Array },
  ): Promise<void> {
    const h = this.#need();
    let old: Held | undefined;
    if (typeof from === "string")
      old = this.#others.find((o) => o.ringId === from);
    else if (RING_ID.test(from.ringId) && from.root.length === SYNC_ROOT_BYTES)
      old = {
        ringId: from.ringId,
        epoch: from.epoch,
        root: from.root.slice(),
        kid: await deriveKid(this.#crypto, from.root),
      };
    if (!old || !RING_ID.test(old.ringId) || !(old.epoch >= 1))
      throw badArg("No root is held for that ring.");
    const blob = await sealAdopt(
      this.#crypto,
      h.root,
      { fromRingId: old.ringId, epoch: old.epoch, kid: old.kid },
      old.root,
    );
    await this.#send("POST", "devices/keyring/adopt", {
      fromRingId: old.ringId,
      epoch: old.epoch,
      kid: hex(old.kid),
      ct: base64UrlEncodeBytes(blob),
    });
    if (typeof from !== "string") old.root.fill(0);
  }

  /**
   * Open the ring's `adopted` candidates with the current root and keep the roots they hold, so
   * `codec.open` reads data sealed under them. Returns the ring ids it opened; a candidate that
   * does not open (or names a different `kid`) is skipped.
   */
  async openAdopted(): Promise<string[]> {
    const h = this.#need();
    const ring = this.#ring ?? (await this.read()).ring;
    const opened: string[] = [];
    for (const a of ring?.adopted ?? []) {
      const kid = unhex(a.kid);
      const ct = unb64(a.ct);
      if (kid === null || ct === null) continue;
      const root = await openAdopt(
        this.#crypto,
        h.root,
        { fromRingId: a.ringId, epoch: a.epoch, kid },
        ct,
      );
      if (root === null) continue;
      if (!same(await deriveKid(this.#crypto, root), kid)) {
        root.fill(0);
        continue;
      }
      this.#others = this.#others.filter((o) => o.ringId !== a.ringId);
      this.#others.push({ ringId: a.ringId, epoch: a.epoch, kid, root });
      opened.push(a.ringId);
    }
    return opened;
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────

  #need(): Held {
    if (this.#held === null) throw locked();
    return this.#held;
  }

  /** Take a freshly acquired root and pin its ring (pinned first: no root is held without one). */
  async #hold(h: Held): Promise<void> {
    await this.#writePin({
      ringId: h.ringId,
      epoch: h.epoch,
      rootKid: hex(h.kid),
    });
    if (this.#held !== null) {
      // A root for a ring is never replaced by another for the same ring and epoch (§13.11.1).
      if (this.#held.ringId !== h.ringId || this.#held.epoch !== h.epoch)
        this.#others.push(this.#held);
      else this.#held.root.fill(0);
    }
    this.#held = h;
    this.#notify();
  }

  #notify(): void {
    for (const l of this.#listeners) l.setRoot(this.#held !== null);
  }

  #wrapContext(ringId: string, epoch: number, deviceId = this.ctx.deviceId) {
    return { product: this.ctx.product, deviceId, ringId, epoch };
  }

  async #agreeKey(): Promise<Uint8Array> {
    if (!this.#keys)
      throw new KeyringError(
        ErrorCode.deviceKeysRequired,
        "Device keys are needed for the key ring; give the client a DeviceKeyPort.",
      );
    const pub = unb64((await this.#keys.ensure()).agreeKey, 32);
    if (pub === null)
      throw new KeyringError(
        ErrorCode.deviceKeysInvalid,
        "The device agreement key is not usable.",
      );
    return pub;
  }

  async #makeRing(path: string, withRecovery: boolean): Promise<CreatedRing> {
    const agree = await this.#agreeKey();
    const root = this.#crypto.random(SYNC_ROOT_BYTES);
    let code: Uint8Array | null = null;
    try {
      const kid = await deriveKid(this.#crypto, root);
      const ringId = `rg_${base64UrlEncodeBytes(this.#crypto.random(16))}`;
      const epoch = 1;
      const wrap = await wrapRoot(
        this.#crypto,
        agree,
        this.#wrapContext(ringId, epoch),
        kid,
        root,
      );
      const body: Record<string, unknown> = {
        ringId,
        rootKid: hex(kid),
        wrap: wireWrap(wrap),
      };
      if (withRecovery) {
        code = newRecoveryCode(this.#crypto);
        body.recovery = {
          ct: base64UrlEncodeBytes(
            await wrapRecovery(this.#crypto, code, ringId, epoch, kid, root),
          ),
        };
      }
      await this.#send("POST", path, body);
      const shown = code ? await encodeRecoveryCode(this.#crypto, code) : null;
      await this.#hold({ ringId, epoch, kid, root });
      this.#ring = null;
      return {
        ringId,
        epoch,
        rootKid: hex(kid),
        ...(shown !== null ? { recoveryCode: shown } : {}),
      };
    } catch (e) {
      // `#hold` took the root only on success; on any failure no copy outlives this call.
      if (this.#held?.root !== root) root.fill(0);
      throw e;
    } finally {
      code?.fill(0);
    }
  }

  /** After a recovery: store this device's own wrap. Never throws; false when it could not. */
  async #depositOwnWrap(): Promise<boolean> {
    try {
      await this.wrapTo(this.ctx.deviceId, await this.#agreeKey());
      return true;
    } catch {
      return false;
    }
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = this.tokens.current;
    if (!token)
      throw new KeyringError(
        ErrorCode.noToken,
        "Activate, register or sign in before using the key ring.",
      );
    const headers = this.ctx.headers({ authorization: `Bearer ${token}` });
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.ctx.request(this.ctx.url(path), init, "key ring");
    if (!res.ok) throw await responseError(res, "key ring");
    return res;
  }

  /** A write whose answer carries nothing the client reads (201 or 204). */
  async #send(method: string, path: string, body?: unknown): Promise<void> {
    const res = await this.#request(method, path, body);
    await res.body?.cancel();
  }

  #makeCodec(): SyncCodec {
    const self = this;
    const candidates = (kid: Uint8Array | null): Uint8Array[] => [
      ...(self.#held ? [self.#held.root] : []),
      ...self.#others
        .filter((o) => kid === null || same(o.kid, kid))
        .map((o) => o.root),
    ];
    // The current root first, then any adopted root whose `kid` the envelope names.
    const tryRoots = async (
      envelope: Uint8Array,
      attempt: (root: Uint8Array) => Promise<OpenedValue>,
    ): Promise<OpenedValue> => {
      let last = await attempt(self.#need().root);
      if (last.ok || last.reason !== "kid") return last;
      const kid = envelope.subarray(1, 1 + SYNC_KID_BYTES);
      for (const r of candidates(kid).slice(1)) {
        last = await attempt(r);
        if (last.ok || last.reason !== "kid") return last;
      }
      return last;
    };
    const codec: SyncCodec = {
      get kid() {
        return self.#held ? hex(self.#held.kid) : null;
      },
      get locked() {
        return self.#held === null;
      },
      async seal(collection, name, value) {
        return sealValue(
          self.#crypto,
          self.#need().root,
          collection,
          name,
          value,
        );
      },
      open: (collection, name, envelope, aliases = []) =>
        tryRoots(envelope, (root) =>
          openValue(self.#crypto, root, collection, name, envelope, aliases),
        ),
      openAny: (collection, envelope) =>
        tryRoots(envelope, (root) =>
          openValueAnyName(self.#crypto, root, collection, envelope),
        ),
      async blind(kind, ctx, name) {
        return blind(self.#crypto, self.#need().root, kind, ctx, name);
      },
    };
    printAs(codec, () => ({ locked: self.#held === null }));
    return codec;
  }
}

function wireWrap(w: SyncWrap): { kem: number; enc: string; ct: string } {
  return {
    kem: HPKE_KEM_X25519,
    enc: base64UrlEncodeBytes(w.enc),
    ct: base64UrlEncodeBytes(w.ct),
  };
}

function parseState(body: unknown): KeyringState | null {
  if (!isRecord(body) || !("ring" in body) || !("wrap" in body)) return null;
  let ring: KeyringRing | null = null;
  const r = body.ring;
  if (r !== null) {
    if (
      !isRecord(r) ||
      typeof r.ringId !== "string" ||
      typeof r.epoch !== "number" ||
      typeof r.rootKid !== "string" ||
      typeof r.state !== "string" ||
      typeof r.createdAt !== "number" ||
      !isRecord(r.recovery) ||
      typeof r.recovery.set !== "boolean" ||
      !Array.isArray(r.adopted)
    )
      return null;
    const adopted: KeyringRing["adopted"] = [];
    for (const a of r.adopted) {
      if (
        !isRecord(a) ||
        typeof a.ringId !== "string" ||
        typeof a.epoch !== "number" ||
        typeof a.kid !== "string" ||
        typeof a.ct !== "string"
      )
        return null;
      adopted.push({ ringId: a.ringId, epoch: a.epoch, kid: a.kid, ct: a.ct });
    }
    const p = r.previous;
    if (p !== undefined && p !== null) {
      if (
        !isRecord(p) ||
        typeof p.ringId !== "string" ||
        typeof p.kid !== "string" ||
        typeof p.until !== "number"
      )
        return null;
    }
    ring = {
      ringId: r.ringId,
      epoch: r.epoch,
      rootKid: r.rootKid,
      state: r.state,
      createdAt: r.createdAt,
      recovery: {
        set: r.recovery.set,
        ...(typeof r.recovery.createdAt === "number"
          ? { createdAt: r.recovery.createdAt }
          : {}),
      },
      adopted,
      ...(isRecord(p)
        ? {
            previous: {
              ringId: p.ringId as string,
              kid: p.kid as string,
              until: p.until as number,
            },
          }
        : {}),
    };
  }
  let wrap: KeyringWrapInfo | null = null;
  const w = body.wrap;
  if (w !== null) {
    if (
      !isRecord(w) ||
      typeof w.epoch !== "number" ||
      typeof w.kid !== "string" ||
      (typeof w.kem !== "string" && typeof w.kem !== "number") ||
      typeof w.enc !== "string" ||
      typeof w.ct !== "string"
    )
      return null;
    wrap = {
      epoch: w.epoch,
      kid: w.kid,
      kem: w.kem,
      enc: w.enc,
      ct: w.ct,
      ...(typeof w.by === "string" ? { by: w.by } : {}),
    };
  }
  return { ring, wrap };
}
