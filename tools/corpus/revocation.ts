// `cases.json#/revocationCases` (plans/P4-13.md §4.2).

import {
  ALT_KID,
  AUD_V3,
  PIN_KID,
  pub,
  raw,
  rawJson,
  REL_KID,
  REL2_KID,
  sha256Hex,
  signAs,
  signText,
} from "./common.js";
import { P13_COUNTS } from "./content-fixture.js";
import { placeNonWire } from "./nonwire.js";
import { packRecords } from "./pack-records.js";
import { r15Builds, RECORD_ISSUED } from "./release-records.js";
import { hasOwn } from "./reference/claims.js";
import { refVerifyJws } from "./reference/jws.js";
import {
  refVerifyRevocationCase,
  type RevocationCase,
} from "./reference/revocation.js";
import { refNonWire } from "./reference/tokens.js";

export async function buildRevocationCases(): Promise<RevocationCase[]> {
  const packs = await packRecords();
  const target = packs.get("djdl.levels@1.0.0")!;
  const repl = packs.get("djdl.levels@1.1.0")!;
  const other = packs.get("djdl.assets@1.1.0")!;
  const RK = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const ISSUED = RECORD_ISSUED + 5_000;
  const revDoc = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: "djdl.levels",
    kind: "revocation",
    version: "1.0.0",
    seq: 1,
    issuedAt: ISSUED,
    revokes: target.sha256,
    replacement: { sha256: repl.sha256, seq: 2, version: "1.1.0" },
    reason: "Exploit in the level 3 spawn tables.",
    ...over,
  });
  const cases: RevocationCase[] = [];
  const hashes = new Map<string, string>();
  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      kid?: string;
      releaseKeys?: Record<string, string>;
      entry?: Partial<NonNullable<RevocationCase["entry"]>>;
      /** Sign this exact JWS (`replacement` mode, or a pre-signed record). */
      jws?: string;
      mode?: "revocation" | "replacement";
      pin?: RevocationCase["pin"];
      hashOverride?: string;
      supersedes?: string;
      winner?: string;
      expect:
        | "ok"
        | Exclude<RevocationCase["expect"], { verify: "ok" }>["step"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const mode = o.mode ?? "revocation";
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, "pkey-release+jws")
        : await signAs(o.doc ?? revDoc(), kid, "pkey-release+jws"));
    const base: RevocationCase = {
      id,
      description,
      mode,
      jws,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expect: { verify: "ok" },
    };
    const c: RevocationCase =
      mode === "revocation"
        ? {
            ...base,
            entry: {
              record: o.hashOverride ?? sha256Hex(jws),
              pack: "djdl.levels",
              target: target.sha256,
              version: "1.0.0",
              seq: 1,
              ...o.entry,
            },
          }
        : {
            ...base,
            expectedHash: o.hashOverride ?? sha256Hex(jws),
            pin: o.pin!,
          };
    const want = refVerifyRevocationCase(c);
    if (o.expect === "ok") {
      if (want.verify !== "ok")
        throw new Error(`revocationCases ${id}: the reference refuses it`);
      c.expect = {
        ...want,
        ...(o.supersedes ? { supersedes: o.supersedes } : {}),
        ...(o.winner ? { winner: o.winner } : {}),
      };
    } else {
      if (want.verify !== "fail" || want.step !== o.expect)
        throw new Error(
          `revocationCases ${id}: the reference answers ${JSON.stringify(want)}`,
        );
      c.expect = want;
    }
    hashes.set(id, sha256Hex(jws));
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
  const withoutKey = (
    k: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const d = revDoc(over);
    delete d[k];
    return d;
  };

  // Valid.
  await mk(
    "revocation-valid-with-replacement",
    "The control: djdl.levels@1.0.0 revoked, replaced by 1.1.0 (same deliverable), signed by the pinned release key.",
    { expect: "ok" },
  );
  await mk(
    "revocation-valid-no-replacement",
    "A revocation without a replacement.",
    {
      doc: withoutKey("replacement"),
      expect: "ok",
    },
  );
  await mk(
    "revocation-valid-reason-at-max",
    "`reason` of exactly 512 UTF-8 bytes (multi-byte characters counted as bytes).",
    {
      doc: revDoc({ reason: `${"é".repeat(200)}${"x".repeat(112)}` }),
      expect: "ok",
    },
  );
  await mk(
    "revocation-valid-second-release-key",
    "Signed by the second pinned release key (2027), during a rotation.",
    {
      kid: REL2_KID,
      releaseKeys: { ...RK, [REL2_KID]: pub(REL2_KID) },
      expect: "ok",
    },
  );
  // jws.
  await mk(
    "revocation-signed-by-product-key",
    "Signed by the product key, which is in the product trust set: refused at step `jws` (decision 3: the Worker can never sign one).",
    {
      kid: PIN_KID,
      releaseKeys: { ...RK, [PIN_KID]: pub(PIN_KID) },
      expect: "jws",
    },
  );
  await mk(
    "revocation-kid-not-pinned",
    "Signed by the 2027 release key, which this app does not pin.",
    { kid: REL2_KID, expect: "jws" },
  );
  // hash.
  await mk(
    "revocation-hash-mismatch",
    "The body does not hash to `entry.record`.",
    { hashOverride: sha256Hex("pkey-corpus-revocation:other"), expect: "hash" },
  );
  // claims.
  await mk("revocation-wrong-aud", "`aud` names another product.", {
    doc: revDoc({ aud: "other" }),
    expect: "claims",
  });
  // cross-check.
  await mk(
    "revocation-entry-pack-mismatch",
    "The feed entry names another pack.",
    { entry: { pack: "djdl.assets" }, expect: "cross-check" },
  );
  await mk(
    "revocation-entry-version-mismatch",
    "The feed entry names another version.",
    { entry: { version: "1.0.1" }, expect: "cross-check" },
  );
  await mk(
    "revocation-entry-seq-mismatch",
    "The feed entry names another `seq`.",
    { entry: { seq: 2 }, expect: "cross-check" },
  );
  await mk(
    "revocation-kind-app",
    "A record of `kind: app` where a revocation is pinned.",
    {
      doc: revDoc({ kind: "app", builds: r15Builds("1.0.0", ["macos-dmg"]) }),
      expect: "cross-check",
    },
  );
  // revocation (step 16).
  await mk(
    "revocation-deliverable-app",
    "`deliverable: app`: an app build is revoked by License's compatibility window, never by a revocation record.",
    {
      doc: revDoc({ deliverable: "app" }),
      entry: { pack: "app" },
      expect: "revocation",
    },
  );
  await mk("revocation-revokes-missing", "No `revokes`.", {
    doc: withoutKey("revokes"),
    expect: "revocation",
  });
  await mk("revocation-revokes-uppercase", "`revokes` in uppercase hex.", {
    doc: revDoc({ revokes: target.sha256.toUpperCase() }),
    expect: "revocation",
  });
  await mk(
    "revocation-revokes-not-entry-target",
    "`revokes` is not the feed entry's `target`.",
    { doc: revDoc({ revokes: other.sha256 }), expect: "revocation" },
  );
  await mk(
    "revocation-replacement-equals-revokes",
    "The replacement is the revoked record itself.",
    {
      doc: revDoc({
        replacement: { sha256: target.sha256, seq: 1, version: "1.0.0" },
      }),
      expect: "revocation",
    },
  );
  await mk(
    "revocation-replacement-seq-token",
    "V4 §3.1: `replacement.seq` written as the token `2.0`.",
    {
      text: rawJson(
        revDoc({
          replacement: {
            sha256: repl.sha256,
            seq: raw("2.0"),
            version: "1.1.0",
          },
        }),
      ),
      expect: "revocation",
    },
  );
  await mk("revocation-replacement-seq-zero", "`replacement.seq` 0.", {
    doc: revDoc({
      replacement: { sha256: repl.sha256, seq: 0, version: "1.1.0" },
    }),
    expect: "revocation",
  });
  await mk("revocation-reason-missing", "No `reason`.", {
    doc: withoutKey("reason"),
    expect: "revocation",
  });
  await mk("revocation-reason-over-max", "`reason` of 513 bytes.", {
    doc: revDoc({ reason: "x".repeat(513) }),
    expect: "revocation",
  });
  // replacement mode.
  await mk(
    "revocation-replacement-record-valid",
    "`replacement` mode: the replacement record (djdl.levels@1.1.0) verifies as a pack record against the revocation's replacement pin.",
    {
      mode: "replacement",
      jws: repl.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: "ok",
    },
  );
  await mk(
    "revocation-replacement-other-deliverable",
    "`replacement` mode: the replacement hash names a record of another deliverable (djdl.assets@1.1.0): refused at `cross-check`.",
    {
      mode: "replacement",
      jws: other.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: "cross-check",
    },
  );
  // Superseding (decision 18).
  const replB = { sha256: other.sha256, seq: 2, version: "1.1.0" };
  await mk(
    "revocation-supersedes-replacement",
    "A later revocation of the same target with a newer `issuedAt` and a different replacement; with `revocation-valid-with-replacement` it is the winner (`newerRevocation`).",
    {
      doc: revDoc({ issuedAt: ISSUED + 600, replacement: replB }),
      supersedes: "revocation-valid-with-replacement",
      winner: "revocation-supersedes-replacement",
      expect: "ok",
    },
  );
  await mk(
    "revocation-supersede-omits-revokes",
    "A superseding record cannot omit `revokes`: still step `revocation`.",
    {
      doc: withoutKey("revokes", { issuedAt: ISSUED + 900 }),
      expect: "revocation",
    },
  );
  {
    const tie = revDoc({ replacement: replB, reason: "Tie." });
    const tieJws = await signAs(tie, REL_KID, "pkey-release+jws");
    const control = hashes.get("revocation-valid-with-replacement")!;
    const winner =
      sha256Hex(tieJws) > control
        ? "revocation-supersede-tie"
        : "revocation-valid-with-replacement";
    await mk(
      "revocation-supersede-tie",
      "Equal `issuedAt` with `revocation-valid-with-replacement`: the higher record hash (by bytes) wins.",
      {
        jws: tieJws,
        supersedes: "revocation-valid-with-replacement",
        winner,
        expect: "ok",
      },
    );
  }
  await mk(
    "revocation-supersede-older-loses",
    "An older `issuedAt` with a different replacement loses to `revocation-valid-with-replacement`, which stays the winner.",
    {
      doc: revDoc({ issuedAt: ISSUED - 600, replacement: replB }),
      supersedes: "revocation-valid-with-replacement",
      winner: "revocation-valid-with-replacement",
      expect: "ok",
    },
  );

  // The superseding winners, recomputed with the reference rule.
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const c of cases) {
    if (c.expect.verify !== "ok" || !c.expect.supersedes) continue;
    const o = byId.get(c.expect.supersedes)!;
    const a = c.expect.revocation as { issuedAt: number };
    const b = (o.expect as unknown as { revocation: { issuedAt: number } })
      .revocation;
    const ha = c.entry!.record;
    const hb = o.entry!.record;
    const win =
      a.issuedAt !== b.issuedAt
        ? a.issuedAt > b.issuedAt
          ? c.id
          : o.id
        : ha >= hb
          ? c.id
          : o.id;
    if (win !== c.expect.winner)
      throw new Error(`revocationCases ${c.id}: the winner is ${win}`);
    if (c.entry!.target !== o.entry!.target)
      throw new Error(`revocationCases ${c.id}: supersedes another target`);
  }
  if (cases.length !== P13_COUNTS.revocationCases)
    throw new Error(
      `revocationCases: ${cases.length} != ${P13_COUNTS.revocationCases}`,
    );
  return cases;
}
