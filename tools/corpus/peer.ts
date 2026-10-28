// `cases.json#/peerCertCases`, `#/ringCases` and `#/peerAdmissionCases`: the Cloud Connect
// device certificate (`pkey-peer+jws`, V5 §15.2) and roster (`pkey-ring+jws`, V5 §15.3), and the
// admission verdict of a certificate against a held roster. Every verdict is recomputed through
// `reference/peer.ts`, and a hand-written expectation that disagrees throws.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  ALT_KID,
  AUD_V3,
  ISSUER_V3,
  MAX_WIRE_INTEGER_REF,
  PIN_KID,
  pub,
  raw,
  rawJson,
  REL_KID,
  signRawSegments,
  signText,
  type TypV3,
  V3_ISSUED,
} from "./common.js";
import {
  type AdmissionVerdict,
  type PeerReason,
  type PeerSession,
  type PeerVerdict,
  REF_X25519_LOW_ORDER_HEX,
  type RefPeerCert,
  type RefRing,
  refAdmission,
  refPeerCert,
  refRing,
  refRingExpired,
  refRingReplace,
  type ReplaceReason,
  type RingReason,
} from "./reference/peer.js";

const pending: (() => Promise<void>)[] = [];
const names7 = [
  "zero",
  "one",
  "order8-a",
  "order8-b",
  "p-minus-1",
  "p",
  "p-plus-1",
];
const DAY = 86400;
const WEEK = 604800;
const ISSUED = V3_ISSUED;
const NOW = ISSUED + 1000;
const SUB = "ps_AbCdEfGhIjKlMnOpQrStUv";
const OTHER_SUB = "ps_ZyXwVuTsRqPoNmLkJiHgFe";
const TRUST = { [PIN_KID]: pub(PIN_KID) };

// ── fixed device material, derived from seeds (never secrets) ────────────────────────────────

const seedOf = (label: string): Buffer =>
  createHash("sha256").update(`pkey-corpus-v5-${label}`).digest();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
function rawPublic(prefixHex: string, seed: Buffer): string {
  const priv: KeyObject = createPrivateKey({
    key: Buffer.concat([Buffer.from(prefixHex, "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(priv).export({ format: "jwk" }).x as string;
}
const ed25519Pub = (label: string): string =>
  rawPublic("302e020100300506032b657004220420", seedOf(label));
const x25519Pub = (label: string): string =>
  rawPublic("302e020100300506032b656e04220420", seedOf(label));

interface Dev {
  deviceId: string;
  signKey: string;
  agreeKey: string;
}
const devCache: Dev[] = [];
function dev(i: number): Dev {
  return (devCache[i] ??= {
    deviceId: b64u(seedOf(`device-${i}`)).slice(0, 32),
    signKey: ed25519Pub(`sign-${i}`),
    agreeKey: x25519Pub(`agree-${i}`),
  });
}
const byId = (a: Dev, b: Dev): number =>
  a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
const devs = (n: number, from = 0): Dev[] =>
  Array.from({ length: n }, (_, k) => dev(from + k)).sort(byId);

/** The key with its last character changed so the unused low bits are non-zero. */
function nonCanonical(key: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(key[key.length - 1]!);
  return key.slice(0, -1) + alphabet[last | 1]!;
}
const hexKey = (hex: string, topBit: boolean): string => {
  const b = Buffer.from(hex, "hex");
  if (topBit) b[31] = b[31]! | 0x80;
  return b64u(b);
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;
const certDoc = (d: Dev = dev(0), over: Doc = {}): Doc => ({
  iss: ISSUER_V3,
  aud: AUD_V3,
  sub: SUB,
  deviceId: d.deviceId,
  signKey: d.signKey,
  agreeKey: d.agreeKey,
  ringEpoch: 7,
  issuedAt: ISSUED,
  expiresAt: ISSUED + WEEK,
  ...over,
});
const ringDoc = (devices: unknown, over: Doc = {}): Doc => ({
  iss: ISSUER_V3,
  aud: AUD_V3,
  sub: SUB,
  epoch: 7,
  issuedAt: ISSUED,
  expiresAt: ISSUED + WEEK,
  devices,
  ...over,
});
const without = (doc: Doc, name: string): Doc => {
  const out = { ...doc };
  delete out[name];
  return out;
};
const signDoc = (
  doc: Doc,
  typ: TypV3,
  kid: string = PIN_KID,
): Promise<string> => signText(rawJson(doc), kid, typ);

function agree(id: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `peer corpus ${id}: reference ${JSON.stringify(got)} != expected ${JSON.stringify(want)}`,
    );
}

// ── peerCertCases ────────────────────────────────────────────────────────────────────────────

interface PeerCertCase {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  expectedAud: string;
  now: number;
  session?: PeerSession;
  expect:
    | { valid: true; cert: RefPeerCert }
    | { valid: false; reason: PeerReason };
}

export async function buildPeerCertCases(): Promise<PeerCertCase[]> {
  const cases: PeerCertCase[] = [];
  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Doc;
      jws?: string;
      typ?: TypV3;
      kid?: string;
      trust?: Record<string, string>;
      now?: number;
      aud?: string;
      session?: PeerSession;
      expect: "ok" | PeerReason;
    },
  ): Promise<void> => {
    const jws =
      o.jws ??
      (await signDoc(o.doc ?? certDoc(), o.typ ?? "pkey-peer+jws", o.kid));
    const c: PeerCertCase = {
      id,
      description,
      jws,
      trust: o.trust ?? TRUST,
      expectedAud: o.aud ?? AUD_V3,
      now: o.now ?? NOW,
      ...(o.session === undefined ? {} : { session: o.session }),
      expect: { valid: false, reason: "jws-rejected" },
    };
    const v: PeerVerdict = refPeerCert(jws, c.trust, {
      expectedAud: c.expectedAud,
      now: c.now,
      session: c.session,
    });
    agree(id, v.ok ? "ok" : v.reason, o.expect);
    c.expect = v.ok
      ? { valid: true, cert: v.cert }
      : { valid: false, reason: v.reason };
    cases.push(c);
  };

  // valid controls
  await mk(
    "peer-valid",
    "The control: a certificate signed by the pinned product key.",
    { expect: "ok" },
  );
  await mk(
    "peer-valid-rotated-key",
    "A certificate signed by a second product key in the effective set verifies.",
    {
      kid: ALT_KID,
      trust: { ...TRUST, [ALT_KID]: pub(ALT_KID) },
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-unknown-members-ignored",
    "Members beyond the schema are ignored (§3.2).",
    {
      doc: certDoc(dev(0), { extra: { nested: [1, 2] }, label: "ignored" }),
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-agreekey-top-bit-set",
    "An agreeKey with bit 255 set is not low-order: the base point u = 9 spelled with the top bit.",
    {
      doc: certDoc(dev(0), { agreeKey: hexKey("09" + "00".repeat(31), true) }),
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-ring-epoch-max",
    "ringEpoch 2^53 − 1 is the largest wire integer.",
    {
      doc: certDoc(dev(0), { ringEpoch: MAX_WIRE_INTEGER_REF }),
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-lifetime-max",
    "expiresAt − issuedAt = 604800, the maximum.",
    { expect: "ok" },
  );
  await mk(
    "peer-valid-lifetime-min",
    "expiresAt − issuedAt = 1, the minimum.",
    {
      doc: certDoc(dev(0), { expiresAt: ISSUED + 1 }),
      now: ISSUED,
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-issued-at-skew-edge",
    "issuedAt = now + 300 is inside the skew.",
    {
      now: ISSUED - 300,
      expect: "ok",
    },
  );
  await mk(
    "peer-valid-expired-at-skew-edge",
    "now = expiresAt + 300 is inside the skew.",
    {
      now: ISSUED + WEEK + 300,
      expect: "ok",
    },
  );

  // typ, signer, signature
  for (const typ of [
    "pkey-ring+jws",
    "pkey-license+jws",
    "pkey-feed+jws",
    "pkey-trust+jws",
  ] as const)
    await mk(
      `peer-wrong-typ-${typ.slice(5, -4)}`,
      `A certificate payload under ${typ}: the typ is refused (§2).`,
      {
        typ,
        expect: "jws-rejected",
      },
    );
  await mk(
    "peer-signed-by-release-key",
    "A release key never signs a certificate: its kid is not in the effective product set.",
    {
      kid: REL_KID,
      expect: "jws-rejected",
    },
  );
  const valid = await signDoc(certDoc(), "pkey-peer+jws");
  const [vh, vp, vs] = valid.split(".") as [string, string, string];
  const hdrWith = (h: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(h)).toString("base64url");
  await mk(
    "peer-release-signature-under-product-kid",
    "Signed by a release key but naming the product kid: the signature fails.",
    {
      jws: await signRawSegments(
        JSON.stringify({ alg: "EdDSA", typ: "pkey-peer+jws", kid: PIN_KID }),
        rawJson(certDoc()),
        REL_KID,
      ),
      expect: "jws-rejected",
    },
  );
  const tampered = Buffer.from(
    Buffer.from(vp, "base64url")
      .toString()
      .replace('"ringEpoch":7', '"ringEpoch":8'),
  ).toString("base64url");
  await mk("peer-tampered-payload", "The payload changed after signing.", {
    jws: `${vh}.${tampered}.${vs}`,
    expect: "jws-rejected",
  });
  await mk("peer-missing-typ-header", "A header with no typ is refused.", {
    jws: await signRawSegments(
      JSON.stringify({ alg: "EdDSA", kid: PIN_KID }),
      rawJson(certDoc()),
      PIN_KID,
    ),
    expect: "jws-rejected",
  });
  await mk("peer-unknown-kid", "A header kid outside the effective set.", {
    trust: { [ALT_KID]: pub(ALT_KID) },
    expect: "jws-rejected",
  });
  await mk("peer-two-segments", "Not a compact JWS.", {
    jws: `${vh}.${vp}`,
    expect: "jws-rejected",
  });
  void hdrWith;

  // iss, aud
  await mk("peer-wrong-iss", "iss is not the fixed issuer.", {
    doc: certDoc(dev(0), { iss: "https://key.plrs.im" }),
    expect: "issuer-or-audience",
  });
  await mk("peer-wrong-aud", "aud names another product.", {
    doc: certDoc(dev(0), { aud: "other-product" }),
    expect: "issuer-or-audience",
  });
  await mk(
    "peer-aud-not-the-apps-product",
    "The certificate is right for djdl and the app is another product.",
    { aud: "other-product", expect: "issuer-or-audience" },
  );
  await mk("peer-aud-case", "aud differs from the product only by case.", {
    doc: certDoc(dev(0), { aud: "DJDL" }),
    expect: "issuer-or-audience",
  });

  // sub, deviceId
  const goodSub = SUB;
  const subs: [string, string][] = [
    ["short", goodSub.slice(0, -1)],
    ["long", goodSub + "x"],
    ["no-prefix", goodSub.slice(3)],
    ["upper-prefix", "PS_" + goodSub.slice(3)],
    ["account-id", "acct_" + goodSub.slice(3)],
    ["trailing-newline", goodSub + "\n"],
    ["non-ascii", goodSub.slice(0, -1) + "é"],
    ["empty", ""],
  ];
  for (const [n, v] of subs)
    await mk(`peer-sub-${n}`, `sub fails ^ps_[A-Za-z0-9_-]{22}$ (${n}).`, {
      doc: certDoc(dev(0), { sub: v }),
      expect: "subject-or-device",
    });
  await mk("peer-sub-not-a-string", "sub is a number.", {
    doc: certDoc(dev(0), { sub: 7 }),
    expect: "subject-or-device",
  });
  const id0 = dev(0).deviceId;
  const ids: [string, string][] = [
    ["short", id0.slice(0, 31)],
    ["long", id0 + "A"],
    ["plus", id0.slice(0, 31) + "+"],
    ["padding", id0.slice(0, 31) + "="],
    ["trailing-newline", id0.slice(0, 31) + "\n"],
    ["non-ascii", id0.slice(0, 31) + "é"],
    ["empty", ""],
  ];
  for (const [n, v] of ids)
    await mk(
      `peer-device-id-${n}`,
      `deviceId fails ^[A-Za-z0-9_-]{32}$ (${n}).`,
      { doc: certDoc(dev(0), { deviceId: v }), expect: "subject-or-device" },
    );
  await mk("peer-device-id-not-a-string", "deviceId is a number.", {
    doc: certDoc(dev(0), { deviceId: 12 }),
    expect: "subject-or-device",
  });

  // keys
  const sk = dev(0).signKey;
  const ak = dev(0).agreeKey;
  const keyBad = (
    field: "signKey" | "agreeKey",
    n: string,
    v: unknown,
    why: string,
  ): Promise<void> =>
    mk(
      `peer-${field.toLowerCase().replace("key", "-key")}-${n}`,
      `${field} ${why}.`,
      { doc: certDoc(dev(0), { [field]: v }), expect: "keys" },
    );
  for (const field of ["signKey", "agreeKey"] as const) {
    const k = field === "signKey" ? sk : ak;
    await keyBad(
      field,
      "non-canonical",
      nonCanonical(k),
      "has non-zero unused base64url bits",
    );
    await keyBad(field, "padded", k + "=", "carries base64 padding");
    await keyBad(field, "short", k.slice(0, 42), "is 42 characters");
    await keyBad(
      field,
      "long-33-bytes",
      b64u(Buffer.alloc(33, 7)),
      "decodes to 33 bytes",
    );
    await keyBad(
      field,
      "standard-alphabet",
      "+" + k.slice(1),
      "uses the standard base64 alphabet",
    );
    await keyBad(field, "not-a-string", 5, "is a number");
    await keyBad(field, "empty", "", "is empty");
  }
  const ed = (hex: string): string => b64u(Buffer.from(hex, "hex"));
  const edBad: [string, string][] = [
    ["identity", "01" + "00".repeat(31)],
    ["zero", "00".repeat(32)],
    ["zero-sign-bit", "00".repeat(31) + "80"],
    [
      "order8",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    ],
    [
      "order8-sign-bit",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    ],
    ["order-minus-one", "ecff" + "ff".repeat(29) + "7f"],
    ["y-equals-p", "edff" + "ff".repeat(29) + "7f"],
    ["y-equals-p-plus-1", "eeff" + "ff".repeat(29) + "7f"],
    ["y-all-ones", "ff".repeat(32)],
  ];
  for (const [n, hex] of edBad)
    await keyBad(
      "signKey",
      `ed25519-${n}`,
      ed(hex),
      "is a small-order or non-canonical Ed25519 point (§1.1 checks 2-3)",
    );

  // every spelling of the seven X25519 low-order points, top bit clear and set
  const names = names7;
  REF_X25519_LOW_ORDER_HEX.forEach((hex, k) => {
    for (const top of [false, true])
      pending.push(() =>
        keyBad(
          "agreeKey",
          `low-order-${names[k]}-top-bit-${top ? "set" : "clear"}`,
          hexKey(hex, top),
          `is the X25519 low-order point ${names[k]}${top ? " with bit 255 set" : ""}`,
        ),
      );
  });
  for (const p of pending.splice(0)) await p();

  // integers
  const intBad = (
    n: string,
    field: string,
    v: unknown,
    why: string,
  ): Promise<void> =>
    mk(`peer-int-${n}`, `${field} ${why}.`, {
      doc: certDoc(dev(0), { [field]: v }),
      expect: "integer",
    });
  await intBad(
    "ring-epoch-zero",
    "ringEpoch",
    0,
    "is 0, below the minimum of 1",
  );
  await intBad("ring-epoch-negative", "ringEpoch", -1, "is negative");
  await intBad("ring-epoch-fraction", "ringEpoch", raw("1.5"), "is a fraction");
  await intBad(
    "ring-epoch-trailing-zero",
    "ringEpoch",
    raw("7.0"),
    "is written 7.0, not a plain integer token",
  );
  await intBad(
    "ring-epoch-exponent",
    "ringEpoch",
    raw("7e0"),
    "is written with an exponent",
  );
  await intBad(
    "ring-epoch-over-2-53",
    "ringEpoch",
    raw("9007199254740993"),
    "is above 2^53 − 1",
  );
  await intBad("ring-epoch-string", "ringEpoch", "7", "is a string");
  await intBad("ring-epoch-null", "ringEpoch", null, "is null");
  await intBad(
    "issued-at-fraction",
    "issuedAt",
    raw("1700000000.5"),
    "is a fraction",
  );
  await intBad("issued-at-negative", "issuedAt", -1, "is negative");
  await intBad(
    "expires-at-exponent",
    "expiresAt",
    raw("1.7006048e9"),
    "is written with an exponent",
  );
  await intBad(
    "expires-at-string",
    "expiresAt",
    String(ISSUED + WEEK),
    "is a string",
  );

  // missing members
  const expectMissing: [
    string,
    "issuer-or-audience" | "subject-or-device" | "keys" | "integer",
  ][] = [
    ["iss", "issuer-or-audience"],
    ["aud", "issuer-or-audience"],
    ["sub", "subject-or-device"],
    ["deviceId", "subject-or-device"],
    ["signKey", "keys"],
    ["agreeKey", "keys"],
    ["ringEpoch", "integer"],
    ["issuedAt", "integer"],
    ["expiresAt", "integer"],
  ];
  for (const [name, reason] of expectMissing)
    await mk(`peer-missing-${name}`, `${name} is absent.`, {
      doc: without(certDoc(), name),
      expect: reason,
    });

  // lifetime and the clock
  await mk("peer-lifetime-over-max", "expiresAt − issuedAt = 604801.", {
    doc: certDoc(dev(0), { expiresAt: ISSUED + WEEK + 1 }),
    expect: "lifetime",
  });
  await mk("peer-lifetime-zero", "expiresAt = issuedAt.", {
    doc: certDoc(dev(0), { expiresAt: ISSUED }),
    expect: "lifetime",
  });
  await mk("peer-lifetime-negative", "expiresAt before issuedAt.", {
    doc: certDoc(dev(0), { expiresAt: ISSUED - 1 }),
    expect: "lifetime",
  });
  await mk("peer-lifetime-huge", "A thirty-day lifetime.", {
    doc: certDoc(dev(0), { expiresAt: ISSUED + 30 * DAY }),
    expect: "lifetime",
  });
  await mk("peer-issued-in-the-future", "issuedAt = now + 301.", {
    now: ISSUED - 301,
    expect: "clock",
  });
  await mk("peer-expired", "now = expiresAt + 301.", {
    now: ISSUED + WEEK + 301,
    expect: "clock",
  });
  await mk("peer-expired-long-ago", "A year after expiry.", {
    now: ISSUED + WEEK + 365 * DAY,
    expect: "clock",
  });

  // the session (§15.2 step 7)
  const sess = (
    s: Partial<PeerSession> & { mode: PeerSession["mode"] },
  ): PeerSession => ({
    remoteStatic: ak,
    ...s,
  });
  await mk(
    "peer-session-a-ok",
    "Mode a: sub is the verifier's own, deviceId differs, agreeKey is the remote static key.",
    {
      session: sess({ mode: "a", ownSub: SUB, ownDeviceId: dev(1).deviceId }),
      expect: "ok",
    },
  );
  await mk(
    "peer-session-a-other-subject",
    "Mode a: sub is not the verifier's own subject.",
    {
      session: sess({
        mode: "a",
        ownSub: OTHER_SUB,
        ownDeviceId: dev(1).deviceId,
      }),
      expect: "sub-mismatch",
    },
  );
  await mk(
    "peer-session-a-own-device",
    "Mode a: deviceId is the verifier's own.",
    {
      session: sess({ mode: "a", ownSub: SUB, ownDeviceId: dev(0).deviceId }),
      expect: "own-device",
    },
  );
  await mk(
    "peer-session-v-other-subject-ok",
    "Mode v has no own-subject rule.",
    {
      session: sess({ mode: "v" }),
      expect: "ok",
    },
  );
  await mk("peer-session-p-ok", "Mode p has no own-subject rule.", {
    session: sess({ mode: "p" }),
    expect: "ok",
  });
  for (const mode of ["a", "v", "p"] as const)
    await mk(
      `peer-session-${mode}-static-mismatch`,
      `Mode ${mode}: agreeKey is not the Noise remote static key.`,
      {
        session: sess({
          mode,
          ownSub: SUB,
          ownDeviceId: dev(1).deviceId,
          remoteStatic: dev(1).agreeKey,
        }),
        expect: "static-mismatch",
      },
    );

  return cases;
}

// ── ringCases ────────────────────────────────────────────────────────────────────────────────

type RingCase =
  | {
      kind: "verify";
      id: string;
      description: string;
      jws: string;
      trust: Record<string, string>;
      expectedAud: string;
      now: number;
      expect:
        | { valid: true; epoch: number; devices: number; expired: boolean }
        | { valid: false; reason: RingReason };
    }
  | {
      kind: "replace";
      id: string;
      description: string;
      heldJws: string | null;
      jws: string;
      trust: Record<string, string>;
      expectedAud: string;
      now: number;
      expect: { replace: true } | { replace: false; reason: ReplaceReason };
    };

export async function buildRingCases(): Promise<RingCase[]> {
  const cases: RingCase[] = [];
  const mkVerify = async (
    id: string,
    description: string,
    o: {
      doc?: Doc;
      devices?: unknown;
      typ?: TypV3;
      kid?: string;
      jws?: string;
      trust?: Record<string, string>;
      now?: number;
      expect: "ok" | RingReason;
      expired?: boolean;
    },
  ): Promise<void> => {
    const jws =
      o.jws ??
      (await signDoc(
        o.doc ?? ringDoc(o.devices ?? devs(3)),
        o.typ ?? "pkey-ring+jws",
        o.kid,
      ));
    const trust = o.trust ?? TRUST;
    const now = o.now ?? NOW;
    const v = refRing(jws, trust, { expectedAud: AUD_V3 });
    agree(id, v.ok ? "ok" : v.reason, o.expect);
    let expect: Extract<RingCase, { kind: "verify" }>["expect"];
    if (v.ok) {
      const expired = refRingExpired(v.ring, now);
      if (o.expired !== undefined) agree(`${id} expired`, expired, o.expired);
      expect = {
        valid: true,
        epoch: v.ring.epoch,
        devices: v.ring.devices.length,
        expired,
      };
    } else expect = { valid: false, reason: v.reason };
    cases.push({
      kind: "verify",
      id,
      description,
      jws,
      trust,
      expectedAud: AUD_V3,
      now,
      expect,
    });
  };

  await mkVerify(
    "ring-valid-three",
    "The control: three devices, sorted, signed by the product key.",
    { expect: "ok", expired: false },
  );
  await mkVerify("ring-valid-one", "One device is the smallest roster.", {
    devices: devs(1),
    expect: "ok",
  });
  await mkVerify("ring-valid-128", "128 devices is the maximum.", {
    devices: devs(128),
    expect: "ok",
  });
  await mkVerify(
    "ring-valid-rotated-key",
    "A roster signed by a second product key in the effective set.",
    {
      kid: ALT_KID,
      trust: { ...TRUST, [ALT_KID]: pub(ALT_KID) },
      expect: "ok",
    },
  );
  await mkVerify(
    "ring-valid-unknown-members-ignored",
    "Members beyond the schema, in the roster and in an entry, are ignored.",
    {
      doc: ringDoc(
        devs(2).map((d) => ({ ...d, label: "x" })),
        { extra: [1] },
      ),
      expect: "ok",
    },
  );
  await mkVerify("ring-valid-epoch-max", "epoch 2^53 − 1.", {
    doc: ringDoc(devs(2), { epoch: MAX_WIRE_INTEGER_REF }),
    expect: "ok",
  });
  await mkVerify(
    "ring-valid-expired",
    "An expired roster still verifies; expiry is the held-ring rule's question.",
    {
      doc: ringDoc(devs(2), {
        issuedAt: ISSUED - 2 * WEEK,
        expiresAt: ISSUED - WEEK,
      }),
      expect: "ok",
      expired: true,
    },
  );
  // byte order, not locale order
  const odd = (c: string): Dev => ({ ...dev(0), deviceId: c + "A".repeat(31) });
  const oddDevs = ["0", "Z", "_", "a"].map((c, k) => ({
    ...odd(c),
    signKey: dev(k).signKey,
    agreeKey: dev(k).agreeKey,
  }));
  await mkVerify(
    "ring-valid-byte-order",
    "Ids 0, Z, _, a: ascending by bytes.",
    { devices: oddDevs, expect: "ok" },
  );
  await mkVerify(
    "ring-unsorted-locale-order",
    "Ids _, 0, a, Z: the order a locale compare gives, not byte order.",
    {
      devices: [oddDevs[2]!, oddDevs[0]!, oddDevs[3]!, oddDevs[1]!],
      expect: "unsorted",
    },
  );

  // sizes and shape
  await mkVerify("ring-empty", "No devices.", {
    devices: [],
    expect: "devices-size",
  });
  await mkVerify("ring-129-devices", "One over MAX_RING_DEVICES.", {
    devices: devs(129),
    expect: "devices-size",
  });
  await mkVerify("ring-devices-not-an-array", "devices is an object.", {
    devices: { 0: dev(0) },
    expect: "devices-size",
  });
  await mkVerify("ring-missing-devices", "devices is absent.", {
    doc: without(ringDoc(devs(2)), "devices"),
    expect: "devices-size",
  });
  const d3 = devs(3);
  await mkVerify("ring-unsorted", "Entries 1 and 2 swapped.", {
    devices: [d3[0]!, d3[2]!, d3[1]!],
    expect: "unsorted",
  });
  await mkVerify("ring-reversed", "Descending order.", {
    devices: [...d3].reverse(),
    expect: "unsorted",
  });
  await mkVerify("ring-duplicate-id", "The same entry twice.", {
    devices: [d3[0]!, d3[0]!, d3[1]!],
    expect: "duplicate-id",
  });
  await mkVerify("ring-duplicate-id-other-keys", "One id with two key sets.", {
    devices: [d3[0]!, { ...dev(5), deviceId: d3[0]!.deviceId }],
    expect: "duplicate-id",
  });
  await mkVerify("ring-duplicate-sign-key", "Two devices share a signKey.", {
    devices: [d3[0]!, { ...d3[1]!, signKey: d3[0]!.signKey }],
    expect: "duplicate-key",
  });
  await mkVerify("ring-duplicate-agree-key", "Two devices share an agreeKey.", {
    devices: [d3[0]!, { ...d3[1]!, agreeKey: d3[0]!.agreeKey }],
    expect: "duplicate-key",
  });
  await mkVerify("ring-entry-null", "An entry is null.", {
    devices: [d3[0]!, null],
    expect: "device",
  });
  await mkVerify(
    "ring-entry-bad-device-id",
    "An entry's deviceId is 31 characters.",
    {
      devices: [{ ...d3[0]!, deviceId: d3[0]!.deviceId.slice(0, 31) }],
      expect: "device",
    },
  );
  await mkVerify("ring-entry-missing-device-id", "An entry has no deviceId.", {
    devices: [{ signKey: d3[0]!.signKey, agreeKey: d3[0]!.agreeKey }],
    expect: "device",
  });
  await mkVerify("ring-entry-missing-sign-key", "An entry has no signKey.", {
    devices: [{ deviceId: d3[0]!.deviceId, agreeKey: d3[0]!.agreeKey }],
    expect: "keys",
  });
  await mkVerify(
    "ring-entry-non-canonical-agree-key",
    "An entry's agreeKey has non-zero unused bits.",
    {
      devices: [{ ...d3[0]!, agreeKey: nonCanonical(d3[0]!.agreeKey) }],
      expect: "keys",
    },
  );
  await mkVerify(
    "ring-entry-small-order-sign-key",
    "An entry's signKey is the Ed25519 identity.",
    {
      devices: [
        {
          ...d3[0]!,
          signKey: b64u(Buffer.from("01" + "00".repeat(31), "hex")),
        },
      ],
      expect: "keys",
    },
  );
  REF_X25519_LOW_ORDER_HEX.forEach((hex, k) => {
    for (const top of [false, true])
      pending.push(() =>
        mkVerify(
          `ring-entry-low-order-${names7[k]}-top-bit-${top ? "set" : "clear"}`,
          `An entry's agreeKey is the low-order point ${names7[k]}${top ? " with bit 255 set" : ""}.`,
          {
            devices: [{ ...d3[0]!, agreeKey: hexKey(hex, top) }],
            expect: "keys",
          },
        ),
      );
  });
  for (const p of pending.splice(0)) await p();

  // claims
  await mkVerify("ring-wrong-iss", "iss is not the fixed issuer.", {
    doc: ringDoc(d3, { iss: "polaris" }),
    expect: "issuer-or-audience",
  });
  await mkVerify("ring-wrong-aud", "aud names another product.", {
    doc: ringDoc(d3, { aud: "other-product" }),
    expect: "issuer-or-audience",
  });
  await mkVerify("ring-sub-malformed", "sub is not a pairwise subject.", {
    doc: ringDoc(d3, { sub: "acct_x" }),
    expect: "subject",
  });
  await mkVerify("ring-missing-sub", "sub is absent.", {
    doc: without(ringDoc(d3), "sub"),
    expect: "subject",
  });
  await mkVerify("ring-epoch-zero", "epoch 0 is below the minimum of 1.", {
    doc: ringDoc(d3, { epoch: 0 }),
    expect: "integer",
  });
  await mkVerify("ring-epoch-fraction", "epoch 1.5.", {
    doc: ringDoc(d3, { epoch: raw("1.5") }),
    expect: "integer",
  });
  await mkVerify("ring-epoch-trailing-zero", "epoch written 7.0.", {
    doc: ringDoc(d3, { epoch: raw("7.0") }),
    expect: "integer",
  });
  await mkVerify("ring-epoch-over-2-53", "epoch above 2^53 − 1.", {
    doc: ringDoc(d3, { epoch: raw("9007199254740993") }),
    expect: "integer",
  });
  await mkVerify("ring-epoch-string", "epoch is a string.", {
    doc: ringDoc(d3, { epoch: "7" }),
    expect: "integer",
  });
  await mkVerify("ring-missing-epoch", "epoch is absent.", {
    doc: without(ringDoc(d3), "epoch"),
    expect: "integer",
  });
  await mkVerify("ring-issued-at-negative", "issuedAt is negative.", {
    doc: ringDoc(d3, { issuedAt: -1 }),
    expect: "integer",
  });
  await mkVerify("ring-expires-at-fraction", "expiresAt is a fraction.", {
    doc: ringDoc(d3, { expiresAt: raw("1700604800.5") }),
    expect: "integer",
  });

  // lifetime: 1 to RING_SECONDS
  await mkVerify("ring-valid-span-max", "expiresAt − issuedAt = 604800.", {
    doc: ringDoc(d3, { expiresAt: ISSUED + WEEK }),
    expect: "ok",
  });
  await mkVerify("ring-valid-span-min", "expiresAt − issuedAt = 1.", {
    doc: ringDoc(d3, { expiresAt: ISSUED + 1 }),
    expect: "ok",
  });
  await mkVerify("ring-lifetime-over-max", "expiresAt − issuedAt = 604801.", {
    doc: ringDoc(d3, { expiresAt: ISSUED + WEEK + 1 }),
    expect: "lifetime",
  });
  await mkVerify("ring-lifetime-zero", "expiresAt = issuedAt.", {
    doc: ringDoc(d3, { expiresAt: ISSUED }),
    expect: "lifetime",
  });
  await mkVerify("ring-lifetime-negative", "expiresAt before issuedAt.", {
    doc: ringDoc(d3, { expiresAt: ISSUED - 1 }),
    expect: "lifetime",
  });
  await mkVerify("ring-lifetime-huge", "A thirty-day span.", {
    doc: ringDoc(d3, { expiresAt: ISSUED + 30 * DAY }),
    expect: "lifetime",
  });

  // typ and signer
  for (const typ of [
    "pkey-peer+jws",
    "pkey-trust+jws",
    "pkey-feed+jws",
  ] as const)
    await mkVerify(
      `ring-wrong-typ-${typ.slice(5, -4)}`,
      `A roster payload under ${typ}.`,
      { typ, expect: "jws-rejected" },
    );
  await mkVerify(
    "ring-signed-by-release-key",
    "A release key never signs a roster.",
    { kid: REL_KID, expect: "jws-rejected" },
  );
  const rv = await signDoc(ringDoc(d3), "pkey-ring+jws");
  const [rh, rp, rs] = rv.split(".") as [string, string, string];
  const rtamper = Buffer.from(
    Buffer.from(rp, "base64url").toString().replace('"epoch":7', '"epoch":8'),
  ).toString("base64url");
  await mkVerify(
    "ring-tampered-payload",
    "The payload changed after signing.",
    { jws: `${rh}.${rtamper}.${rs}`, expect: "jws-rejected" },
  );
  await mkVerify(
    "ring-unknown-kid",
    "A header kid outside the effective set.",
    { trust: { [ALT_KID]: pub(ALT_KID) }, expect: "jws-rejected" },
  );

  // replacement (§15.3 held ring and replacement)

  const held7 = await signDoc(ringDoc(devs(2), { epoch: 7 }), "pkey-ring+jws");
  const mkReplace = async (
    id: string,
    description: string,
    o: {
      held?: string | null;
      doc: Doc;
      now?: number;
      kid?: string;
      expect: "ok" | ReplaceReason;
    },
  ): Promise<void> => {
    const jws = await signDoc(o.doc, "pkey-ring+jws", o.kid);
    const heldJws = o.held === undefined ? held7 : o.held;
    const now = o.now ?? NOW;
    const r = refRingReplace(heldJws, jws, TRUST, { expectedAud: AUD_V3, now });
    agree(id, r.replace ? "ok" : r.reason, o.expect);
    cases.push({
      kind: "replace",
      id,
      description,
      heldJws,
      jws,
      trust: TRUST,
      expectedAud: AUD_V3,
      now,
      expect: r.replace
        ? { replace: true }
        : { replace: false, reason: r.reason },
    });
  };
  const two = devs(2);
  await mkReplace("ring-replace-higher", "Epoch 8 over a held epoch 7.", {
    doc: ringDoc(two, { epoch: 8 }),
    expect: "ok",
  });
  await mkReplace(
    "ring-replace-much-higher",
    "Epoch 2^53 − 1 over a held epoch 7.",
    { doc: ringDoc(two, { epoch: MAX_WIRE_INTEGER_REF }), expect: "ok" },
  );
  await mkReplace("ring-replace-equal", "Epoch 7 over a held epoch 7.", {
    doc: ringDoc(two, { epoch: 7 }),
    expect: "epoch-not-higher",
  });
  await mkReplace("ring-replace-lower", "Epoch 6 over a held epoch 7.", {
    doc: ringDoc(two, { epoch: 6 }),
    expect: "epoch-not-higher",
  });
  await mkReplace(
    "ring-replace-other-subject",
    "Epoch 8 for another subject.",
    {
      doc: ringDoc(two, { epoch: 8, sub: OTHER_SUB }),
      expect: "other-product-or-subject",
    },
  );
  await mkReplace(
    "ring-replace-other-audience",
    "Epoch 8 for another product: it does not verify for this app.",
    {
      doc: ringDoc(two, { epoch: 8, aud: "other-product" }),
      expect: "new-rejected",
    },
  );
  await mkReplace("ring-replace-unsorted-new", "Epoch 8, unsorted.", {
    doc: ringDoc([two[1]!, two[0]!], { epoch: 8 }),
    expect: "new-rejected",
  });
  await mkReplace("ring-replace-new-expired", "Epoch 8, already expired.", {
    doc: ringDoc(two, {
      epoch: 8,
      issuedAt: ISSUED - 2 * WEEK,
      expiresAt: ISSUED - WEEK,
    }),
    expect: "new-expired",
  });
  await mkReplace(
    "ring-replace-signed-by-release-key",
    "Epoch 8 signed by a release key.",
    { doc: ringDoc(two, { epoch: 8 }), kid: REL_KID, expect: "new-rejected" },
  );
  await mkReplace(
    "ring-replace-no-held",
    "No held ring: any verified roster is taken.",
    { held: null, doc: ringDoc(two, { epoch: 1 }), expect: "ok" },
  );
  const heldExpired = await signDoc(
    ringDoc(two, {
      epoch: 9,
      issuedAt: ISSUED - 2 * WEEK,
      expiresAt: ISSUED - WEEK,
    }),
    "pkey-ring+jws",
  );
  await mkReplace(
    "ring-replace-held-expired-lower-epoch",
    "An expired held ring counts as none: epoch 3 replaces an expired epoch 9.",
    { held: heldExpired, doc: ringDoc(two, { epoch: 3 }), expect: "ok" },
  );
  await mkReplace(
    "ring-replace-held-expired-other-subject",
    "An expired held ring counts as none: another subject replaces it.",
    {
      held: heldExpired,
      doc: ringDoc(two, { epoch: 3, sub: OTHER_SUB }),
      expect: "ok",
    },
  );
  await mkReplace(
    "ring-replace-held-expired-new-expired",
    "Both rings expired: the new one is refused.",
    {
      held: heldExpired,
      doc: ringDoc(two, {
        epoch: 10,
        issuedAt: ISSUED - 2 * WEEK,
        expiresAt: ISSUED - WEEK,
      }),
      expect: "new-expired",
    },
  );

  return cases;
}

// ── peerAdmissionCases ───────────────────────────────────────────────────────────────────────

interface AdmissionCase {
  id: string;
  description: string;
  certJws: string;
  ringJws: string | null;
  trust: Record<string, string>;
  expectedAud: string;
  now: number;
  expect: AdmissionVerdict;
}

export async function buildAdmissionCases(): Promise<AdmissionCase[]> {
  const cases: AdmissionCase[] = [];
  const peer = dev(0);
  const mk = async (
    id: string,
    description: string,
    o: {
      cert?: Doc;
      certTyp?: TypV3;
      ring?: Doc | null;
      now?: number;
      expect: AdmissionVerdict;
    },
  ): Promise<void> => {
    const certJws = await signDoc(
      o.cert ?? certDoc(peer),
      o.certTyp ?? "pkey-peer+jws",
    );
    const ringJws =
      o.ring === null
        ? null
        : await signDoc(o.ring ?? ringDoc(devs(3)), "pkey-ring+jws");
    const now = o.now ?? NOW;
    const v = refAdmission(certJws, ringJws, TRUST, {
      expectedAud: AUD_V3,
      now,
    });
    agree(id, v, o.expect);
    cases.push({
      id,
      description,
      certJws,
      ringJws,
      trust: TRUST,
      expectedAud: AUD_V3,
      now,
      expect: v,
    });
  };
  const admit = (ringSync: "none" | "request"): AdmissionVerdict => ({
    admit: true,
    ringSync,
  });
  const revoked: AdmissionVerdict = { admit: false, reason: "peer_revoked" };
  const invalid: AdmissionVerdict = { admit: false, reason: "cert-invalid" };
  const withPeer = (n: number, epoch: number, over: Doc = {}): Doc =>
    ringDoc([...devs(n, 1), peer].sort(byId), { epoch, ...over });
  const withoutPeer = (n: number, epoch: number, over: Doc = {}): Doc =>
    ringDoc(devs(n, 1), { epoch, ...over });

  await mk("admit-no-ring", "No held ring: the certificate alone admits.", {
    ring: null,
    expect: admit("none"),
  });
  await mk(
    "admit-same-epoch-listed",
    "Ring epoch 7, certificate epoch 7, device listed.",
    { ring: withPeer(2, 7), expect: admit("none") },
  );
  await mk(
    "admit-same-epoch-unlisted",
    "Ring epoch 7, certificate epoch 7, device not listed: the ring is not newer, so admit.",
    { ring: withoutPeer(2, 7), expect: admit("none") },
  );
  await mk(
    "admit-ring-older-request-ring",
    "Ring epoch 5, certificate epoch 7: admit and request the newer ring.",
    { ring: withoutPeer(2, 5), expect: admit("request") },
  );
  await mk(
    "admit-ring-older-listed-request-ring",
    "Ring epoch 6, certificate epoch 7, device listed: admit and request.",
    { ring: withPeer(2, 6), expect: admit("request") },
  );
  await mk(
    "admit-ring-newer-listed",
    "Ring epoch 8 lists the device exactly.",
    { ring: withPeer(2, 8), expect: admit("none") },
  );
  await mk(
    "admit-ring-newer-listed-in-128",
    "Ring epoch 8 lists the device among 128.",
    {
      ring: ringDoc([...devs(127, 1), peer].sort(byId), { epoch: 8 }),
      expect: admit("none"),
    },
  );
  await mk(
    "revoked-ring-newer-unlisted",
    "Ring epoch 8 does not list the device.",
    { ring: withoutPeer(2, 8), expect: revoked },
  );
  await mk(
    "revoked-ring-newer-other-sign-key",
    "Ring epoch 8 lists the device id with another signKey.",
    {
      ring: ringDoc(
        [...devs(2, 1), { ...peer, signKey: dev(9).signKey }].sort(byId),
        { epoch: 8 },
      ),
      expect: revoked,
    },
  );
  await mk(
    "revoked-ring-newer-other-agree-key",
    "Ring epoch 8 lists the device id with another agreeKey.",
    {
      ring: ringDoc(
        [...devs(2, 1), { ...peer, agreeKey: dev(9).agreeKey }].sort(byId),
        { epoch: 8 },
      ),
      expect: revoked,
    },
  );
  await mk(
    "revoked-ring-newer-other-device-id",
    "Ring epoch 8 lists the keys under another device id.",
    {
      ring: ringDoc(
        [...devs(2, 1), { ...peer, deviceId: dev(9).deviceId }].sort(byId),
        { epoch: 8 },
      ),
      expect: revoked,
    },
  );
  await mk(
    "revoked-ring-epoch-max",
    "Ring epoch 2^53 − 1 without the device.",
    { ring: withoutPeer(2, MAX_WIRE_INTEGER_REF), expect: revoked },
  );
  await mk(
    "admit-expired-held-ring-counts-as-none",
    "A held ring at epoch 8 without the device, expired: it counts as no ring.",
    {
      ring: withoutPeer(2, 8, {
        issuedAt: ISSUED - 2 * WEEK,
        expiresAt: ISSUED - WEEK,
      }),
      expect: admit("none"),
    },
  );
  await mk(
    "invalid-cert-no-ring",
    "An expired certificate is refused even with no ring.",
    { ring: null, now: ISSUED + WEEK + 301, expect: invalid },
  );
  await mk(
    "invalid-cert-wrong-typ",
    "A certificate payload under the roster's typ is refused.",
    { certTyp: "pkey-ring+jws", ring: withPeer(2, 8), expect: invalid },
  );
  await mk(
    "invalid-cert-listed-low-order-key",
    "A low-order agreeKey is refused even if a ring lists the device.",
    {
      cert: certDoc(peer, {
        agreeKey: hexKey(REF_X25519_LOW_ORDER_HEX[1], true),
      }),
      ring: withPeer(2, 8),
      expect: invalid,
    },
  );
  await mk(
    "invalid-cert-wrong-audience",
    "A certificate for another product.",
    {
      cert: certDoc(peer, { aud: "other-product" }),
      ring: null,
      expect: invalid,
    },
  );
  return cases;
}
