// `cases.json#/packRecordCases` and `#/markerCases` (plans/P4-01.md §4.6, P4-21) and the
// per-check self-check over them.

import { base64UrlDecode } from "@polaris-key/jws";
import {
  ALT_KID,
  type AnyCase,
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
import { BIG_OVER, placeNonWire } from "./nonwire.js";
import {
  appTwin,
  hashBytes,
  levelsChunks,
  levelsV2Variant,
  objRef,
  PACK_PAYLOADS,
  PACK_RECORDS,
  packObjectHashes,
  packRecords,
} from "./pack-records.js";
import {
  leafDiff,
  r15Builds,
  recordDoc,
  type RecordVector,
} from "./release-records.js";
import { ctxOf, hasOwn, isObj } from "./reference/claims.js";
import { refVerifyJws } from "./reference/jws.js";
import {
  PACK_CHECK_SET,
  PACK_CLAIM_CHECKS,
  type PackCheck,
} from "./reference/pack-claims.js";
import {
  type MarkerCase,
  type PackPin,
  type PackRecordCase,
  refVerifyMarkerCase,
  refVerifyPackCase,
} from "./reference/packs.js";
import { refRecordClaims } from "./reference/record.js";
import { payloadTextOf, refNonWire } from "./reference/tokens.js";

// ── plans/P4-01.md §4.6: packs on the wire — `packRecordCases` and `markerCases` (P4-21) ─────
//
// Two new JWS families after `releaseRecordCases`, which the v4 record runners of P3-04 to P3-08
// never read. P4-21 signs them over the FIXED object-ref table (§4.2): every `sha256` is
// the SHA-256 of the blob's name and every size is §4.3's figure, because the content set does
// not exist yet and no claim fetches an object, so every verdict holds. P4-04 then re-signs the
// valid records, their twins, the markers and the two rewritten P3-02 cases over the content
// set's real refs: their bytes change, never their ids or `expect`.

// ── `packRecordCases` (159) ──────────────────────────────────────────────────────────────────

/** A structure case's generator-only facts: its check, its twin and the property it breaks. */
interface StructureCase {
  check: PackCheck;
  twin: Record<string, unknown>;
  prop: string;
}
/** Filled by `buildPackRecordCases`, read by the per-check self-check; never in the corpus. */
const PACK_STRUCTURE = new Map<string, StructureCase>();
/** The per-integer-path rows for §2.5's 16 paths (token, bound, minimum case ids). */
export const PACK_PER_CLAIM: [string, string, string, string][] = [];

const clone = <T>(v: T): T => structuredClone(v);

export async function buildPackRecordCases(): Promise<PackRecordCase[]> {
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const packs = await packRecords();
  const rec = (name: string): RecordVector => packs.get(name)!;
  const LV1 = rec("djdl.levels@1.0.0");
  const LV2 = rec("djdl.levels@1.1.0");
  const AS2 = rec("djdl.assets@1.1.0");
  const MIN = rec("djdl.docs@1.0.0").doc;
  /** The one-variant container twin: v2's s3tc variant, one delta of each scope. */
  const ONE: Record<string, unknown> = {
    ...clone(LV2.doc),
    variants: [levelsV2Variant()],
  };
  const APP = appTwin(packs);
  const cases: PackRecordCase[] = [];
  PACK_STRUCTURE.clear();
  PACK_PER_CLAIM.length = 0;

  const mk = async (
    id: string,
    description: string,
    o: {
      doc?: Record<string, unknown>;
      text?: string;
      jws?: string;
      kid?: string;
      expectedHash?: string;
      pin?: PackPin;
      expect: PackRecordCase["expect"];
    },
  ): Promise<void> => {
    const kid = o.kid ?? REL_KID;
    const jws =
      o.jws ??
      (o.text !== undefined
        ? await signText(o.text, kid, "pkey-release+jws")
        : await signAs(o.doc!, kid, "pkey-release+jws"));
    const c: PackRecordCase = {
      id,
      description,
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: o.expectedHash ?? sha256Hex(jws),
      ...(o.pin ? { pin: o.pin } : {}),
      expect: o.expect,
    };
    const v = hasOwn(RK, kid)
      ? refVerifyJws(jws, { [kid]: RK[kid]! }, "pkey-release+jws")
      : null;
    const nonWire = v ? refNonWire(v.text) : [];
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const ok = (kind: string, doc?: unknown): PackRecordCase["expect"] =>
    doc === undefined ? { verify: "ok", kind } : { verify: "ok", kind, doc };
  const fail = (
    step: "hash" | "jws" | "claims" | "cross-check",
  ): PackRecordCase["expect"] => ({ verify: "fail", step });

  // ── Valid (13) ──
  await mk(
    "pack-valid-container",
    "`djdl.levels@1.1.0`: a `godot.pck` container with two texture variants, the first with one delta of each scope.",
    { jws: LV2.jws, expect: ok("pack", LV2.doc) },
  );
  await mk(
    "pack-valid-tree",
    "`djdl.assets@1.1.0`: an unvaried `files.tree` pack with a `files` delta and no gaps.",
    { jws: AS2.jws, expect: ok("pack") },
  );
  await mk(
    "pack-valid-pinned",
    "`djdl.levels@1.1.0` cross-checked against a pack pin `{kind: pack, djdl.levels, 1.1.0, 2}` (plans/P4-01.md §2.6).",
    {
      jws: LV2.jws,
      pin: {
        kind: "pack",
        deliverable: "djdl.levels",
        version: "1.1.0",
        seq: 2,
      },
      expect: ok("pack"),
    },
  );
  await mk(
    "pack-valid-minimal",
    "`djdl.docs@1.0.0`: only the required members (no handler, entitlement, deltas or requires).",
    { jws: rec("djdl.docs@1.0.0").jws, expect: ok("pack") },
  );
  {
    const d = clone(MIN);
    d.type = "l10n.table";
    await mk(
      "pack-valid-unknown-type",
      "An unknown pack type (`l10n.table`) verifies; the pack is unusable on a v1 SDK (`pack-type-unsupported`).",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.deltas[0].method = "godot-delta-pck";
    v.deltas.push({
      method: "zstd-patch-from",
      scope: "chunks",
      from: PACK_PAYLOADS.v1.sha256,
      memBytes: 1048576,
    });
    v.files.format = "pkey-files/2";
    v.full.codec = "lz4";
    (d.handler as Record<string, unknown>).activation = "lazy";
    await mk(
      "pack-valid-unknown-vocabulary",
      "Values outside v1's vocabularies (a `godot-delta-pck` method, a `chunks` scope, a `pkey-files/2` index, an `lz4` object, activation `lazy`) verify; each only makes its thing unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    (d.variants as Record<string, any>[])[0]!.files.layout = "strata";
    await mk(
      "pack-valid-unknown-layout",
      "An unknown layout (`strata`) carrying `gaps` and a `payload` delta verifies: it neither needs nor refuses them, and the variant is unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.full.size = v.payload.size + 1;
    await mk(
      "pack-valid-full-size-differs",
      "`full.size` differs from `payload.size`: not a claim (no claim relates two integer members); `full` is unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.deltas[0].patch = null;
    v.deltas[0].data = 5;
    v.deltas[1].artifact = "x";
    await mk(
      "pack-valid-foreign-delta-members",
      'A `payload` delta with `patch: null` and `data: 5`, and a `files` delta with `artifact: "x"`: a member of the other scope is ignored, not refused.',
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const d = clone(ONE);
    const v = (d.variants as Record<string, any>[])[0]!;
    v.chunks = {
      format: "pkey-chunks/1",
      ...objRef("files/v2.files.zst"),
      params: { avg: 65536 },
    };
    v.conflicts = ["djdl.other"];
    v.requires = {
      engine: "godot-4.7",
      contentApi: 1,
      packs: ["djdl.assets"],
      features: ["x"],
    };
    d.provides = ["djdl.levels-hd"];
    d.removes = [];
    d.content = 5;
    await mk(
      "pack-valid-reserved-members",
      "Every reserved member (`conflicts`, `requires.{contentApi, packs, features}`, `provides`, `removes`) and `content: 5`, which a pack record ignores; its `chunks` is well formed (plans/P4-10.md §2.2).",
      { doc: d, expect: ok("pack") },
    );
  }
  {
    const jws = await signAs(APP, REL_KID, "pkey-release+jws");
    await mk(
      "app-valid-content",
      "An app record with `content` (two pins, two expects) and `builds[].embeds`.",
      { jws, expect: ok("app", APP) },
    );
  }
  {
    const d = clone(APP);
    const c = d.content as Record<string, any>;
    c.expects.push({
      pack: "djdl.music",
      required: false,
      delivery: "background",
    });
    c.holds = [];
    c.packChannels = { "djdl.levels": "beta" };
    await mk(
      "app-valid-content-forward",
      "Forward members: an unpinned expect, `holds`, `packChannels` and delivery `background` verify (cross-record rules are publish rules, never claims).",
      { doc: d, expect: ok("app") },
    );
  }
  {
    const builds = r15Builds("1.5.0", ["web"]);
    builds[0]!.embeds = 7;
    await mk(
      "content-valid-ignored-on-unknown-kind",
      "A record of an unknown kind with `content: 5` and a build with `embeds: 7`: only the common claims apply.",
      {
        doc: recordDoc({ kind: "future", content: 5, builds }),
        expect: ok("future"),
      },
    );
  }

  // ── Structure (92): one property of a twin, refused by its check alone ──
  const brk = async (
    id: string,
    check: PackCheck,
    twin: Record<string, unknown>,
    prop: string,
    description: string,
    mutate: (d: Record<string, any>) => void,
  ): Promise<void> => {
    const d = clone(twin) as Record<string, any>;
    mutate(d);
    PACK_STRUCTURE.set(id, { check, twin, prop });
    await mk(id, description, { doc: d, expect: fail("claims") });
  };
  const V0 = "/variants/0";
  const v0 = (d: Record<string, any>): Record<string, any> => d.variants[0];
  const pd = (d: Record<string, any>): Record<string, any> => v0(d).deltas[0];
  const fd = (d: Record<string, any>): Record<string, any> => v0(d).deltas[1];

  await brk(
    "pack-deliverable-app",
    "deliverable.not-app",
    ONE,
    "/deliverable",
    "A pack record whose `deliverable` is `app`.",
    (d) => {
      d.deliverable = "app";
    },
  );
  await brk(
    "pack-builds-present",
    "builds.absent",
    ONE,
    "/builds",
    "A pack record with `builds: []`.",
    (d) => {
      d.builds = [];
    },
  );
  await brk("pack-type-missing", "type", ONE, "/type", "No `type`.", (d) => {
    delete d.type;
  });
  await brk(
    "pack-type-bad-pattern",
    "type",
    ONE,
    "/type",
    '`type: "godot"`, outside `PACK_TYPE_PATTERN`.',
    (d) => {
      d.type = "godot";
    },
  );
  await brk(
    "pack-type-trailing-newline",
    "type",
    ONE,
    "/type",
    'Whole-string patterns: `type` `"godot.pck\\n"`.',
    (d) => {
      d.type = "godot.pck\n";
    },
  );
  await brk(
    "pack-format-version-missing",
    "formatVersion",
    ONE,
    "/formatVersion",
    "No `formatVersion`.",
    (d) => {
      delete d.formatVersion;
    },
  );
  await brk(
    "pack-handler-null",
    "handler",
    ONE,
    "/handler",
    "`handler: null`.",
    (d) => {
      d.handler = null;
    },
  );
  await brk(
    "pack-mount-order-null",
    "handler.mountOrder",
    ONE,
    "/handler/mountOrder",
    "`handler.mountOrder: null`.",
    (d) => {
      d.handler.mountOrder = null;
    },
  );
  await brk(
    "pack-handler-prefixes-null",
    "handler.prefixes",
    ONE,
    "/handler/prefixes",
    "`handler.prefixes: null`.",
    (d) => {
      d.handler.prefixes = null;
    },
  );
  await brk(
    "pack-handler-prefixes-empty",
    "handler.prefixes.count",
    ONE,
    "/handler/prefixes",
    "`handler.prefixes: []` (1–32 items).",
    (d) => {
      d.handler.prefixes = [];
    },
  );
  await brk(
    "pack-handler-prefixes-over-max",
    "handler.prefixes.count",
    ONE,
    "/handler/prefixes",
    "33 distinct prefixes (1–32 items).",
    (d) => {
      d.handler.prefixes = Array.from({ length: 33 }, (_, k) => `res://p${k}/`);
    },
  );
  await brk(
    "pack-handler-prefix-bad",
    "handler.prefixes.item",
    ONE,
    "/handler/prefixes",
    "A prefix without its trailing slash (`res://levels`).",
    (d) => {
      d.handler.prefixes = ["res://levels"];
    },
  );
  await brk(
    "pack-handler-prefix-not-string",
    "handler.prefixes.item",
    ONE,
    "/handler/prefixes",
    "A prefix that is a number.",
    (d) => {
      d.handler.prefixes = [7];
    },
  );
  await brk(
    "pack-handler-prefix-over-256-bytes",
    "handler.prefixes.length",
    ONE,
    "/handler/prefixes",
    "A 257-byte prefix that matches `HANDLER_PREFIX_PATTERN`.",
    (d) => {
      d.handler.prefixes = [`res://${"a".repeat(250)}/`];
    },
  );
  await brk(
    "pack-handler-prefixes-duplicate",
    "handler.prefixes.unique",
    ONE,
    "/handler/prefixes",
    "The same prefix twice.",
    (d) => {
      d.handler.prefixes = ["res://levels/", "res://levels/"];
    },
  );
  await brk(
    "pack-handler-activation-empty",
    "handler.activation",
    ONE,
    "/handler/activation",
    '`handler.activation: ""`.',
    (d) => {
      d.handler.activation = "";
    },
  );
  await brk(
    "pack-handler-activation-null",
    "handler.activation",
    ONE,
    "/handler/activation",
    "`handler.activation: null`.",
    (d) => {
      d.handler.activation = null;
    },
  );
  await brk(
    "pack-entitlement-bad",
    "entitlement",
    ONE,
    "/entitlement",
    '`entitlement: "-hd"`, outside `ENTITLEMENT_PATTERN`.',
    (d) => {
      d.entitlement = "-hd";
    },
  );
  await brk(
    "pack-variants-missing",
    "variants",
    ONE,
    "/variants",
    "No `variants`.",
    (d) => {
      delete d.variants;
    },
  );
  await brk(
    "pack-variants-empty",
    "variants.count",
    ONE,
    "/variants",
    "`variants: []` (1–32 items).",
    (d) => {
      d.variants = [];
    },
  );
  await brk(
    "pack-variants-over-max",
    "variants.count",
    ONE,
    "/variants",
    "33 variants with distinct keys (1–32 items).",
    (d) => {
      const base = v0(d);
      delete base.deltas;
      d.variants = Array.from({ length: 33 }, (_, k) => ({
        ...clone(base),
        variant: { texture: `t${k}` },
      }));
    },
  );
  await brk(
    "pack-variant-not-object",
    "variants.item",
    ONE,
    "/variants/0",
    "A variant that is a number.",
    (d) => {
      d.variants[0] = 7;
    },
  );
  await brk(
    "pack-variant-key-duplicate",
    "variants.key-unique",
    ONE,
    "/variants",
    "Two variants with the key `texture=s3tc`.",
    (d) => {
      d.variants.push(clone(v0(d)));
    },
  );
  await brk(
    "pack-variant-axes-differ",
    "variants.axes-same",
    ONE,
    "/variants",
    "A second variant declaring `locale` where the first declares `texture`.",
    (d) => {
      d.variants.push({ ...clone(v0(d)), variant: { locale: "fr" } });
    },
  );
  await brk(
    "pack-variant-member-missing",
    "variant",
    ONE,
    `${V0}/variant`,
    "A variant without its `variant` member.",
    (d) => {
      delete v0(d).variant;
    },
  );
  await brk(
    "pack-variant-five-axes",
    "variant.count",
    ONE,
    `${V0}/variant`,
    "A variant with five axes (0–4 members).",
    (d) => {
      v0(d).variant = {
        texture: "s3tc",
        locale: "fr",
        quality: "hd",
        tier: "a",
        size: "b",
      };
    },
  );
  await brk(
    "pack-variant-axis-bad",
    "variant.axis",
    ONE,
    `${V0}/variant`,
    "An axis name `Texture`, outside `VARIANT_AXIS_PATTERN`.",
    (d) => {
      v0(d).variant = { Texture: "s3tc" };
    },
  );
  await brk(
    "pack-variant-value-non-ascii",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    "An axis value `s3tç`: `VARIANT_VALUE_PATTERN` is ASCII.",
    (d) => {
      v0(d).variant.texture = "s3tç";
    },
  );
  await brk(
    "pack-variant-value-trailing-newline",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    'Whole-string patterns: an axis value `"s3tc\\n"`.',
    (d) => {
      v0(d).variant.texture = "s3tc\n";
    },
  );
  await brk(
    "pack-variant-value-not-string",
    "variant.value",
    ONE,
    `${V0}/variant/texture`,
    "An axis value that is a number.",
    (d) => {
      v0(d).variant.texture = 7;
    },
  );
  await brk(
    "pack-payload-missing",
    "payload",
    ONE,
    `${V0}/payload`,
    "A variant without `payload`.",
    (d) => {
      delete v0(d).payload;
    },
  );
  await brk(
    "pack-payload-size-missing",
    "payload.size",
    ONE,
    `${V0}/payload/size`,
    "`payload` without `size`.",
    (d) => {
      delete v0(d).payload.size;
    },
  );
  await brk(
    "pack-payload-sha256-uppercase",
    "payload.sha256",
    ONE,
    `${V0}/payload/sha256`,
    "`payload.sha256` in uppercase hex.",
    (d) => {
      v0(d).payload.sha256 = String(v0(d).payload.sha256).toUpperCase();
    },
  );
  await brk(
    "pack-full-missing",
    "full",
    ONE,
    `${V0}/full`,
    "A variant without `full`.",
    (d) => {
      delete v0(d).full;
    },
  );
  await brk(
    "pack-ref-sha256-short",
    "ref.sha256",
    ONE,
    `${V0}/full/sha256`,
    "`full.sha256` with 63 hex digits (standing for every object ref).",
    (d) => {
      v0(d).full.sha256 = String(v0(d).full.sha256).slice(1);
    },
  );
  await brk(
    "pack-ref-bytes-missing",
    "ref.bytes",
    ONE,
    `${V0}/full/bytes`,
    "`full` without `bytes`.",
    (d) => {
      delete v0(d).full.bytes;
    },
  );
  await brk(
    "pack-ref-size-missing",
    "ref.size",
    ONE,
    `${V0}/full/size`,
    "`full` without `size`.",
    (d) => {
      delete v0(d).full.size;
    },
  );
  await brk(
    "pack-ref-codec-missing",
    "ref.codec",
    ONE,
    `${V0}/full/codec`,
    "`full` without `codec` (required even for `none`).",
    (d) => {
      delete v0(d).full.codec;
    },
  );
  await brk(
    "pack-ref-codec-bad-pattern",
    "ref.codec",
    ONE,
    `${V0}/full/codec`,
    '`full.codec: "ZSTD"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => {
      v0(d).full.codec = "ZSTD";
    },
  );
  await brk(
    "pack-ref-none-bytes-mismatch",
    "ref.none-bytes",
    ONE,
    `${V0}/full/codec`,
    "`full.codec: none` while `bytes` ≠ `size`.",
    (d) => {
      v0(d).full.codec = "none";
    },
  );
  await brk(
    "pack-files-missing",
    "files",
    ONE,
    `${V0}/files`,
    "A variant without `files`.",
    (d) => {
      delete v0(d).files;
    },
  );
  await brk(
    "pack-files-format-empty",
    "files.format",
    ONE,
    `${V0}/files/format`,
    '`files.format: ""`.',
    (d) => {
      v0(d).files.format = "";
    },
  );
  await brk(
    "pack-files-layout-empty",
    "files.layout",
    ONE,
    `${V0}/files/layout`,
    '`files.layout: ""`.',
    (d) => {
      v0(d).files.layout = "";
    },
  );
  await brk(
    "pack-files-gaps-null",
    "files.gaps",
    ONE,
    `${V0}/files/gaps`,
    "`files.gaps: null` on a container.",
    (d) => {
      v0(d).files.gaps = null;
    },
  );
  await brk(
    "pack-files-gaps-missing",
    "files.gaps-container",
    ONE,
    `${V0}/files/gaps`,
    "A container without `files.gaps`.",
    (d) => {
      delete v0(d).files.gaps;
    },
  );
  await brk(
    "pack-files-gaps-on-tree",
    "files.gaps-tree",
    MIN,
    `${V0}/files/gaps`,
    "A tree carrying `files.gaps`.",
    (d) => {
      v0(d).files.gaps = objRef("files/v2.gaps.zst");
    },
  );
  await brk(
    "pack-deltas-null",
    "deltas",
    ONE,
    `${V0}/deltas`,
    "`deltas: null`.",
    (d) => {
      v0(d).deltas = null;
    },
  );
  await brk(
    "pack-deltas-over-max",
    "deltas.count",
    ONE,
    `${V0}/deltas`,
    "17 `payload` deltas with distinct ids (at most 16).",
    (d) => {
      const base = pd(d);
      v0(d).deltas = Array.from({ length: 17 }, (_, k) => ({
        ...clone(base),
        artifact: {
          sha256: sha256Hex(`pkey-corpus-delta:${k}`),
          bytes: 312704,
        },
      }));
    },
  );
  await brk(
    "pack-delta-not-object",
    "deltas.item",
    ONE,
    `${V0}/deltas/0`,
    "A delta that is a number.",
    (d) => {
      v0(d).deltas[0] = 7;
    },
  );
  await brk(
    "pack-delta-id-duplicate",
    "deltas.id-unique",
    ONE,
    `${V0}/deltas`,
    "Two `payload` deltas with one id (`artifact.sha256`).",
    (d) => {
      v0(d).deltas = [clone(pd(d)), clone(pd(d))];
    },
  );
  await brk(
    "pack-delta-method-bad",
    "delta.method",
    ONE,
    `${V0}/deltas/0/method`,
    '`method: "Zstd"`, outside `VOCAB_TOKEN_PATTERN`.',
    (d) => {
      pd(d).method = "Zstd";
    },
  );
  await brk(
    "pack-delta-scope-empty",
    "delta.scope",
    ONE,
    `${V0}/deltas/0/scope`,
    '`scope: ""`.',
    (d) => {
      pd(d).scope = "";
    },
  );
  await brk(
    "pack-delta-payload-on-tree",
    "delta.scope-tree",
    MIN,
    `${V0}/deltas`,
    "A `payload` delta on a tree variant.",
    (d) => {
      v0(d).deltas = [
        {
          method: "zstd-patch-from",
          scope: "payload",
          from: PACK_PAYLOADS.treeV1.sha256,
          memBytes: 19000,
          artifact: hashBytes("deltas/v1-v2.pf.zst"),
        },
      ];
    },
  );
  await brk(
    "pack-delta-from-bad",
    "delta.from",
    ONE,
    `${V0}/deltas/0/from`,
    "`from` that is not 64 lowercase hex.",
    (d) => {
      pd(d).from = "088b";
    },
  );
  await brk(
    "pack-delta-mem-bytes-missing",
    "delta.memBytes",
    ONE,
    `${V0}/deltas/0/memBytes`,
    "A delta without `memBytes`.",
    (d) => {
      delete pd(d).memBytes;
    },
  );
  await brk(
    "pack-delta-artifact-missing",
    "delta.artifact",
    ONE,
    `${V0}/deltas/0/artifact`,
    "A `payload` delta without `artifact`.",
    (d) => {
      delete pd(d).artifact;
    },
  );
  await brk(
    "pack-delta-artifact-sha256-bad",
    "delta.artifact.sha256",
    ONE,
    `${V0}/deltas/0/artifact/sha256`,
    "`artifact.sha256` in uppercase hex.",
    (d) => {
      pd(d).artifact.sha256 = String(pd(d).artifact.sha256).toUpperCase();
    },
  );
  await brk(
    "pack-delta-artifact-bytes-missing",
    "delta.artifact.bytes",
    ONE,
    `${V0}/deltas/0/artifact/bytes`,
    "`artifact` without `bytes`.",
    (d) => {
      delete pd(d).artifact.bytes;
    },
  );
  await brk(
    "pack-delta-patch-missing",
    "delta.patch",
    ONE,
    `${V0}/deltas/1/patch`,
    "A `files` delta without `patch`.",
    (d) => {
      delete fd(d).patch;
    },
  );
  await brk(
    "pack-delta-data-missing",
    "delta.data",
    ONE,
    `${V0}/deltas/1/data`,
    "A `files` delta without `data`.",
    (d) => {
      delete fd(d).data;
    },
  );
  await brk(
    "pack-delta-data-sha256-bad",
    "delta.data.sha256",
    ONE,
    `${V0}/deltas/1/data/sha256`,
    "`data.sha256` with 63 hex digits.",
    (d) => {
      fd(d).data.sha256 = String(fd(d).data.sha256).slice(1);
    },
  );
  await brk(
    "pack-delta-data-bytes-missing",
    "delta.data.bytes",
    ONE,
    `${V0}/deltas/1/data/bytes`,
    "`data` without `bytes`.",
    (d) => {
      delete fd(d).data.bytes;
    },
  );
  await brk(
    "pack-requires-null",
    "requires",
    ONE,
    `${V0}/requires`,
    "`requires: null`.",
    (d) => {
      v0(d).requires = null;
    },
  );
  await brk(
    "pack-requires-engine-bad",
    "requires.engine",
    ONE,
    `${V0}/requires/engine`,
    '`requires.engine: "godot-4"`, outside `ENGINE_PATTERN`.',
    (d) => {
      v0(d).requires.engine = "godot-4";
    },
  );

  // kind: app, on the app twin.
  const C = "/content";
  const ct = (d: Record<string, any>): Record<string, any> => d.content;
  const pin0 = (d: Record<string, any>): Record<string, any> => ct(d).pins[0];
  const exp0 = (d: Record<string, any>): Record<string, any> =>
    ct(d).expects[0];
  const B0 = "/builds/0/embeds";
  await brk("app-content-null", "content", APP, C, "`content: null`.", (d) => {
    d.content = null;
  });
  await brk(
    "app-content-api-missing",
    "content.contentApi",
    APP,
    `${C}/contentApi`,
    "`content` without `contentApi`.",
    (d) => {
      delete ct(d).contentApi;
    },
  );
  await brk(
    "app-pins-missing",
    "content.pins",
    APP,
    `${C}/pins`,
    "`content` without `pins`.",
    (d) => {
      delete ct(d).pins;
    },
  );
  await brk(
    "app-pins-over-max",
    "content.pins.count",
    APP,
    `${C}/pins`,
    "257 pins with distinct packs (at most 256).",
    (d) => {
      const base = pin0(d);
      ct(d).pins = Array.from({ length: 257 }, (_, k) => ({
        ...clone(base),
        pack: `p${k}`,
      }));
    },
  );
  await brk(
    "app-pin-not-object",
    "content.pins.item",
    APP,
    `${C}/pins/0`,
    "A pin that is a number.",
    (d) => {
      ct(d).pins[0] = 7;
    },
  );
  await brk(
    "app-pins-duplicate-pack",
    "content.pins.unique",
    APP,
    `${C}/pins/1/pack`,
    "Two pins of `djdl.levels`.",
    (d) => {
      ct(d).pins[1].pack = "djdl.levels";
    },
  );
  await brk(
    "app-pin-pack-bad",
    "pin.pack",
    APP,
    `${C}/pins/0/pack`,
    '`pins[].pack: "Djdl.levels"`, outside the pack-id pattern.',
    (d) => {
      pin0(d).pack = "Djdl.levels";
    },
  );
  await brk(
    "app-pin-pack-over-64-bytes",
    "pin.pack",
    APP,
    `${C}/pins/0/pack`,
    "A 65-byte pack id.",
    (d) => {
      pin0(d).pack = "a".repeat(65);
    },
  );
  await brk(
    "app-pin-pack-app",
    "pin.pack.not-app",
    APP,
    `${C}/pins/0/pack`,
    '`pins[].pack: "app"`.',
    (d) => {
      pin0(d).pack = "app";
    },
  );
  await brk(
    "app-pin-release-missing",
    "pin.release",
    APP,
    `${C}/pins/0/release`,
    "A pin without `release`.",
    (d) => {
      delete pin0(d).release;
    },
  );
  await brk(
    "app-pin-sha256-bad",
    "pin.release.sha256",
    APP,
    `${C}/pins/0/release/sha256`,
    "`release.sha256` in uppercase hex.",
    (d) => {
      pin0(d).release.sha256 = String(pin0(d).release.sha256).toUpperCase();
    },
  );
  await brk(
    "app-pin-seq-missing",
    "pin.release.seq",
    APP,
    `${C}/pins/0/release/seq`,
    "`release` without `seq`.",
    (d) => {
      delete pin0(d).release.seq;
    },
  );
  await brk(
    "app-pin-version-trailing-newline",
    "pin.release.version",
    APP,
    `${C}/pins/0/release/version`,
    'Whole-string patterns: `release.version` `"1.1.0\\n"`.',
    (d) => {
      pin0(d).release.version = "1.1.0\n";
    },
  );
  await brk(
    "app-expects-missing",
    "content.expects",
    APP,
    `${C}/expects`,
    "`content` without `expects`.",
    (d) => {
      delete ct(d).expects;
    },
  );
  await brk(
    "app-expects-over-max",
    "content.expects.count",
    APP,
    `${C}/expects`,
    "257 expects with distinct packs (at most 256).",
    (d) => {
      const base = exp0(d);
      ct(d).expects = Array.from({ length: 257 }, (_, k) => ({
        ...clone(base),
        pack: `p${k}`,
      }));
    },
  );
  await brk(
    "app-expect-not-object",
    "content.expects.item",
    APP,
    `${C}/expects/0`,
    "An expect that is a number.",
    (d) => {
      ct(d).expects[0] = 7;
    },
  );
  await brk(
    "app-expects-duplicate-pack",
    "content.expects.unique",
    APP,
    `${C}/expects/1/pack`,
    "Two expects of `djdl.levels`.",
    (d) => {
      ct(d).expects[1].pack = "djdl.levels";
    },
  );
  await brk(
    "app-expect-pack-bad",
    "expect.pack",
    APP,
    `${C}/expects/0/pack`,
    '`expects[].pack: "djdl..levels"`, outside the pack-id pattern.',
    (d) => {
      exp0(d).pack = "djdl..levels";
    },
  );
  await brk(
    "app-expect-pack-over-64-bytes",
    "expect.pack",
    APP,
    `${C}/expects/0/pack`,
    "A 65-byte pack id.",
    (d) => {
      exp0(d).pack = "b".repeat(65);
    },
  );
  await brk(
    "app-expect-pack-app",
    "expect.pack.not-app",
    APP,
    `${C}/expects/0/pack`,
    '`expects[].pack: "app"`.',
    (d) => {
      exp0(d).pack = "app";
    },
  );
  await brk(
    "app-expect-required-not-boolean",
    "expect.required",
    APP,
    `${C}/expects/0/required`,
    '`required: "yes"`.',
    (d) => {
      exp0(d).required = "yes";
    },
  );
  await brk(
    "app-expect-delivery-empty",
    "expect.delivery",
    APP,
    `${C}/expects/0/delivery`,
    '`delivery: ""`.',
    (d) => {
      exp0(d).delivery = "";
    },
  );
  await brk(
    "app-embeds-null",
    "embeds",
    APP,
    B0,
    "`builds[].embeds: null`.",
    (d) => {
      d.builds[0].embeds = null;
    },
  );
  await brk(
    "app-embeds-over-max",
    "embeds.count",
    APP,
    B0,
    "65 distinct embedded packs (at most 64).",
    (d) => {
      d.builds[0].embeds = Array.from({ length: 65 }, (_, k) => `p${k}`);
    },
  );
  await brk(
    "app-embeds-item-bad",
    "embeds.item",
    APP,
    B0,
    "An embedded pack id `Djdl`.",
    (d) => {
      d.builds[0].embeds = ["Djdl"];
    },
  );
  await brk(
    "app-embeds-item-over-64-bytes",
    "embeds.item",
    APP,
    B0,
    "A 65-byte embedded pack id.",
    (d) => {
      d.builds[0].embeds = ["c".repeat(65)];
    },
  );
  await brk(
    "app-embeds-app",
    "embeds.not-app",
    APP,
    B0,
    "`app` among the embedded packs.",
    (d) => {
      d.builds[0].embeds = ["app"];
    },
  );
  await brk(
    "app-embeds-duplicate",
    "embeds.unique",
    APP,
    B0,
    "One pack embedded twice.",
    (d) => {
      d.builds[0].embeds = ["djdl.levels", "djdl.levels"];
    },
  );

  // ── Cross-check, hash and key (6) ──
  const PACK_PIN: PackPin = {
    kind: "pack",
    deliverable: "djdl.levels",
    version: "1.1.0",
    seq: 2,
  };
  await mk(
    "pack-pin-version-mismatch",
    "Step 15: the pack record's version is not the pin's.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, version: "1.0.0" },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-seq-mismatch",
    "Step 15: the pack record's `seq` is not the pin's.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, seq: 1 },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-deliverable-mismatch",
    "Step 15: the pack record's `deliverable` is not the pin's pack id.",
    {
      jws: LV2.jws,
      pin: { ...PACK_PIN, deliverable: "djdl.assets" },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-pin-kind-app",
    "Step 15: an app record where a pack is pinned (`kind` differs; deliverable, version and `seq` match).",
    {
      doc: APP,
      pin: { kind: "pack", deliverable: "app", version: "1.5.0", seq: 15 },
      expect: fail("cross-check"),
    },
  );
  await mk(
    "pack-hash-mismatch",
    "Step 12: the body's SHA-256 is not the pin (another valid pack record).",
    {
      jws: LV2.jws,
      expectedHash: LV1.sha256,
      expect: fail("hash"),
    },
  );
  await mk(
    "pack-signed-by-product-key",
    "A pack record signed by the PRODUCT key: its kid is not among the pinned release keys.",
    {
      doc: LV2.doc,
      kid: PIN_KID,
      expect: fail("jws"),
    },
  );

  // ── Integers (48): token, bound and minimum per §2.5 path, each breaking its path alone ──
  const intRow = async (
    pointer: string,
    twin: Record<string, unknown>,
    ids: [string, string, string],
    tokens: [string, string],
    member: string,
  ): Promise<void> => {
    const at = (d: Record<string, any>, token: unknown): void => {
      const parts = pointer.split("/").slice(1);
      let o: any = d;
      for (const p of parts.slice(0, -1)) o = o[p];
      o[parts[parts.length - 1]!] = token;
    };
    const [tokenId, boundId, minId] = ids;
    const t = clone(twin) as Record<string, any>;
    at(t, raw(tokens[0]));
    await mk(
      tokenId,
      `V4 §3: the ${member} token \`${tokens[0]}\` at \`${pointer}\`.`,
      {
        text: rawJson(t),
        expect: fail("claims"),
      },
    );
    const b = clone(twin) as Record<string, any>;
    at(b, raw(BIG_OVER));
    await mk(boundId, `V4 §3: ${member} ${BIG_OVER} at \`${pointer}\`.`, {
      text: rawJson(b),
      expect: fail("claims"),
    });
    const m = clone(twin) as Record<string, any>;
    at(m, tokens[1] === "0" ? 0 : -1);
    await mk(
      minId,
      `V4 §3 minimums: ${member} ${tokens[1] === "0" ? 0 : -1} at \`${pointer}\` (minimum ${tokens[1] === "0" ? 1 : 0}).`,
      {
        doc: m,
        expect: fail("claims"),
      },
    );
    PACK_PER_CLAIM.push([pointer, tokenId, boundId, minId]);
  };
  const tok = (pointer: string, twin: Record<string, unknown>): number => {
    let o: any = twin;
    for (const p of pointer.split("/").slice(1)) o = o[p];
    return o as number;
  };
  const IF = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}.0`;
  const NI = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}.0000000000000001`;
  const EX = (p: string, tw: Record<string, unknown>): string =>
    `${tok(p, tw)}e0`;
  const rows: [
    string,
    Record<string, unknown>,
    string,
    (p: string, t: Record<string, unknown>) => string,
    "0" | "-1",
    string,
  ][] = [
    ["/formatVersion", ONE, "pack-format-version", IF, "0", "`formatVersion`"],
    ["/handler/mountOrder", ONE, "pack-mount-order", NI, "-1", "`mountOrder`"],
    [
      `${V0}/payload/size`,
      ONE,
      "pack-payload-size",
      IF,
      "-1",
      "`payload.size`",
    ],
    [`${V0}/full/bytes`, ONE, "pack-full-bytes", NI, "-1", "`full.bytes`"],
    [`${V0}/full/size`, ONE, "pack-full-size", EX, "-1", "`full.size`"],
    [`${V0}/files/bytes`, ONE, "pack-files-bytes", IF, "0", "`files.bytes`"],
    [`${V0}/files/size`, ONE, "pack-files-size", NI, "0", "`files.size`"],
    [
      `${V0}/files/gaps/bytes`,
      ONE,
      "pack-gaps-bytes",
      IF,
      "-1",
      "`gaps.bytes`",
    ],
    [`${V0}/files/gaps/size`, ONE, "pack-gaps-size", NI, "-1", "`gaps.size`"],
    [`${V0}/deltas/0/memBytes`, ONE, "pack-mem-bytes", EX, "0", "`memBytes`"],
    [
      `${V0}/deltas/0/artifact/bytes`,
      ONE,
      "pack-artifact-bytes",
      NI,
      "0",
      "`artifact.bytes`",
    ],
    [
      `${V0}/deltas/1/patch/bytes`,
      ONE,
      "pack-patch-bytes",
      IF,
      "0",
      "`patch.bytes`",
    ],
    [
      `${V0}/deltas/1/patch/size`,
      ONE,
      "pack-patch-size",
      NI,
      "0",
      "`patch.size`",
    ],
    [
      `${V0}/deltas/1/data/bytes`,
      ONE,
      "pack-data-bytes",
      IF,
      "0",
      "`data.bytes`",
    ],
    ["/content/contentApi", APP, "app-content-api", NI, "0", "`contentApi`"],
    [
      "/content/pins/0/release/seq",
      APP,
      "app-pin-seq",
      IF,
      "0",
      "`pins[].release.seq`",
    ],
  ];
  for (const [pointer, twin, stem, token, min, member] of rows) {
    const kind =
      token === IF
        ? "integral-fraction"
        : token === NI
          ? "near-integer"
          : "exponent";
    await intRow(
      pointer,
      twin,
      [
        `${stem}-${kind}`,
        `${stem}-over-max`,
        `${stem}-${min === "0" ? "zero" : "negative"}`,
      ],
      [token(pointer, twin), min],
      member,
    );
  }

  // ── plans/P4-10.md §4.5: `chunks` (+11), appended after P4-01's 159 ──
  const CH: Record<string, unknown> = clone(ONE);
  (CH.variants as Record<string, any>[])[0]!.chunks = levelsChunks();
  {
    const L3 = rec("djdl.levels@1.2.0");
    await mk(
      "pack-valid-chunks",
      "`djdl.levels@1.2.0`: v2's payload republished by a chunk-aware CI; both variants carry `chunks` pinning `chunks/v2.pkc.zst`, which joins the content corpus by SHA-256 (plans/P4-10.md §4.5).",
      { jws: L3.jws, expect: ok("pack", L3.doc) },
    );
  }
  {
    const d = clone(CH);
    const c = (d.variants as Record<string, any>[])[0]!.chunks;
    c.format = "pkey-chunks/2";
    c.codec = "lz4";
    c.deltas = [];
    c.params = { ...c.params, later: { anything: true }, avgSize: "big" };
    await mk(
      "pack-valid-chunks-forward",
      "`chunks` with format `pkey-chunks/2`, codec `lz4`, an extra `deltas: []` member and unknown `params` members: it verifies, and its chunks are only unusable.",
      { doc: d, expect: ok("pack") },
    );
  }
  await brk(
    "pack-chunks-null",
    "chunks",
    CH,
    `${V0}/chunks`,
    "`chunks: null` (absent or an object).",
    (d) => {
      v0(d).chunks = null;
    },
  );
  await brk(
    "pack-chunks-format-empty",
    "chunks.format",
    CH,
    `${V0}/chunks/format`,
    '`chunks.format: ""`, outside `OBJECT_FORMAT_PATTERN`.',
    (d) => {
      v0(d).chunks.format = "";
    },
  );
  await brk(
    "pack-chunks-params-not-object",
    "chunks.params",
    CH,
    `${V0}/chunks/params`,
    "`chunks.params: 7` (absent or an object).",
    (d) => {
      v0(d).chunks.params = 7;
    },
  );
  for (const [pointer, stem, token, min, member] of [
    [`${V0}/chunks/bytes`, "pack-chunks-bytes", IF, "0", "`chunks.bytes`"],
    [`${V0}/chunks/size`, "pack-chunks-size", NI, "0", "`chunks.size`"],
  ] as const) {
    const kind = token === IF ? "integral-fraction" : "near-integer";
    await intRow(
      pointer,
      CH,
      [`${stem}-${kind}`, `${stem}-over-max`, `${stem}-zero`],
      [token(pointer, CH), min],
      member,
    );
  }

  if (cases.length !== 170)
    throw new Error(`packRecordCases: ${cases.length} != 170`);
  for (const c of cases) {
    const want = refVerifyPackCase(c);
    if (
      JSON.stringify({ ...want, doc: undefined }) !==
      JSON.stringify({ ...c.expect, doc: undefined })
    )
      throw new Error(
        `packRecordCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
  }
  return cases;
}

// ── `markerCases` (17), V4 §3.7 ──────────────────────────────────────────────────────────────

/** The marker's `release` when the marker text is a JSON object holding a string there. */
export function markerRelease(text: string): string | null {
  try {
    const m = JSON.parse(text) as unknown;
    return isObj(m) && typeof m.release === "string" ? m.release : null;
  } catch {
    return null;
  }
}

export async function buildMarkerCases(): Promise<MarkerCase[]> {
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const PT = { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) };
  const packs = await packRecords();
  const LV2 = packs.get("djdl.levels@1.1.0")!;
  const AS2 = packs.get("djdl.assets@1.1.0")!;
  const DOC1 = packs.get("djdl.docs@1.0.0")!;
  const cases: MarkerCase[] = [];
  const marker = (o: Record<string, unknown>): string => JSON.stringify(o);
  const of = (r: RecordVector, over: Record<string, unknown> = {}): string =>
    marker({
      format: "pkey-marker/1",
      packId: r.doc.deliverable,
      version: r.doc.version,
      release: r.jws,
      ...over,
    });
  const mk = (
    id: string,
    description: string,
    text: string,
    expect: MarkerCase["expect"],
    releaseKeys: Record<string, string> = RK,
  ): void => {
    const c: MarkerCase = {
      id,
      description,
      marker: text,
      releaseKeys,
      productTrust: PT,
      expectedAud: AUD_V3,
      expect,
    };
    const release = markerRelease(text);
    let nonWire: string[] = [];
    if (release !== null) {
      const parts = release.split(".");
      let kid: unknown;
      try {
        kid = (
          JSON.parse(
            new TextDecoder().decode(base64UrlDecode(parts[0] ?? "")),
          ) as Record<string, unknown>
        ).kid;
      } catch {
        kid = undefined;
      }
      const v =
        typeof kid === "string" && hasOwn(releaseKeys, kid)
          ? refVerifyJws(
              release,
              { [kid]: releaseKeys[kid]! },
              "pkey-release+jws",
            )
          : null;
      if (v) nonWire = refNonWire(v.text);
    }
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const okOf = (r: RecordVector): MarkerCase["expect"] => ({
    verify: "ok",
    packId: r.doc.deliverable as string,
    version: r.doc.version as string,
    recordSha256: r.sha256,
  });
  const fail = (
    step: "format" | "hash" | "jws" | "claims" | "cross-check",
  ): MarkerCase["expect"] => ({ verify: "fail", step });

  mk(
    "marker-valid",
    "`djdl.levels.pck.pkey.json`: the marker beside a single-file payload, carrying `djdl.levels@1.1.0`.",
    of(LV2),
    okOf(LV2),
  );
  mk(
    "marker-valid-tree",
    "`.pkey/pack.json` inside a tree, carrying `djdl.assets@1.1.0`.",
    of(AS2),
    okOf(AS2),
  );
  {
    const jws = await signAs(DOC1.doc, REL2_KID, "pkey-release+jws");
    const r = { ...DOC1, jws, sha256: sha256Hex(jws) };
    mk(
      "marker-valid-rotation-second-key",
      "A marker whose record is signed by the 2027 release key while both are pinned.",
      of(r),
      okOf(r),
      { ...RK, [REL2_KID]: pub(REL2_KID) },
    );
  }
  mk(
    "marker-not-object",
    "Step 1: the marker is a JSON array.",
    "[]",
    fail("format"),
  );
  mk(
    "marker-duplicate-member",
    "Step 1: strict JSON refuses a marker that declares `version` twice.",
    of(LV2).replace('"version":"1.1.0"', '"version":"1.1.0","version":"1.0.0"'),
    fail("format"),
  );
  mk(
    "marker-leading-bom",
    "Step 1: a leading byte-order mark.",
    `\ufeff${of(LV2)}`,
    fail("format"),
  );
  mk(
    "marker-format-unknown",
    "Step 2: `format: pkey-marker/2`.",
    of(LV2, { format: "pkey-marker/2" }),
    fail("format"),
  );
  mk(
    "marker-pack-id-bad",
    "Step 2: `packId` outside the pack-id pattern.",
    of(LV2, { packId: "djdl.Levels" }),
    fail("format"),
  );
  mk(
    "marker-release-not-string",
    "Step 2: `release` is an object.",
    of(LV2, { release: { jws: LV2.jws } }),
    fail("format"),
  );
  {
    const [h, p, s] = LV2.jws.split(".") as [string, string, string];
    const padded = `${h}.${p}${"A".repeat(88845 - LV2.jws.length)}.${s}`;
    if (padded.length !== 88845)
      throw new Error("marker-release-over-bound length");
    mk(
      "marker-release-over-bound",
      "Step 3: a `release` of 88,845 ASCII bytes, one over the bound, refused before hashing.",
      of(LV2, { release: padded }),
      fail("hash"),
    );
  }
  mk(
    "marker-release-non-ascii",
    "Step 3: a `release` with a byte outside ASCII, refused before hashing.",
    of(LV2, { release: `${LV2.jws}é` }),
    fail("hash"),
  );
  {
    const jws = await signAs(LV2.doc, PIN_KID, "pkey-release+jws");
    mk(
      "marker-signed-by-product-key",
      "Step 3: the record is signed by the PRODUCT key, whose kid is not a pinned release key.",
      of(LV2, { release: jws }),
      fail("jws"),
    );
  }
  mk(
    "marker-key-dropped",
    "Step 3: the record is signed by the 2026 key after it left the pinned set.",
    of(LV2),
    fail("jws"),
    { [REL2_KID]: pub(REL2_KID) },
  );
  {
    const jws = await signAs(
      { ...LV2.doc, type: "godot" },
      REL_KID,
      "pkey-release+jws",
    );
    mk(
      "marker-record-claims",
      'Step 3: the record fails the pack claims (`type: "godot"`).',
      of(LV2, { release: jws }),
      fail("claims"),
    );
  }
  mk(
    "marker-pack-id-mismatch",
    "Step 4: the marker names `djdl.assets`, the record `djdl.levels`.",
    of(LV2, { packId: "djdl.assets" }),
    fail("cross-check"),
  );
  mk(
    "marker-version-mismatch",
    "Step 4: the marker names 1.0.0, the record 1.1.0.",
    of(LV2, { version: "1.0.0" }),
    fail("cross-check"),
  );
  {
    const jws = await signAs(appTwin(packs), REL_KID, "pkey-release+jws");
    mk(
      "marker-record-is-app",
      "Step 4: the record is a valid app record, not a pack record.",
      of(LV2, { release: jws, packId: "djdl.levels", version: "1.5.0" }),
      fail("cross-check"),
    );
  }

  if (cases.length !== 17)
    throw new Error(`markerCases: ${cases.length} != 17`);
  for (const c of cases) {
    const want = refVerifyMarkerCase(c);
    if (JSON.stringify(want) !== JSON.stringify(c.expect))
      throw new Error(
        `markerCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
  }
  return cases;
}

/** §4.2's per-check self-check: the registry is §4.6's table, every registered id has a case,
 *  and every structure case breaks its one property and is refused by its check alone. */
export function checkPackClaimCases(corpus: Record<string, AnyCase[]>): void {
  const fail = (m: string): never => {
    throw new Error(`packRecordCases self-check: ${m}`);
  };
  if (PACK_CLAIM_CHECKS.length !== 83 || PACK_CHECK_SET.size !== 83)
    fail("the registry must hold 83 distinct checks");
  const byId = new Map(corpus.packRecordCases!.map((c) => [c.id as string, c]));
  const covered = new Set<string>();
  for (const [id, s] of PACK_STRUCTURE) {
    const c = byId.get(id) ?? fail(`${id} is not a packRecordCases case`);
    covered.add(s.check);
    const text = payloadTextOf(c.jws)!;
    const doc = JSON.parse(text) as unknown;
    const diff = leafDiff(s.twin, doc);
    if (diff.length === 0) fail(`${id} equals its twin`);
    for (const p of diff)
      if (p !== s.prop && !p.startsWith(`${s.prop}/`))
        fail(`${id} differs from its twin at ${p}, outside ${s.prop}`);
    if (!refRecordClaims(s.twin, ctxOf(JSON.stringify(s.twin)), AUD_V3))
      fail(`${id}'s twin fails the claims`);
    if (refRecordClaims(doc, ctxOf(text), AUD_V3))
      fail(`${id}: the claims accept it`);
    if (!refRecordClaims(doc, ctxOf(text, [`check:${s.check}`]), AUD_V3))
      fail(`${id}: it fails beyond check ${s.check}`);
  }
  for (const id of PACK_CLAIM_CHECKS)
    if (!covered.has(id)) fail(`check ${id} has no case`);
  if (PACK_STRUCTURE.size !== 95)
    fail(`${PACK_STRUCTURE.size} structure cases, not 95`);
  if (PACK_PER_CLAIM.length !== 18)
    fail(`${PACK_PER_CLAIM.length} integer paths, not 18`);
  // plans/P4-10.md §4.2: pack-valid-chunks' `chunks` ref is `chunks/v2.pkc.zst`'s (the join).
  {
    const want = objRef("chunks/v2.pkc.zst");
    const l3 = PACK_RECORDS!.get("djdl.levels@1.2.0")!.doc;
    for (const v of l3.variants as Record<string, any>[]) {
      const c = v.chunks as Record<string, unknown>;
      for (const k of ["sha256", "bytes", "size", "codec"])
        if (c[k] !== want[k])
          fail(`djdl.levels@1.2.0's chunks.${k} is not chunks/v2.pkc.zst's`);
    }
  }
  // The valid pack records pin only §4.2's table.
  for (const r of PACK_RECORDS!.values()) {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) {
        if (typeof v.sha256 === "string" && typeof v.bytes === "number")
          refs.push(v.sha256);
        Object.values(v).forEach(walk);
      }
    };
    walk(r.doc.variants);
    for (const h of refs)
      if (!packObjectHashes().has(h))
        fail(`${r.name} pins ${h}, outside the object table`);
  }
}
