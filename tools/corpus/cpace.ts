// `noise-vectors.json` section `cpace` (CC-29.1; WIRE-CONTRACT-V5 §15.12, "The mode-q handshake"):
// the CPace known answers for account-free local pairing. The draft's own vectors are vendored
// in `inputs/cpace-anchors.json` (hash-checked) and reproduced by `reference/cpace.ts`; the rows
// built here (Elligator 2 map, generators for a code and for a QR, share refusals, the frames C1
// and C2, whole attempts, the all-zero K abort) are all recomputed through that reference, which
// shares nothing with client-core. The generator throws when a vendored hash or a reproduced
// answer disagrees.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./common.js";
import {
  type CpaceKind,
  type RefCpaceOut,
  REF_P,
  bytesHex,
  hexBytes,
  refC1,
  refC2,
  refCpaceGenerator,
  refCpacePsk as refCpaceRunPsk,
  refCpaceRun,
  refElligator2,
  refEncodeU,
  refGeneratorString,
  refIsk,
  refIskOc,
  refIsZero32,
  refLvCat,
  refOCat,
  refParseC1,
  refParseC2,
  refPrependLen,
  refPrs,
  refShare,
  refShareCheck,
  refTranscriptIr,
  refTranscriptOc,
} from "./reference/cpace.js";
import { refPrologue, utf8 } from "./reference/peerMatrix.js";
import { REF_X25519_LOW_ORDER_HEX } from "./reference/peer.js";
import { refX25519, sha256 } from "./reference/noise.js";

const hex = bytesHex;
const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));

/** Fixed test material: SHA-256 of a label. Never used outside the corpus. */
const mat = (label: string): Uint8Array =>
  sha256(utf8(`pkey-peer/1 cpace vector ${label}`));

const ANCHORS_PATH = join(
  REPO_ROOT,
  "tools",
  "corpus",
  "inputs",
  "cpace-anchors.json",
);

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

function check(label: string, got: string, want: string): void {
  if (got !== want)
    throw new Error(`cpace ${label}: reference gives ${got}, row says ${want}`);
}

// ── The draft's vectors ──────────────────────────────────────────────────────

interface AnchorVector {
  id: string;
  title: string;
  sha256: string;
  vector: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
interface AnchorFile {
  description: string;
  suite: string;
  source: { id: string; url: string; sha256: string; sections: string };
  vectors: AnchorVector[];
}

const H = (s: string): Uint8Array => hexBytes(s);

function checkAnchor(a: AnchorVector): void {
  const v = a.vector;
  switch (a.id) {
    case "B.1.1": {
      const prs = H(v.PRS);
      const gen = refCpaceGenerator(prs, H(v.CI), H(v.sid));
      check(
        "B.1.1 generator string",
        hex(gen.generatorString),
        v.generatorString,
      );
      if (
        refGeneratorString(H(v.DSI), prs, H(v.CI), H(v.sid), 128).length -
          (1 + 8 + 1 + 8 + 1 + v.zpadLength + 1 + 24 + 1 + 16) !==
        0
      )
        throw new Error("cpace B.1.1: zero padding length");
      check("B.1.1 hash", hex(gen.hash), v.hashGeneratorString);
      check("B.1.1 decoded", hex(gen.decoded), v.decodedFieldElement);
      check("B.1.1 g", hex(gen.g), v.g);
      return;
    }
    case "B.1.2-B.1.5": {
      const g = H(
        "d04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f",
      );
      const sid = H("7e4b4791d6a8ef019b936c79fb7f2c57");
      check("B.1.2 Ya", hex(refShare(H(v.ya), g)), v.Ya);
      check("B.1.3 Yb", hex(refShare(H(v.yb), g)), v.Yb);
      check("B.1.4 K (a)", hex(refX25519(H(v.ya), H(v.Yb))), v.K);
      check("B.1.4 K (b)", hex(refX25519(H(v.yb), H(v.Ya))), v.Kb);
      const tIr = refTranscriptIr(H(v.Ya), H(v.ADa), H(v.Yb), H(v.ADb));
      check("B.1.5 transcript_ir", hex(tIr), v.transcriptIr);
      check(
        "B.1.5 ISK input",
        hex(cat(refLvCat(utf8("CPace255_ISK"), sid, H(v.K)), tIr)),
        v.iskInput,
      );
      check(
        "B.1.5 ISK",
        hex(refIsk(sid, H(v.K), H(v.Ya), H(v.Yb), H(v.ADa), H(v.ADb))),
        v.isk,
      );
      const tOc = refTranscriptOc(H(v.Ya), H(v.ADa), H(v.Yb), H(v.ADb));
      check("B.1.6 transcript_oc", hex(tOc), v.transcriptOc);
      check(
        "B.1.6 ISK",
        hex(refIskOc(sid, H(v.K), H(v.Ya), H(v.Yb), H(v.ADa), H(v.ADb))),
        v.iskOc,
      );
      const sidOut = (t: Uint8Array): string =>
        createHash("sha512")
          .update(cat(utf8("CPaceSidOutput"), t))
          .digest("hex");
      check("B.1.7 sid output (ir)", sidOut(tIr), v.sidOutputIr);
      check("B.1.7 sid output (oc)", sidOut(tOc), v.sidOutputOc);
      return;
    }
    case "B.1.10": {
      for (const k of Object.keys(v.u)) {
        check(`B.1.10 q${k}`, hex(refX25519(H(v.s), H(v.u[k]))), v.q[k]);
      }
      for (const k of v.abort as string[])
        if (!refIsZero32(H(v.q[k])))
          throw new Error(`cpace B.1.10 u${k}: not an abort vector`);
      return;
    }
    default: {
      // Appendix A: the string functions.
      const fn = v.fn as string;
      for (const c of v.cases as { in: any; out: string }[]) {
        const got =
          fn === "prepend_len"
            ? refPrependLen(H(c.in))
            : fn === "lv_cat"
              ? refLvCat(...(c.in as string[]).map(H))
              : fn === "transcript_ir"
                ? refTranscriptIr(
                    ...((c.in as [string, string, string, string]).map(H) as [
                      Uint8Array,
                      Uint8Array,
                      Uint8Array,
                      Uint8Array,
                    ]),
                  )
                : refOCat(H(c.in[0]), H(c.in[1]));
        check(`${a.id}`, hex(got), c.out);
      }
    }
  }
}

function buildAnchors(): unknown {
  const file = JSON.parse(readFileSync(ANCHORS_PATH, "utf8")) as AnchorFile;
  for (const a of file.vectors) {
    const sum = createHash("sha256")
      .update(canonicalJson(a.vector))
      .digest("hex");
    if (sum !== a.sha256)
      throw new Error(
        `cpace anchor ${a.id}: vector hash ${sum} is not the pinned ${a.sha256}`,
      );
    checkAnchor(a);
  }
  return {
    note: "Vectors of the pinned CFRG draft (CPACE-X25519-SHA512; appendix A.1 to A.3 and B.1), copied from its text with byte strings as lower-case hex. `source` pins the draft by URL and the SHA-256 of the whole file; each vector's `sha256` is over it as sorted-key compact JSON. B.1.1: generator string, hash, decoded field element and generator g for PRS 'Password', CI and a 16-byte sid; B.1.2 to B.1.5: shares, K and ISK (initiator/responder, and the parallel setting) with ADa = 'ADa' and ADb = 'ADb'; B.1.10: X25519(s, u) for the low-order and non-canonical u (the vectors in `abort` give an all-zero K). The reference reproduces every value.",
    suite: file.suite,
    source: file.source,
    vectors: file.vectors.map(({ id, title, sha256: s, vector }) => ({
      id,
      title,
      sha256: s,
      vector,
    })),
  };
}

// ── Elligator 2 ──────────────────────────────────────────────────────────────

function buildElligator(): unknown[] {
  const le = (n: bigint): Uint8Array => refEncodeU(n);
  const withTop = (b: Uint8Array): Uint8Array => {
    const c = Uint8Array.from(b);
    c[31] = c[31]! | 0x80;
    return c;
  };
  // The smallest r that lands on each branch (found with the reference, pinned by the row).
  const branch = (want: boolean): bigint => {
    for (let r = 1n; ; r++) if (refElligator2(le(r)).onCurve === want) return r;
  };
  const rows: [string, Uint8Array][] = [
    ["zero", le(0n)],
    ["one", le(1n)],
    ["two", le(2n)],
    ["first-on-curve", le(branch(true))],
    ["first-on-twist", le(branch(false))],
    ["zero-top-bit-set", withTop(le(0n))],
    ["one-top-bit-set", withTop(le(1n))],
    [
      "draft-hash-b11",
      H("03998087bdb1a2617bbe25ef5a7c18cd4f84f902328701790958755ee4aed1d3"),
    ],
    [
      "draft-decoded-b11",
      H("03998087bdb1a2617bbe25ef5a7c18cd4f84f902328701790958755ee4aed153"),
    ],
    ["p-minus-1", le(REF_P - 1n)],
    ["p", le(REF_P)],
    ["p-plus-1", le(REF_P + 1n)],
    ["p-plus-18", le((1n << 255n) - 1n)],
    ["all-ones", new Uint8Array(32).fill(0xff)],
    ["half-p", le((REF_P - 1n) / 2n)],
    ["pattern", mat("elligator pattern")],
    ["pattern-top-bit-set", withTop(mat("elligator pattern"))],
  ];
  return rows.map(([id, input]) => {
    const e = refElligator2(input);
    return {
      id,
      input: hex(input),
      // decodeUCoordinate(input, 255) mod p, as 32 little-endian bytes.
      r: hex(e.r),
      // True when v = -A / (1 + 2 r^2) is a u-coordinate on the curve; false when the twist's
      // x = -v - A is used.
      onCurve: e.onCurve,
      u: hex(e.u),
    };
  });
}

// ── Generators ───────────────────────────────────────────────────────────────

const SLUG = "demo";
const ci = (slug: string): Uint8Array => refPrologue(slug, "q");
const SID = mat("sid").slice(0, 10);

interface GenIn {
  id: string;
  kind: CpaceKind;
  secret: string;
  slug?: string;
  sid?: Uint8Array;
}

const QR_SECRET = hex(mat("qr secret").slice(0, 16));
const QR_SECRET_2 = hex(mat("qr secret 2").slice(0, 16));
export const CPACE_QR_SECRET_2 = QR_SECRET_2;

function buildGenerators(): unknown[] {
  const rows: GenIn[] = [
    { id: "code-123456", kind: "code", secret: "123456" },
    { id: "code-000000", kind: "code", secret: "000000" },
    { id: "code-000001", kind: "code", secret: "000001" },
    { id: "code-999999", kind: "code", secret: "999999" },
    { id: "code-other-slug", kind: "code", secret: "123456", slug: "other" },
    {
      id: "code-other-sid",
      kind: "code",
      secret: "123456",
      sid: mat("sid 2").slice(0, 10),
    },
    { id: "qr", kind: "qr", secret: QR_SECRET },
    { id: "qr-other-secret", kind: "qr", secret: QR_SECRET_2 },
    { id: "qr-other-slug", kind: "qr", secret: QR_SECRET, slug: "other" },
    { id: "qr-all-zero-secret", kind: "qr", secret: "00".repeat(16) },
  ];
  return rows.map((r) => {
    const slug = r.slug ?? SLUG;
    const sid = r.sid ?? SID;
    const prs = refPrs(r.kind, r.secret);
    const g = refCpaceGenerator(prs, ci(slug), sid);
    return {
      id: r.id,
      kind: r.kind,
      // The 6 ASCII digits of a code, or the 16 QR secret bytes as hex.
      secret: r.secret,
      slug,
      prs: hex(prs),
      ci: hex(ci(slug)),
      sid: hex(sid),
      generatorString: hex(g.generatorString),
      hash: hex(g.hash),
      decoded: hex(g.decoded),
      g: hex(g.g),
    };
  });
}

// ── Shares and frames ────────────────────────────────────────────────────────

const g0 = refCpaceGenerator(refPrs("code", "123456"), ci(SLUG), SID).g;
const goodShare = refShare(mat("share scalar"), g0);
const withTop = (b: Uint8Array): Uint8Array => {
  const c = Uint8Array.from(b);
  c[31] = c[31]! | 0x80;
  return c;
};

function buildShares(): unknown[] {
  const rows: [string, Uint8Array][] = [
    ["valid-share", goodShare],
    ["valid-share-2", refShare(mat("share scalar 2"), g0)],
    ["base-point", H(`09${"00".repeat(31)}`)],
    ["u-2", H(`02${"00".repeat(31)}`)],
    ["p-minus-2", refEncodeU(REF_P - 2n)],
    ["top-bit-set", withTop(goodShare)],
    ["top-bit-set-base-point", withTop(H(`09${"00".repeat(31)}`))],
    ["p", refEncodeU(REF_P)],
    ["p-plus-1", refEncodeU(REF_P + 1n)],
    ["p-plus-9", refEncodeU(REF_P + 9n)],
    ["max-below-2-255", refEncodeU((1n << 255n) - 1n)],
    ["all-ones", new Uint8Array(32).fill(0xff)],
    ["short-31", goodShare.slice(0, 31)],
    ["long-33", cat(goodShare, Uint8Array.of(0))],
    ["empty", new Uint8Array(0)],
  ];
  REF_X25519_LOW_ORDER_HEX.forEach((h, k) => {
    rows.push([`low-order-${k}`, H(h)]);
    rows.push([`low-order-${k}-top-bit-set`, withTop(H(h))]);
  });
  return rows.map(([id, y]) => {
    const v = refShareCheck(y);
    return {
      id,
      share: hex(y),
      want: v.ok ? { ok: true } : { ok: false, reason: v.reason },
    };
  });
}

function buildFrames(): unknown {
  const ya = goodShare;
  const yb = refShare(mat("share scalar b"), g0);
  const c1: [string, Uint8Array][] = [
    ["code", refC1("code", ya)],
    ["qr", refC1("qr", ya)],
    ["length-33", refC1("code", ya).slice(0, 33)],
    ["length-35", cat(refC1("code", ya), Uint8Array.of(0))],
    ["empty", new Uint8Array(0)],
    ["version-0", cat(Uint8Array.of(0, 1), ya)],
    ["version-2", cat(Uint8Array.of(2, 1), ya)],
    ["kind-0", cat(Uint8Array.of(1, 0), ya)],
    ["kind-3", cat(Uint8Array.of(1, 3), ya)],
    ["kind-255", cat(Uint8Array.of(1, 255), ya)],
    ["share-top-bit-set", refC1("code", withTop(ya))],
    ["share-p", refC1("code", refEncodeU(REF_P))],
    ["share-zero", refC1("code", new Uint8Array(32))],
    ["share-one", refC1("qr", H(`01${"00".repeat(31)}`))],
    ["share-order-8", refC1("code", H(REF_X25519_LOW_ORDER_HEX[2]))],
    ["share-p-minus-1", refC1("qr", H(REF_X25519_LOW_ORDER_HEX[4]))],
  ];
  const c2: [string, Uint8Array][] = [
    ["good", refC2(yb)],
    ["length-32", refC2(yb).slice(0, 32)],
    ["length-34", cat(refC2(yb), Uint8Array.of(0))],
    ["empty", new Uint8Array(0)],
    ["version-0", cat(Uint8Array.of(0), yb)],
    ["version-2", cat(Uint8Array.of(2), yb)],
    ["share-top-bit-set", refC2(withTop(yb))],
    ["share-p-plus-1", refC2(refEncodeU(REF_P + 1n))],
    ["share-zero", refC2(new Uint8Array(32))],
    ["share-order-8", refC2(H(REF_X25519_LOW_ORDER_HEX[3]))],
  ];
  const outV = (v: ReturnType<typeof refParseC1>) =>
    v.ok
      ? {
          ok: true,
          ...(v.kind !== undefined ? { kind: v.kind } : {}),
          share: hex(v.share),
        }
      : { ok: false, reason: v.reason };
  return {
    c1: c1.map(([id, b]) => ({ id, frame: hex(b), want: outV(refParseC1(b)) })),
    c2: c2.map(([id, b]) => ({ id, frame: hex(b), want: outV(refParseC2(b)) })),
  };
}

// ── Whole attempts ───────────────────────────────────────────────────────────

/** One attempt with the fixed scalars every vector uses; `slug` and `sid` as the window's. */
export function cpaceAttempt(
  kind: CpaceKind,
  secret: string,
  o: { slug?: string; sid?: Uint8Array } = {},
): RefCpaceOut & {
  ya: Uint8Array;
  yb: Uint8Array;
  sid: Uint8Array;
  slug: string;
} {
  const slug = o.slug ?? SLUG;
  const sid = o.sid ?? SID;
  const ya = mat("scalar a");
  const yb = mat("scalar b");
  const out = refCpaceRun({ kind, secret, slug, ci: ci(slug), sid, ya, yb });
  return { ...out, ya, yb, sid, slug };
}

export const CPACE_CODE_PASSWORD = "123456";
export const CPACE_QR_SECRET = QR_SECRET;

interface AttemptIn {
  id: string;
  kind: CpaceKind;
  joiner: string;
  shower: string;
  slug?: string;
  showerSlug?: string;
  sid?: Uint8Array;
  showerSid?: Uint8Array;
  /** Whether both sides derive one ISK. */
  agree: boolean;
}

const ATTEMPTS: AttemptIn[] = [
  { id: "code", kind: "code", joiner: "123456", shower: "123456", agree: true },
  {
    id: "code-leading-zeros",
    kind: "code",
    joiner: "000042",
    shower: "000042",
    agree: true,
  },
  { id: "qr", kind: "qr", joiner: QR_SECRET, shower: QR_SECRET, agree: true },
  {
    id: "code-wrong-password",
    kind: "code",
    joiner: "123457",
    shower: "123456",
    agree: false,
  },
  {
    id: "qr-wrong-secret",
    kind: "qr",
    joiner: QR_SECRET_2,
    shower: QR_SECRET,
    agree: false,
  },
  {
    id: "code-other-slug",
    kind: "code",
    joiner: "123456",
    shower: "123456",
    slug: "other",
    agree: true,
  },
  {
    id: "code-slug-mismatch",
    kind: "code",
    joiner: "123456",
    shower: "123456",
    slug: "other",
    showerSlug: SLUG,
    agree: false,
  },
  {
    id: "code-sid-mismatch",
    kind: "code",
    joiner: "123456",
    shower: "123456",
    showerSid: mat("sid 2").slice(0, 10),
    agree: false,
  },
];

/** One attempt in full: each side's generator, share, K, ISK and PSK. */
export function cpaceAttemptRow(id: string) {
  const r = ATTEMPTS.find((a) => a.id === id);
  if (r === undefined) throw new Error(`cpace attempt ${id}`);
  const jSlug = r.slug ?? SLUG;
  const sSlug = r.showerSlug ?? jSlug;
  const jSid = r.sid ?? SID;
  const sSid = r.showerSid ?? jSid;
  const ya = mat("scalar a");
  const yb = mat("scalar b");
  const jGen = refCpaceGenerator(refPrs(r.kind, r.joiner), ci(jSlug), jSid);
  const sGen = refCpaceGenerator(refPrs(r.kind, r.shower), ci(sSlug), sSid);
  const Ya = refShare(ya, jGen.g);
  const Yb = refShare(yb, sGen.g);
  const kJ = refX25519(ya, Yb);
  const kS = refX25519(yb, Ya);
  const iskJ = refIsk(jSid, kJ, Ya, Yb);
  const iskS = refIsk(sSid, kS, Ya, Yb);
  const agree = hex(iskJ) === hex(iskS);
  if (agree !== r.agree)
    throw new Error(`cpace attempt ${r.id}: ISK agreement is ${agree}`);
  return {
    r,
    jSlug,
    sSlug,
    jSid,
    sSid,
    ya,
    yb,
    jGen,
    sGen,
    Ya,
    Yb,
    kJ,
    kS,
    iskJ,
    iskS,
    pskJ: refCpaceRunPsk(iskJ, jSlug),
    pskS: refCpaceRunPsk(iskS, sSlug),
    agree,
  };
}

function buildAttempts(): unknown[] {
  return ATTEMPTS.map(({ id }) => {
    const a = cpaceAttemptRow(id);
    return {
      id,
      kind: a.r.kind,
      joinerSecret: a.r.joiner,
      showerSecret: a.r.shower,
      joinerSlug: a.jSlug,
      showerSlug: a.sSlug,
      joinerSid: hex(a.jSid),
      showerSid: hex(a.sSid),
      ya: hex(a.ya),
      yb: hex(a.yb),
      joinerG: hex(a.jGen.g),
      showerG: hex(a.sGen.g),
      Ya: hex(a.Ya),
      Yb: hex(a.Yb),
      c1: hex(refC1(a.r.kind, a.Ya)),
      c2: hex(refC2(a.Yb)),
      joinerK: hex(a.kJ),
      showerK: hex(a.kS),
      joinerIsk: hex(a.iskJ),
      showerIsk: hex(a.iskS),
      joinerPsk: hex(a.pskJ),
      showerPsk: hex(a.pskS),
      // True when both sides derive one ISK, and so one PSK: the Noise message 1 then opens.
      agree: a.agree,
    };
  });
}

// ── The all-zero K abort ─────────────────────────────────────────────────────

function buildAbort(): unknown {
  const s = mat("abort scalar");
  const rows: unknown[] = [];
  REF_X25519_LOW_ORDER_HEX.forEach((h, k) => {
    for (const top of [false, true]) {
      const u = H(h);
      if (top) u[31] = u[31]! | 0x80;
      const out = refX25519(s, u);
      if (!refIsZero32(out))
        throw new Error(`cpace abort ${k}: output is not all zeros`);
      rows.push({
        id: `low-order-${k}${top ? "-top-bit-set" : ""}`,
        u: hex(u),
        k: hex(out),
        // Refused as a share first (the share check); the zero K is the second line of defence.
        kAllZero: true,
        shareRefused: !refShareCheck(u).ok,
      });
    }
  });
  const good = refX25519(s, goodShare);
  rows.push({
    id: "valid-share",
    u: hex(goodShare),
    k: hex(good),
    kAllZero: false,
    shareRefused: false,
  });
  return { scalar: hex(s), rows };
}

export function buildCpace(): unknown {
  return {
    note: "CPace for account-free local pairing (WIRE-CONTRACT-V5 15.12). Suite CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21, initiator-responder setting; DSI 'CPace255', DSI_ISK 'CPace255_ISK', H = SHA-512 with s_in_bytes 128, empty ADa and ADb in every row but the draft's. All fields are lower-case hex unless said. `anchors`: the draft's vectors, vendored and hash-checked. `elligator`: map_to_curve_elligator2 on 32 input bytes: decodeUCoordinate clears bit 255 and the result is reduced mod p (`r`), then v = -A / (1 + 2 r^2) with A = 486662; the result is v when v^3 + A v^2 + v is a square (`onCurve`) and -v - A otherwise, as 32 little-endian bytes. `generators`: g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32]); PRS is 'pkey-peer/1 code' 0x00 + the 6 digit characters, or 'pkey-peer/1 qr' 0x00 + the 16 secret bytes; CI is the mode-q prologue and sid the window's 10 bytes. `shares`: the share check of a received Y (32 bytes; bit 255 clear and u < 2^255 - 19, checked first, then not one of the seven low-order points of `lowOrder`); a refused share closes silently and counts no failure. `frames`: C1 (0x01, kind 0x01 code or 0x02 QR, Ya; 34 bytes) and C2 (0x01, Yb; 33 bytes) as the receiver judges them: length, version, kind, then the share. `attempts`: whole runs with fixed scalars ya, yb (X25519 clamps them): Y = X25519(y, g), K = X25519(y, Y_peer), ISK = SHA-512(lv_cat('CPace255_ISK', sid, K) || transcript_ir(Ya, '', Yb, '')) and psk = HKDF-SHA256(salt empty, ikm ISK, info 'pkey-peer/1 cpace' 0x00 slug), 32 bytes; `agree` says whether both sides derive the same ISK (a wrong password, a wrong QR secret, another slug or another sid does not). `abort`: X25519(scalar, u) for the low-order points is 32 zero bytes, and a K of 32 zero bytes aborts the attempt. Append-only: a new row keeps noiseVectorsVersion; a changed row or rule bumps it.",
    suite: "CPACE-X25519-SHA512",
    dsi: "CPace255",
    dsiIsk: "CPace255_ISK",
    sInBytes: 128,
    anchors: buildAnchors(),
    elligator: buildElligator(),
    generators: buildGenerators(),
    shares: buildShares(),
    frames: buildFrames(),
    attempts: buildAttempts(),
    abort: buildAbort(),
  };
}
