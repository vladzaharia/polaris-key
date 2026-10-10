// `cases.json#/trustCases`: the trust-set vectors (§1), the v4 trust claim cases, and V4 §1's
// key custody: the status allow-list, canonical published keys and pinned-key tombstones with
// their signed evidence (`pinRevocations`).

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
import { refTrustOutcome } from "./reference/trust.js";

// ── §1 trust-set vectors ─────────────────────────────────────────────────────
// v1's eleven, carried verbatim in meaning: only `iss` (§8) and `typ` (§2) moved. The merge,
// prune, revocation, substitution and freshness-profile rules are unchanged in v3.

interface TrustCaseV2 {
  id: string;
  description: string;
  pinned: Record<string, string>;
  /** The discovered set held before this manifest (kept when it is refused). */
  before: Record<string, string>;
  /** V4 §4.1: the `pinRevocations` slice held before this manifest — kid → the revoking
   *  manifest, verbatim. Absent means none. A runner re-derives the tombstones from it (in
   *  ascending manifest `issuedAt`) before it verifies `manifestJws`. */
  pinRevocations?: Record<string, string>;
  manifestJws: string;
  now: number;
  checkFreshness?: boolean;
  expect: {
    accepted: boolean;
    /** The effective set after: the usable pins over the discovered keys. */
    trust: Record<string, string>;
    issuedAt?: number;
    /** V4 §1: every tombstoned pin after this case, the evidence's and this manifest's,
     *  ascending byte order. Absent means none. */
    revokedPins?: string[];
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

  const all: TrustCaseV2[] = [
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
    // V4 §1: key custody, appended after the claim cases.
    ...(await buildTrustCustodyCases()),
  ];
  checkTrustCases(all);
  return all;
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
      "V4 §3 'Members outside the claims': no `jwksUrl` and no `cacheSeconds`, a key with no `status`, and a key whose `alg` is `1`. The manifest is accepted (Swift's synthesized decoders refused it); both odd keys are skipped, the status-less one by V4 §1's status allow-list (it used to be trusted).",
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
          trust: { [PIN_KID]: pub(PIN_KID) },
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

// ── V4 §1: key custody ───────────────────────────────────────────────────────────────────────
// Two pins (`PIN_KID` and `ALT_KID`) wherever a pin is revoked. Each case's expectation is
// recomputed by the reference (`reference/trust.ts`), and every one but the substitution
// control is refused, or answered differently, by a verifier without the rule it pins.

/** The non-canonical spelling of a canonical base64url string: the lowest unused bit of the
 *  last character set. A lenient decoder reads the same bytes. */
export function noncanonical(s: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  if (s.length % 4 === 0) throw new Error("noncanonical: no unused bits");
  const last = alphabet.indexOf(s[s.length - 1]!);
  if ((last & 1) !== 0) throw new Error("noncanonical: input not canonical");
  return s.slice(0, -1) + alphabet[last | 1]!;
}

async function buildTrustCustodyCases(): Promise<TrustCaseV2[]> {
  const now = V3_ISSUED + 100;
  const PINS2 = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const manifest = (
    keys: Record<string, unknown>[],
    signWith: string,
    issuedAt = V3_ISSUED,
  ): Promise<string> =>
    signAs(trustManifestV3({ keys, issuedAt }), signWith, "pkey-trust+jws");
  // Evidence: ALT_KID's manifest listing PIN_KID revoked, and the reverse, older and newer.
  const altRevokesPin = await manifest(
    [
      keyEntry(PIN_KID, pub(PIN_KID), "revoked"),
      keyEntry(ALT_KID, pub(ALT_KID), "active"),
    ],
    ALT_KID,
    V3_ISSUED - 1000,
  );
  const pinRevokesAlt = await manifest(
    [
      keyEntry(PIN_KID, pub(PIN_KID), "active"),
      keyEntry(ALT_KID, pub(ALT_KID), "revoked"),
    ],
    PIN_KID,
    V3_ISSUED - 500,
  );

  const cases: TrustCaseV2[] = [
    {
      id: "key-status-unknown-skipped",
      description:
        'V4 §1 status allow-list: only `active`, `staged` and `retired` keep a key. `suspended`, the number 1 and `null` are skipped, never fatal; the manifest is accepted with the pin alone. A verifier that dropped only `"revoked"` trusted all three.',
      pinned: PINNED_V3,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, pub(ALT_KID), "suspended"),
          { ...keyEntry("k-status-number", FOREIGN_PUB, "x"), status: 1 },
          { ...keyEntry("k-status-null", FOREIGN_PUB, "x"), status: null },
        ],
        PIN_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "key-status-case-variant-skipped",
      description:
        "V4 §1: statuses are exact, case-sensitive strings. `Staged` and `REVOKED` are unknown statuses, so both keys are skipped (a `REVOKED` key does not revoke, and is not trusted either).",
      pinned: PINNED_V3,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, pub(ALT_KID), "Staged"),
          keyEntry("k-status-upper", FOREIGN_PUB, "REVOKED"),
        ],
        PIN_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "trust-pubkey-noncanonical-skipped",
      description:
        "V4 §1 canonical base64url: a published (unpinned) key whose last character has an unused bit set. A lenient decoder reads the same 32 bytes; the entry is skipped, not fatal, and the manifest is accepted.",
      pinned: PINNED_V3,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, noncanonical(pub(ALT_KID)), "staged"),
        ],
        PIN_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [PIN_KID]: pub(PIN_KID) },
        issuedAt: V3_ISSUED,
      },
    },
    {
      id: "pin-revoked-by-other-pin",
      description:
        "V4 §1 tombstone rule 1: a manifest signed by the usable pin ALT lists the other pin with its exact pinned bytes as `revoked`. The pin is tombstoned: it leaves the effective set, and this manifest is its evidence (`pinRevocations`). A verifier with terminal pins kept it.",
      pinned: PINS2,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "revoked"),
          keyEntry(ALT_KID, pub(ALT_KID), "active"),
        ],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
        revokedPins: [PIN_KID],
      },
    },
    {
      id: "pin-self-revocation-refused",
      description:
        "V4 §1 tombstone rule 2: a manifest that lists its own signer as `revoked` is refused in full, and the previous trust is kept. A key cannot revoke itself, so the usable pins are never empty.",
      pinned: PINS2,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "revoked"),
          keyEntry(ALT_KID, pub(ALT_KID), "active"),
        ],
        PIN_KID,
      ),
      now,
      expect: { accepted: false, trust: PINS2 },
    },
    {
      id: "pin-revocation-sticky",
      description:
        "V4 §1 tombstone rule 3: the pin was tombstoned earlier (the evidence in `pinRevocations`), and a newer manifest from the other pin lists it as `active` with its exact bytes. A tombstone is permanent: the kid stays out of every set.",
      pinned: PINS2,
      before: { [ALT_KID]: pub(ALT_KID) },
      pinRevocations: { [PIN_KID]: altRevokesPin },
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, pub(ALT_KID), "active"),
        ],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
        revokedPins: [PIN_KID],
      },
    },
    {
      id: "pin-revocation-evidence-order",
      description:
        "V4 §4.1: the evidence is re-verified in ascending manifest `issuedAt`, each entry against the pins minus the tombstones before it. ALT revoked PIN first (issuedAt − 1000), so PIN's later revocation of ALT (− 500) has a tombstoned signer and is dropped. The map lists ALT's entry first, so a verifier that walks it in member or kid order tombstones ALT instead and refuses this manifest.",
      pinned: PINS2,
      before: { [ALT_KID]: pub(ALT_KID) },
      pinRevocations: {
        [ALT_KID]: pinRevokesAlt,
        [PIN_KID]: altRevokesPin,
      },
      manifestJws: await manifest(
        [keyEntry(ALT_KID, pub(ALT_KID), "active")],
        ALT_KID,
      ),
      now,
      expect: {
        accepted: true,
        trust: { [ALT_KID]: pub(ALT_KID) },
        issuedAt: V3_ISSUED,
        revokedPins: [PIN_KID],
      },
    },
    {
      id: "pin-revocation-evidence-mismatch-dropped",
      description:
        "V4 §4.1: an evidence entry counts only when its manifest verifies and revokes the kid it is filed under. Filed under PIN, this one (signed by ALT) does not list PIN at all, so it is dropped and PIN signs the new manifest as usual.",
      pinned: PINS2,
      before: {},
      pinRevocations: {
        [PIN_KID]: await manifest(
          [keyEntry(ALT_KID, pub(ALT_KID), "active")],
          ALT_KID,
          V3_ISSUED - 1000,
        ),
      },
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, pub(ALT_KID), "staged"),
        ],
        PIN_KID,
      ),
      now,
      expect: { accepted: true, trust: PINS2, issuedAt: V3_ISSUED },
    },
    {
      id: "manifest-signed-by-tombstoned-pin-refused",
      description:
        "V4 §1 tombstone rule 3: a tombstoned pin leaves the usable pins for every purpose. A well-formed manifest it signed is refused, and the previous trust (the other pin) is kept.",
      pinned: PINS2,
      before: { [ALT_KID]: pub(ALT_KID) },
      pinRevocations: { [PIN_KID]: altRevokesPin },
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, pub(PIN_KID), "active"),
          keyEntry(ALT_KID, pub(ALT_KID), "staged"),
        ],
        PIN_KID,
      ),
      now,
      expect: {
        accepted: false,
        trust: { [ALT_KID]: pub(ALT_KID) },
        revokedPins: [PIN_KID],
      },
    },
    {
      id: "pin-revoked-with-other-bytes-is-substitution",
      description:
        "V4 §1 tombstone rule 5: listing a pinned kid with other bytes stays a substitution, even with `status: revoked`. The whole manifest is refused (the control: this verdict predates tombstones).",
      pinned: PINS2,
      before: {},
      manifestJws: await manifest(
        [
          keyEntry(PIN_KID, FOREIGN_PUB, "revoked"),
          keyEntry(ALT_KID, pub(ALT_KID), "active"),
        ],
        ALT_KID,
      ),
      now,
      expect: { accepted: false, trust: PINS2 },
    },
  ];
  return cases;
}

/** Recompute every trust case's outcome with the reference (V4 §1, §4.1). */
export function checkTrustCases(cases: TrustCaseV2[]): void {
  for (const c of cases) {
    const want = refTrustOutcome(c);
    const got = {
      accepted: c.expect.accepted,
      trust: c.expect.trust,
      revokedPins: c.expect.revokedPins ?? [],
    };
    const norm = (t: Record<string, string>) =>
      JSON.stringify(Object.entries(t).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (
      want.accepted !== got.accepted ||
      norm(want.trust) !== norm(got.trust) ||
      JSON.stringify(want.revokedPins) !== JSON.stringify(got.revokedPins) ||
      (c.expect.issuedAt !== undefined && want.issuedAt !== c.expect.issuedAt)
    )
      throw new Error(
        `trustCases: the reference disagrees on ${c.id}: ${JSON.stringify(want)}`,
      );
  }
}
