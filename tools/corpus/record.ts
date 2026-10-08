// `cases.json#/releaseRecordCases` (§4.5).

import {
  ALT_KID,
  AUD_V3,
  encSeg,
  PIN_KID,
  pub,
  raw,
  rawJson,
  REL_KID,
  REL2_KID,
  sha256Hex,
  signAs,
  signText,
  type TypV3,
} from "./common.js";
import { BIG_OVER, placeNonWire } from "./nonwire.js";
import { packRecords } from "./pack-records.js";
import {
  artifact,
  r15Builds,
  recordDoc,
  type RecordVector,
} from "./release-records.js";
import { hasOwn } from "./reference/claims.js";
import { refVerifyJws } from "./reference/jws.js";
import { type RecordCase, refVerifyRecordCase } from "./reference/record.js";
import { refNonWire } from "./reference/tokens.js";

export async function buildReleaseRecordCases(
  records: Map<string, RecordVector>,
): Promise<RecordCase[]> {
  const RK = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const PIN = { deliverable: "app", version: "1.5.0", seq: 15 };
  const cases: RecordCase[] = [];
  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      jws?: string;
      kid?: string;
      typ?: TypV3;
      releaseKeys?: Record<string, string>;
      expectedHash?: string;
      pin?: RecordCase["pin"] | null;
      expect: RecordCase["expect"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, o.typ ?? "pkey-release+jws")
        : await signAs(o.doc ?? recordDoc(), kid, o.typ ?? "pkey-release+jws"));
    const c: RecordCase = {
      id,
      description,
      jws,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: o.expectedHash ?? sha256Hex(jws),
      ...(o.pin === null ? {} : { pin: o.pin ?? PIN }),
      expect: o.expect,
    };
    // A case built to pass `verifyJws` (its own keys, typ and cap) carries its non-wire pointers.
    const kidOk =
      hasOwn(c.releaseKeys, kid) &&
      !Object.values(PT).includes(c.releaseKeys[kid]!);
    const v = kidOk
      ? refVerifyJws(jws, { [kid]: c.releaseKeys[kid]! }, "pkey-release+jws")
      : null;
    const nonWire = v ? refNonWire(v.text) : [];
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ok = (kind = "app"): RecordCase["expect"] => ({ verify: "ok", kind });
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check",
  ): RecordCase["expect"] => ({ verify: "fail", step });
  const r15 = records.get("R15")!;
  const rd = (over: Record<string, unknown>): Record<string, unknown> =>
    recordDoc(over);
  const builds = r15Builds("1.5.0");
  const withBuild0 = (
    patch: (b: Record<string, unknown>) => Record<string, unknown>,
  ): Record<string, unknown>[] =>
    builds.map((b, i) => (i === 0 ? patch(structuredClone(b)) : b));
  const artifact0 = (
    patch: Record<string, unknown>,
  ): Record<string, unknown>[] =>
    withBuild0((b) => ({
      ...b,
      artifacts: [
        { ...(b.artifacts as Record<string, unknown>[])[0], ...patch },
      ],
    }));

  await mk(
    "record-valid-app",
    "The control: R15, signed by the pinned release key, its hash the pin, cross-checked against `{app, 1.5.0, 15}`.",
    {
      jws: r15.jws,
      expect: { verify: "ok", kind: "app", doc: r15.doc },
    },
  );
  await mk(
    "record-valid-rotation-second-key",
    "A record signed by the 2027 release key while both are pinned: two keys are valid at once during a rotation.",
    {
      kid: REL2_KID,
      releaseKeys: { ...RK, [REL2_KID]: pub(REL2_KID) },
      expect: ok(),
    },
  );
  await mk(
    "record-valid-unknown-arch-build",
    "A `riscv64` build: an unknown arch is allowed and never eligible.",
    {
      doc: rd({
        builds: [
          ...builds,
          {
            id: "linux-riscv64",
            platform: "linux",
            arch: "riscv64",
            format: "tar.gz",
            artifacts: [
              artifact("linux-riscv64", "1.5.0", "tar.gz", "payload", 11),
            ],
          },
        ],
      }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-store-only-build",
    "A store-only build (`aab`, `artifacts: []`) verifies; it is never installed.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["aab", "apk"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-build-number-absent",
    "`buildNumber` is optional and absent here.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["linux-arm64"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-non-payload-build",
    "A build whose one file is a `chunk-bundle` verifies (P2-04 accepts it) and is never eligible.",
    {
      doc: rd({ builds: r15Builds("1.5.0", ["win-chunks", "win-zip"]) }),
      expect: ok(),
    },
  );
  await mk(
    "record-valid-4part-version",
    "`1.5.0.0`: the record's claims name no scheme; the pin's version parses under the feed's.",
    {
      jws: records.get("R4")!.jws,
      pin: { deliverable: "app", version: "1.5.0.0", seq: 15 },
      expect: ok(),
    },
  );
  await mk(
    "record-valid-content-reserved",
    "A reserved `content` member (P4-01) is ignored.",
    {
      doc: rd({
        content: {
          contentApi: 1,
          pins: [],
          holds: [],
          expects: [],
          packChannels: {},
        },
      }),
      expect: ok(),
    },
  );
  // plans/P4-01.md §4.6: rewritten in place to sign `djdl.levels@1.1.0`, a pack record a P4
  // verifier accepts at `claims`; same ids, same `expect`.
  const packLevels = (await packRecords()).get("djdl.levels@1.1.0")!;
  await mk(
    "record-valid-kind-pack-verify-only",
    "`kind: pack` (`djdl.levels@1.1.0`) verifies when no pin asks for an app (verify only).",
    {
      jws: packLevels.jws,
      pin: null,
      expect: ok("pack"),
    },
  );
  await mk(
    "record-valid-kind-revocation-verify-only",
    "`kind: revocation`, reserved (P4-13), verifies and is never acted on.",
    {
      doc: rd({ kind: "revocation", builds: undefined }),
      pin: null,
      expect: ok("revocation"),
    },
  );
  await mk(
    "record-valid-kind-unknown-verify-only",
    "An unknown kind verifies; the cross-check refuses it where an app record is expected.",
    {
      doc: rd({ kind: "future", builds: undefined }),
      pin: null,
      expect: ok("future"),
    },
  );
  await mk(
    "record-hash-mismatch",
    "Step 12: the body's SHA-256 is not the pin (another valid record).",
    {
      jws: r15.jws,
      expectedHash: records.get("RB")!.sha256,
      expect: fail("hash"),
    },
  );
  {
    const [h, , s] = r15.jws.split(".") as [string, string, string];
    const tampered = `${h}.${encSeg({ ...r15.doc, seq: 99 })}.${s}`;
    await mk(
      "record-hash-checked-before-signature",
      "Step 12 runs before any Ed25519 work: a tampered body whose signature is also bad fails at `hash`.",
      {
        jws: tampered,
        expectedHash: r15.sha256,
        expect: fail("hash"),
      },
    );
  }
  await mk(
    "record-hash-pin-uppercase",
    "The pin is lowercase hex; an uppercase pin is no match.",
    {
      jws: r15.jws,
      expectedHash: r15.sha256.toUpperCase(),
      expect: fail("hash"),
    },
  );
  await mk(
    "record-rotation-old-key-dropped",
    "Signed by the 2026 key after it left the pinned set.",
    {
      releaseKeys: { [REL2_KID]: pub(REL2_KID) },
      expect: fail("jws"),
    },
  );
  await mk(
    "record-release-key-is-product-key",
    "A product key pinned as a release key: refused at `jws` because its bytes are in the product trust set (V4 §2.4).",
    {
      kid: PIN_KID,
      releaseKeys: { [PIN_KID]: pub(PIN_KID) },
      expect: fail("jws"),
    },
  );
  await mk(
    "record-duplicate-key",
    "A payload that declares `version` twice: strict JSON refuses it at `jws`.",
    {
      text: JSON.stringify(recordDoc()).replace(
        '"version":"1.5.0"',
        '"version":"1.5.0","version":"1.6.0"',
      ),
      expect: fail("jws"),
    },
  );
  await mk(
    "record-build-requires-null",
    "V4 §3 presence: `requires: null` on one build.",
    {
      doc: rd({ builds: withBuild0((b) => ({ ...b, requires: null })) }),
      expect: fail("claims"),
    },
  );
  const tokenCase = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    pin: RecordCase["pin"] | null = PIN,
  ): Promise<void> =>
    mk(id, description, {
      text: rawJson(recordDoc(over)),
      pin,
      expect: fail("claims"),
    });
  await tokenCase(
    "record-schema-version-near-integer",
    'V4 §3: `"schemaVersion":1.0000000000000001`.',
    { schemaVersion: raw("1.0000000000000001") },
  );
  await tokenCase(
    "record-issued-at-near-integer",
    "V4 §3: the `issuedAt` token `1700000000.00000001`.",
    { issuedAt: raw("1700000000.00000001") },
  );
  await tokenCase(
    "record-seq-over-max",
    "V4 §3: `seq` 9007199254740993, no pin.",
    { seq: raw(BIG_OVER) },
    null,
  );
  await tokenCase(
    "record-min-supported-seq-over-max",
    "V4 §3: `minSupportedSeq` 9007199254740993.",
    { minSupportedSeq: raw(BIG_OVER) },
  );
  await mk(
    "record-deliverable-trailing-newline",
    'Whole-string patterns: `deliverable` `"app\\n"`, no pin.',
    { doc: rd({ deliverable: "app\n" }), pin: null, expect: fail("claims") },
  );
  await mk("record-issued-at-negative", "V4 §3 minimums: `issuedAt` −1.", {
    doc: rd({ issuedAt: -1 }),
    expect: fail("claims"),
  });
  await mk(
    "record-build-id-non-ascii",
    "`BUILD_ID_PATTERN` is ASCII: a build id `macos-arm64-é` is refused, so uniqueness and the tie-break compare bytes in every SDK.",
    {
      doc: rd({
        builds: withBuild0((b) => ({ ...b, id: "macos-arm64-\u00e9" })),
      }),
      expect: fail("claims"),
    },
  );
  await mk("record-wrong-aud", "A record scoped to another product.", {
    doc: rd({ aud: "other-product" }),
    expect: fail("claims"),
  });
  await mk("record-schema-version-2", "`schemaVersion: 2`.", {
    doc: rd({ schemaVersion: 2 }),
    expect: fail("claims"),
  });
  await mk(
    "record-version-bad-chars",
    "A version outside P2-04's `VERSION_RE` (a space).",
    { doc: rd({ version: "1.5.0 beta" }), expect: fail("claims") },
  );
  await tokenCase("record-seq-not-integer", 'V4 §3: `"seq":15.5`.', {
    seq: raw("15.5"),
  });
  await mk("record-builds-missing", "`kind: app` with no `builds`.", {
    doc: rd({ builds: undefined }),
    expect: fail("claims"),
  });
  await mk("record-duplicate-build-id", "Two builds with one id.", {
    doc: rd({ builds: [...builds, builds[0]] }),
    expect: fail("claims"),
  });
  await mk("record-build-platform-null", "`platform: null` on a build.", {
    doc: rd({ builds: withBuild0((b) => ({ ...b, platform: null })) }),
    expect: fail("claims"),
  });
  await mk("record-build-two-payloads", "A build with two `payload` files.", {
    doc: rd({
      builds: withBuild0((b) => ({
        ...b,
        artifacts: [
          ...(b.artifacts as unknown[]),
          artifact("macos-dmg-2", "1.5.0", "dmg", "payload", 12),
        ],
      })),
    }),
    expect: fail("claims"),
  });
  await mk(
    "record-artifact-sha256-uppercase",
    "An artifact digest in uppercase hex.",
    {
      doc: rd({
        builds: artifact0({
          sha256: (
            builds[0]!.artifacts as Record<string, string>[]
          )[0]!.sha256!.toUpperCase(),
        }),
      }),
      expect: fail("claims"),
    },
  );
  await mk("record-build-number-not-string", "`buildNumber: 46`, a number.", {
    doc: rd({ builds: withBuild0((b) => ({ ...b, buildNumber: 46 })) }),
    expect: fail("claims"),
  });
  await mk(
    "record-min-supported-seq-zero",
    "V4 §3 minimums: `minSupportedSeq` 0.",
    { doc: rd({ minSupportedSeq: 0 }), expect: fail("claims") },
  );
  await mk(
    "record-version-mismatches-pin",
    "Step 15: the record's version is not the pin's.",
    {
      doc: rd({ version: "1.5.1", builds: r15Builds("1.5.1") }),
      expect: fail("cross-check"),
    },
  );
  await mk(
    "record-seq-mismatches-pin",
    "Step 15: the record's `seq` is not the pin's.",
    { doc: rd({ seq: 16 }), expect: fail("cross-check") },
  );
  await mk(
    "record-kind-pack-refused-as-app",
    "Step 15: a pack record (`djdl.levels@1.1.0`) is verified, then refused where an app record is expected.",
    {
      jws: packLevels.jws,
      expect: fail("cross-check"),
    },
  );
  await mk(
    "record-signed-by-product-key",
    "A record signed by the PRODUCT key: its kid is not among the pinned release keys.",
    { kid: PIN_KID, expect: fail("jws") },
  );
  await mk("record-wrong-typ", "A genuine record signed as `pkey-feed+jws`.", {
    typ: "pkey-feed+jws",
    expect: fail("jws"),
  });
  await mk("record-artifact-size-over-max", "V4 §3: `size` 9007199254740992.", {
    doc: rd({ builds: artifact0({ size: 9007199254740992 }) }),
    expect: fail("claims"),
  });
  await tokenCase(
    "record-artifact-size-integral-fraction",
    'V4 §3: `"size":1024.0` at `/builds/0/artifacts/0/size`.',
    { builds: artifact0({ size: raw("1024.0") }) },
  );
  await tokenCase(
    "record-seq-integral-fraction",
    'V4 §3: `"seq":15.0`, with the pin\'s `seq` 15.',
    { seq: raw("15.0") },
  );
  await tokenCase(
    "record-min-supported-seq-near-integer",
    'V4 §3: `"minSupportedSeq":3.0000000000000001`.',
    { minSupportedSeq: raw("3.0000000000000001") },
  );
  await tokenCase(
    "record-issued-at-over-max",
    "V4 §3: `issuedAt` 9007199254740993.",
    { issuedAt: raw(BIG_OVER) },
  );
  await mk(
    "record-version-trailing-newline",
    'Whole-string patterns: `version` `"1.5.0\\n"`, no pin.',
    {
      doc: rd({ version: "1.5.0\n", builds: builds }),
      pin: null,
      expect: fail("claims"),
    },
  );
  await mk("record-seq-zero", "V4 §3 minimums: `seq` 0, no pin.", {
    doc: rd({ seq: 0 }),
    pin: null,
    expect: fail("claims"),
  });
  await mk(
    "record-artifact-size-negative",
    'V4 §3 minimums: `"size":-1` at `/builds/0/artifacts/0/size`.',
    { doc: rd({ builds: artifact0({ size: -1 }) }), expect: fail("claims") },
  );

  if (cases.length !== 49)
    throw new Error(`releaseRecordCases: ${cases.length} != 49`);
  for (const c of cases) {
    const want = refVerifyRecordCase(c);
    const got = c.expect;
    if (
      want.verify !== got.verify ||
      (want.verify === "fail" &&
        got.verify === "fail" &&
        want.step !== got.step)
    )
      throw new Error(
        `releaseRecordCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
    if (want.verify === "ok" && got.verify === "ok" && want.kind !== got.kind)
      throw new Error(`releaseRecordCases: kind of ${c.id}`);
  }
  return cases;
}
