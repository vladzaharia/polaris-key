// `noise-vectors.json`: the `pkey-peer/1` Noise known answers (WIRE-CONTRACT-V5 §15.5, §15.6,
// §15.9; plans/CC-01-cloud-connect.md §2.5).
//
// X25519 and AES-256-GCM known answers, the low-order points, the three handshake modes with fixed
// ephemerals (and the transport records and rekey that follow), the refusals, and the external
// Noise vectors that anchor the reference. Every row is recomputed through
// `reference/noise.ts` (`node:crypto` only, nothing from client-core) and the generator throws
// when a hand-written known answer disagrees.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./common.js";
import {
  type AnchorVector,
  bytesHex,
  hexBytes,
  refAnchorMismatch,
  refGcmSeal,
  refHkdf,
  refNoiseRun,
  refX25519,
  refX25519Ladder,
  refX25519Public,
  sha256,
} from "./reference/noise.js";
import { refPrologue as prologue } from "./reference/peerMatrix.js";
import {
  REF_X25519_LOW_ORDER_HEX,
  refX25519LowOrder,
} from "./reference/peer.js";

const enc = new TextEncoder();
const utf8 = (s: string): Uint8Array => enc.encode(s);
const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));
const hex = bytesHex;

/** A fixed private key for a vector: SHA-256 of a label. Test material, never used elsewhere. */
const key = (label: string): Uint8Array =>
  sha256(utf8(`pkey-peer/1 noise vector ${label}`));

const ANCHORS_PATH = join(
  REPO_ROOT,
  "tools",
  "corpus",
  "inputs",
  "noise-anchors.json",
);

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

function check(label: string, got: string, want: string): void {
  if (got !== want)
    throw new Error(`noise ${label}: reference gives ${got}, row says ${want}`);
}

// ── X25519 (RFC 7748) ────────────────────────────────────────────────────────

const RFC7748_5_2 = [
  {
    id: "rfc7748-5.2-1",
    scalar: "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
    u: "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
    expect: "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
  },
  {
    id: "rfc7748-5.2-2",
    scalar: "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
    u: "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
    expect: "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
  },
];

const RFC7748_6_1 = {
  id: "rfc7748-6.1",
  alicePrivate:
    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  alicePublic:
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  bobPrivate:
    "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  bobPublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
};

const BASE_POINT = `09${"00".repeat(31)}`;

function buildX25519(): unknown {
  const scalarMult = RFC7748_5_2.map((r) => {
    check(r.id, hex(refX25519(hexBytes(r.scalar), hexBytes(r.u))), r.expect);
    check(
      `${r.id} (ladder)`,
      hex(refX25519Ladder(hexBytes(r.scalar), hexBytes(r.u))),
      r.expect,
    );
    return r;
  });
  const r = RFC7748_6_1;
  check(
    "6.1 alice",
    hex(refX25519Public(hexBytes(r.alicePrivate))),
    r.alicePublic,
  );
  check("6.1 bob", hex(refX25519Public(hexBytes(r.bobPrivate))), r.bobPublic);
  check(
    "6.1 shared (alice)",
    hex(refX25519(hexBytes(r.alicePrivate), hexBytes(r.bobPublic))),
    r.shared,
  );
  check(
    "6.1 shared (bob)",
    hex(refX25519(hexBytes(r.bobPrivate), hexBytes(r.alicePublic))),
    r.shared,
  );
  return { scalarMult, agreement: [r] };
}

// ── The low-order points (the CC-04.3 list) ──────────────────────────────────

const LOW_ORDER_NAMES = [
  "zero",
  "one",
  "order-8-a",
  "order-8-b",
  "p-minus-1",
  "p",
  "p-plus-1",
];

function buildLowOrder(): unknown {
  const scalar = key("low-order scalar");
  const rows: unknown[] = [];
  const row = (id: string, u: Uint8Array, lowOrder: boolean) => {
    const out = hex(refX25519Ladder(scalar, u));
    const zero = out === "00".repeat(32);
    if (refX25519LowOrder(u) !== lowOrder)
      throw new Error(`noise lowOrder ${id}: classification disagrees`);
    if (zero !== lowOrder)
      throw new Error(`noise lowOrder ${id}: all-zero output is ${zero}`);
    check(`lowOrder ${id} (node)`, hex(refX25519(scalar, u)), out);
    rows.push({
      id,
      u: hex(u),
      lowOrder,
      // The 32 bytes X25519(scalar, u) gives; a handshake aborts when they are all zero (§15.5).
      output: out,
      allZero: zero,
    });
  };
  REF_X25519_LOW_ORDER_HEX.forEach((h, k) => {
    for (const top of [false, true]) {
      const u = hexBytes(h);
      if (top) u[31] = u[31]! | 0x80;
      row(`${LOW_ORDER_NAMES[k]}-top-bit-${top ? "set" : "clear"}`, u, true);
    }
  });
  row("base-point", hexBytes(BASE_POINT), false);
  const top = hexBytes(BASE_POINT);
  top[31] = 0x80;
  row("base-point-top-bit-set", top, false);
  row("rfc7748-5.2-1-u", hexBytes(RFC7748_5_2[0]!.u), false);
  return { scalar: hex(scalar), rows };
}

// ── AES-256-GCM ──────────────────────────────────────────────────────────────

const GCM_P =
  "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255";
const GCM_C =
  "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad";
const GCM_K =
  "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";

/** The AES-256-GCM cases 13 to 16 of the GCM specification's test vectors (McGrew and Viega). */
const GCM_CASES = [
  {
    id: "gcm-spec-13",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    aad: "",
    plaintext: "",
    ciphertext: "",
    tag: "530f8afbc74536b9a963b4f1c4cb738b",
  },
  {
    id: "gcm-spec-14",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    aad: "",
    plaintext: "00".repeat(16),
    ciphertext: "cea7403d4d606b6e074ec5d3baf39d18",
    tag: "d0d1c8a799996bf0265b98b5d48ab919",
  },
  {
    id: "gcm-spec-15",
    key: GCM_K,
    nonce: "cafebabefacedbaddecaf888",
    aad: "",
    plaintext: GCM_P,
    ciphertext: GCM_C,
    tag: "b094dac5d93471bdec1a502270e3cc6c",
  },
  {
    id: "gcm-spec-16",
    key: GCM_K,
    nonce: "cafebabefacedbaddecaf888",
    aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    plaintext: GCM_P.slice(0, 120),
    ciphertext: GCM_C.slice(0, 120),
    tag: "76fc6ece0f4e1768cddf8853bb2d551b",
  },
];

function buildAesGcm(): unknown {
  return GCM_CASES.map((c) => {
    const { ciphertext, tag } = refGcmSeal(
      hexBytes(c.key),
      hexBytes(c.nonce),
      hexBytes(c.aad),
      hexBytes(c.plaintext),
    );
    check(`${c.id} ciphertext`, hex(ciphertext), c.ciphertext);
    check(`${c.id} tag`, hex(tag), c.tag);
    return c;
  });
}

// ── Handshakes ───────────────────────────────────────────────────────────────

const SLUG = "demo";
const MODES = {
  a: { protocol: "Noise_XXpsk0_25519_AESGCM_SHA256", psk: true },
  v: { protocol: "Noise_XX_25519_AESGCM_SHA256", psk: false },
  p: { protocol: "Noise_XX_25519_AESGCM_SHA256", psk: false },
} as const;
type Mode = keyof typeof MODES;

const PAYLOADS: Record<Mode, string[]> = {
  a: [
    '{"v":1}',
    '{"v":1,"cert":"AAAA.BBBB.CCCC","ring":7,"caps":["ring/1","trust/1","app/1"]}',
    '{"v":1,"cert":"DDDD.EEEE.FFFF","ring":7,"caps":["ring/1","app/1"]}',
  ],
  v: ['{"v":1}', '{"v":1,"caps":["vouch/1"]}', '{"v":1,"caps":["vouch/1"]}'],
  p: ['{"v":1}', '{"v":1,"caps":["app/1"]}', '{"v":1,"caps":["app/1"]}'],
};

/** A record (§15.6): u16be type, u8 flags, body. */
const record = (
  type: number,
  body: Uint8Array = new Uint8Array(0),
): Uint8Array => cat(Uint8Array.of(type >> 8, type & 255, 0), body);
const HELLO = (app: string) =>
  record(
    0x8001,
    utf8(`{"platform":"node","app":"${app}","maxMessage":1048576}`),
  );
const REKEY = record(0x80fe);
const PING = (n: number) =>
  record(0x0004, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, n));
const PONG = (n: number) =>
  record(0x0005, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, n));

function transport(mode: Mode) {
  const t: { from: "i" | "r"; payload: Uint8Array; rekeyAfter?: boolean }[] = [
    { from: "i", payload: HELLO("initiator") },
    { from: "r", payload: HELLO("responder") },
    { from: "i", payload: PING(1) },
    { from: "r", payload: PONG(1) },
    { from: "i", payload: REKEY, rekeyAfter: true },
    { from: "i", payload: PING(2) },
    { from: "r", payload: REKEY, rekeyAfter: true },
    { from: "r", payload: PONG(2) },
  ];
  if (mode === "p")
    // three rekeys in a row, then traffic, so a counter or key slip shows
    t.push(
      { from: "i", payload: REKEY, rekeyAfter: true },
      { from: "i", payload: REKEY, rekeyAfter: true },
      { from: "i", payload: REKEY, rekeyAfter: true },
      { from: "i", payload: PING(3) },
      { from: "r", payload: PONG(3) },
    );
  return t;
}

function baseHandshake(mode: Mode) {
  const m = MODES[mode];
  const psk = m.psk
    ? refHkdf(
        new Uint8Array(0),
        key("k_disc"),
        cat(utf8("pkey-peer/1 psk"), Uint8Array.of(0), utf8(SLUG)),
        32,
      )
    : undefined;
  return {
    protocol: m.protocol,
    prologue: prologue(SLUG, mode),
    ...(psk ? { psk } : {}),
    initStatic: key(`${mode} initiator static`),
    initEphemeral: key(`${mode} initiator ephemeral`),
    respStatic: key(`${mode} responder static`),
    respEphemeral: key(`${mode} responder ephemeral`),
    payloads: PAYLOADS[mode].map(utf8),
    transport: transport(mode),
  };
}

function buildHandshakes(): unknown[] {
  return (Object.keys(MODES) as Mode[]).map((mode) => {
    const h = baseHandshake(mode);
    const out = refNoiseRun(h);
    if (!out.ok) throw new Error(`noise handshake ${mode}: ${out.reason}`);
    return {
      id: `mode-${mode}`,
      mode,
      protocol: h.protocol,
      slug: SLUG,
      prologue: hex(h.prologue),
      ...(h.psk ? { psk: hex(h.psk) } : {}),
      initStatic: hex(h.initStatic),
      initStaticPublic: hex(refX25519Public(h.initStatic)),
      initEphemeral: hex(h.initEphemeral),
      initEphemeralPublic: hex(refX25519Public(h.initEphemeral)),
      respStatic: hex(h.respStatic),
      respStaticPublic: hex(refX25519Public(h.respStatic)),
      respEphemeral: hex(h.respEphemeral),
      respEphemeralPublic: hex(refX25519Public(h.respEphemeral)),
      handshakeHash: hex(out.handshakeHash),
      // Messages alternate as `from` says. The first three are the handshake; the rest are
      // transport records (empty associated data). After `rekeyAfter` the sender rekeys its
      // sending key and the receiver its receiving key.
      messages: out.messages.map((m2, k) => ({
        index: k,
        from: m2.from,
        kind: k < 3 ? "handshake" : "transport",
        payload: hex(m2.payload),
        ciphertext: hex(m2.ciphertext),
        ...(m2.rekeyAfter ? { rekeyAfter: true } : {}),
      })),
    };
  });
}

function buildFailures(): unknown[] {
  const rows: unknown[] = [];
  const fail = (
    id: string,
    mode: Mode,
    description: string,
    mutate: Partial<ReturnType<typeof baseHandshake>> & {
      responder?: { prologue?: Uint8Array; psk?: Uint8Array };
      initEphemeralPublic?: Uint8Array;
    },
    want: { failedAt: number; reason: "dh_zero" | "decrypt" },
  ) => {
    const h = { ...baseHandshake(mode), ...mutate, transport: [] };
    const out = refNoiseRun(h);
    if (out.ok || out.failedAt !== want.failedAt || out.reason !== want.reason)
      throw new Error(
        `noise failure ${id}: reference says ${JSON.stringify(out.ok ? "ok" : out)}`,
      );
    rows.push({
      id,
      mode,
      description,
      protocol: h.protocol,
      prologue: hex(h.prologue),
      ...(mutate.responder?.prologue
        ? { responderPrologue: hex(mutate.responder.prologue) }
        : {}),
      ...(h.psk ? { psk: hex(h.psk) } : {}),
      ...(mutate.responder?.psk
        ? { responderPsk: hex(mutate.responder.psk) }
        : {}),
      initStatic: hex(h.initStatic),
      initEphemeral: hex(h.initEphemeral),
      ...(mutate.initEphemeralPublic
        ? { initEphemeralPublic: hex(mutate.initEphemeralPublic) }
        : {}),
      respStatic: hex(h.respStatic),
      respEphemeral: hex(h.respEphemeral),
      payloads: h.payloads.map(hex),
      // The 0-based handshake message at which a side stops, and why. `decrypt`: the AEAD tag
      // fails (the connection closes silently, §15.5). `dh_zero`: a DH output is all zeros.
      failedAt: want.failedAt,
      reason: want.reason,
    });
  };
  fail(
    "a-wrong-psk",
    "a",
    "The responder holds another PSK (a stale discKey): message 1's payload fails its tag.",
    { responder: { psk: key("other psk") } },
    { failedAt: 0, reason: "decrypt" },
  );
  fail(
    "a-wrong-slug",
    "a",
    "The responder's prologue names another product.",
    { responder: { prologue: prologue("other", "a") } },
    { failedAt: 0, reason: "decrypt" },
  );
  fail(
    "v-wrong-slug",
    "v",
    "The responder's prologue names another product: the initiator cannot read message 2.",
    { responder: { prologue: prologue("other", "v") } },
    { failedAt: 1, reason: "decrypt" },
  );
  fail(
    "v-wrong-mode",
    "v",
    "The responder's prologue says mode p.",
    { responder: { prologue: prologue(SLUG, "p") } },
    { failedAt: 1, reason: "decrypt" },
  );
  fail(
    "p-wrong-mode",
    "p",
    "The responder's prologue says mode v.",
    { responder: { prologue: prologue(SLUG, "v") } },
    { failedAt: 1, reason: "decrypt" },
  );
  fail(
    "a-wrong-version",
    "a",
    "The responder's prologue names another protocol version.",
    {
      responder: {
        prologue: cat(
          utf8("pkey-peer/2"),
          Uint8Array.of(0),
          utf8(SLUG),
          Uint8Array.of(0),
          utf8("a"),
          Uint8Array.of(0),
        ),
      },
    },
    { failedAt: 0, reason: "decrypt" },
  );
  // A low-order remote ephemeral: the responder's ee is all zeros and it aborts (§15.5).
  const modes: Mode[] = ["a", "v", "p"];
  for (const mode of modes)
    REF_X25519_LOW_ORDER_HEX.forEach((h, k) => {
      if (mode !== "v" && k !== 0) return;
      fail(
        `${mode}-low-order-ephemeral-${LOW_ORDER_NAMES[k]}`,
        mode,
        `The initiator's ephemeral key is the low-order point ${LOW_ORDER_NAMES[k]}: the responder's DH is all zeros and it aborts.`,
        { initEphemeralPublic: hexBytes(h) },
        { failedAt: 1, reason: "dh_zero" },
      );
    });
  return rows;
}

// ── External anchors ─────────────────────────────────────────────────────────

interface AnchorFile {
  sources: { id: string; url: string; sha256: string }[];
  vectors: { source: string; sha256: string; vector: AnchorVector }[];
}

function buildAnchors(): unknown {
  const file = JSON.parse(readFileSync(ANCHORS_PATH, "utf8")) as AnchorFile;
  const vectors = file.vectors.map((a) => {
    const sum = createHash("sha256")
      .update(canonicalJson(a.vector))
      .digest("hex");
    if (sum !== a.sha256)
      throw new Error(
        `noise anchor ${a.vector.protocol_name} (${a.source}): vector hash ${sum} is not the pinned ${a.sha256}`,
      );
    const bad = refAnchorMismatch(a.vector);
    if (bad !== null)
      throw new Error(
        `noise anchor ${a.vector.protocol_name} (${a.source}): reference ${bad}`,
      );
    return { source: a.source, sha256: a.sha256, vector: a.vector };
  });
  return {
    note: "Vectors from independent Noise implementations, copied verbatim (noise-c JSON format: hex fields, messages alternate from the initiator, the handshake first and then transport). `sources` pins each upstream file by commit URL and SHA-256; `sha256` is over the vector as sorted-key compact JSON. The reference reproduces every ciphertext.",
    sources: file.sources,
    vectors,
  };
}

export function buildNoiseVectors(): unknown {
  return {
    noiseVectorsVersion: 1,
    description:
      "pkey-peer/1 Noise known answers (WIRE-CONTRACT-V5 sections 15.5, 15.6, 15.9; plans/CC-01-cloud-connect.md 2.5). All fields are lower-case hex. `x25519` holds RFC 7748 section 5.2 and 6.1; `lowOrder` the seven low-order points of 15.2 step 4 in both top-bit spellings, with the all-zero DH output a handshake must refuse; `aesGcm` the GCM specification's AES-256 cases (96-bit nonce); `handshakes` the three modes with fixed ephemerals and statics, the handshake hash, the three handshake messages and the transport records that follow, with rekey (Noise section 4.2: k = ENCRYPT(k, 2^64 - 1, empty, 32 zero bytes)[0..32], counter unchanged); `failures` the refusals; `anchors` external Noise_XX_25519_AESGCM_SHA256 and Noise_NNpsk0_25519_AESGCM_SHA256 vectors. The AESGCM nonce is four zero bytes then the 64-bit big-endian counter. The prologue is the ASCII 'pkey-peer/1', 0x00, the slug, 0x00, the mode, 0x00. The mode-a PSK is HKDF-SHA256 (salt empty, ikm a 32-byte discovery key, info 'pkey-peer/1 psk', 0x00, slug); the vector lists the PSK itself. Every key here is test material derived from a label. Append-only: a new row keeps noiseVectorsVersion; a changed row or rule bumps it.",
    x25519: buildX25519(),
    lowOrder: buildLowOrder(),
    aesGcm: buildAesGcm(),
    handshakes: buildHandshakes(),
    failures: buildFailures(),
    anchors: buildAnchors(),
  };
}
