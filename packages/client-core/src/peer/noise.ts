// WIRE-CONTRACT-V5 §15.5 and §15.6: the Noise engine of `pkey-peer/1`. The Noise Protocol
// Framework (revision 34), patterns XX and XXpsk0 over 25519, AESGCM and SHA256, written over two
// ports: an `Aead` (AES-256-GCM) and an `X25519`. Both default to WebCrypto, which has X25519 and
// AES-GCM everywhere client-core runs, so no dependency is added. Nothing here does I/O: bytes in,
// bytes out. A host that has no WebCrypto X25519 supplies its own ports.
//
// Failures throw a `NoiseError` whose `code` is all a caller may show or log; it carries no key,
// payload or ciphertext. After any failure a handshake is dead and refuses further use.

import { isX25519LowOrder } from "@polaris-key/jws";

// ── Ports ────────────────────────────────────────────────────────────────────────────────────

/** AES-256-GCM with a 96-bit nonce and a 16-byte tag appended to the ciphertext. */
export interface Aead {
  seal(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  /** The plaintext, or null when the tag does not verify. */
  open(
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null>;
}

/** X25519 (RFC 7748). */
export interface X25519Port {
  /** The public key of a 32-byte private scalar. */
  publicKey(privateKey: Uint8Array): Promise<Uint8Array>;
  /**
   * The shared secret, or null when the backend refuses the point. A backend that returns the
   * all-zero output instead is also fine: the engine refuses it.
   */
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array | null>;
}

export interface NoisePorts {
  aead: Aead;
  x25519: X25519Port;
  /** Random bytes for ephemeral keys. Default `crypto.getRandomValues`. */
  random: (length: number) => Uint8Array;
}

const buf = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const cat = (...parts: Uint8Array[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

async function gcm(
  op: "encrypt" | "decrypt",
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(key), "AES-GCM", false, [op]);
  const params = {
    name: "AES-GCM",
    iv: buf(nonce),
    additionalData: buf(aad),
    tagLength: 128,
  };
  return new Uint8Array(await subtle()[op](params, k, buf(data)));
}

/** `Aead` on WebCrypto AES-GCM. */
export const webCryptoAead: Aead = {
  seal: (key, nonce, aad, plaintext) =>
    gcm("encrypt", key, nonce, aad, plaintext),
  open: (key, nonce, aad, ciphertext) =>
    gcm("decrypt", key, nonce, aad, ciphertext).catch(() => null),
};

// PKCS#8 wrapper of a raw X25519 scalar (RFC 8410): WebCrypto imports no raw private key.
const PKCS8_X25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);
const BASE_POINT = Uint8Array.from([9, ...new Array<number>(31).fill(0)]);

async function webDh(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const priv = await subtle().importKey(
      "pkcs8",
      buf(cat(PKCS8_X25519, privateKey)),
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
    const pub = await subtle().importKey(
      "raw",
      buf(publicKey),
      { name: "X25519" },
      false,
      [],
    );
    return new Uint8Array(
      await subtle().deriveBits({ name: "X25519", public: pub }, priv, 256),
    );
  } catch {
    return null;
  }
}

/** `X25519Port` on WebCrypto. A point WebCrypto refuses (low order) answers null. */
export const webCryptoX25519: X25519Port = {
  async publicKey(privateKey) {
    const out = await webDh(privateKey, BASE_POINT);
    if (out === null) throw new NoiseError("bad_key");
    return out;
  },
  dh: webDh,
};

export const webCryptoNoisePorts: NoisePorts = {
  aead: webCryptoAead,
  x25519: webCryptoX25519,
  random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
};

// ── Errors ───────────────────────────────────────────────────────────────────────────────────

export type NoiseErrorCode =
  /** A Noise message or record fails its tag (wrong key, PSK, prologue or tampering). */
  | "decrypt"
  /** A DH output is all zeros (a low-order point). */
  | "dh_zero"
  /** A message is shorter than its tokens need, or longer than 65,535 bytes. */
  | "malformed"
  /** A call out of order, after the handshake ended, or after a failure. */
  | "state"
  /** The nonce counter is exhausted. */
  | "nonce_exhausted"
  /** A key or the PSK has the wrong length, or the backend refuses a key. */
  | "bad_key";

export class NoiseError extends Error {
  constructor(readonly code: NoiseErrorCode) {
    super(`noise: ${code}`);
    this.name = "NoiseError";
  }
}

/** A Noise message is at most 65,535 bytes (Noise §3), and a TCP frame carries one (§15.6). */
export const NOISE_MAX_MESSAGE = 65535;
const TAG = 16;
const MAX_NONCE = (1n << 64n) - 1n;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── Hash and KDF ─────────────────────────────────────────────────────────────────────────────

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", buf(cat(...parts))));
}

export async function hmac(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey(
    "raw",
    buf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle().sign("HMAC", k, buf(data)));
}

/** HKDF-SHA256 (RFC 5869). An empty salt is HashLen zero bytes, as the RFC defines. */
export async function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt.length === 0 ? new Uint8Array(32) : salt, ikm);
  let t: Uint8Array = new Uint8Array(0);
  const out: Uint8Array[] = [];
  for (let i = 1; out.length * 32 < length; i++) {
    t = await hmac(prk, cat(t, info, Uint8Array.of(i)));
    out.push(t);
  }
  return cat(...out).subarray(0, length);
}

// ── Protocol names, prologue, PSK (§15.5) ────────────────────────────────────────────────────

export type PeerMode = "a" | "v" | "p";

/** The Noise protocol name of a mode: XXpsk0 for `a` (R-1), plain XX for `v` and `p`. */
export function peerNoiseProtocol(mode: PeerMode): string {
  return mode === "a"
    ? "Noise_XXpsk0_25519_AESGCM_SHA256"
    : "Noise_XX_25519_AESGCM_SHA256";
}

/** `"pkey-peer/1" ‖ 0x00 ‖ slug ‖ 0x00 ‖ mode ‖ 0x00`. */
export function peerPrologue(slug: string, mode: PeerMode): Uint8Array {
  return cat(
    utf8("pkey-peer/1"),
    Uint8Array.of(0),
    utf8(slug),
    Uint8Array.of(0),
    utf8(mode),
    Uint8Array.of(0),
  );
}

/**
 * The mode-a PSK: HKDF-SHA256 with an empty salt, the 32-byte discovery key as the input keying
 * material and `"pkey-peer/1 psk" ‖ 0x00 ‖ slug` as info, 32 bytes out (V5 §15.5 pins this order).
 */
export async function peerPsk(
  discKey: Uint8Array,
  slug: string,
): Promise<Uint8Array> {
  if (discKey.length !== 32) throw new NoiseError("bad_key");
  return hkdfSha256(
    new Uint8Array(0),
    discKey,
    cat(utf8("pkey-peer/1 psk"), Uint8Array.of(0), utf8(slug)),
    32,
  );
}

// ── CipherState ──────────────────────────────────────────────────────────────────────────────

const noiseNonce = (n: bigint): Uint8Array => {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, false);
  return out;
};

/**
 * One direction of the transport, or the handshake's cipher. The counter moves before the call
 * awaits, and calls run one at a time, so two concurrent calls never share a nonce. A failed read
 * does not advance the counter (Noise §5.1).
 */
export class CipherState {
  private n = 0n;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private k: Uint8Array | null,
    private readonly aead: Aead,
  ) {}

  hasKey(): boolean {
    return this.k !== null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  setKey(k: Uint8Array): void {
    this.k = k;
    this.n = 0n;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return this.serial(async () => {
      if (this.k === null) return plaintext;
      if (this.n === MAX_NONCE) throw new NoiseError("nonce_exhausted");
      if (plaintext.length + TAG > NOISE_MAX_MESSAGE)
        throw new NoiseError("malformed");
      const nonce = noiseNonce(this.n);
      this.n++;
      return this.aead.seal(this.k, nonce, ad, plaintext);
    });
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    return this.serial(async () => {
      if (this.k === null) return ciphertext;
      if (this.n === MAX_NONCE) throw new NoiseError("nonce_exhausted");
      if (ciphertext.length < TAG || ciphertext.length > NOISE_MAX_MESSAGE)
        throw new NoiseError("malformed");
      const pt = await this.aead.open(
        this.k,
        noiseNonce(this.n),
        ad,
        ciphertext,
      );
      if (pt === null) throw new NoiseError("decrypt");
      this.n++;
      return pt;
    });
  }

  /** REKEY (Noise §4.2): `k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32]`. The counter stays. */
  rekey(): Promise<void> {
    return this.serial(async () => {
      if (this.k === null) throw new NoiseError("state");
      const out = await this.aead.seal(
        this.k,
        noiseNonce(MAX_NONCE),
        new Uint8Array(0),
        new Uint8Array(32),
      );
      this.k = out.slice(0, 32);
    });
  }
}

/** The two directions of a finished handshake. */
export interface NoiseTransport {
  send: CipherState;
  receive: CipherState;
}

// ── HandshakeState ───────────────────────────────────────────────────────────────────────────

type Token = "e" | "s" | "ee" | "es" | "se" | "psk";

/** Message token lists of XX, initiator first. */
const XX: readonly (readonly Token[])[] = [
  ["e"],
  ["e", "ee", "s", "es"],
  ["s", "se"],
];

export interface NoiseHandshakeOptions {
  role: "initiator" | "responder";
  /** `Noise_XX_25519_AESGCM_SHA256` or `Noise_XXpsk0_25519_AESGCM_SHA256`. */
  protocol: string;
  prologue: Uint8Array;
  /** The 32-byte PSK; required exactly when the protocol is XXpsk0. */
  psk?: Uint8Array;
  /** This side's static private key (32 bytes). */
  staticKey: Uint8Array;
  /** A fixed ephemeral private key, for known-answer tests only. Default: random. */
  ephemeralKey?: Uint8Array;
  ports?: NoisePorts;
}

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/**
 * One handshake. Alternate `writeMessage` and `readMessage` as the role dictates (the initiator
 * writes first); after the third message `transport()` yields the two ciphers. Any thrown
 * `NoiseError` kills the handshake.
 */
export class NoiseHandshake {
  private readonly ports: NoisePorts;
  private readonly initiator: boolean;
  private readonly usesPsk: boolean;
  private readonly psk: Uint8Array | null;
  private readonly s: Uint8Array;
  private e: Uint8Array | null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private sPub: Uint8Array | null = null;
  private h: Uint8Array = new Uint8Array(0);
  private ck: Uint8Array = new Uint8Array(0);
  private cs: CipherState;
  private index = 0;
  private dead = false;
  private ready: Promise<void>;

  constructor(o: NoiseHandshakeOptions) {
    const m = /^Noise_XX(psk0)?_25519_AESGCM_SHA256$/.exec(o.protocol);
    if (m === null) throw new NoiseError("state");
    this.usesPsk = m[1] !== undefined;
    if (this.usesPsk !== (o.psk !== undefined)) throw new NoiseError("bad_key");
    if (o.psk !== undefined && o.psk.length !== 32)
      throw new NoiseError("bad_key");
    if (o.staticKey.length !== 32) throw new NoiseError("bad_key");
    if (o.ephemeralKey !== undefined && o.ephemeralKey.length !== 32)
      throw new NoiseError("bad_key");
    this.ports = o.ports ?? webCryptoNoisePorts;
    this.initiator = o.role === "initiator";
    this.psk = o.psk ?? null;
    this.s = o.staticKey;
    this.e = o.ephemeralKey ?? null;
    this.cs = new CipherState(null, this.ports.aead);
    this.ready = this.init(o.protocol, o.prologue);
  }

  private async init(protocol: string, prologue: Uint8Array): Promise<void> {
    const name = utf8(protocol);
    this.h =
      name.length <= 32
        ? cat(name, new Uint8Array(32 - name.length))
        : await sha256(name);
    this.ck = this.h;
    await this.mixHash(prologue);
  }

  /** True once all three messages are written and read. */
  get finished(): boolean {
    return this.index === XX.length;
  }

  /** The peer's static public key, once its `s` token has been read. */
  get remoteStatic(): Uint8Array | null {
    return this.rs;
  }

  /** The handshake hash `h`: the channel binding, once finished. */
  get handshakeHash(): Uint8Array {
    if (!this.finished) throw new NoiseError("state");
    return this.h;
  }

  private async mixHash(data: Uint8Array): Promise<void> {
    this.h = await sha256(this.h, data);
  }

  private async kdf(ikm: Uint8Array, outputs: 2 | 3): Promise<Uint8Array[]> {
    const temp = await hmac(this.ck, ikm);
    const o1 = await hmac(temp, Uint8Array.of(1));
    const o2 = await hmac(temp, cat(o1, Uint8Array.of(2)));
    if (outputs === 2) return [o1, o2];
    return [o1, o2, await hmac(temp, cat(o2, Uint8Array.of(3)))];
  }

  private async mixKey(ikm: Uint8Array): Promise<void> {
    const [ck, k] = await this.kdf(ikm, 2);
    this.ck = ck!;
    this.cs.setKey(k!);
  }

  private async mixKeyAndHash(ikm: Uint8Array): Promise<void> {
    const [ck, th, k] = await this.kdf(ikm, 3);
    this.ck = ck!;
    await this.mixHash(th!);
    this.cs.setKey(k!);
  }

  private async encryptAndHash(pt: Uint8Array): Promise<Uint8Array> {
    const ct = await this.cs.encrypt(this.h, pt);
    await this.mixHash(ct);
    return ct;
  }

  private async decryptAndHash(ct: Uint8Array): Promise<Uint8Array> {
    const pt = await this.cs.decrypt(this.h, ct);
    await this.mixHash(ct);
    return pt;
  }

  /** One DH token: this side's private key of the kind against the peer's public key. */
  private async dh(token: "ee" | "es" | "se"): Promise<void> {
    const pair = { ee: ["e", "e"], es: ["e", "s"], se: ["s", "e"] }[token];
    const mine = this.initiator ? pair[0] : pair[1];
    const theirs = this.initiator ? pair[1] : pair[0];
    const priv = mine === "e" ? this.e : this.s;
    const remote = theirs === "e" ? this.re : this.rs;
    if (priv === null || remote === null) throw new NoiseError("state");
    // The backend may refuse a low-order point or return zeros; both abort (§15.5).
    if (isX25519LowOrder(remote)) throw new NoiseError("dh_zero");
    const out = await this.ports.x25519.dh(priv, remote);
    if (out === null || out.length !== 32 || isZero(out))
      throw new NoiseError("dh_zero");
    await this.mixKey(out);
  }

  private guard<T>(turn: boolean, fn: () => Promise<T>): Promise<T> {
    return this.ready.then(async () => {
      if (this.dead || this.finished || this.initiator !== turn)
        throw new NoiseError("state");
      try {
        return await fn();
      } catch (err) {
        this.dead = true;
        throw err instanceof NoiseError ? err : new NoiseError("state");
      }
    });
  }

  private tokens(): Token[] {
    const t = [...XX[this.index]!];
    if (this.index === 0 && this.usesPsk) t.unshift("psk");
    return t;
  }

  /** Write the next handshake message carrying `payload`. */
  writeMessage(payload: Uint8Array): Promise<Uint8Array> {
    return this.guard(this.index % 2 === 0, async () => {
      let wire: Uint8Array = new Uint8Array(0);
      for (const t of this.tokens()) {
        if (t === "psk") await this.mixKeyAndHash(this.psk!);
        else if (t === "e") {
          this.e ??= this.ports.random(32);
          const pub = await this.ports.x25519.publicKey(this.e);
          wire = cat(wire, pub);
          await this.mixHash(pub);
          if (this.usesPsk) await this.mixKey(pub);
        } else if (t === "s") {
          this.sPub ??= await this.ports.x25519.publicKey(this.s);
          wire = cat(wire, await this.encryptAndHash(this.sPub));
        } else await this.dh(t);
      }
      wire = cat(wire, await this.encryptAndHash(payload));
      if (wire.length > NOISE_MAX_MESSAGE) throw new NoiseError("malformed");
      this.index++;
      return wire;
    });
  }

  /** Read the next handshake message; returns its payload. */
  readMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.guard(this.index % 2 === 1, async () => {
      if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError("malformed");
      let off = 0;
      for (const t of this.tokens()) {
        if (t === "psk") await this.mixKeyAndHash(this.psk!);
        else if (t === "e") {
          if (message.length < off + 32) throw new NoiseError("malformed");
          this.re = message.slice(off, off + 32);
          off += 32;
          await this.mixHash(this.re);
          if (this.usesPsk) await this.mixKey(this.re);
        } else if (t === "s") {
          const len = this.cs.hasKey() ? 32 + TAG : 32;
          if (message.length < off + len) throw new NoiseError("malformed");
          this.rs = await this.decryptAndHash(message.subarray(off, off + len));
          off += len;
        } else await this.dh(t);
      }
      const payload = await this.decryptAndHash(message.subarray(off));
      this.index++;
      return payload;
    });
  }

  /**
   * The transport ciphers of a finished handshake: `send` for this side's writes, `receive` for
   * its reads. The handshake object is spent afterwards.
   */
  async transport(): Promise<NoiseTransport> {
    await this.ready;
    if (this.dead || !this.finished) throw new NoiseError("state");
    this.dead = true;
    const [k1, k2] = await this.kdf(new Uint8Array(0), 2);
    const a = new CipherState(k1!, this.ports.aead);
    const b = new CipherState(k2!, this.ports.aead);
    return this.initiator ? { send: a, receive: b } : { send: b, receive: a };
  }
}
