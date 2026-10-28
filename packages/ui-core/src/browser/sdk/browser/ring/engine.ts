// The browser's key ring client (sync.keyring, U-38.2) over the bearer engine: client-core's
// crypto (`@polaris-key/client-core/sync`) on WebCrypto, the Worker's `/devices/keyring` routes
// (WIRE-CONTRACT-V5 §13.11.2).
//
// What it holds, and for how long:
//  - the root `R` as a non-extractable HKDF key in the vault (IndexedDB), the only copy that
//    outlives a call. Sealing keys are derived from that handle (`ringKeys`);
//  - `R` as bytes only in `session`, after this page created, recovered or unwrapped it, for
//    `sessionRootSeconds`. Wrapping to another device, replacing the recovery code and adopting
//    need the bytes; once the window closes they need the recovery code again;
//  - the recovery code only inside the call that makes or reads it. It is returned once, never
//    stored, never logged, never in an error.
//
// A browser unlocks only with the recovery code (Q8). A browser whose device keys die with the
// page (WebKit when it keeps nothing of an X25519 key) cannot create or reset a ring, because the
// Worker wants registered keys for the ring's own wrap; it unlocks with the code, holds the root
// in memory, and asks for the code again at the next load.

import {
  HPKE_KEM_X25519,
  RECOVERY_CODE_INVALID,
  deriveKid,
  encodeRecoveryCode,
  newRecoveryCode,
  parseRecoveryCode,
  sealAdopt,
  unwrapRecovery,
  unwrapRootWithDh,
  webCryptoSyncPort,
  wrapRecovery,
  wrapRoot,
  type SyncCryptoPort,
  type SyncWrap,
} from "@polaris-key/client-core/sync";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import {
  ERROR_CODE_VALUES,
  ErrorCode,
  Feature,
} from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import { PolarisError, type PolarisErrorCode } from "../../core/types.js";
import type {
  RingCode,
  RingPersistence,
  RingStatus,
  KeyringClient,
} from "../../core/keyring.js";
import {
  importRootHandle,
  memoryRootVault,
  ringKeysOf,
  type RingKeys,
  type RootVault,
  type StoredRoot,
} from "./rootVault.js";

/** How the engine reaches the Worker: the bearer session's request, with its headers and token. */
export interface RingTransport {
  /** `path` is relative to the product: `devices/keyring`, `devices/keyring/recovery`, … */
  request(
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response>;
}

export interface RingEngineOptions {
  product: string;
  deviceId: () => string;
  transport: RingTransport;
  /** This device's key store; null when the host configured none (the ring cannot be created). */
  keys: DeviceKeyPort | null;
  /** Registers the device keys with the Worker if they are not yet (`PUT /devices/keys`). */
  ensureKeysRegistered?: () => Promise<void>;
  /** The durable vault. A memory-only key store makes the engine use a memory vault instead. */
  vault: RootVault;
  crypto?: SyncCryptoPort;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** A test seam: the id for the next ring (default `rg_` and 16 random bytes in base64url). */
  newRingId?: () => string;
  /** How long root bytes stay in memory after a create, a recovery or an unwrap. Default 300. */
  sessionRootSeconds?: number;
}

const DEFAULT_SESSION_ROOT_SECONDS = 300;
/**
 * `kem` on the wire is the HPKE KEM id as a JSON integer (V5 §13.11.1). The Worker's first
 * routes took the text "x25519" for the same key type, so a reader accepts that too (and "32").
 */
const isX25519Kem = (kem: unknown): boolean =>
  kem === HPKE_KEM_X25519 ||
  kem === "x25519" ||
  kem === String(HPKE_KEM_X25519);

// ── Small codecs ─────────────────────────────────────────────────────────────────────────────

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: unknown): Uint8Array | null => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const t = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(t, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: unknown): Uint8Array | null =>
  typeof s === "string" && /^[0-9a-f]{32}$/.test(s)
    ? Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16))
    : null;

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

interface WireRing {
  ringId: string;
  epoch: number;
  rootKid: string;
  state: string;
  recoverySet: boolean;
  previous: string | null;
  adopted: string[];
}
interface WireWrap {
  epoch: number;
  kid: string;
  kem: unknown;
  enc: unknown;
  ct: unknown;
  by: string;
}

/** The ring and this device's wrap as the Worker holds them, without the key material. */
export interface RingDetail {
  ring: {
    ringId: string;
    epoch: number;
    rootKid: string;
    state: string;
    recoverySet: boolean;
    /** The id of the ring a reset replaced, while the server keeps it. */
    previous: string | null;
    /** The ids of rings merged into this one. */
    adopted: string[];
  } | null;
  wrap: { epoch: number; kid: string; by: string } | null;
}

/** A refusal in the one taxonomy: the server's code when the registry holds it. */
async function refusal(res: Response): Promise<PolarisError> {
  const b = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
  };
  const wire = typeof b.error === "string" ? b.error : (b.error?.code ?? "");
  const code = (ERROR_CODE_VALUES as readonly string[]).includes(wire)
    ? (wire as PolarisErrorCode)
    : "http-error";
  const retry = Number(res.headers.get("retry-after"));
  return new PolarisError(
    code,
    `The key ring request failed with status ${res.status}.`,
    wire || undefined,
    undefined,
    {
      status: res.status,
      ...(Number.isFinite(retry) && retry > 0
        ? { retryAfterSeconds: retry }
        : {}),
    },
  );
}

const badResponse = (what: string): PolarisError =>
  new PolarisError(
    ErrorCode.badResponse,
    `The key ring answer was malformed (${what}).`,
  );

export class RingEngine implements KeyringClient {
  readonly unsupported = null;
  private readonly p: SyncCryptoPort;
  private readonly now: () => number;
  private readonly memory = memoryRootVault();
  private readonly listeners = new Set<() => void>();
  private held = false;
  private session: {
    ringId: string;
    epoch: number;
    kid: Uint8Array;
    bytes: Uint8Array;
    until: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private previous: {
    ringId: string;
    epoch: number;
    kid: Uint8Array;
    bytes: Uint8Array;
  } | null = null;
  private recoveryBlob: {
    ringId: string;
    ct: Uint8Array;
    epoch: number;
    kid: string;
  } | null = null;

  constructor(private readonly o: RingEngineOptions) {
    this.p = o.crypto ?? webCryptoSyncPort;
    this.now = o.now ?? (() => Date.now());
  }

  // ── State ──────────────────────────────────────────────────────────────────────────────────

  hasRoot(): boolean {
    return this.held;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setHeld(v: boolean): void {
    if (this.held === v) return;
    this.held = v;
    for (const l of [...this.listeners]) l();
  }

  private async keysDurable(): Promise<boolean> {
    const k = this.o.keys;
    if (!k) return false;
    return ((await k.persistence?.()) ?? "durable") === "durable";
  }

  /** The vault in use: the durable one only while the device keys are durable too. */
  private async vault(): Promise<RootVault> {
    return (await this.keysDurable()) ? this.o.vault : this.memory;
  }

  private async persistence(): Promise<RingPersistence> {
    return (await this.vault()).persistence();
  }

  /** The derived keys the sealing codec takes, or null while this device holds no root. */
  async ringKeys(): Promise<RingKeys | null> {
    const rec = await (await this.vault()).get();
    return rec ? ringKeysOf(rec, this.p) : null;
  }

  private unsupported_(detail: string): UnsupportedError {
    return new UnsupportedError({
      supported: false,
      feature: Feature.syncKeyring,
      reason: "runtime",
      detail,
    });
  }

  private async requireDurableKeys(): Promise<DeviceKeyPort> {
    const k = this.o.keys;
    if (!k)
      throw this.unsupported_(
        "No device key store is configured, so this page cannot make a key ring.",
      );
    if (!(await this.keysDurable()))
      throw this.unsupported_(
        "This browser cannot keep device keys, so it cannot create or reset the key ring. Unlock it with the recovery code, or use another device.",
      );
    return k;
  }

  private sessionRoot(): NonNullable<RingEngine["session"]> {
    const s = this.session;
    if (s && this.now() >= s.until) this.dropSession();
    if (!this.session)
      throw this.unsupported_(
        "The root is not held as bytes any more. Unlock with the recovery code first.",
      );
    return this.session;
  }

  private dropSession(): void {
    const s = this.session;
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.bytes.fill(0);
    this.session = null;
  }

  private dropPrevious(): void {
    this.previous?.bytes.fill(0);
    this.previous = null;
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────

  private async call(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    return this.o.transport.request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private async read(): Promise<{
    ring: WireRing | null;
    wrap: WireWrap | null;
  }> {
    const res = await this.call("devices/keyring", "GET");
    if (!res.ok) throw await refusal(res);
    const b = (await res.json().catch(() => null)) as {
      ring?: Record<string, unknown> | null;
      wrap?: Record<string, unknown> | null;
    } | null;
    if (!b || typeof b !== "object") throw badResponse("not an object");
    if (b.ring == null) return { ring: null, wrap: null };
    const r = b.ring;
    const recovery = r.recovery as { set?: unknown } | undefined;
    if (
      typeof r.ringId !== "string" ||
      !Number.isSafeInteger(r.epoch) ||
      unhex(r.rootKid) === null
    )
      throw badResponse("ring");
    const prev = r.previous as { ringId?: unknown } | undefined;
    const adopted = Array.isArray(r.adopted)
      ? (r.adopted as { ringId?: unknown }[])
          .map((a) => a?.ringId)
          .filter((id): id is string => typeof id === "string")
      : [];
    const ring: WireRing = {
      ringId: r.ringId,
      epoch: r.epoch as number,
      rootKid: r.rootKid as string,
      state: typeof r.state === "string" ? r.state : "active",
      recoverySet: recovery?.set === true,
      previous: typeof prev?.ringId === "string" ? prev.ringId : null,
      adopted,
    };
    const w = b.wrap;
    const wrap =
      w && typeof w === "object" && Number.isSafeInteger(w.epoch)
        ? ({
            epoch: w.epoch as number,
            kid: String(w.kid),
            kem: w.kem,
            enc: w.enc,
            ct: w.ct,
            by: String(w.by ?? ""),
          } satisfies WireWrap)
        : null;
    return { ring, wrap };
  }

  /** The ring and this device's wrap as the Worker holds them. Unlocks nothing. */
  async inspect(): Promise<RingDetail> {
    const { ring, wrap } = await this.read();
    return {
      ring,
      wrap: wrap && { epoch: wrap.epoch, kid: wrap.kid, by: wrap.by },
    };
  }

  async status(): Promise<RingStatus> {
    const { ring, wrap } = await this.read();
    const vault = await this.vault();
    const persistence = vault.persistence();
    const canCreate = await this.keysDurable();
    if (!ring) {
      // The ring is gone (its data was deleted): a root for it opens nothing.
      await vault.clear();
      this.dropSession();
      this.setHeld(false);
      return this.shape("none", null, persistence, canCreate);
    }
    const have = await vault.get();
    if (
      have &&
      have.ringId === ring.ringId &&
      have.epoch === ring.epoch &&
      have.kid === ring.rootKid
    ) {
      this.setHeld(true);
      return this.shape("unlocked", ring, persistence, canCreate);
    }
    // Not the current ring's root: nothing held is current any more.
    if (have) this.setHeld(false);
    if (wrap && canCreate && (await this.openOwnWrap(ring, wrap)))
      return this.shape("unlocked", ring, persistence, canCreate);
    return this.shape("locked", ring, persistence, canCreate);
  }

  private shape(
    state: RingStatus["state"],
    ring: WireRing | null,
    persistence: RingPersistence,
    canCreate: boolean,
  ): RingStatus {
    return {
      state,
      ringId: ring?.ringId ?? null,
      epoch: ring?.epoch ?? null,
      recoverySet: ring?.recoverySet ?? false,
      persistence,
      canCreate,
    };
  }

  /** Opens this device's wrap with its agreement key; true when the root is now held. */
  private async openOwnWrap(ring: WireRing, wrap: WireWrap): Promise<boolean> {
    const keys = this.o.keys;
    if (!keys || wrap.epoch !== ring.epoch || wrap.kid !== ring.rootKid)
      return false;
    if (!isX25519Kem(wrap.kem)) return false;
    const enc = unb64(wrap.enc);
    const ct = unb64(wrap.ct);
    const kid = unhex(wrap.kid);
    const pub = await keys.publicKeys();
    if (!enc || !ct || !kid || !pub) return false;
    const agree = unb64(pub.agreeKey);
    if (!agree) return false;
    const root = await unwrapRootWithDh(
      this.p,
      { publicKey: agree, dh: (peer) => keys.dh(peer) },
      {
        product: this.o.product,
        deviceId: this.o.deviceId(),
        ringId: ring.ringId,
        epoch: ring.epoch,
      },
      kid,
      { kem: HPKE_KEM_X25519, enc, ct } satisfies SyncWrap,
    );
    if (!root) return false;
    return this.accept(root, ring.ringId, ring.epoch, ring.rootKid);
  }

  /** Keeps `root` if its `kid` is the ring's: the vault handle, and the session bytes. */
  private async accept(
    root: Uint8Array,
    ringId: string,
    epoch: number,
    rootKid: string,
  ): Promise<boolean> {
    const kid = await deriveKid(this.p, root);
    if (hex(kid) !== rootKid) {
      root.fill(0);
      return false;
    }
    const rec: StoredRoot = {
      v: 1,
      ringId,
      epoch,
      kid: rootKid,
      key: await importRootHandle(root),
    };
    await (await this.vault()).put(rec);
    this.dropSession();
    const ms =
      (this.o.sessionRootSeconds ?? DEFAULT_SESSION_ROOT_SECONDS) * 1000;
    const timer = setTimeout(() => this.dropSession(), ms);
    (timer as { unref?: () => void }).unref?.();
    this.session = {
      ringId,
      epoch,
      kid,
      bytes: root,
      until: this.now() + ms,
      timer,
    };
    this.setHeld(true);
    return true;
  }

  // ── Making a ring ──────────────────────────────────────────────────────────────────────────

  private async newRing(): Promise<{
    ringId: string;
    root: Uint8Array;
    kid: Uint8Array;
    code: Uint8Array;
    body: Record<string, unknown>;
  }> {
    const keys = await this.requireDurableKeys();
    await this.o.ensureKeysRegistered?.();
    const pub = await keys.ensure();
    const agree = unb64(pub.agreeKey);
    if (!agree) throw badResponse("device key");
    const root = this.p.random(32);
    const kid = await deriveKid(this.p, root);
    const ringId = this.o.newRingId?.() ?? `rg_${b64(this.p.random(16))}`;
    const code = newRecoveryCode(this.p);
    const wrap = await wrapRoot(
      this.p,
      agree,
      {
        product: this.o.product,
        deviceId: this.o.deviceId(),
        ringId,
        epoch: 1,
      },
      kid,
      root,
    );
    const recovery = await wrapRecovery(this.p, code, ringId, 1, kid, root);
    return {
      ringId,
      root,
      kid,
      code,
      body: {
        ringId,
        rootKid: hex(kid),
        wrap: { kem: HPKE_KEM_X25519, enc: b64(wrap.enc), ct: b64(wrap.ct) },
        recovery: { ct: b64(recovery) },
      },
    };
  }

  private async make(path: string): Promise<RingCode> {
    const n = await this.newRing();
    try {
      const res = await this.call(path, "POST", n.body);
      if (!res.ok) throw await refusal(res);
      const b = (await res.json().catch(() => null)) as {
        ringId?: unknown;
        epoch?: unknown;
      } | null;
      const epoch = b?.epoch;
      if (b?.ringId !== n.ringId || !Number.isSafeInteger(epoch))
        throw badResponse("create");
      if (!(await this.accept(n.root, n.ringId, epoch as number, hex(n.kid))))
        throw badResponse("root");
      this.recoveryBlob = null;
      return {
        recoveryCode: await encodeRecoveryCode(this.p, n.code),
        ringId: n.ringId,
        epoch: epoch as number,
      };
    } finally {
      n.code.fill(0);
      // `accept` keeps the bytes for the session; on any failure they are not kept.
      if (this.session?.bytes !== n.root) n.root.fill(0);
    }
  }

  async create(): Promise<RingCode> {
    return this.make("devices/keyring");
  }

  async reset(): Promise<RingCode> {
    // The ring being replaced stays readable for 30 days if this session still holds its root.
    const old =
      this.session && this.now() < this.session.until ? this.session : null;
    const keep = old
      ? {
          ringId: old.ringId,
          epoch: old.epoch,
          kid: old.kid.slice(),
          bytes: old.bytes.slice(),
        }
      : null;
    try {
      const out = await this.make("devices/keyring/reset");
      this.dropPrevious();
      this.previous = keep;
      return out;
    } catch (e) {
      keep?.bytes.fill(0);
      throw e;
    }
  }

  async adoptPrevious(): Promise<void> {
    const from = this.previous;
    if (!from)
      throw this.unsupported_(
        "No earlier root is held in this session, so nothing can be adopted.",
      );
    const cur = this.sessionRoot();
    const ct = await sealAdopt(
      this.p,
      cur.bytes,
      { fromRingId: from.ringId, epoch: from.epoch, kid: from.kid },
      from.bytes,
    );
    const res = await this.call("devices/keyring/adopt", "POST", {
      fromRingId: from.ringId,
      epoch: from.epoch,
      kid: hex(from.kid),
      ct: b64(ct),
    });
    if (!res.ok) throw await refusal(res);
  }

  // ── Recovery ───────────────────────────────────────────────────────────────────────────────

  async recover(codeText: string): Promise<RingStatus> {
    // The checksum first: a mistyped code costs no request, and the server allows 5 a day.
    const code = await parseRecoveryCode(this.p, codeText);
    if (!code)
      throw new PolarisError(
        ErrorCode.recoveryCodeInvalid,
        "That recovery code is not valid.",
        RECOVERY_CODE_INVALID,
      );
    try {
      const { ring } = await this.read();
      if (!ring)
        throw new PolarisError(
          ErrorCode.notFound,
          "There is no key ring to unlock.",
        );
      const blob = await this.fetchRecovery(ring);
      const kid = unhex(blob.kid);
      if (!kid || blob.epoch !== ring.epoch || blob.kid !== ring.rootKid)
        throw badResponse("recovery");
      const root = await unwrapRecovery(
        this.p,
        code,
        ring.ringId,
        blob.epoch,
        kid,
        blob.ct,
      );
      if (
        !root ||
        !(await this.accept(root, ring.ringId, ring.epoch, ring.rootKid))
      )
        throw new PolarisError(
          ErrorCode.recoveryCodeInvalid,
          "That recovery code is not valid.",
          RECOVERY_CODE_INVALID,
        );
      this.recoveryBlob = null;
      // A device that can keep keys deposits its own wrap, so a reload needs no code. Best effort.
      if (await this.keysDurable())
        await this.depositOwnWrap(ring).catch(() => undefined);
      return this.shape(
        "unlocked",
        ring,
        await this.persistence(),
        await this.keysDurable(),
      );
    } finally {
      code.fill(0);
    }
  }

  /** `GET /<p>/devices/keyring/recovery`: the sealed blob, 5 a day per device. Opens nothing. */
  async getRecoveryBlob(): Promise<{ ct: string; epoch: number; kid: string }> {
    const res = await this.call("devices/keyring/recovery", "GET");
    if (!res.ok) throw await refusal(res);
    const b = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      !b ||
      typeof b.ct !== "string" ||
      unb64(b.ct) === null ||
      !Number.isSafeInteger(b.epoch) ||
      unhex(b.kid) === null
    )
      throw badResponse("recovery");
    return { ct: b.ct, epoch: b.epoch as number, kid: b.kid as string };
  }

  private async fetchRecovery(
    ring: WireRing,
  ): Promise<NonNullable<RingEngine["recoveryBlob"]>> {
    // One read per ring per page: a wrong code must not spend the day's five.
    if (this.recoveryBlob?.ringId === ring.ringId) return this.recoveryBlob;
    const b = await this.getRecoveryBlob();
    this.recoveryBlob = {
      ringId: ring.ringId,
      ct: unb64(b.ct)!,
      epoch: b.epoch,
      kid: b.kid,
    };
    return this.recoveryBlob;
  }

  private async depositOwnWrap(ring: WireRing): Promise<void> {
    const keys = this.o.keys!;
    const s = this.sessionRoot();
    await this.o.ensureKeysRegistered?.();
    const pub = await keys.ensure();
    const agree = unb64(pub.agreeKey);
    if (!agree) return;
    await this.putWrap(this.o.deviceId(), agree, s, ring.rootKid);
  }

  async setRecoveryCode(): Promise<RingCode> {
    const s = this.sessionRoot();
    const code = newRecoveryCode(this.p);
    try {
      const blob = await wrapRecovery(
        this.p,
        code,
        s.ringId,
        s.epoch,
        s.kid,
        s.bytes,
      );
      const res = await this.call("devices/keyring/recovery", "PUT", {
        ct: b64(blob),
        epoch: s.epoch,
        kid: hex(s.kid),
      });
      if (!res.ok) throw await refusal(res);
      this.recoveryBlob = null;
      return {
        recoveryCode: await encodeRecoveryCode(this.p, code),
        ringId: s.ringId,
        epoch: s.epoch,
      };
    } finally {
      code.fill(0);
    }
  }

  // ── Wraps ──────────────────────────────────────────────────────────────────────────────────

  private async putWrap(
    deviceId: string,
    agree: Uint8Array,
    s: NonNullable<RingEngine["session"]>,
    kidHex: string,
  ): Promise<void> {
    const wrap = await wrapRoot(
      this.p,
      agree,
      { product: this.o.product, deviceId, ringId: s.ringId, epoch: s.epoch },
      s.kid,
      s.bytes,
    );
    const res = await this.call(
      `devices/keyring/wraps/${encodeURIComponent(deviceId)}`,
      "PUT",
      {
        epoch: s.epoch,
        kid: kidHex,
        kem: HPKE_KEM_X25519,
        enc: b64(wrap.enc),
        ct: b64(wrap.ct),
      },
    );
    if (!res.ok) throw await refusal(res);
  }

  async wrapTo(deviceId: string, agreeKey: string | Uint8Array): Promise<void> {
    const s = this.sessionRoot();
    const agree = typeof agreeKey === "string" ? unb64(agreeKey) : agreeKey;
    if (!agree || agree.length !== 32)
      throw new PolarisError(
        "invalid-options",
        "The device's agreement key is not 32 bytes.",
      );
    await this.putWrap(deviceId, agree, s, hex(s.kid));
  }

  async removeWrap(deviceId: string): Promise<void> {
    const res = await this.call(
      `devices/keyring/wraps/${encodeURIComponent(deviceId)}`,
      "DELETE",
    );
    if (!res.ok) throw await refusal(res);
  }

  async lock(): Promise<void> {
    this.dropSession();
    this.dropPrevious();
    this.recoveryBlob = null;
    await this.o.vault.clear();
    await this.memory.clear();
    this.setHeld(false);
  }
}
