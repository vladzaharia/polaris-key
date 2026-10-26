// Reference: the Noise handshake and transport of `pkey-peer/1` (V5 §15.5, §15.6).
//
// The generator's independent implementation of the Noise Protocol Framework (revision 34),
// written from the specification over `node:crypto` alone (X25519, AES-256-GCM, SHA-256, HMAC),
// so it shares no code with client-core's WebCrypto port. `noise.ts` (the family module) checks
// it against the published anchors before it writes a vector. It runs both roles in one process
// and checks every message by decrypting it with the other side, so a vector it writes has been
// read back by an independent party.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";

export const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
export const bytesHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const cat = (...parts: Uint8Array[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

export const sha256 = (...parts: Uint8Array[]): Uint8Array =>
  Uint8Array.from(
    createHash("sha256")
      .update(cat(...parts))
      .digest(),
  );

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  Uint8Array.from(createHmac("sha256", key).update(data).digest());

/** HKDF-SHA256 (RFC 5869): extract with `salt`, expand `info` to `length` bytes. */
export function refHkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const prk = hmac(salt.length === 0 ? new Uint8Array(32) : salt, ikm);
  let t: Uint8Array = new Uint8Array(0);
  const out: number[] = [];
  for (let i = 1; out.length < length; i++) {
    t = hmac(prk, cat(t, info, Uint8Array.of(i)));
    out.push(...t);
  }
  return Uint8Array.from(out.slice(0, length));
}

// ── X25519 ───────────────────────────────────────────────────────────────────

const PKCS8_X25519 = hexBytes("302e020100300506032b656e04220420");
const SPKI_X25519 = hexBytes("302a300506032b656e032100");
const P = (1n << 255n) - 19n;

/** RFC 7748 §5 over BigInt: the ladder, for points `node:crypto` refuses (low order). */
export function refX25519Ladder(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = Uint8Array.from(scalar);
  k[0] = k[0]! & 248;
  k[31] = (k[31]! & 127) | 64;
  const le = (b: Uint8Array): bigint =>
    b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const kn = le(k);
  const uc = Uint8Array.from(u);
  uc[31] = uc[31]! & 127;
  const x1 = le(uc) % P;
  const inv = (a: bigint): bigint => {
    let r = 1n;
    let b = a % P;
    let e = P - 2n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % P;
      b = (b * b) % P;
      e >>= 1n;
    }
    return r;
  };
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  const A24 = 121665n;
  for (let t = 254n; t >= 0n; t--) {
    const kt = (kn >> t) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;
    const a = (x2 + z2) % P;
    const aa = (a * a) % P;
    const b = (x2 - z2 + P) % P;
    const bb = (b * b) % P;
    const e = (aa - bb + P) % P;
    const c = (x3 + z3) % P;
    const d = (x3 - z3 + P) % P;
    const da = (d * a) % P;
    const cb = (c * b) % P;
    x3 = (((da + cb) % P) * ((da + cb) % P)) % P;
    const dc = (da - cb + P) % P;
    z3 = (x1 * ((dc * dc) % P)) % P;
    x2 = (aa * bb) % P;
    z2 = (e * ((aa + A24 * e) % P)) % P;
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  const r = (x2 * inv(z2)) % P;
  const out = new Uint8Array(32);
  let v = r;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

/** X25519(scalar, u) through `node:crypto`; a refused point (all-zero output) falls back to the
 *  ladder, so the caller always sees the 32 bytes RFC 7748 defines. */
export function refX25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(cat(PKCS8_X25519, scalar)),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey({
      key: Buffer.from(cat(SPKI_X25519, u)),
      format: "der",
      type: "spki",
    });
    return Uint8Array.from(diffieHellman({ privateKey, publicKey }));
  } catch {
    return refX25519Ladder(scalar, u);
  }
}

export function refX25519Public(scalar: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: Buffer.from(cat(PKCS8_X25519, scalar)),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return Uint8Array.from(der.subarray(der.length - 32));
}

// ── AES-256-GCM (Noise's AESGCM: 96-bit nonce = 4 zero bytes ‖ u64be n) ──────

const noiseNonce = (n: bigint): Uint8Array => {
  const out = new Uint8Array(12);
  for (let i = 0; i < 8; i++) out[11 - i] = Number((n >> BigInt(8 * i)) & 255n);
  return out;
};

export function refGcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ciphertext = Uint8Array.from(
    Buffer.concat([c.update(plaintext), c.final()]),
  );
  return { ciphertext, tag: Uint8Array.from(c.getAuthTag()) };
}

export function refGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Uint8Array | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Uint8Array.from(Buffer.concat([d.update(ciphertext), d.final()]));
  } catch {
    return null;
  }
}

// ── Noise ────────────────────────────────────────────────────────────────────

const MAX_NONCE = (1n << 64n) - 1n;

class CipherState {
  k: Uint8Array | null = null;
  n = 0n;
  setKey(k: Uint8Array | null): void {
    this.k = k;
    this.n = 0n;
  }
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (this.k === null) return pt;
    const { ciphertext, tag } = refGcmSeal(this.k, noiseNonce(this.n), ad, pt);
    this.n++;
    return cat(ciphertext, tag);
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array | null {
    if (this.k === null) return ct;
    if (ct.length < 16) return null;
    const pt = refGcmOpen(
      this.k,
      noiseNonce(this.n),
      ad,
      ct.subarray(0, ct.length - 16),
      ct.subarray(ct.length - 16),
    );
    if (pt !== null) this.n++;
    return pt;
  }
  /** REKEY: k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32] (Noise §4.2). */
  rekey(): void {
    if (this.k === null) throw new Error("noise: rekey without a key");
    const { ciphertext } = refGcmSeal(
      this.k,
      noiseNonce(MAX_NONCE),
      new Uint8Array(0),
      new Uint8Array(32),
    );
    this.k = ciphertext;
    // the counter is unchanged by REKEY
  }
}

class Symmetric {
  h: Uint8Array;
  ck: Uint8Array;
  cs = new CipherState();
  constructor(name: string) {
    const nb = new TextEncoder().encode(name);
    this.h =
      nb.length <= 32 ? cat(nb, new Uint8Array(32 - nb.length)) : sha256(nb);
    this.ck = this.h;
  }
  private hkdf(ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
    const temp = hmac(this.ck, ikm);
    const o1 = hmac(temp, Uint8Array.of(1));
    const o2 = hmac(temp, cat(o1, Uint8Array.of(2)));
    if (outputs === 2) return [o1, o2];
    return [o1, o2, hmac(temp, cat(o2, Uint8Array.of(3)))];
  }
  mixHash(data: Uint8Array): void {
    this.h = sha256(this.h, data);
  }
  mixKey(ikm: Uint8Array): void {
    const [ck, k] = this.hkdf(ikm, 2);
    this.ck = ck!;
    this.cs.setKey(k!);
  }
  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, th, k] = this.hkdf(ikm, 3);
    this.ck = ck!;
    this.mixHash(th!);
    this.cs.setKey(k!);
  }
  encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cs.encrypt(this.h, pt);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct: Uint8Array): Uint8Array | null {
    const pt = this.cs.decrypt(this.h, ct);
    if (pt === null) return null;
    this.mixHash(ct);
    return pt;
  }
  split(): [CipherState, CipherState] {
    const [k1, k2] = this.hkdf(new Uint8Array(0), 2);
    const a = new CipherState();
    const b = new CipherState();
    a.setKey(k1!);
    b.setKey(k2!);
    return [a, b];
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

/** The patterns the vectors use: handshake messages as token lists, initiator first. */
const PATTERNS: Record<string, Token[][]> = {
  NN: [["e"], ["e", "ee"]],
  XX: [["e"], ["e", "ee", "s", "es"], ["s", "se"]],
};

export interface RefHandshake {
  /** `Noise_<pattern>[psk0]_25519_AESGCM_SHA256` */
  protocol: string;
  prologue: Uint8Array;
  psk?: Uint8Array;
  initStatic?: Uint8Array;
  initEphemeral: Uint8Array;
  respStatic?: Uint8Array;
  respEphemeral: Uint8Array;
  /** Handshake payloads, one per handshake message. */
  payloads: Uint8Array[];
  /** Transport script, initiator and responder alternating as listed. */
  transport: { from: "i" | "r"; payload: Uint8Array; rekeyAfter?: boolean }[];
  /** Responder-side deviations, to produce a failing vector. */
  responder?: { prologue?: Uint8Array; psk?: Uint8Array };
  /** Replace the initiator's message-1 ephemeral public key with these 32 bytes. */
  initEphemeralPublic?: Uint8Array;
}

export interface RefMessage {
  from: "i" | "r";
  payload: Uint8Array;
  ciphertext: Uint8Array;
  rekeyAfter?: boolean;
}

export type RefOutcome =
  | { ok: true; messages: RefMessage[]; handshakeHash: Uint8Array }
  | { ok: false; failedAt: number; reason: "dh_zero" | "decrypt" };

const ZEROS32 = "0".repeat(64);

/** Run both roles of a handshake and the transport script. A failure on the responder's or the
 *  initiator's read ends the run and says which message (0-based) failed. */
export function refNoiseRun(h: RefHandshake): RefOutcome {
  const m = /^Noise_(XX|NN)(psk0)?_25519_AESGCM_SHA256$/.exec(h.protocol);
  if (m === null) throw new Error(`noise: unsupported protocol ${h.protocol}`);
  const pattern = PATTERNS[m[1]!]!;
  const usesPsk = m[2] !== undefined;
  interface Role {
    s: Symmetric;
    psk: Uint8Array | undefined;
    e: Uint8Array;
    st: Uint8Array | undefined;
    remoteE: Uint8Array | null;
    remoteS: Uint8Array | null;
  }
  const mk = (
    prologue: Uint8Array,
    psk: Uint8Array | undefined,
    e: Uint8Array,
    st: Uint8Array | undefined,
  ): Role => {
    const s = new Symmetric(h.protocol);
    s.mixHash(prologue);
    return { s, psk, e, st, remoteE: null, remoteS: null };
  };
  const I = mk(h.prologue, h.psk, h.initEphemeral, h.initStatic);
  const R = mk(
    h.responder?.prologue ?? h.prologue,
    h.responder?.psk ?? h.psk,
    h.respEphemeral,
    h.respStatic,
  );
  const messages: RefMessage[] = [];

  /** The DH of one token for one role: its own private key against the remote public key of the
   *  other kind. Pairs are (initiator kind, responder kind): ee, es = (e, s), se = (s, e). */
  const dhToken = (t: "ee" | "es" | "se", isInit: boolean, r: Role) => {
    const pair = { ee: ["e", "e"], es: ["e", "s"], se: ["s", "e"] }[t];
    const mine = isInit ? pair[0] : pair[1];
    const theirs = isInit ? pair[1] : pair[0];
    const priv = mine === "e" ? r.e : r.st!;
    const remote = theirs === "e" ? r.remoteE! : r.remoteS!;
    const out = refX25519(priv, remote);
    return bytesHex(out) === ZEROS32 ? null : out;
  };

  for (let idx = 0; idx < pattern.length; idx++) {
    const fromInit = idx % 2 === 0;
    const W = fromInit ? I : R;
    const D = fromInit ? R : I;
    const tokens = [...pattern[idx]!];
    if (idx === 0 && usesPsk) tokens.unshift("psk");
    let wire: Uint8Array = new Uint8Array(0);
    for (const t of tokens) {
      if (t === "psk") W.s.mixKeyAndHash(W.psk!);
      else if (t === "e") {
        const e =
          idx === 0 && h.initEphemeralPublic !== undefined
            ? h.initEphemeralPublic
            : refX25519Public(W.e);
        wire = cat(wire, e);
        W.s.mixHash(e);
        if (usesPsk) W.s.mixKey(e);
      } else if (t === "s") {
        wire = cat(wire, W.s.encryptAndHash(refX25519Public(W.st!)));
      } else {
        const out = dhToken(t as "ee" | "es" | "se", fromInit, W);
        if (out === null)
          return { ok: false, failedAt: idx, reason: "dh_zero" };
        W.s.mixKey(out);
      }
    }
    const payload = h.payloads[idx]!;
    wire = cat(wire, W.s.encryptAndHash(payload));
    messages.push({ from: fromInit ? "i" : "r", payload, ciphertext: wire });

    let off = 0;
    for (const t of tokens) {
      if (t === "psk") D.s.mixKeyAndHash(D.psk!);
      else if (t === "e") {
        const e = Uint8Array.from(wire.subarray(off, off + 32));
        off += 32;
        D.remoteE = e;
        D.s.mixHash(e);
        if (usesPsk) D.s.mixKey(e);
      } else if (t === "s") {
        const len = D.s.cs.k === null ? 32 : 48;
        const got = D.s.decryptAndHash(wire.subarray(off, off + len));
        off += len;
        if (got === null)
          return { ok: false, failedAt: idx, reason: "decrypt" };
        D.remoteS = got;
      } else {
        const out = dhToken(t as "ee" | "es" | "se", !fromInit, D);
        if (out === null)
          return { ok: false, failedAt: idx, reason: "dh_zero" };
        D.s.mixKey(out);
      }
    }
    const got = D.s.decryptAndHash(wire.subarray(off));
    if (got === null) return { ok: false, failedAt: idx, reason: "decrypt" };
    if (bytesHex(got) !== bytesHex(payload))
      throw new Error("noise reference: payload read back differs");
  }

  if (bytesHex(I.s.h) !== bytesHex(R.s.h))
    throw new Error("noise reference: handshake hashes differ");
  const handshakeHash = I.s.h;
  const [i1, i2] = I.s.split();
  const [r1, r2] = R.s.split();
  const send = { i: i1, r: r2 };
  const recv = { i: r1, r: i2 }; // recv[from]: the cipher the other side reads `from`'s messages with
  for (const t of h.transport) {
    const ct = send[t.from].encrypt(new Uint8Array(0), t.payload);
    const back = recv[t.from].decrypt(new Uint8Array(0), ct);
    if (back === null || bytesHex(back) !== bytesHex(t.payload))
      throw new Error("noise reference: transport read back differs");
    messages.push({
      from: t.from,
      payload: t.payload,
      ciphertext: ct,
      ...(t.rekeyAfter ? { rekeyAfter: true } : {}),
    });
    if (t.rekeyAfter) {
      send[t.from].rekey();
      recv[t.from].rekey();
    }
  }
  return { ok: true, messages, handshakeHash };
}

/** Replay a noise-c / Cacophony / Snow style vector (hex fields, messages alternating from the
 *  initiator, handshake then transport) through the reference; returns the first message whose
 *  ciphertext differs, or null when every one matches. Used to anchor the reference. */
export interface AnchorVector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static?: string;
  init_ephemeral: string;
  resp_prologue: string;
  resp_static?: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

export function refAnchorMismatch(v: AnchorVector): string | null {
  const proto = /^Noise_(XX|NN)(psk0)?_25519_AESGCM_SHA256$/.exec(
    v.protocol_name,
  );
  if (proto === null) throw new Error(`anchor: unsupported ${v.protocol_name}`);
  const hs = PATTERNS[proto[1]!]!.length;
  const out = refNoiseRun({
    protocol: v.protocol_name,
    prologue: hexBytes(v.init_prologue),
    ...(v.init_psks?.[0] !== undefined
      ? { psk: hexBytes(v.init_psks[0]) }
      : {}),
    ...(v.init_static !== undefined
      ? { initStatic: hexBytes(v.init_static) }
      : {}),
    initEphemeral: hexBytes(v.init_ephemeral),
    ...(v.resp_static !== undefined
      ? { respStatic: hexBytes(v.resp_static) }
      : {}),
    respEphemeral: hexBytes(v.resp_ephemeral),
    payloads: v.messages.slice(0, hs).map((m) => hexBytes(m.payload)),
    transport: v.messages.slice(hs).map((m, k) => ({
      from: (hs + k) % 2 === 0 ? ("i" as const) : ("r" as const),
      payload: hexBytes(m.payload),
    })),
  });
  if (!out.ok) return `fails at message ${out.failedAt} (${out.reason})`;
  for (let k = 0; k < v.messages.length; k++)
    if (bytesHex(out.messages[k]!.ciphertext) !== v.messages[k]!.ciphertext)
      return `message ${k} ciphertext differs`;
  if (
    v.handshake_hash !== undefined &&
    bytesHex(out.handshakeHash) !== v.handshake_hash
  )
    return "handshake hash differs";
  return null;
}
