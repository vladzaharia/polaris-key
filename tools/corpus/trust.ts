// `cases.json#/trustCases`: the trust-set vectors (§1) and the v4 trust claim cases.

import {
  ALT_KID,
  FOREIGN_PUB,
  keyEntry,
  PIN_KID,
  PINNED_V3,
  pub,
  raw,
  rawJson,
  signAs,
  signText,
  SKEW,
  trustManifestV3,
  V3_ISSUED,
} from "./common.js";
import {
  BIG_OVER,
  placeNonWire,
  withNonWire,
  type WithNonWire,
} from "./nonwire.js";

// ── §1 trust-set vectors ─────────────────────────────────────────────────────
// v1's eleven, carried verbatim in meaning: only `iss` (§8) and `typ` (§2) moved. The merge,
// prune, revocation, substitution and freshness-profile rules are unchanged in v3.

interface TrustCaseV2 {
  id: string;
  description: string;
  pinned: Record<string, string>;
  before: Record<string, string>;
  manifestJws: string;
  now: number;
  checkFreshness?: boolean;
  expect: {
    accepted: boolean;
    trust: Record<string, string>;
    issuedAt?: number;
  };
}

export async function buildTrustCasesV2(): Promise<TrustCaseV2[]> {
  const pinned = PINNED_V3;
  const now = V3_ISSUED + 100;
  const manifest = (
    keys: Record<string, unknown>[],
    signWith = PIN_KID,
  ): Promise<string> =>
    signAs(trustManifestV3({ keys }), signWith, "pkey-trust+jws");

  return [
    {
      id: "trust-learn-rotated-key",
      description:
        "The control: a manifest signed by the pinned key publishes a second key, which joins the trust set alongside the pin.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "key-status-revoked",
      description:
        'A key published with `status:"revoked"` — the positive revocation signal the server emits for 2× cacheSeconds — MUST NOT enter the trust set (§1).',
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "revoked"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "key-status-retired-and-staged-are-trusted",
      description:
        "`retired` and `staged` DO verify, deliberately: in-flight documents signed before a rotation must still validate, and a key must be trusted before it signs or rotation can never land (§1).",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "retired"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-prune-on-absence",
      description:
        "A key present in `before` but ABSENT from the new manifest is DROPPED: the discovered set is REPLACED wholesale, never merged, so revocation by omission works on a provisioned client (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-pinned-substitution",
      description:
        "A correctly-signed manifest presenting a PINNED kid with DIFFERENT key bytes. A substitution attempt, not an update: the WHOLE manifest is rejected and the previous trust set kept — not merged with the substitution quietly dropped (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, FOREIGN_PUB, "active")]),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-pinned-kid-same-bytes",
      description:
        "Re-publishing a pinned kid with the SAME bytes is an ordinary manifest, not a substitution — it must be accepted.",
      pinned,
      before: {},
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-prune-to-pins-only",
      description:
        "A manifest that revokes everything leaves exactly the pins. Pinned keys are NEVER pruned — pinning is the host application's escape hatch for a total control-plane compromise (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(ALT_KID, pub(ALT_KID), "revoked")]),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-expired-manifest",
      description:
        "A manifest evaluated past `expiresAt + CLOCK_SKEW` is refused on the network path, and the previous trust set is kept.",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest([keyEntry(PIN_KID, pub(PIN_KID), "active")]),
      now: V3_ISSUED + 300 + SKEW + 1,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    {
      id: "trust-expired-manifest-reload-path",
      description:
        "The SAME long-expired manifest on the CACHE-RELOAD path (and the bundle-import path, §7.3). A manifest's `expiresAt` is `issuedAt + cacheSeconds` — minutes — so re-checking freshness on load would drop every rotated key on every restart and strand the client offline. Its `issuedAt` still raises the §4.2 clock floor.",
      pinned,
      before: {},
      manifestJws: await manifest([
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      now: V3_ISSUED + 300 + SKEW + 1,
      checkFreshness: false,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-aud-mismatch",
      description:
        "A manifest scoped to another product is refused — the same cross-tenant binding documents get.",
      pinned,
      before: {},
      manifestJws: await signAs(
        trustManifestV3({
          aud: "other-product",
          keys: [keyEntry(ALT_KID, pub(ALT_KID), "active")],
        }),
        PIN_KID,
        "pkey-trust+jws",
      ),
      now,
      expect: { accepted: false, trust: { [PIN_KID]: pub(PIN_KID) } },
    },
    {
      id: "trust-signed-by-non-pinned-key",
      description:
        "A manifest signed by a DISCOVERED key rather than a pinned one. Manifests verify against the PINNED set only — on the network path AND the reload path — so a rotated (or planted) key can never sign the manifest that mints the next key (§1).",
      pinned,
      before: { [ALT_KID]: pub(ALT_KID) },
      manifestJws: await manifest(
        [keyEntry("minted-by-rotated-key", FOREIGN_PUB, "active")],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: false,
        trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      },
    },
    // Wire contract v4 §3: the trust-manifest claim cases, after the family's last case.
    ...(await buildTrustCasesV4()).map(placeNonWire),
  ];
}

async function buildTrustCasesV4(): Promise<WithNonWire<TrustCaseV2>[]> {
  const pinned = PINNED_V3;
  const now = V3_ISSUED + 100;
  const keys = [
    keyEntry(PIN_KID, pub(PIN_KID), "active"),
    keyEntry(ALT_KID, pub(ALT_KID), "staged"),
  ];
  const refused = { accepted: false, trust: { [PIN_KID]: pub(PIN_KID) } };
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    o: {
      now?: number;
      checkFreshness?: boolean;
      expect?: TrustCaseV2["expect"];
      drop?: string[];
    } = {},
  ): Promise<WithNonWire<TrustCaseV2>> => {
    const doc: Record<string, unknown> = {
      ...trustManifestV3({ keys }),
      ...over,
    };
    for (const k of o.drop ?? []) delete doc[k];
    const jws = await signText(rawJson(doc), PIN_KID, "pkey-trust+jws");
    const c: TrustCaseV2 = {
      id,
      description,
      pinned,
      before: {},
      manifestJws: jws,
      now: o.now ?? now,
      ...(o.checkFreshness === undefined
        ? {}
        : { checkFreshness: o.checkFreshness }),
      expect: o.expect ?? refused,
    };
    return withNonWire(c, jws);
  };
  return [
    await mk(
      "trust-schema-version-near-integer",
      "V4 §3: the `schemaVersion` token `1.0000000000000001`, which every v3 SDK read as 1.",
      { schemaVersion: raw("1.0000000000000001") },
    ),
    await mk(
      "trust-schema-version-boolean",
      "V4 §3: `schemaVersion: true` — Python's `True in frozenset({1})` held.",
      { schemaVersion: true },
    ),
    await mk(
      "trust-issued-at-near-integer",
      "V4 §3: the `issuedAt` token `1700000000.00000001`.",
      { issuedAt: raw("1700000000.00000001") },
    ),
    await mk(
      "trust-expires-at-near-integer",
      "V4 §3: the `expiresAt` token `1700000300.00000001`.",
      { expiresAt: raw("1700000300.00000001") },
    ),
    await mk(
      "trust-issued-at-over-max",
      "V4 §3: only `issuedAt` (9007199254740993) is above 2^53 − 1 at this `now`.",
      { issuedAt: raw(BIG_OVER), expiresAt: 9007199254740950 },
      { now: 9007199254740900 },
    ),
    await mk(
      "trust-expires-at-over-max",
      "V4 §3: `expiresAt` 9007199254740993.",
      { expiresAt: raw(BIG_OVER) },
    ),
    await mk(
      "trust-member-shapes-ignored",
      "V4 §3 'Members outside the claims': no `jwksUrl` and no `cacheSeconds`, a key with no `status`, and a key whose `alg` is `1` (skipped). Swift's synthesized decoders refused the manifest.",
      {
        keys: [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          {
            kid: ALT_KID,
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: pub(ALT_KID),
          },
          {
            kid: "future-2026",
            alg: 1,
            kty: "OKP",
            crv: "Ed25519",
            publicKey: FOREIGN_PUB,
            status: "active",
          },
        ],
      },
      {
        drop: ["jwksUrl", "cacheSeconds"],
        expect: {
          accepted: true,
          trust: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
          issuedAt: V3_ISSUED,
        },
      },
    ),
    await mk(
      "trust-issued-at-negative",
      "V4 §3 minimums: `issuedAt` −1 with the control's `expiresAt`.",
      { issuedAt: -1, expiresAt: V3_ISSUED + 300 },
    ),
    await mk(
      "trust-expires-at-negative-reload-path",
      "V4 §3 minimums: `expiresAt` −1, on the reload path, where freshness does not refuse it first.",
      { expiresAt: -1 },
      { checkFreshness: false },
    ),
  ];
}
