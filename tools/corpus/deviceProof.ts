// `device-proof.json`: the one device proof, `pkey-proof/1` (WIRE-CONTRACT-V5 §12.11.1, §15.8;
// plans/CC-01.md R-6). `deviceProofVersion` 1.
//
// Every purpose has a valid row; the refusals cover a field that breaks the line format, a proof
// moved to another purpose, product, device, token or value, a signature that is not canonical, a
// signing key of small order or not canonical, a bad agreement key, and the `keys` skew window.
// Every verdict is recomputed through `reference/deviceProof.ts` (`node:crypto` only; nothing from
// client-core) and the generator throws when an authored verdict disagrees. Signatures are
// deterministic Ed25519 over fixed seeds, so the file is stable. Rows other than `keys` and
// `exchange` carry an illustrative value: the byte format is the vector, the value belongs to the
// route that takes the purpose.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from "node:crypto";
import {
  ED_L,
  ED_P,
  IDENTITY_ENC,
  IDENTITY_Y_P_PLUS_1,
  ORDER8_ENC,
  bigToLe,
  leToBig,
} from "./reference/ed25519.js";
import {
  REF_KEYS_SKEW,
  REF_PROOF_LINE_1,
  REF_PROOF_PURPOSES,
  refProofMessage,
  refVerifyProof,
  type RefProofReason,
  type RefProofRow,
} from "./reference/deviceProof.js";

const PRODUCT = "djdl";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const OTHER_DEVICE = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const NOW = 1700000000;

const seed = (label: string): Buffer =>
  createHash("sha256").update(`pkey-proof vector ${label}`).digest();
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256B64 = (s: string): string =>
  createHash("sha256").update(s).digest("base64url");

const PKCS8_ED = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X = Buffer.from("302e020100300506032b656e04220420", "hex");

interface Signer {
  signKey: string;
  sign: (msg: Uint8Array) => Buffer;
}
function signer(label: string): Signer {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED, seed(label)]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(priv).export({ format: "jwk" });
  return {
    signKey: jwk.x as string,
    sign: (msg) => nodeSign(null, msg, priv),
  };
}
function agreeKeyOf(label: string): string {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_X, seed(label)]),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(priv).export({ format: "jwk" }).x as string;
}

const A = signer("device a signing");
const B = signer("device b signing");
const AGREE = agreeKeyOf("device a agreement");
const NONCE = b64(seed("nonce"));
const TOKEN_HASH = sha256B64("idtoken-fixture");

type Fields = Pick<
  RefProofRow,
  "purpose" | "product" | "deviceId" | "value" | "tokenHash"
>;

interface Row extends RefProofRow {
  id: string;
  description: string;
  verdict: "ok" | "fail";
  /** Informational: why the reference refuses. An implementation answers true or false only. */
  reason: RefProofReason;
  /** The six lines as hex, or null when a field breaks the line format. */
  messageHex: string | null;
}

const rows: Row[] = [];
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A signature by `who` over the joined lines, even when a field would break the format. */
function sigOver(f: Fields, who: Signer): string {
  const text = [
    REF_PROOF_LINE_1,
    f.purpose,
    f.product,
    f.deviceId,
    f.value,
    f.tokenHash,
  ].join("\n");
  return b64(who.sign(Buffer.from(text, "utf8")));
}

function add(
  id: string,
  description: string,
  f: Fields,
  opts: {
    who?: Signer;
    signKey?: string;
    sig?: string;
    now?: number;
    expect: RefProofReason;
  },
): Row {
  const who = opts.who ?? A;
  const row: RefProofRow = {
    ...f,
    signKey: opts.signKey ?? who.signKey,
    sig: opts.sig ?? sigOver(f, who),
    now: opts.now ?? NOW,
  };
  const reason = refVerifyProof(row);
  if (reason !== opts.expect)
    throw new Error(
      `deviceProof ${id}: reference says ${reason}, authored ${opts.expect}`,
    );
  const msg = refProofMessage(f);
  const out: Row = {
    id,
    description,
    ...row,
    verdict: reason === "ok" ? "ok" : "fail",
    reason,
    messageHex: msg ? msg.toString("hex") : null,
  };
  if (rows.some((r) => r.id === id)) throw new Error(`deviceProof: dup ${id}`);
  rows.push(out);
  return out;
}

const keysValue = (sk: string, ak: string, at: number | string): string =>
  `${sk}.${ak}.${at}`;

const base = (purpose: string, value: string, tokenHash = "-"): Fields => ({
  purpose,
  product: PRODUCT,
  deviceId: DEVICE,
  value,
  tokenHash,
});

// ── valid rows: every purpose ──────────────────────────────────────────────────────────────
const VALUES: Record<string, { value: string; tokenHash: string }> = {
  keys: { value: keysValue(A.signKey, AGREE, NOW - 10), tokenHash: "-" },
  nonce: { value: `${A.signKey}.${AGREE}`, tokenHash: "-" },
  exchange: { value: `${NONCE}.${A.signKey}`, tokenHash: TOKEN_HASH },
  link: { value: NONCE, tokenHash: TOKEN_HASH },
  "nearby-start": { value: `${A.signKey}.${AGREE}`, tokenHash: "-" },
  "nearby-poll": { value: "nr_" + NONCE.slice(0, 22), tokenHash: "-" },
  "nearby-approve": { value: "nr_" + NONCE.slice(0, 22), tokenHash: "-" },
  vouch: { value: `${NONCE}.nr_${NONCE.slice(0, 22)}`, tokenHash: "-" },
  restore: { value: NONCE, tokenHash: "-" },
};
for (const p of REF_PROOF_PURPOSES) {
  const v = VALUES[p]!;
  add(`valid-${p}`, `A valid ${p} proof.`, base(p, v.value, v.tokenHash), {
    expect: "ok",
  });
}

const EX = base("exchange", VALUES.exchange!.value, TOKEN_HASH);
const exRow = rows.find((r) => r.id === "valid-exchange")!;
const KEYS = base("keys", VALUES.keys!.value);
const keysRow = rows.find((r) => r.id === "valid-keys")!;

// ── the line format: a field that breaks it is refused whatever the signature ────────────
for (const [field, bad] of [
  ["product", "dj\ndl"],
  ["deviceId", `${DEVICE}\n`],
  ["value", `${NONCE}\n${A.signKey}`],
  ["tokenHash", `${TOKEN_HASH}\nx`],
] as const) {
  add(
    `newline-in-${field}`,
    `A newline in ${field}; the signature covers the joined text, so only the line format refuses it.`,
    { ...EX, [field]: bad },
    { expect: "line-format" },
  );
}
add(
  "space-in-device",
  "A space inside the device id.",
  {
    ...EX,
    deviceId: "AAAA BBBB",
  },
  { expect: "line-format" },
);
add(
  "empty-value",
  "An empty value line.",
  { ...EX, value: "" },
  {
    expect: "line-format",
  },
);
add(
  "non-ascii-product",
  "A non-ASCII product.",
  { ...EX, product: "djdé" },
  {
    expect: "line-format",
  },
);
add(
  "unknown-purpose",
  "A purpose outside the nine, signed correctly.",
  { ...EX, purpose: "bogus" },
  { expect: "unknown-purpose" },
);

// ── binding: a proof does not move to another purpose, product, device, token or value ────
const moved = (
  id: string,
  description: string,
  patch: Partial<Fields>,
): void => {
  add(
    id,
    description,
    { ...EX, ...patch },
    {
      sig: exRow.sig,
      expect: "sig",
    },
  );
};
moved("wrong-purpose", "An exchange signature presented as link.", {
  purpose: "link",
});
moved("wrong-slug", "An exchange signature presented for another product.", {
  product: "other",
});
moved("wrong-device", "An exchange signature presented for another device.", {
  deviceId: OTHER_DEVICE,
});
moved("wrong-token-hash", "An exchange signature with another token hash.", {
  tokenHash: sha256B64("another-token"),
});
moved(
  "wrong-token-hash-dash",
  "An exchange signature with the token hash replaced by -.",
  {
    tokenHash: "-",
  },
);
moved("wrong-value", "An exchange signature presented with another nonce.", {
  value: `${b64(seed("nonce 2"))}.${A.signKey}`,
});
add(
  "wrong-signer",
  "A signature by another device's key, checked against this key.",
  EX,
  {
    who: B,
    signKey: A.signKey,
    expect: "sig",
  },
);

// ── signature encoding ─────────────────────────────────────────────────────────────────────
const sigBytes = Buffer.from(exRow.sig, "base64url");
const withSig = (
  id: string,
  description: string,
  sig: string,
  expect: RefProofReason,
): void => {
  add(id, description, EX, { sig, expect });
};
{
  const s = Buffer.from(sigBytes);
  const bigS = leToBig(s.subarray(32)) + ED_L;
  s.set(bigToLe(bigS, 32), 32);
  withSig(
    "sig-s-plus-l",
    "S replaced by S + L: a second encoding of the same signature.",
    b64(s),
    "sig-scalar",
  );
}
{
  const s = Buffer.from(sigBytes);
  s.set(bigToLe(ED_L, 32), 32);
  withSig("sig-s-equals-l", "S equal to L.", b64(s), "sig-scalar");
}
{
  const s = Buffer.from(sigBytes);
  s.set(IDENTITY_ENC, 0);
  withSig(
    "sig-r-identity",
    "R the identity point (small order).",
    b64(s),
    "sig-point",
  );
}
{
  const s = Buffer.from(sigBytes);
  s.set(IDENTITY_Y_P_PLUS_1, 0);
  withSig(
    "sig-r-noncanonical",
    "R encoded with y = p + 1 (not canonical).",
    b64(s),
    "sig-point",
  );
}
{
  const s = Buffer.from(sigBytes);
  s.set(ORDER8_ENC, 0);
  withSig("sig-r-order-8", "R a point of order 8.", b64(s), "sig-point");
}
{
  // 86 characters carry 512 data bits and 4 spare ones in the last character; set a spare bit.
  const idx = B64URL.indexOf(exRow.sig.slice(-1));
  const noncanon = exRow.sig.slice(0, -1) + B64URL[(idx & ~15) | 1]!;
  withSig(
    "sig-b64-spare-bits",
    "The same 64 bytes spelled with a non-zero spare bit in the last character.",
    noncanon,
    "sig-encoding",
  );
}
withSig(
  "sig-padded",
  "The signature with = padding.",
  exRow.sig + "==",
  "sig-encoding",
);
withSig(
  "sig-short",
  "A 63-byte signature.",
  b64(sigBytes.subarray(0, 63)),
  "sig-encoding",
);
withSig(
  "sig-long",
  "A 65-byte signature.",
  b64(Buffer.concat([sigBytes, Buffer.from([0])])),
  "sig-encoding",
);
withSig("sig-empty", "An empty signature.", "", "sig-encoding");
{
  const std = sigBytes.toString("base64").replace(/=+$/, "");
  if (std !== exRow.sig)
    withSig(
      "sig-standard-base64",
      "The standard base64 alphabet (+ and /) where base64url is required.",
      std,
      "sig-encoding",
    );
}
withSig(
  "sig-zero",
  "An all-zero signature.",
  b64(new Uint8Array(64)),
  "sig-point",
);
{
  const s = Buffer.from(sigBytes);
  s[40] = s[40]! ^ 1;
  withSig("sig-flipped-bit", "One bit of S flipped.", b64(s), "sig");
}

// ── signing key: small order, not canonical ────────────────────────────────────────────────
const keyRow = (
  id: string,
  description: string,
  key: Uint8Array | string,
  expect: RefProofReason,
): void => {
  const k = typeof key === "string" ? key : b64(key);
  add(id, description, EX, { signKey: k, sig: exRow.sig, expect });
};
keyRow(
  "key-identity",
  "The identity point as signing key.",
  IDENTITY_ENC,
  "sign-key",
);
keyRow("key-zero", "An all-zero signing key.", new Uint8Array(32), "sign-key");
keyRow("key-order-8", "A signing key of order 8.", ORDER8_ENC, "sign-key");
keyRow(
  "key-y-p-plus-1",
  "A signing key encoded with y = p + 1.",
  IDENTITY_Y_P_PLUS_1,
  "sign-key",
);
{
  const neg = Buffer.from(ORDER8_ENC);
  neg[31] = neg[31]! | 0x80;
  keyRow(
    "key-order-8-negated",
    "The order-8 point with the sign bit set.",
    neg,
    "sign-key",
  );
}
{
  // 43 characters carry 256 data bits and 2 spare ones in the last character.
  const idx = B64URL.indexOf(A.signKey.slice(-1));
  const alt = B64URL[(idx & ~3) | ((idx & 3) === 0 ? 1 : 0)]!;
  keyRow(
    "key-b64-spare-bits",
    "The signing key spelled with a non-zero spare bit in its last character.",
    A.signKey.slice(0, -1) + alt,
    "sign-key",
  );
}
keyRow(
  "key-short",
  "A 31-byte signing key.",
  Buffer.from(A.signKey, "base64url").subarray(0, 31),
  "sign-key",
);
keyRow("key-empty", "An empty signing key.", "", "sign-key");

// ── purpose `keys`: the agreement key and the skew window ────────────────────────────────
const keysWith = (
  id: string,
  description: string,
  ak: string,
  expect: RefProofReason,
): void => {
  add(id, description, base("keys", keysValue(A.signKey, ak, NOW)), { expect });
};
const hexKey = (h: string): string => b64(Buffer.from(h, "hex"));
keysWith(
  "keys-agree-zero",
  "The all-zero agreement key.",
  hexKey("00".repeat(32)),
  "agree-key",
);
keysWith(
  "keys-agree-one",
  "The agreement key u = 1.",
  hexKey("01" + "00".repeat(31)),
  "agree-key",
);
keysWith(
  "keys-agree-order-8",
  "An agreement key of order 8.",
  hexKey("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
  "agree-key",
);
keysWith(
  "keys-agree-p-minus-1",
  "The agreement key u = p - 1.",
  hexKey("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
  "agree-key",
);
{
  const k = Buffer.from(AGREE, "base64url");
  k[31] = k[31]! | 0x80;
  keysWith(
    "keys-agree-bit-255",
    "A valid agreement key with bit 255 set (not the canonical spelling).",
    b64(k),
    "agree-key",
  );
}
{
  const k = bigToLe(ED_P + 5n, 32);
  keysWith(
    "keys-agree-ge-p",
    "An agreement key with u = p + 5 (not reduced).",
    b64(k),
    "agree-key",
  );
}
keysWith(
  "keys-agree-short",
  "A 31-byte agreement key.",
  b64(Buffer.from(AGREE, "base64url").subarray(0, 31)),
  "keys-value",
);
add(
  "keys-value-other-sign-key",
  "The value names another signing key.",
  base("keys", keysValue(B.signKey, AGREE, NOW)),
  { expect: "keys-value" },
);
add(
  "keys-token-hash",
  "A keys proof with a token hash other than -.",
  base("keys", VALUES.keys!.value, TOKEN_HASH),
  { expect: "keys-value" },
);
add(
  "keys-value-two-parts",
  "A keys value with no issuedAt.",
  base("keys", `${A.signKey}.${AGREE}`),
  { expect: "keys-value" },
);
add(
  "keys-value-leading-zero",
  "issuedAt written with a leading zero.",
  base("keys", keysValue(A.signKey, AGREE, `0${NOW}`)),
  { expect: "keys-value" },
);
add(
  "keys-value-negative",
  "A negative issuedAt.",
  base("keys", keysValue(A.signKey, AGREE, "-5")),
  { expect: "keys-value" },
);
add(
  "keys-value-fraction",
  "A fractional issuedAt.",
  base("keys", keysValue(A.signKey, AGREE, "1.5")),
  { expect: "keys-value" },
);
add(
  "keys-value-exponent",
  "issuedAt in exponent form.",
  base("keys", keysValue(A.signKey, AGREE, "1e9")),
  { expect: "keys-value" },
);
for (const [id, delta, expect] of [
  ["keys-skew-plus-300", 300, "ok"],
  ["keys-skew-minus-300", -300, "ok"],
  ["keys-skew-plus-301", 301, "skew"],
  ["keys-skew-minus-301", -301, "skew"],
  ["keys-skew-far-future", 86400, "skew"],
  ["keys-skew-epoch", -NOW, "skew"],
] as const) {
  add(
    id,
    `A keys proof issued ${delta} seconds from now (window +-${REF_KEYS_SKEW}).`,
    base("keys", keysValue(A.signKey, AGREE, NOW + delta)),
    { expect },
  );
}
add(
  "keys-skew-on-other-purpose",
  "The skew window is a keys rule: an exchange proof ignores now.",
  EX,
  { now: NOW + 100000, expect: "ok" },
);
add(
  "keys-moved-to-nonce",
  "A keys signature presented as nonce.",
  { ...KEYS, purpose: "nonce" },
  { sig: keysRow.sig, expect: "sig" },
);

// `<signKey>.<agreeKey>.<issuedAt>` from its parts: what a client builds.
const keyValueCases = [
  { signKey: A.signKey, agreeKey: AGREE, issuedAt: NOW },
  {
    signKey: B.signKey,
    agreeKey: agreeKeyOf("device b agreement"),
    issuedAt: 0,
  },
].map((p) => ({ ...p, value: keysValue(p.signKey, p.agreeKey, p.issuedAt) }));

export function buildDeviceProof(): unknown {
  return {
    deviceProofVersion: 1,
    description:
      "pkey-proof/1 (WIRE-CONTRACT-V5 section 12.11.1 and 15.8): an Ed25519 signature by the device's signing key over the six lines pkey-proof/1, purpose, product slug, X-PKey-Device, value and token hash (or -), joined by LF with no trailing newline. A field that is empty or holds a byte outside 0x21..0x7e breaks the line format and makes the proof invalid. The signature is checked strictly (V5 1.1): canonical base64url of 64 bytes, S < L, R and the key neither of small order nor non-canonical. Purpose keys also needs a value of signKey.agreeKey.issuedAt naming the presenting signKey, a valid agreeKey (canonical X25519 spelling, not low-order) and |issuedAt - now| <= skewSeconds, and a token hash of -. A runner answers true or false only; `reason` is documentation. Append-only: a new row keeps deviceProofVersion.",
    line1: REF_PROOF_LINE_1,
    purposes: [...REF_PROOF_PURPOSES],
    skewSeconds: REF_KEYS_SKEW,
    now: NOW,
    keyValueCases,
    cases: rows,
  };
}
