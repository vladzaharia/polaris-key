// `cases.json#/licenseDocCases` and `#/configDocCases`: the per-document claim vectors (§3), each
// family's v4 claim cases appended after its last case.

import {
  AUD_V3,
  configDoc,
  DEVICE_V3,
  ISSUER_V3,
  licenseDoc,
  MAX_GRACE_SECONDS,
  PIN_KID,
  pub,
  raw,
  rawJson,
  signAs,
  signText,
  SKEW,
  type TypV3,
  V3_EXPIRES,
  V3_GRACE,
  V3_ISSUED,
  V3_NOW,
} from "./common.js";
import {
  BIG_OVER,
  placeNonWire,
  withNonWire,
  type WithNonWire,
} from "./nonwire.js";

// ── §3 per-document claim vectors ────────────────────────────────────────────
// v1 had ONE `docCases` array because v2 had one document. v3 has two, and they carry
// independent anti-replay floors, so the same claim families are pinned twice — once per
// document type — and a verifier that implements the envelope only once still passes both.

interface DocCaseV2 {
  id: string;
  description: string;
  jws: string;
  trust: Record<string, string>;
  /** The `typ` the runner must demand: which of the two verifiers this case drives. */
  typ: TypV3;
  expectedAud: string;
  expectedIss: string;
  deviceId: string;
  now: number;
  /** Per-TYPE anti-replay floor (§3): license and config never share one. */
  lastAcceptedIssuedAt?: number;
  /** False = the cache-reload path (and bundle import), where the outer bound is
   *  `graceUntil`, not `expiresAt`. */
  checkFreshness?: boolean;
  expect: { accept: boolean };
}

/** The claim families every per-service document shares (§3). Instantiated once for the
 *  license document and once for the config document, so the two can never drift apart. */
async function envelopeCases(
  prefix: string,
  typ: TypV3,
  doc: (over?: Record<string, unknown>) => Record<string, unknown>,
): Promise<DocCaseV2[]> {
  const sign = (over: Record<string, unknown> = {}): Promise<string> =>
    signAs(doc(over), PIN_KID, typ);
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  return [
    {
      ...common,
      id: `${prefix}-valid-control`,
      description:
        "The control: a well-formed, correctly-bound, in-window document is accepted.",
      jws: await sign(),
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-expired`,
      description:
        "Evaluated past `expiresAt + CLOCK_SKEW`. An expired document is refused AT VERIFY on the network path — never accepted and then merely reported `grace` by the gate while its contents are handed out (§3).",
      jws: await sign(),
      now: V3_EXPIRES + SKEW + 1,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-expired-within-skew`,
      description:
        "The same document one second INSIDE the skew window is still accepted — CLOCK_SKEW_SECONDS is 300 in every implementation.",
      jws: await sign(),
      now: V3_EXPIRES + SKEW - 1,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-expired-reload-path`,
      description:
        "The expired document again on the CACHE-RELOAD path (`checkFreshness: false`, also the bundle-import profile, §7.4). A cached document is EXPECTED to be past its one-hour `expiresAt` — that is what offline operation is — so its signed outer bound there is `graceUntil`, enforced by the gate against the clock floor (§3, §4.2).",
      jws: await sign(),
      now: V3_EXPIRES + SKEW + 1,
      checkFreshness: false,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-iss-mismatch`,
      description:
        "A foreign `iss`. Documented as 'always ISSUER' since v1 but never enforced on documents until v3 (§3).",
      jws: await sign({ iss: "https://evil.example" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-iss-near-miss-rejected`,
      description:
        '`iss: "plrs.im"` — the bare apex, one label away from the real `key.plrs.im` (§8). The issuer is a fixed string, never a suffix match and never derived from the serving host, so a near-miss issuer is refused outright rather than shading into acceptance.',
      jws: await sign({ iss: "plrs.im" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issued-far-future`,
      description:
        "`issuedAt` ten years ahead. Without an `iat` sanity check a far-future document gates `ok` AND pins the anti-replay floor out of reach for every later document (§3).",
      jws: await sign({
        issuedAt: 2000000000,
        expiresAt: 2000003600,
        graceUntil: 2002592000,
      }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-issued-future-within-skew`,
      description:
        "`issuedAt` exactly CLOCK_SKEW seconds ahead of the verifier's clock is tolerated: a client running slightly behind must not reject a freshly-signed document.",
      jws: await sign(),
      now: V3_ISSUED - SKEW,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-grace-before-expiry`,
      description:
        "`graceUntil` earlier than `expiresAt` is incoherent — the offline window cannot close before the document does (§3).",
      jws: await sign({ graceUntil: V3_EXPIRES - 1 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-grace-at-365d-cap`,
      description:
        "`graceUntil` at EXACTLY `issuedAt + MAX_GRACE_SECONDS` (365 d). The ceiling is inclusive, and it is applied at verify time rather than only in the gate (§3.3) — an operator-minted bundle may legitimately sit right on it (D-22).",
      jws: await sign({ graceUntil: V3_ISSUED + MAX_GRACE_SECONDS }),
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-grace-over-365d-cap`,
      description:
        "One second past the same ceiling. Bounds a hostile control plane and a tampered cache alike, at the byte the boundary actually falls on.",
      jws: await sign({ graceUntil: V3_ISSUED + MAX_GRACE_SECONDS + 1 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-grace-unbounded`,
      description:
        "`graceUntil` a century past `issuedAt` — the shape v1 accepted without complaint.",
      jws: await sign({ graceUntil: V3_ISSUED + 100 * 365 * 86400 }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-replayed-below-floor`,
      description:
        "`issuedAt` EQUAL to this type's anti-replay floor. Equal is not strictly newer, so a re-presented document is refused (§3).",
      jws: await sign(),
      lastAcceptedIssuedAt: V3_ISSUED,
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-replay-strictly-newer-accepted`,
      description:
        "The same floor one second lower: strictly newer IS accepted. Without this pair a verifier that rejects everything would pass the anti-replay case.",
      jws: await sign(),
      lastAcceptedIssuedAt: V3_ISSUED - 1,
      expect: { accept: true },
    },
    {
      ...common,
      id: `${prefix}-aud-mismatch`,
      description:
        "A document scoped to another product — enforced on the network path AND the reload path (§3).",
      jws: await sign({ aud: "other-product" }),
      expect: { accept: false },
    },
    {
      ...common,
      id: `${prefix}-device-mismatch`,
      description:
        "A document bound to another device — a document lifted from a colleague's machine (§3).",
      jws: await sign({ deviceId: "dev_someone_else" }),
      expect: { accept: false },
    },
  ];
}

export async function buildLicenseDocCases(): Promise<DocCaseV2[]> {
  return [
    ...(await envelopeCases("license", "pkey-license+jws", licenseDoc)),
    // Wire contract v4 §3: the licence claim cases, after the family's last case.
    ...(await buildLicenseDocCasesV4()).map(placeNonWire),
  ];
}

export async function buildConfigDocCases(): Promise<DocCaseV2[]> {
  const shared = await envelopeCases("config", "pkey-config+jws", configDoc);
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ: "pkey-config+jws" as TypV3,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  return [
    ...shared,
    {
      ...common,
      id: "config-doc-no-license-fields",
      description:
        "D-08, on the wire: a config document carrying NO licenseId, NO entitlements and NO profile is ACCEPTED. A product with `config` enabled and `license` disabled issues exactly this to any registered device, and a verifier that reaches for a license field while validating it makes service independence unimplementable (§2.2).",
      jws: await signAs(
        {
          iss: ISSUER_V3,
          aud: AUD_V3,
          deviceId: DEVICE_V3,
          issuedAt: V3_ISSUED,
          expiresAt: V3_EXPIRES,
          graceUntil: V3_GRACE,
          schemaVersion: 4,
          config: {
            "run.concurrency": {
              state: "enforced",
              value: 4,
              updatedAt: 1699990000,
            },
          },
          secrets: {},
        },
        PIN_KID,
        "pkey-config+jws",
      ),
      expect: { accept: true },
    },
    {
      ...common,
      id: "config-schema-version-invalid",
      description:
        '`schemaVersion` as a STRING. The field carries the product\'s catalog version, so its value cannot be allow-listed — but its shape can, and `schemaVersion: "4"` is the shape R2-08 slipped through (§2.2).',
      jws: await signAs(
        configDoc({ schemaVersion: "4" }),
        PIN_KID,
        "pkey-config+jws",
      ),
      expect: { accept: false },
    },
    // Wire contract v4 §3: the config claim cases, after the family's last case.
    ...(await buildConfigDocCasesV4()).map(placeNonWire),
  ];
}

async function buildLicenseDocCasesV4(): Promise<WithNonWire<DocCaseV2>[]> {
  const typ: TypV3 = "pkey-license+jws";
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  const sign = (over: Record<string, unknown>): Promise<string> =>
    signText(rawJson(licenseDoc(over)), PIN_KID, typ);
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    accept: boolean,
    extra: Partial<DocCaseV2> = {},
  ): Promise<WithNonWire<DocCaseV2>> => {
    const jws = await sign(over);
    return withNonWire(
      { ...common, ...extra, id, description, jws, expect: { accept } },
      jws,
    );
  };
  const base = licenseDoc();
  return [
    await mk(
      "license-issued-at-near-integer",
      "V4 §3: the `issuedAt` token `1700000000.00000001` denotes no integer, but binary64 rounding makes it one in Node, Swift and Godot. Only the token rule refuses it.",
      { issuedAt: raw("1700000000.00000001") },
      false,
    ),
    await mk(
      "license-expires-at-near-integer",
      "V4 §3: the `expiresAt` token `1700003600.00000001`.",
      { expiresAt: raw("1700003600.00000001") },
      false,
    ),
    await mk(
      "license-grace-until-near-integer",
      "V4 §3: the `graceUntil` token `1702592000.00000001`.",
      { graceUntil: raw("1702592000.00000001") },
      false,
    ),
    await mk(
      "license-issued-at-over-max",
      "V4 §3: only `issuedAt` (9007199254740993) is above 2^53 − 1; every other claim is in range at this `now`. JavaScript reads it as 2^53.",
      {
        issuedAt: raw(BIG_OVER),
        expiresAt: 9007199254740950,
        graceUntil: 9007199254740960,
      },
      false,
      { now: 9007199254740900 },
    ),
    await mk(
      "license-grace-until-over-max",
      "V4 §3: only `graceUntil` (9007199254826400) is above 2^53 − 1.",
      {
        issuedAt: 9007199254740000,
        expiresAt: 9007199254740900,
        graceUntil: 9007199254826400,
      },
      false,
      { now: 9007199254740000 },
    ),
    await mk(
      "license-member-shapes-ignored",
      "V4 §3 'Members outside the claims': an entry with `state: \"future\"` and a fractional `updatedAt`, an entry with no `value`, an entry that is `5`, and a profile with no `firstName` and a fractional `activatedAt` decide nothing. Swift's synthesized decoders refused these.",
      {
        entitlements: {
          "license.tier": {
            state: "future",
            value: "pro",
            updatedAt: 1699990000.5,
          },
          channels: { state: "enforced", updatedAt: 1699990000 },
          "app.minVersion": (base.entitlements as Record<string, unknown>)[
            "app.minVersion"
          ],
          polarisVpn: 5,
        },
        profile: {
          name: "Grace Hopper",
          email: "grace@example.com",
          activatedAt: 1690000000.5,
        },
      },
      true,
    ),
    await mk(
      "license-profile-null",
      "V4 §3 presence: a present `profile: null` is refused (Python and Swift read it as absent).",
      { profile: null },
      false,
    ),
    await mk(
      "license-issued-at-negative-reload-path",
      "V4 §3 minimums: `issuedAt` −1 is a plain integer token below its minimum, 0. On the reload path nothing else refuses it.",
      { issuedAt: -1, expiresAt: 3599, graceUntil: 2591999 },
      false,
      { checkFreshness: false },
    ),
    await mk(
      "license-expires-at-negative-reload-path",
      "V4 §3 minimums: `expiresAt` −1, with the control's `issuedAt` and `graceUntil`, on the reload path.",
      { expiresAt: -1 },
      false,
      { checkFreshness: false },
    ),
  ];
}

async function buildConfigDocCasesV4(): Promise<WithNonWire<DocCaseV2>[]> {
  const typ: TypV3 = "pkey-config+jws";
  const common = {
    trust: { [PIN_KID]: pub(PIN_KID) },
    typ,
    expectedAud: AUD_V3,
    expectedIss: ISSUER_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
  };
  const mk = async (
    id: string,
    description: string,
    schemaVersion: unknown,
  ): Promise<WithNonWire<DocCaseV2>> => {
    const jws = await signText(
      rawJson(configDoc({ schemaVersion })),
      PIN_KID,
      typ,
    );
    return withNonWire(
      { ...common, id, description, jws, expect: { accept: false } },
      jws,
    );
  };
  return [
    await mk(
      "config-schema-version-near-integer",
      "V4 §3: the `schemaVersion` token `4.0000000000000001`.",
      raw("4.0000000000000001"),
    ),
    await mk(
      "config-schema-version-over-max",
      "V4 §3: `schemaVersion` 9007199254740993, above 2^53 − 1.",
      raw(BIG_OVER),
    ),
    await mk(
      "config-schema-version-zero",
      "V4 §3 minimums: `schemaVersion` 0, below its minimum, 1.",
      0,
    ),
  ];
}
