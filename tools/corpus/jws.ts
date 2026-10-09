// `cases.json#/jwsCases`: the raw-JWS vectors (§1–§2) and wire contract v4's new cases (§4.3),
// including the hand-signed Ed25519 constructions of `ed25519.ts`.

import {
  signJws,
  base64UrlDecode,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@polaris-key/jws";
import {
  ALT_KID,
  annotateNul,
  AUD_V3,
  configDoc,
  DEVICE_V3,
  docOfExactBytes,
  encSeg,
  headerText,
  ISSUER_V3,
  keyEntry,
  licenseDoc,
  MAX_BUNDLE_BYTES,
  pem,
  PIN_KID,
  pub,
  signAs,
  signRawBytes,
  signRawSegments,
  trustManifestV3,
  type TypV3,
  utf8Bytes,
  V3_GRACE,
  V3_ISSUED,
  type VerifyExpect,
} from "./common.js";
import {
  checkEd25519Tables,
  EdPoint,
  handSign,
  nonce,
  secretScalar,
} from "./ed25519.js";
import { placeNonWire } from "./nonwire.js";
import { feedPayload } from "./release-records.js";
import { canonicalEqual, type Json } from "./reference/config.js";
import {
  bigToLe,
  ED_L,
  IDENTITY_ENC,
  IDENTITY_Y_P_PLUS_1,
  leToBig,
  NEGATIVE_ZERO_ENC,
  ORDER8_ENC,
  SMALL_ORDER_REF,
} from "./reference/ed25519.js";
import { refVerifyJws } from "./reference/jws.js";
import { noncanonical } from "./trust.js";
import { refNonWire } from "./reference/tokens.js";

// ── §1–§2 raw-JWS vectors ────────────────────────────────────────────────────
// v1's `cases` carried forward with v3 typs, plus the three the v3 envelope adds. Every
// runner drives these through the bare JWS verifier with `requireTyp: true` — v3 verifiers
// always demand a type — and with `maxPayloadBytes` only where the case declares one.

interface JwsCaseV2 {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  /** The `typ` the CALL SITE expects. v3 has no untyped call sites, so this is always set
   *  where a document-shaped expectation is meaningful. */
  typ?: TypV3;
  /** §1 — present ONLY on the `pkey-bundle+jws` vectors, which is the one artifact allowed
   *  past 65 536 bytes. Runners must not pass it anywhere else. */
  maxPayloadBytes?: number;
  /** `doc` is omitted where the payload is a quarter-megabyte of padding: the vector pins
   *  the size boundary, and the id already says which side of it. */
  expect: VerifyExpect;
}

export async function buildJwsCases(): Promise<JwsCaseV2[]> {
  const cases: JwsCaseV2[] = [];
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const LIC: TypV3 = "pkey-license+jws";

  // 1. The DJDL baseline, restated as a v3 license document under the djdl test key.
  const baseline = licenseDoc({
    licenseId: "abc123def456",
    deviceId: "device-fixture-01",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "djdl-baseline",
    description:
      "The DJDL cross-platform vector, restated as a v3 license document.",
    jws: await signAs(baseline, ALT_KID, LIC),
    trust: { [ALT_KID]: pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "ok", kid: ALT_KID, doc: baseline },
  });

  // 2. The control: a valid license document under the prod-like test key.
  const validDoc = licenseDoc();
  const validJws = await signAs(validDoc, PIN_KID, LIC);
  cases.push({
    id: "valid-stable",
    description: "A valid v3 license document (typ + envelope + grants).",
    jws: validJws,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: validDoc },
  });

  const [vh, vp, vs] = validJws.split(".") as [string, string, string];
  /** `encPayload.encSig` of the valid document — reused to swap ONLY the protected header. */
  const validHeaderless = `${vp}.${vs}`;

  // 3. Tampered payload — flip a value, keep the original signature.
  cases.push({
    id: "tampered-payload",
    description: "Payload mutated after signing — signature must fail.",
    jws: `${vh}.${encSeg(licenseDoc({ licenseId: "lic_elevated" }))}.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 4. Unknown kid — signed by a key absent from the trust set.
  cases.push({
    id: "wrong-kid",
    description: "Valid signature, but the kid is absent from the trust set.",
    jws: validJws,
    trust: { "some-other-kid": pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 5. alg downgrade — `none` is rejected before any signature math.
  cases.push({
    id: "wrong-alg-none",
    description: "Header alg=none — rejected as an algorithm downgrade.",
    jws: `${encSeg({ alg: "none", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 6. Structurally invalid input must fail cleanly, never throw.
  cases.push({
    id: "malformed-two-parts",
    description: "Structurally invalid JWS (two segments).",
    jws: "a.b",
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 7. Key selection is by `kid`, not by position, in a multi-key trust set.
  const multiTrust = {
    [ALT_KID]: pub(ALT_KID),
    [PIN_KID]: pub(PIN_KID),
  };
  const secondKeyDoc = licenseDoc({ licenseId: "lic_second_key" });
  cases.push({
    id: "valid-second-key-multi-trust",
    description:
      "A document signed by djdl-test-2026, verified against a trust set holding BOTH test keys — selection is by kid.",
    jws: await signAs(secondKeyDoc, ALT_KID, LIC),
    trust: multiTrust,
    typ: LIC,
    expect: { verify: "ok", kid: ALT_KID, doc: secondKeyDoc },
  });

  // 8. Extensibility: unknown top-level fields round-trip verbatim.
  const extensionDoc = licenseDoc({
    futureFeature: { tier: "gold", seats: 5 },
    unknownTopLevel: "preserved-extension-field",
  });
  cases.push({
    id: "valid-extension-extra-fields",
    description:
      "A document carrying unknown top-level fields still verifies and round-trips byte-for-byte.",
    jws: await signAs(extensionDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: extensionDoc },
  });

  // 9. Right kid, WRONG key bytes — presence of the kid is not enough.
  cases.push({
    id: "right-kid-wrong-key",
    description:
      "Signature from pkey-test-prod-2026 verified against a trust mapping that kid to djdl-test-2026's pubkey — must fail.",
    jws: validJws,
    trust: { [PIN_KID]: pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 10/11. Degenerate segment counts.
  cases.push({
    id: "malformed-empty-string",
    description:
      "An empty-string JWS — structurally invalid, must fail cleanly.",
    jws: "",
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "malformed-four-parts",
    description:
      "A 4-segment JWS (extra trailing part) — structurally invalid, must fail.",
    jws: `${validJws}.extra`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 12. Unicode in the signed profile — byte-exact UTF-8 across languages.
  const unicodeDoc = licenseDoc({
    licenseId: "lic_unicode",
    profile: {
      name: "Ada Lovelace 💻 — 北京 — Ångström",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "valid-unicode-profile-name",
    description:
      "A document whose profile.name contains emoji + CJK + diacritics — verifies and round-trips the exact UTF-8.",
    jws: await signAs(unicodeDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: unicodeDoc },
  });

  // 13. The ManagedEntry states, now on the CONFIG document where v3 puts them. Carried from
  //     v1's `valid-v2-management-states`; the entry encoding itself is unchanged.
  const statesDoc = configDoc({
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1699991111,
      },
      "ui.theme": { state: "default", value: "dark", updatedAt: 1699992222 },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/xyz",
        updatedAt: 1699993333,
      },
    },
  });
  cases.push({
    id: "valid-management-states",
    description:
      "A config document with enforced + hidden + default ManagedEntry shapes (each carrying updatedAt) — the entry encoding is unchanged from v2, only the document it rides on moved.",
    jws: await signAs(statesDoc, PIN_KID, "pkey-config+jws"),
    trust: TRUST,
    typ: "pkey-config+jws",
    expect: { verify: "ok", kid: PIN_KID, doc: statesDoc },
  });

  // 14. `updatedAt` round-trip — clients change-detect on it.
  const updatedAtDoc = licenseDoc({
    licenseId: "lic_updated_at",
    entitlements: {
      polarisVpn: { state: "default", value: false, updatedAt: 1700654321 },
      "license.tier": {
        state: "enforced",
        value: "free",
        updatedAt: 1700123456,
      },
    },
  });
  cases.push({
    id: "valid-updated-at-roundtrip",
    description:
      "Per-entry updatedAt (epoch seconds) round-trips exactly through sign + verify — clients change-detect on it.",
    jws: await signAs(updatedAtDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: updatedAtDoc },
  });

  // 15/16. alg confusion — an asymmetric curve swap and the symmetric-MAC downgrade.
  cases.push({
    id: "wrong-alg-es256",
    description:
      "Header alg=ES256 against an Ed25519 trust set — rejected as algorithm confusion.",
    jws: `${encSeg({ alg: "ES256", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "wrong-alg-hs256",
    description:
      "Header alg=HS256 (symmetric) against an Ed25519 trust set — rejected, no key-confusion.",
    jws: `${encSeg({ alg: "HS256", typ: LIC, kid: PIN_KID })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 17/18. No usable key: an empty trust set, and a non-empty one keyed under a foreign kid.
  cases.push({
    id: "empty-trust-set",
    description:
      "A valid token verified with an empty trust set ({}) — no key can match, must be null.",
    jws: validJws,
    trust: {},
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "foreign-kid-only",
    description:
      "Valid token whose kid is absent from a non-empty (foreign-keyed) trust set — null.",
    jws: validJws,
    trust: { "fleet-key-eu-2027": pub(ALT_KID) },
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 19. Timestamps at 2^53-1 — no precision loss in JS doubles / Python ints / Swift Int64.
  const MAX_SAFE = 9007199254740991;
  const bigIntDoc = licenseDoc({
    licenseId: "lic_big_int_ts",
    issuedAt: MAX_SAFE - 2,
    expiresAt: MAX_SAFE - 1,
    graceUntil: MAX_SAFE,
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: MAX_SAFE - 1 },
    },
  });
  cases.push({
    id: "valid-large-integer-timestamps",
    description:
      "Timestamps at/near 2^53-1 (Number.MAX_SAFE_INTEGER) round-trip losslessly across JS/Python/Swift — no precision loss.",
    jws: await signAs(bigIntDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: bigIntDoc },
  });

  // 20/21. The signing input is the segments EXACTLY as transmitted — no canonicalisation.
  cases.push({
    id: "base64url-payload-padding",
    description:
      "Payload segment carries a `=` base64url padding char — alters the signing input, must be rejected.",
    jws: `${vh}.${vp}=.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "base64url-payload-trailing-data",
    description:
      "Trailing data appended to the payload segment — signing input differs, signature must fail.",
    jws: `${vh}.${vp}AAAA.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 22/23. UTF-8 stability: a NUL inside a string, and non-ASCII throughout keys AND values.
  const nulByteDoc = licenseDoc({
    licenseId: "lic_nul_byte",
    profile: {
      name: "before\u0000after",
      firstName: "Gr\u0000ace",
      email: "grace@example.com",
      activatedAt: 1690000000,
    },
  });
  cases.push({
    id: "valid-nul-byte-in-string",
    description:
      "A NUL (U+0000) byte embedded in a JSON string value round-trips byte-for-byte — UTF-8 stays stable through control chars.",
    jws: await signAs(nulByteDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: nulByteDoc },
  });
  const nonAsciiDoc = licenseDoc({
    licenseId: "lic_ünïcödé",
    profile: {
      name: "Ångström 💻 — 北京 — العربية — é",
      firstName: "Åsa",
      email: "ada@exämple.com",
      activatedAt: 1690000000,
    },
    entitlements: {
      日本語: { state: "enforced", value: true, updatedAt: 1699990000 },
      "ui.gruß": { state: "enforced", value: "größe", updatedAt: 1699990000 },
    },
  });
  cases.push({
    id: "valid-non-ascii-payload",
    description:
      "Non-ASCII throughout keys AND values. Signers MUST emit raw UTF-8, never \\uXXXX escapes — this vector pins the canonical signed bytes so a re-serialising signer that escapes is caught (R2-07).",
    jws: await signAs(nonAsciiDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: nonAsciiDoc },
  });

  // 24. Oversized protected header — the payload cap is trivially bypassed without it (R2-04).
  //     §1 keeps the header cap at 1024 even for bundles: no `typ` ever widens it.
  cases.push({
    id: "header-oversized",
    description:
      "Protected header past MAX_HEADER_BYTES (1024). Must be rejected on the ENCODED length, before any decode/parse.",
    jws: `${encSeg({ alg: "EdDSA", typ: LIC, kid: PIN_KID, junk: "J".repeat(2048) })}.${validHeaderless}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 25/26. The ORDINARY payload cap from both sides: 65 536 decoded / 87 386 encoded.
  const atCapDoc = docOfExactBytes(65536, licenseDoc({ licenseId: "lic_cap" }));
  cases.push({
    id: "payload-at-cap",
    description:
      "A payload of EXACTLY MAX_DOC_BYTES (65536) decoded bytes — at the cap is still valid and must verify.",
    jws: await signAs(atCapDoc, PIN_KID, LIC),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "ok", kid: PIN_KID, doc: atCapDoc },
  });
  cases.push({
    id: "payload-over-cap",
    description:
      "An encoded payload one character past MAX_PAYLOAD_B64 (87386) — rejected on length before it is ever decoded, so the allocation never happens.",
    jws: `${encSeg({ alg: "EdDSA", typ: LIC, kid: PIN_KID })}.${"A".repeat(87387)}.${vs}`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 27/28. Duplicate JSON members — TS/Python resolve last-wins, Swift first-wins, so any
  //        silent resolution is a differential. Both are correctly SIGNED so the only
  //        possible cause of failure is the duplicate-key rule.
  cases.push({
    id: "duplicate-key-header-alg",
    description:
      "Protected header declaring `alg` twice (none, then EdDSA). Last-wins reads EdDSA, first-wins reads none — every implementation MUST instead reject.",
    jws: await signRawSegments(
      `{"alg":"none","typ":"${LIC}","kid":"${PIN_KID}","alg":"EdDSA"}`,
      JSON.stringify(validDoc),
      PIN_KID,
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "duplicate-key-payload",
    description:
      "Payload declaring `licenseId` twice. Checked only after the signature verifies, so this pins the post-verification parse — reject, never last/first-wins.",
    jws: await signRawSegments(
      `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}"}`,
      `{"iss":"${ISSUER_V3}","aud":"${AUD_V3}","deviceId":"${DEVICE_V3}","licenseId":"lic_a","issuedAt":${V3_ISSUED},"licenseId":"lic_b"}`,
      PIN_KID,
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 29–31. Out-of-alphabet bytes in the SIGNATURE segment. Python's lenient base64 silently
  //        DISCARDED these, so they verified there and were rejected by Node and Swift.
  for (const [suffix, id, label] of [
    ["***", "sig-out-of-alphabet-stars", "`***`"],
    ["\n \t", "sig-out-of-alphabet-whitespace", "whitespace (`\\n \\t`)"],
    ["====", "sig-out-of-alphabet-padding", "explicit base64 padding (`====`)"],
  ] as const) {
    cases.push({
      id,
      description: `Signature segment carrying ${label}. Strict base64url means the \`-_\` alphabet only — no whitespace, no \`=\`, no out-of-alphabet bytes; reject rather than discard.`,
      jws: `${vh}.${vp}.${vs}${suffix}`,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }

  // 32. THE v3 CHANGE. v1's `typ-missing` accepted a typ-less header during the rollout
  //     window; §2 closes that window ("unknown or missing `typ` is rejected"). The claims
  //     are otherwise valid and the signature is genuine, so the ONLY reason this fails is
  //     the absent type — which is what makes it a regression pin rather than a truism.
  cases.push({
    id: "typ-missing-rejected",
    description:
      "A correctly-signed document with valid claims and NO `typ` in the header. Accepted by v2's tolerance window (corpus v1's `typ-missing`); REJECTED by v3 (§2), where every verifier requires a type. This is the tolerance window's closure, pinned.",
    jws: await signJws(validDoc, pem(PIN_KID), PIN_KID),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 33/34. Domain separation: the WRONG type, and a genuine artifact of another type.
  cases.push({
    id: "typ-wrong",
    description:
      "Header asserts `typ: pkey-config+jws` at a call site expecting `pkey-license+jws` — the two v3 documents share a signing key, so only the type separates them (§2).",
    jws: await signAs(validDoc, PIN_KID, "pkey-config+jws"),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  cases.push({
    id: "trust-manifest-as-license",
    description:
      "A genuine, correctly-signed TRUST MANIFEST presented where a license document is expected — cross-protocol replay, rejected by the `typ` domain separator rather than incidentally (§2).",
    jws: await signAs(
      trustManifestV3({ keys: [keyEntry(PIN_KID, pub(PIN_KID), "active")] }),
      PIN_KID,
      "pkey-trust+jws",
    ),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // 35/36. §1's ONE exception: `pkey-bundle+jws` is capped at 262 144, not 65 536, and the
  //        caller passes that cap explicitly for that typ alone. Both sides of the boundary,
  //        both CORRECTLY SIGNED — the over-cap vector's encoded length (349 527) is inside
  //        the derived encoded pre-check (349 530), so it can only be refused by the DECODED
  //        cap, which runs after the signature. A verifier that forgot the decoded check
  //        would pass the pre-check and accept it.
  const bundleCapBase = {
    bundleId: "01JBUNDLECAP00000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_GRACE,
    docs: {},
    trust: "",
  };
  cases.push({
    id: "bundle-payload-at-cap",
    description:
      "A `pkey-bundle+jws` payload of EXACTLY 262 144 decoded bytes, verified with maxPayloadBytes = 262 144 — at the cap is valid (§1). `doc` is omitted: the payload is a quarter-megabyte of padding and the boundary is the whole point.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES, bundleCapBase),
      PIN_KID,
      "pkey-bundle+jws",
    ),
    trust: TRUST,
    typ: "pkey-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "ok", kid: PIN_KID },
  });
  cases.push({
    id: "bundle-payload-over-cap",
    description:
      "The same bundle one decoded byte past the cap (262 145) with the same raised cap — rejected. The raised cap is a CAP, not a licence to be unbounded.",
    jws: await signAs(
      docOfExactBytes(MAX_BUNDLE_BYTES + 1, bundleCapBase),
      PIN_KID,
      "pkey-bundle+jws",
    ),
    trust: TRUST,
    typ: "pkey-bundle+jws",
    maxPayloadBytes: MAX_BUNDLE_BYTES,
    expect: { verify: "fail" },
  });

  // §10: annotate every U+0000 string in each pinned document (one case today). Wire contract
  // v4's 44 vectors follow the existing 36, which stay byte-identical (plans/P3-01.md §4.3).
  const v4 = await buildJwsCasesV4();
  // V4 §1's canonical base64url follows, appended so every earlier case stays byte-identical.
  const canonical = await buildJwsCasesCanonical();
  return [...cases, ...v4, ...canonical].map((c) =>
    placeNonWire({ ...c, expect: annotateNul(c.expect) }),
  );
}

// ── V4 §1: canonical base64url ─────────────────────────────────────────────────────────────
// A lenient decoder ignores the unused low bits of a segment's last character, so up to sixteen
// spellings decode to the same bytes. Each vector is a genuine JWS (or key) respelled that way;
// every one of them verifies under a decoder without the canonical rule.

async function buildJwsCasesCanonical(): Promise<JwsCaseV2[]> {
  const LIC: TypV3 = "pkey-license+jws";
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const lic = (id: string, extra: Record<string, unknown> = {}) =>
    licenseDoc({ licenseId: `lic_${id.replaceAll("-", "_")}`, ...extra });
  /** Sign over ENCODED segments exactly as given (a non-canonical one included). */
  const signEncoded = async (encHeader: string, encPayload: string) => {
    const key = await importSigningKey(pem(PIN_KID));
    const input = `${encHeader}.${encPayload}`;
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      utf8Bytes(input),
    );
    return `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
  };
  const enc = (text: string) => base64UrlEncodeBytes(utf8Bytes(text));
  const out: JwsCaseV2[] = [];

  {
    const jws = await signAs(
      lic("sig-noncanonical-trailing-bits"),
      PIN_KID,
      LIC,
    );
    const [h, p, sig] = jws.split(".") as [string, string, string];
    out.push({
      id: "sig-noncanonical-trailing-bits",
      description:
        "V4 §1 canonical base64url: a genuine licence document whose 86-character signature has one of its last character's four unused bits set. A lenient decoder reads the same 64 bytes and the signature verifies; the canonical rule refuses the segment.",
      jws: `${h}.${p}.${noncanonical(sig)}`,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  out.push({
    id: "pubkey-noncanonical-trailing-bits",
    description:
      "V4 §1: a genuine document, verified against a trust set whose key for its `kid` is the right 32 bytes spelled non-canonically (an unused bit of the 43rd character set). Every trust-set key must be canonical; the key is refused, so the document does not verify.",
    jws: await signAs(lic("pubkey-noncanonical-trailing-bits"), PIN_KID, LIC),
    trust: { [PIN_KID]: noncanonical(pub(PIN_KID)) },
    typ: LIC,
    expect: { verify: "fail" },
  });
  {
    const header = enc(headerText(LIC, PIN_KID));
    if (header.length % 4 === 0)
      throw new Error("header-noncanonical-trailing-bits: no unused bits");
    out.push({
      id: "header-noncanonical-trailing-bits",
      description:
        "V4 §1: the protected header's last character has an unused bit set, and the signature is computed over that exact spelling, so it verifies as written. The canonical rule refuses the header segment before the signature is checked.",
      jws: await signEncoded(
        noncanonical(header),
        enc(JSON.stringify(lic("header-noncanonical-trailing-bits"))),
      ),
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  {
    // Tune the payload so its encoding has unused bits (a JSON length not divisible by 3).
    let doc = lic("payload-noncanonical-trailing-bits");
    while (utf8Bytes(JSON.stringify(doc)).length % 3 === 0)
      doc = { ...doc, x: `${(doc.x as string | undefined) ?? ""}x` };
    out.push({
      id: "payload-noncanonical-trailing-bits",
      description:
        "V4 §1: the payload segment's last character has an unused bit set, and the signature covers that exact spelling. A lenient decoder reads the same document; the canonical rule refuses the payload segment.",
      jws: await signEncoded(
        enc(headerText(LIC, PIN_KID)),
        noncanonical(enc(JSON.stringify(doc))),
      ),
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  out.push({
    id: "segment-trailing-newline",
    description:
      "V4 §1: a genuine JWS with a newline after the signature. A newline is outside the alphabet; a validator whose pattern's `$` matches before a final newline accepted it.",
    jws: `${await signAs(lic("segment-trailing-newline"), PIN_KID, LIC)}\n`,
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });

  // Recompute every verdict with the reference verifier, and prove each respelling is one a
  // lenient decoder accepts: undoing it gives a JWS (or key) the reference verifies.
  for (const c of out) {
    if (refVerifyJws(c.jws, c.trust, c.typ, c.maxPayloadBytes) !== null)
      throw new Error(`jwsCases canonical: the reference accepts ${c.id}`);
  }
  return out;
}

// ── §4.3 the new `jwsCases` ──────────────────────────────────────────────────────────────────

interface JwsCaseV4Extra {
  /** V4 §4.1: the payload's non-wire-integer pointers, beside `expect`. */
  nonWireIntegers?: string[];
}

/** The 44 vectors appended after `bundle-payload-over-cap`, in §4.3's order. */
async function buildJwsCasesV4(): Promise<(JwsCaseV2 & JwsCaseV4Extra)[]> {
  checkEd25519Tables();
  const LIC: TypV3 = "pkey-license+jws";
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const out: (JwsCaseV2 & JwsCaseV4Extra)[] = [];
  const add = (c: JwsCaseV2 & JwsCaseV4Extra): void => {
    out.push(c);
  };
  const lic = (
    id: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> =>
    licenseDoc({ licenseId: `lic_${id.replaceAll("-", "_")}`, ...extra });
  const pinA = base64UrlDecode(pub(PIN_KID));
  const pinScalar = secretScalar(PIN_KID) % ED_L;

  // §1.1 check 1: S + L.
  {
    const jws = await signAs(lic("sig-s-plus-l"), PIN_KID, LIC);
    const [h, p, s] = jws.split(".") as [string, string, string];
    const sig = base64UrlDecode(s);
    const sBig = leToBig(sig.subarray(32));
    const sPrime = sBig + ED_L;
    if (sPrime < ED_L || sPrime % ED_L !== sBig % ED_L || sPrime >= 2n ** 256n)
      throw new Error("sig-s-plus-l: S' must be ≥ L and ≡ S (mod L)");
    const out64 = new Uint8Array(sig);
    out64.set(bigToLe(sPrime, 32), 32);
    add({
      id: "sig-s-plus-l",
      description:
        "V4 §1.1 check 1: a genuine signature with S replaced by S + L. The equation still holds mod L, so only `S < L` refuses it (every backend measured already does).",
      jws: `${h}.${p}.${base64UrlEncodeBytes(out64)}`,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  // R vectors under the pinned key, with S = k·a so the equation holds over each R encoding.
  for (const [id, rEnc, what] of [
    [
      "sig-r-identity",
      IDENTITY_ENC,
      "R is the canonical identity and S = k·a: RFC 8032-valid, accepted by all four backends, refused by check 3 (a small-order R)",
    ],
    [
      "sig-r-non-canonical",
      IDENTITY_Y_P_PLUS_1,
      "R is the identity encoded with y = p + 1, a non-canonical encoding (check 2)",
    ],
    [
      "sig-r-negative-zero",
      NEGATIVE_ZERO_ENC,
      "R is `01 00…00 80`, x = 0 with the sign bit set (check 2)",
    ],
  ] as const) {
    const { jws } = handSign({
      kid: PIN_KID,
      payload: JSON.stringify(lic(id)),
      aEnc: pinA,
      a: pinScalar,
      label: id,
      rEnc,
    });
    add({
      id,
      description: `V4 §1.1: ${what}.`,
      jws,
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  }
  // A vectors: each brings its own one-key trust.
  const keyVector = async (
    id: string,
    kid: string,
    aEnc: Uint8Array,
    a: bigint,
    kMod8: "zero" | "nonzero" | undefined,
    verdict: "ok" | "fail",
    what: string,
  ): Promise<void> => {
    const doc = lic(id);
    const { jws, k } = handSign({
      kid,
      payload: JSON.stringify(doc),
      aEnc,
      a,
      label: id,
      kMod8,
    });
    if (kMod8 === "zero" && k % 8n !== 0n) throw new Error(`${id}: k mod 8`);
    if (kMod8 === "nonzero" && k % 8n === 0n) throw new Error(`${id}: k mod 8`);
    add({
      id,
      description: `V4 §1.1: ${what}.`,
      jws,
      trust: { [kid]: base64UrlEncodeBytes(aEnc) },
      typ: LIC,
      expect:
        verdict === "ok" ? { verify: "ok", kid, doc } : { verify: "fail" },
    });
  };
  await keyVector(
    "pubkey-small-order-identity",
    "corpus-small-order-identity",
    IDENTITY_ENC,
    0n,
    undefined,
    "fail",
    "A is the identity, R = [r]B and S = r, so [S]B = R + [k]A for every k: refused by check 3",
  );
  await keyVector(
    "pubkey-small-order-order8",
    "corpus-small-order-order8",
    ORDER8_ENC,
    0n,
    "zero",
    "fail",
    "A is an order-8 point and the nonce is ground until k ≡ 0 (mod 8), so [k]A is the identity and S = r verifies cofactorlessly: refused by check 3",
  );
  await keyVector(
    "pubkey-non-canonical",
    "corpus-non-canonical",
    IDENTITY_Y_P_PLUS_1,
    0n,
    undefined,
    "fail",
    "A is the identity encoded with y = p + 1 (check 2). OpenSSL decodes it and accepts; CryptoKit and Godot refuse",
  );
  await keyVector(
    "pubkey-negative-zero",
    "corpus-negative-zero",
    NEGATIVE_ZERO_ENC,
    0n,
    undefined,
    "fail",
    "A is `01 00…00 80` (check 2)",
  );
  {
    const a0 = nonce("mixed-order-key", 0);
    const mixed = EdPoint.BASE.multiply(a0).add(
      EdPoint.fromHex(SMALL_ORDER_REF[6]!),
    );
    if (mixed.isSmallOrder() || mixed.isTorsionFree())
      throw new Error("mixed-order key");
    const aEnc = mixed.toBytes();
    await keyVector(
      "pubkey-mixed-order-cofactored-only",
      "corpus-mixed-order",
      aEnc,
      a0,
      "nonzero",
      "fail",
      "A = A₀ + T₈ with k ≢ 0 (mod 8): only a cofactored equation accepts, and the equation is cofactorless (check 4)",
    );
    await keyVector(
      "valid-pubkey-mixed-order",
      "corpus-mixed-order",
      aEnc,
      a0,
      "zero",
      "ok",
      "A = A₀ + T₈ with k ≡ 0 (mod 8): the cofactorless equation holds, and no prime-subgroup check is made, so it verifies (check 4)",
    );
  }

  // §1.2 vectors on text.
  const header = headerText(LIC, PIN_KID);
  const baseText = JSON.stringify(lic("json"));
  /** The licence payload with `"x":<raw>` spliced in before the closing brace. */
  const withX = (rawValue: string): string =>
    `${baseText.slice(0, -1)},"x":${rawValue}}`;
  const textCase = async (
    id: string,
    payload: string,
    verdict: "ok" | "fail",
    what: string,
    o: { hdr?: string; doc?: unknown } = {},
  ): Promise<void> => {
    const jws = await signRawSegments(o.hdr ?? header, payload, PIN_KID);
    const nonWire = verdict === "ok" ? refNonWire(payload) : [];
    add({
      id,
      description: what,
      jws,
      trust: TRUST,
      typ: LIC,
      ...(nonWire.length > 0 ? { nonWireIntegers: nonWire } : {}),
      expect:
        verdict === "ok"
          ? o.doc !== undefined
            ? { verify: "ok", kid: PIN_KID, doc: o.doc }
            : { verify: "ok", kid: PIN_KID }
          : { verify: "fail" },
    });
  };
  await textCase(
    "json-lone-high-surrogate",
    withX('"\\ud800"'),
    "fail",
    "V4 §1.2 rule 5: a lone high-surrogate escape in a value. JavaScript and Python decode it to an unpaired code unit; Godot refuses it.",
  );
  await textCase(
    "json-lone-low-surrogate",
    withX('"\\udc00"'),
    "fail",
    "Rule 5: a lone low-surrogate escape in a value.",
  );
  await textCase(
    "json-reversed-surrogate-pair",
    withX('"\\udc00\\ud800"'),
    "fail",
    "Rule 5: a low surrogate followed by a high one is two lone surrogates, not a pair.",
  );
  await textCase(
    "json-lone-surrogate-in-key",
    `${baseText.slice(0, -1)},"\\ud800":1}`,
    "fail",
    "Rule 5: a lone surrogate in a member name.",
  );
  {
    const doc = { ...lic("json"), x: "\u{1F4BB}" };
    await textCase(
      "valid-surrogate-pair-escape",
      withX('"\\ud83d\\udcbb"'),
      "ok",
      "Rule 5 must not over-reject: the escaped pair `\\ud83d\\udcbb` decodes to U+1F4BB.",
      { doc },
    );
  }
  await textCase(
    "json-raw-control-char-payload",
    withX('"a\u0001b"'),
    "fail",
    "Rule 4: a raw U+0001 inside a payload string (RFC 8259 already forbids it; Swift's JSONDecoder accepted it).",
  );
  await textCase(
    "json-raw-control-char-header",
    baseText,
    "fail",
    "Rule 4 in the HEADER: a raw U+001F in an extra header member, parsed before the signature (Swift's lazy decoding never looked at it).",
    {
      hdr: `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}","x":"a\u001fb"}`,
    },
  );
  await textCase(
    "json-raw-nul-byte",
    withX('"a\u0000b"'),
    "fail",
    "Rule 4: a raw 0x00 byte inside a payload string.",
  );
  await textCase(
    "json-nul-escape-in-key",
    `${baseText.slice(0, -1)},"a\\u0000b":1}`,
    "fail",
    "Rule 7: U+0000 in a member name, closing V3 §10's open entry. Godot cannot represent it.",
  );
  // Byte vectors.
  const bytesCase = async (
    id: string,
    hdr: Uint8Array,
    payload: Uint8Array,
    what: string,
  ): Promise<void> => {
    add({
      id,
      description: what,
      jws: await signRawBytes(hdr, payload, PIN_KID),
      trust: TRUST,
      typ: LIC,
      expect: { verify: "fail" },
    });
  };
  const H = utf8Bytes(header);
  const P = utf8Bytes(baseText);
  const withBytes = (b: number[]): Uint8Array =>
    Uint8Array.from([
      ...utf8Bytes(baseText.slice(0, -1) + ',"x":"'),
      ...b,
      ...utf8Bytes('"}'),
    ]);
  const BOM = [0xef, 0xbb, 0xbf];
  await bytesCase(
    "json-invalid-utf8",
    H,
    withBytes([0xff]),
    "Rule 1: byte 0xFF inside a string, never valid UTF-8.",
  );
  await bytesCase(
    "json-utf8-encoded-surrogate",
    H,
    withBytes([0xed, 0xa0, 0x80]),
    "Rule 1: ED A0 80, a UTF-8-encoded surrogate (CESU-8).",
  );
  await bytesCase(
    "json-overlong-utf8",
    H,
    withBytes([0xc0, 0xaf]),
    "Rule 1: C0 AF, an overlong encoding of `/`.",
  );
  await bytesCase(
    "json-leading-bom-payload",
    H,
    Uint8Array.from([...BOM, ...P]),
    "Rule 2: a byte order mark before the payload.",
  );
  await bytesCase(
    "json-leading-bom-header",
    Uint8Array.from([...BOM, ...H]),
    P,
    "Rule 2: a byte order mark before the header.",
  );
  await bytesCase(
    "json-two-leading-boms-payload",
    H,
    Uint8Array.from([...BOM, ...BOM, ...P]),
    "Rule 2: two byte order marks before the payload; Godot stripped both.",
  );
  await bytesCase(
    "json-two-leading-boms-header",
    Uint8Array.from([...BOM, ...BOM, ...H]),
    P,
    "Rule 2: two byte order marks before the header.",
  );
  await textCase(
    "json-nan-literal",
    withX("NaN"),
    "fail",
    "Rule 3: a bare `NaN`, which Python's json.loads accepts without parse_constant.",
  );
  await textCase(
    "json-infinity-literal",
    withX("Infinity"),
    "fail",
    "Rule 3: a bare `Infinity`.",
  );
  await textCase(
    "json-negative-infinity-literal",
    withX("-Infinity"),
    "fail",
    "Rule 3: a bare `-Infinity`.",
  );
  await textCase(
    "json-trailing-comma-payload",
    `${baseText.slice(0, -1)},}`,
    "fail",
    "Rule 3: a comma before the payload's closing brace.",
  );
  await textCase(
    "json-trailing-comma-header",
    baseText,
    "fail",
    "Rule 3 in the header, parsed before the signature.",
    {
      hdr: `{"alg":"EdDSA","typ":"${LIC}","kid":"${PIN_KID}",}`,
    },
  );
  await textCase(
    "json-number-overflow",
    withX("1e400"),
    "fail",
    "Rule 8: `1e400` in an unused member — out of range (Node and Python read infinity, Swift throws).",
  );
  await textCase(
    "json-number-underflow",
    withX("1e-400"),
    "fail",
    "Rule 8: `1e-400`, which rounds to zero.",
  );
  await textCase(
    "json-number-subnormal",
    withX("5e-324"),
    "fail",
    "Rule 8: `5e-324`, a subnormal that Godot reads as 0.",
  );
  await textCase(
    "json-number-exponent-wrap",
    withX("1e4294967297"),
    "fail",
    "Rule 8: an exponent of ten significant digits, more than six, is out of range outright; Godot read it as 10.",
  );
  await textCase(
    "valid-number-integral-spellings",
    withX("[7.0,7e0,0.0,-0.0,7.0000000000000001,1700000000.00000001]"),
    "ok",
    "Rule 8 keeps these: they are values in an unused member. Only an integer claim refuses such spellings (V4 §3). No `doc`: Python reads them as floats.",
  );
  await textCase(
    "valid-number-forms",
    withX("[7,-0,7.5,1e-7,1e+21,1e-307,9.99e307,0e5]"),
    "ok",
    "Every number form rule 8 keeps. No `doc`: Godot's last bits differ.",
  );
  const nest = (levels: number): string =>
    `${"[".repeat(levels)}${"]".repeat(levels)}`;
  await textCase(
    "valid-depth-64",
    withX(nest(63)),
    "ok",
    "Rule 9: 64 levels, counting the top-level object as level 1. No `doc`.",
  );
  await textCase(
    "json-depth-65",
    withX(nest(64)),
    "fail",
    "Rule 9: 65 levels.",
  );
  await textCase(
    "valid-canonically-equivalent-member-names",
    withX('{"\\u00e9":1,"e\\u0301":2}'),
    "ok",
    "Rule 6: sibling names U+00E9 and U+0065 U+0301 are two names, compared by scalar value. Swift's String equality refused them. No `doc`: Swift's JSONValue keeps the first (a V4 §10 representation limit).",
  );
  {
    const doc = { ...lic("json"), x: { "a\\u0000": 1 } };
    await textCase(
      "valid-escaped-backslash-before-u0000-in-key",
      withX('{"a\\\\u0000":1}'),
      "ok",
      "Rule 7 must not fire: the member name is `a`, a backslash and `u0000`, not U+0000.",
      { doc },
    );
  }
  {
    const doc = { ...lic("json"), x: { "\uffff": "\uffff" } };
    await textCase(
      "valid-noncharacter-escape",
      withX('{"\\uffff":"\\uffff"}'),
      "ok",
      "`\\uffff` as a value and as a member name: noncharacters are ordinary characters, and no verifier applies RFC 7493 §2.1's ban.",
      { doc },
    );
  }
  // §2: the two new typs at the wrong call site.
  add({
    id: "typ-feed-as-license",
    description:
      "A genuine channel feed (`pkey-feed+jws`) presented at a licence call site: the shared product key signs both, so only the `typ` separates them (V4 §2).",
    jws: await signAs(feedPayload(), PIN_KID, "pkey-feed+jws"),
    trust: TRUST,
    typ: LIC,
    expect: { verify: "fail" },
  });
  add({
    id: "typ-license-as-feed",
    description:
      "A genuine licence document presented at a feed call site (`typ: pkey-feed+jws`).",
    jws: await signAs(lic("typ-license-as-feed"), PIN_KID, LIC),
    trust: TRUST,
    typ: "pkey-feed+jws",
    expect: { verify: "fail" },
  });

  if (out.length !== 44) throw new Error(`jwsCases v4: ${out.length} != 44`);
  // Recompute every verdict with the reference verifier.
  for (const c of out) {
    const v = refVerifyJws(c.jws, c.trust, c.typ, c.maxPayloadBytes);
    if ((v !== null) !== (c.expect.verify === "ok"))
      throw new Error(`jwsCases v4: the reference disagrees on ${c.id}`);
    if (
      v !== null &&
      c.expect.doc !== undefined &&
      !canonicalEqual(JSON.parse(v.text) as Json, c.expect.doc as Json)
    )
      throw new Error(`jwsCases v4: ${c.id}'s doc is not its payload`);
  }
  return out;
}
