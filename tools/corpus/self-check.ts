// §4.9's self-checks over the assembled `cases.json`.

import {
  type AnyCase,
  AUD_V3,
  MAX_BUNDLE_BYTES,
  type TypV3,
  utf8Bytes,
} from "./common.js";
import { P13_COUNTS } from "./content-fixture.js";
import { markerRelease, PACK_PER_CLAIM } from "./packs.js";
import { record, RECORDS, ROLLOUT_SALT } from "./release-records.js";
import {
  claimPathOf,
  ctxOf,
  type EnvelopeOpts,
  refBundleClaims,
  refDocClaims,
  refTrustClaims,
} from "./reference/claims.js";
import { refNumberInRange } from "./reference/config.js";
import { refFeedClaims } from "./reference/feed.js";
import { refVerifyJws } from "./reference/jws.js";
import { REF_OUTLET_ID_RE } from "./reference/outlet.js";
import {
  REF_BUILD_ID_RE,
  REF_CHANNEL_RE,
  REF_DELIVERABLE_RE,
  REF_FEED_PLATFORM_RE,
  REF_RECORD_VERSION_RE,
  REF_SALT_RE,
  REF_SHA256_RE,
} from "./reference/patterns.js";
import { refRecordClaims } from "./reference/record.js";
import {
  payloadTextOf,
  PLAIN_INTEGER_REF,
  refNonWire,
  refNumberTokens,
} from "./reference/tokens.js";
import { refParseVersion } from "./reference/versions.js";

// ── §4.9 self-checks over the assembled corpus ───────────────────────────────────────────────

/** The seven JWS families of §4.1 and plans/P4-01.md §4.6's two: where each keeps its JWS, its
 *  keys, its `typ` and its cap. */
const JWS_FAMILIES: Record<
  string,
  (c: AnyCase) => {
    jws: string;
    keys: Record<string, string>;
    typ: TypV3 | undefined;
    cap: number;
  }
> = {
  jwsCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: c.maxPayloadBytes ?? 65536,
  }),
  licenseDocCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: 65536,
  }),
  configDocCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: c.typ,
    cap: 65536,
  }),
  trustCases: (c) => ({
    jws: c.manifestJws,
    keys: c.pinned,
    typ: "pkey-trust+jws",
    cap: 65536,
  }),
  bundleCases: (c) => ({
    jws: c.bundleJws,
    keys: c.pinned,
    typ: "pkey-bundle+jws",
    cap: MAX_BUNDLE_BYTES,
  }),
  feedCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: "pkey-feed+jws",
    cap: 65536,
  }),
  releaseRecordCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  // plans/P4-13.md §4.2.
  feedContentCases: (c) => ({
    jws: c.jws,
    keys: c.trust,
    typ: "pkey-feed+jws",
    cap: 65536,
  }),
  revocationCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  packRecordCases: (c) => ({
    jws: c.jws,
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
  // A marker's JWS is its `release` (plans/P4-01.md §4.6).
  markerCases: (c) => ({
    jws: markerRelease(c.marker) ?? "",
    keys: c.releaseKeys,
    typ: "pkey-release+jws",
    cap: 65536,
  }),
};

/** Each family's claim step, from the generator's own claim checks, with `off` switched off. */
function claimStep(family: string, c: AnyCase, off: string[]): boolean {
  const { jws } = JWS_FAMILIES[family]!(c);
  const text = payloadTextOf(jws)!;
  const doc = JSON.parse(text) as unknown;
  const ctx = ctxOf(text, off);
  switch (family) {
    case "licenseDocCases":
    case "configDocCases":
      return refDocClaims(c.typ, doc, ctx, c as EnvelopeOpts);
    case "trustCases":
      return (
        refTrustClaims(doc, ctx, {
          pinned: c.pinned,
          now: c.now,
          checkFreshness: c.checkFreshness,
        }) !== null
      );
    case "bundleCases":
      return refBundleClaims(doc, ctx, { now: c.now, deviceId: c.deviceId });
    case "feedCases":
      return (
        refFeedClaims(doc, ctx, {
          aud: c.expectedAud,
          channel: c.channel,
          platform: c.platform,
        }) === null
      );
    case "releaseRecordCases":
    case "packRecordCases":
      return refRecordClaims(doc, ctx, c.expectedAud);
    default:
      throw new Error(family);
  }
}

/** §4.9 "per claim": the 21 paths, each with its token case, its bound case (null where §4.3
 *  lists the bound as implied) and its minimum case (null where §2.2 names the check that
 *  implies it). The licence cases stand for the envelope licence and config share. */
const PER_CLAIM: [string, string, string, string | null, string | null][] = [
  [
    "licenseDocCases",
    "/issuedAt",
    "license-issued-at-near-integer",
    "license-issued-at-over-max",
    "license-issued-at-negative-reload-path",
  ],
  [
    "licenseDocCases",
    "/expiresAt",
    "license-expires-at-near-integer",
    null,
    "license-expires-at-negative-reload-path",
  ],
  [
    "licenseDocCases",
    "/graceUntil",
    "license-grace-until-near-integer",
    "license-grace-until-over-max",
    null,
  ],
  [
    "configDocCases",
    "/schemaVersion",
    "config-schema-version-near-integer",
    "config-schema-version-over-max",
    "config-schema-version-zero",
  ],
  [
    "trustCases",
    "/schemaVersion",
    "trust-schema-version-near-integer",
    null,
    null,
  ],
  [
    "trustCases",
    "/issuedAt",
    "trust-issued-at-near-integer",
    "trust-issued-at-over-max",
    "trust-issued-at-negative",
  ],
  [
    "trustCases",
    "/expiresAt",
    "trust-expires-at-near-integer",
    "trust-expires-at-over-max",
    "trust-expires-at-negative-reload-path",
  ],
  [
    "bundleCases",
    "/issuedAt",
    "bundle-issued-at-near-integer",
    "bundle-issued-at-over-max",
    "bundle-issued-at-negative",
  ],
  [
    "bundleCases",
    "/expiresAt",
    "bundle-expires-at-near-integer",
    "bundle-expires-at-over-max",
    null,
  ],
  [
    "feedCases",
    "/schemaVersion",
    "feed-schema-version-near-integer",
    null,
    null,
  ],
  [
    "feedCases",
    "/seq",
    "feed-seq-near-integer",
    "feed-seq-over-max",
    "feed-seq-zero",
  ],
  [
    "feedCases",
    "/issuedAt",
    "feed-issued-at-near-integer",
    null,
    "feed-issued-at-negative",
  ],
  [
    "feedCases",
    "/expiresAt",
    "feed-expires-at-near-integer",
    "feed-expires-at-over-max",
    null,
  ],
  [
    "feedCases",
    "/app/targets/0/release/seq",
    "feed-target-seq-near-integer",
    "feed-target-seq-over-max",
    "feed-target-seq-zero",
  ],
  [
    "feedCases",
    "/app/targets/0/outlets/direct/live/seq",
    "feed-live-seq-near-integer",
    "feed-live-seq-over-max",
    "feed-live-seq-zero",
  ],
  [
    "feedCases",
    "/app/targets/0/outlets/direct/rollout/bp",
    "feed-rollout-bp-exponent",
    null,
    "feed-rollout-bp-negative",
  ],
  [
    "releaseRecordCases",
    "/schemaVersion",
    "record-schema-version-near-integer",
    null,
    null,
  ],
  [
    "releaseRecordCases",
    "/seq",
    "record-seq-integral-fraction",
    "record-seq-over-max",
    "record-seq-zero",
  ],
  [
    "releaseRecordCases",
    "/issuedAt",
    "record-issued-at-near-integer",
    "record-issued-at-over-max",
    "record-issued-at-negative",
  ],
  [
    "releaseRecordCases",
    "/minSupportedSeq",
    "record-min-supported-seq-near-integer",
    "record-min-supported-seq-over-max",
    "record-min-supported-seq-zero",
  ],
  [
    "releaseRecordCases",
    "/builds/0/artifacts/0/size",
    "record-artifact-size-integral-fraction",
    "record-artifact-size-over-max",
    "record-artifact-size-negative",
  ],
];
/** Cases built to break an integer claim's token or bound beyond the per-claim table. */
const EXTRA_BREAKERS = [
  "feed-seq-fraction",
  "feed-seq-integral-fraction",
  "record-seq-not-integer",
];

const FAMILY_CLAIM_KEYS: Record<string, string[]> = {
  licenseDocCases: ["envelope"],
  configDocCases: ["envelope", "config"],
  trustCases: ["trust"],
  bundleCases: ["bundle"],
  feedCases: ["feed"],
  feedContentCases: ["feed"],
  releaseRecordCases: ["record"],
  revocationCases: ["record"],
  packRecordCases: ["record", "pack", "content"],
  markerCases: ["record", "pack", "content"],
};

export function checkCorpusV4(corpus: Record<string, AnyCase[]>): void {
  const fail = (m: string): never => {
    throw new Error(`corpus v4 self-check: ${m}`);
  };
  const byId = new Map<string, [string, AnyCase]>();
  // Ids are unique in every family.
  for (const family of Object.keys(JWS_FAMILIES).concat("clockFloorCases")) {
    const ids = new Set<string>();
    for (const c of corpus[family]!) {
      if (ids.has(c.id)) fail(`duplicate id ${c.id} in ${family}`);
      ids.add(c.id);
      byId.set(c.id, [family, c]);
    }
  }
  const counts: Record<string, number> = {
    jwsCases: 85,
    licenseDocCases: 25,
    configDocCases: 21,
    trustCases: 30,
    bundleCases: 23,
    feedCases: 80,
    feedContentCases: P13_COUNTS.feedContentCases,
    releaseRecordCases: 49,
    revocationCases: P13_COUNTS.revocationCases,
    packRecordCases: 170,
    markerCases: 17,
  };
  for (const [family, n] of Object.entries(counts))
    if (corpus[family]!.length !== n)
      fail(`${family} has ${corpus[family]!.length} cases, not ${n}`);

  // §4.1: `nonWireIntegers` is the generator's scan exactly where the JWS is built to pass.
  for (const [family, view] of Object.entries(JWS_FAMILIES))
    for (const c of corpus[family]!) {
      const { jws, keys, typ, cap } = view(c);
      const v = refVerifyJws(jws, keys, typ, cap);
      const want = v ? refNonWire(v.text) : [];
      const got = c.nonWireIntegers;
      if (want.length === 0 && got !== undefined)
        fail(`${c.id} carries nonWireIntegers it must not`);
      if (want.length > 0 && JSON.stringify(got) !== JSON.stringify(want))
        fail(
          `${c.id}: nonWireIntegers ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
      if (got !== undefined) {
        const keysOrder = Object.keys(c);
        if (
          keysOrder.indexOf("nonWireIntegers") !==
          keysOrder.indexOf("expect") - 1
        )
          fail(`${c.id}: nonWireIntegers must sit right before expect`);
      }
    }

  // Per claim: token, bound and minimum cases break their path alone.
  const breakers = new Set(EXTRA_BREAKERS);
  // plans/P4-01.md §4.2: P3-02's loop extended with §2.5's 16 pack and `content` paths.
  const perClaim: [string, string, string, string | null, string | null][] = [
    ...PER_CLAIM,
    ...PACK_PER_CLAIM.map(
      ([pointer, token, bound, min]) =>
        ["packRecordCases", pointer, token, bound, min] as [
          string,
          string,
          string,
          string,
          string,
        ],
    ),
  ];
  for (const [family, pointer, token, bound, min] of perClaim) {
    for (const [kind, id] of [
      ["token", token],
      ["bound", bound],
      ["min", min],
    ] as const) {
      if (id === null) continue;
      const hit = byId.get(id);
      if (!hit || hit[0] !== family) fail(`${id} is not a ${family} case`);
      const c = hit![1];
      const text = payloadTextOf(JWS_FAMILIES[family]!(c).jws)!;
      const scan = refNonWire(text);
      if (kind === "min") {
        if (scan.length !== 0)
          fail(`${id}: a minimum case's scan must be empty`);
        const t = refNumberTokens(text).get(pointer);
        if (t === undefined || !PLAIN_INTEGER_REF.test(t))
          fail(`${id}: no plain integer at ${pointer}`);
      } else {
        breakers.add(id);
        if (JSON.stringify(scan) !== JSON.stringify([pointer]))
          fail(`${id}: its scan is ${JSON.stringify(scan)}, not [${pointer}]`);
      }
      if (claimStep(family, c, [])) fail(`${id}: the claim checks accept it`);
      if (!claimStep(family, c, [`${kind}:${pointer}`]))
        fail(`${id}: it fails beyond ${kind} at ${pointer}`);
    }
  }
  // No other case of the six families has a non-wire number at an integer claim.
  for (const family of Object.keys(FAMILY_CLAIM_KEYS))
    for (const c of corpus[family]!) {
      if (breakers.has(c.id)) continue;
      const text = payloadTextOf(JWS_FAMILIES[family]!(c).jws);
      if (text === null) continue;
      let pointers: string[];
      try {
        pointers = refNonWire(text);
      } catch {
        continue; // not JSON at all
      }
      for (const p of pointers)
        if (FAMILY_CLAIM_KEYS[family]!.some((k) => claimPathOf(k, p) !== null))
          fail(`${c.id} has a non-wire integer claim at ${p}`);
    }

  // Every feed pin names a record vector, except the cases built to mismatch.
  const hashes = new Set([...RECORDS!.values()].map((r) => r.sha256));
  for (const c of corpus.feedCases!) {
    const doc = JSON.parse(payloadTextOf(c.jws)!) as Record<string, any>;
    for (const t of doc.app?.targets ?? [])
      if (
        !hashes.has(t.release?.sha256) &&
        ![
          "feed-target-bad-sha256",
          "feed-target-sha256-trailing-newline",
        ].includes(c.id)
      )
        fail(`${c.id}: a pin names no record vector`);
  }

  // The non-ASCII cases and their ASCII twins.
  {
    const c = byId.get("record-build-id-non-ascii")![1];
    const text = payloadTextOf(c.jws)!;
    const doc = JSON.parse(text);
    const id = doc.builds[0].id as string;
    if (REF_BUILD_ID_RE.test(id))
      fail("record-build-id-non-ascii passes BUILD_ID_PATTERN");
    doc.builds[0].id = id.replace(/[^\x00-\x7f]/g, "e");
    if (!refRecordClaims(doc, ctxOf(JSON.stringify(doc)), AUD_V3))
      fail("record-build-id-non-ascii's twin fails");
  }
  {
    const c = byId.get("feed-target-platform-non-ascii")![1];
    const doc = JSON.parse(payloadTextOf(c.jws)!);
    const p = doc.app.targets[2].platform as string;
    if (REF_FEED_PLATFORM_RE.test(p))
      fail("feed-target-platform-non-ascii passes FEED_PLATFORM_PATTERN");
    doc.app.targets[2].platform = "freebsd";
    if (
      refFeedClaims(doc, ctxOf(JSON.stringify(doc)), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      fail("feed-target-platform-non-ascii's twin (freebsd) fails");
  }
  // Each trailing-newline value fails its whole-string pattern and passes without the terminator.
  for (const [value, ok] of [
    ["1.5.0\n", (v: string) => refParseVersion("semver", v) !== null],
    ["direct\n", (v: string) => REF_OUTLET_ID_RE.test(v)],
    ["stable\n", (v: string) => REF_CHANNEL_RE.test(v)],
    [`${record("R15").sha256}\n`, (v: string) => REF_SHA256_RE.test(v)],
    [`${ROLLOUT_SALT}\n`, (v: string) => REF_SALT_RE.test(v)],
    ["1.5.0\n", (v: string) => REF_RECORD_VERSION_RE.test(v)],
    ["app\n", (v: string) => REF_DELIVERABLE_RE.test(v)],
  ] as const)
    if (ok(value) || !ok(value.slice(0, -1)))
      fail(`trailing newline ${JSON.stringify(value)}`);
  // The listing-URL lengths.
  const url = (id: string): string =>
    (JSON.parse(payloadTextOf(byId.get(id)![1].jws)!) as Record<string, any>)
      .app.targets[0].outlets["app-store"].listingUrl;
  const nonAscii = url("feed-listing-url-non-ascii");
  if (!([...nonAscii].length <= 2048 && utf8Bytes(nonAscii).length > 2048))
    fail("feed-listing-url-non-ascii lengths");
  if (utf8Bytes(url("feed-listing-url-over-max")).length !== 2049)
    fail("feed-listing-url-over-max length");
  if (utf8Bytes(url("feed-valid-listing-url-at-max")).length !== 2048)
    fail("feed-valid-listing-url-at-max length");
  // The number and depth vectors break exactly the rule they name.
  for (const id of [
    "json-number-overflow",
    "json-number-underflow",
    "json-number-subnormal",
    "json-number-exponent-wrap",
  ]) {
    const x = /"x":([^}]*)\}$/.exec(payloadTextOf(byId.get(id)![1].jws)!)![1]!;
    if (refNumberInRange(x)) fail(`${id}: ${x} is in range`);
  }
  for (const id of ["valid-number-forms", "valid-number-integral-spellings"]) {
    const text = payloadTextOf(byId.get(id)![1].jws)!;
    for (const t of refNumberTokens(text).values())
      if (!refNumberInRange(t)) fail(`${id}: ${t} out of range`);
  }
}
