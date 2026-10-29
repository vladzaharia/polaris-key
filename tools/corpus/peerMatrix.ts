// `peer-matrix.json`: the `pkey-peer/1` byte-level rules outside the Noise engine
// (WIRE-CONTRACT-V5 §15.4 to §15.7, §15.9; plans/CC-01-cloud-connect.md §2.4, §2.6, §2.7, §2.9).
// `peerMatrixVersion` 1.
//
// `adverts`, `prologue`, `psk`, `sas`, `frames`, `records`, `relayEnvelopes`,
// `handshakePayloads`, `lanAddresses` (CC-IPV6.1; the rule is reference/lanAddress.ts) and
// `mdnsAnswers` (CC-IPV6.2; the DNS encoder and the learning rule are reference/mdns.ts) and
// `vouch` (CC-15.0c; WIRE-CONTRACT-V5 section 15.6.1: the VOUCH_REQ and VOUCH_RESULT bodies, the
// order of the records, and what the approver does with the answer of `nearby/approve`). The
// device proof is not here: it lives in `device-proof.json`. Every row is
// recomputed through `reference/peerMatrix.ts` (`node:crypto` only; nothing from client-core);
// the generator throws when a hand-written known answer disagrees, and the HKDF and base32 steps
// are also checked against `crypto.hkdfSync` and the RFC 4648 test vectors.

import { createHash, hkdfSync } from "node:crypto";
import {
  type BrowseHit,
  type PeerClose,
  type PeerMode,
  type RelayMessage,
  REF_MAX_FRAME,
  REF_MAX_PAYLOAD,
  REF_MAX_PEER_MESSAGE,
  REF_RELAY_MAX_MESSAGE,
  REF_TYPES,
  bytesHex,
  cat,
  hexBytes,
  refAccountInstance,
  refAdvertEpoch,
  refBase32Lower,
  refBrowse,
  refCapsIntersection,
  refFrameDecode,
  refFrameEncode,
  refHandshakePayload,
  refInstanceShape,
  refParseTxt,
  refPeerPsk,
  refPrologue,
  refProductTag,
  refRecordEncode,
  refRecordParse,
  refRecordSession,
  refRelayDecode,
  refRelayEncode,
  refSasCommit,
  refSasDisplay,
  refSasNonce,
  refSasRevealOk,
  refSasValue,
  refVouchFinish,
  refVouchFlow,
  refVouchRequest,
  refVouchResult,
  refVouchSigner,
  type RefFinishResult,
  type RefFinishRow,
  type RefFlowStep,
  type RefFlowWant,
  utf8,
} from "./reference/peerMatrix.js";
import { buildNoiseVectors } from "./noise.js";
import { refX25519Public, sha256 } from "./reference/noise.js";
import {
  type RefInterface,
  refCandidateTarget,
  refGroupKey,
  refLanVerdict,
} from "./reference/lanAddress.js";
import {
  type RefDnsRecord,
  type RefLearned,
  refDnsEncode,
  refMdnsLearn,
} from "./reference/mdns.js";

const hex = bytesHex;
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
/** Fixed test material: SHA-256 of a label. Never used outside this file. */
const mat = (label: string): Uint8Array =>
  sha256(utf8(`pkey-peer/1 matrix vector ${label}`));
/** A 32-character device id from a label (24 bytes of material). */
const devId = (label: string): string => b64u(mat(label).slice(0, 24));
const SLUG = "djdl";

function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `peerMatrix ${label}: reference gives ${JSON.stringify(got)}, row says ${JSON.stringify(want)}`,
    );
}

/** Row bytes: lower-case hex, or `{fill, count}` (one hex byte repeated) for the large rows. */
type Bytes = string | { fill: string; count: number };
const bytesOf = (b: Bytes): Uint8Array =>
  typeof b === "string"
    ? hexBytes(b)
    : new Uint8Array(b.count).fill(parseInt(b.fill, 16));
const fill = (f: string, count: number): Bytes => ({ fill: f, count });
const x4 = (n: number): string => n.toString(16).padStart(4, "0");

// ── adverts ──────────────────────────────────────────────────────────────────

function buildAdverts(): unknown {
  // Anchors outside the reference: RFC 4648 section 10 (lower-cased), and the HMAC step.
  for (const [plain, want] of [
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ] as const)
    check(`base32 ${plain}`, refBase32Lower(utf8(plain)), want);

  const epochs = [0, 1, 899, 900, 901, 1761300000, 1761300899, 4102444800].map(
    (now) => ({ now, epoch: refAdvertEpoch(now) }),
  );
  const names = [0, 1, 2, 3].flatMap((k) =>
    [0, 7, 1956999].map((epoch, e) => {
      const kDisc = mat(`kdisc ${k}`);
      const deviceId = devId(`device ${k}.${e}`);
      return {
        id: `k${k}-e${epoch}`,
        kDisc: hex(kDisc),
        epoch,
        deviceId,
        instance: refAccountInstance(kDisc, epoch, deviceId),
      };
    }),
  );
  const tags = [
    [SLUG, 1956999],
    [SLUG, 0],
    ["acme-notes", 1956999],
    ["a", 1956999],
    ["acme-notes", 1956998],
  ].map(([slug, epoch]) => ({
    slug: slug as string,
    epoch: epoch as number,
    h: refProductTag(slug as string, epoch as number),
  }));

  const txtIn: [string, string[]][] = [
    ["account", ["v=1", "m=a"]],
    ["account-reordered", ["m=a", "v=1"]],
    ["account-unknown-key-ignored", ["v=1", "m=a", "x=anything"]],
    ["account-tag-ignored", ["v=1", "m=a", "h=0123456789abcdef"]],
    ["approver", ["v=1", "m=v", "h=0123456789abcdef"]],
    ["pair", ["m=p", "v=1", "h=fedcba9876543210"]],
    ["entry-without-equals-ignored", ["v=1", "m=a", "flag"]],
    ["value-with-equals", ["v=1", "m=a", "note=a=b"]],
    ["version-2", ["v=2", "m=a"]],
    ["version-missing", ["m=a"]],
    ["version-empty", ["v=", "m=a"]],
    ["version-padded", ["v=01", "m=a"]],
    ["mode-missing", ["v=1"]],
    ["mode-unknown", ["v=1", "m=c"]],
    ["mode-upper", ["v=1", "m=A"]],
    ["key-case-sensitive", ["V=1", "M=a"]],
    ["duplicate-version", ["v=1", "v=1", "m=a"]],
    ["duplicate-unknown", ["v=1", "m=a", "x=1", "x=2"]],
    ["approver-tag-missing", ["v=1", "m=v"]],
    ["pair-tag-short", ["v=1", "m=p", "h=0123456789abcde"]],
    ["pair-tag-long", ["v=1", "m=p", "h=0123456789abcdef0"]],
    ["approver-tag-upper", ["v=1", "m=v", "h=0123456789ABCDEF"]],
    ["approver-tag-not-hex", ["v=1", "m=v", "h=0123456789abcdeg"]],
    ["empty", []],
  ];
  const txt = txtIn.map(([id, entries]) => ({
    id,
    entries,
    want: refParseTxt(entries),
  }));

  const instanceIn = [
    "p1-abcdefghijklmnop",
    "p1-abcdefghijklmn23",
    "p1-abcdefghijklmn2",
    "p1-abcdefghijklmn234",
    "p1-abcdefghijklmn18",
    "p1-ABCDEFGHIJKLMNOP",
    "p2-abcdefghijklmnop",
    "abcdefghijklmnop",
    "",
  ];
  const instances = instanceIn.map((name) => ({
    name,
    want: refInstanceShape(name),
  }));
  for (const n of names) check(n.id, refInstanceShape(n.instance), true);

  // Browsing: the current and the previous epoch, under both delivered keys.
  const now = 1761300450; // epoch 1956999, 450 s in
  const epoch = refAdvertEpoch(now);
  const kNew = mat("browse new");
  const kOld = mat("browse old");
  const roster = Array.from({ length: 4 }, (_, i) => devId(`roster ${i}`));
  const big = Array.from({ length: 128 }, (_, i) => devId(`big roster ${i}`));
  const stranger = devId("stranger");
  const browseRow = (
    id: string,
    instance: string,
    ks: Uint8Array[],
    r: string[],
    at = now,
  ) => {
    const want: BrowseHit | null = refBrowse(instance, ks, at, r);
    return {
      id,
      kDiscs: ks.map(hex),
      now: at,
      roster: r,
      instance,
      want,
    };
  };
  const browse = [
    browseRow(
      "current-epoch-newest-key",
      refAccountInstance(kNew, epoch, roster[2]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "previous-epoch-newest-key",
      refAccountInstance(kNew, epoch - 1, roster[0]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "current-epoch-previous-key",
      refAccountInstance(kOld, epoch, roster[3]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "previous-epoch-previous-key",
      refAccountInstance(kOld, epoch - 1, roster[1]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "two-epochs-old",
      refAccountInstance(kNew, epoch - 2, roster[0]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "next-epoch",
      refAccountInstance(kNew, epoch + 1, roster[0]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "device-not-in-roster",
      refAccountInstance(kNew, epoch, stranger),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "unknown-key",
      refAccountInstance(mat("browse other"), epoch, roster[0]!),
      [kNew, kOld],
      roster,
    ),
    browseRow(
      "only-one-key-delivered",
      refAccountInstance(kOld, epoch, roster[0]!),
      [kNew],
      roster,
    ),
    browseRow(
      "epoch-boundary-first-second",
      refAccountInstance(kNew, 1956998, roster[0]!),
      [kNew],
      roster,
      1956999 * 900,
    ),
    browseRow(
      "128-device-roster-last-device",
      refAccountInstance(kOld, epoch - 1, big[127]!),
      [kNew, kOld],
      big,
    ),
    browseRow(
      "approver-instance-never-matches",
      "p1-abcdefghijklmnop",
      [kNew, kOld],
      roster,
    ),
  ];
  for (const b of browse) {
    const w = b.want;
    if (b.id.endsWith("last-device") && w?.deviceId !== big[127])
      throw new Error("peerMatrix browse: the 128th device was not found");
  }
  return { epochSeconds: 900, epochs, names, tags, txt, instances, browse };
}

// ── prologue and psk ─────────────────────────────────────────────────────────

function buildPrologue(): unknown[] {
  return (
    [
      [SLUG, "a"],
      [SLUG, "v"],
      [SLUG, "p"],
      ["acme-notes", "a"],
      ["a", "p"],
      ["", "a"],
    ] as const
  ).map(([slug, mode]) => ({
    slug,
    mode,
    prologue: hex(refPrologue(slug, mode)),
  }));
}

function buildPsk(): unknown[] {
  return [
    ["psk-1", SLUG],
    ["psk-2", SLUG],
    ["psk-1", "acme-notes"],
    ["psk-3", "a"],
  ].map(([label, slug]) => {
    const kDisc = mat(label!);
    const psk = refPeerPsk(kDisc, slug!);
    // hkdfSync takes the salt, ikm and info in its own order; this is the cross-check.
    const cross = new Uint8Array(
      hkdfSync(
        "sha256",
        kDisc,
        new Uint8Array(0),
        cat(utf8("pkey-peer/1 psk"), Uint8Array.of(0), utf8(slug!)),
        32,
      ),
    );
    check(`psk ${label}`, hex(psk), hex(cross));
    return { slug, kDisc: hex(kDisc), psk: hex(psk) };
  });
}

// ── sas ──────────────────────────────────────────────────────────────────────

function buildSas(): unknown {
  const commits = [0, 1, 2].map((i) => {
    const nD = mat(`nD ${i}`);
    const c = refSasCommit(nD);
    check(`commit ${i}`, hex(c), createHash("sha256").update(nD).digest("hex"));
    return {
      nD: hex(nD),
      c: hex(c),
      commitBody: JSON.stringify({ c: b64u(c) }),
      revealBody: JSON.stringify({ nD: b64u(nD) }),
    };
  });
  const rows: unknown[] = [];
  const add = (
    id: string,
    h: Uint8Array,
    nD: Uint8Array,
    nM: Uint8Array,
    mode: string,
  ) => {
    const code = refSasValue(h, nD, nM, mode);
    rows.push({
      id,
      mode,
      h: hex(h),
      nD: hex(nD),
      nM: hex(nM),
      code,
      display: refSasDisplay(code),
    });
    return code;
  };
  for (const mode of ["v", "p"])
    for (let i = 0; i < 3; i++)
      add(`${mode}-${i}`, mat(`h ${i}`), mat(`nD ${i}`), mat(`nM ${i}`), mode);
  // The same inputs under the other mode differ; so does one flipped bit of any input.
  const h = mat("h 0");
  const nD = mat("nD 0");
  const nM = mat("nM 0");
  const flip = (b: Uint8Array): Uint8Array => {
    const c = b.slice();
    c[0]! ^= 1;
    return c;
  };
  add("v-flip-h", flip(h), nD, nM, "v");
  add("v-flip-nD", h, flip(nD), nM, "v");
  add("v-flip-nM", h, nD, flip(nM), "v");
  add("v-swapped-nonces", h, nM, nD, "v");
  // The first inputs found by counting that need leading zeros in the display, and one that
  // lands at the top of the range.
  let leading1 = 0;
  let leading5 = 0;
  for (let i = 0; i < 2_000_000 && (!leading1 || !leading5); i++) {
    const nm = sha256(utf8(`pkey-peer/1 sas search ${i}`));
    const code = refSasValue(h, nD, nm, "p");
    if (!leading1 && code < 100000 && code >= 10000) {
      leading1 = 1;
      add("p-one-leading-zero", h, nD, nm, "p");
    }
    if (!leading5 && code < 10) {
      leading5 = 1;
      add("p-five-leading-zeros", h, nD, nm, "p");
    }
  }
  if (!leading1 || !leading5)
    throw new Error("peerMatrix sas: no leading-zero input found");

  const nonceText = (b: Uint8Array): string => b64u(b);
  const goodC = nonceText(refSasCommit(nD));
  const goodN = nonceText(nD);
  const reveal = (id: string, c: string, n: string) => ({
    id,
    c,
    nD: n,
    want: refSasRevealOk(c, n),
  });
  const reveals = [
    reveal("matches", goodC, goodN),
    reveal("wrong-nonce", goodC, nonceText(mat("nD 1"))),
    reveal("wrong-commit", nonceText(refSasCommit(mat("nD 1"))), goodN),
    reveal("nonce-31-bytes", goodC, nonceText(nD.slice(0, 31))),
    reveal("nonce-33-bytes", goodC, nonceText(cat(nD, Uint8Array.of(0)))),
    reveal("nonce-padded", goodC, `${goodN}=`),
    reveal(
      "nonce-standard-alphabet",
      goodC,
      goodN.replace(/-/g, "+").replace(/_/g, "/") + "A",
    ),
    reveal(
      "nonce-non-canonical-tail",
      goodC,
      `${goodN.slice(0, 42)}${goodN[42] === "A" ? "B" : "A"}`,
    ),
    reveal("nonce-empty", goodC, ""),
    reveal("commit-short", goodC.slice(0, 42), goodN),
  ];
  const nonces = [
    ["valid-32-bytes", nonceText(nD)],
    ["31-bytes", nonceText(nD.slice(0, 31))],
    ["33-bytes", nonceText(cat(nD, Uint8Array.of(1)))],
    ["padded", `${nonceText(nD)}=`],
    ["empty", ""],
    ["hex-spelling", hex(nD)],
  ].map(([id, text]) => ({
    id,
    text,
    want: refSasNonce(text!) === null ? null : hex(refSasNonce(text!)!),
  }));
  return {
    note: "h is the 32-byte Noise handshake hash. code = u32be(HKDF-SHA256(salt = h, ikm = nD || nM, info = 'pkey-peer/1 sas' || 0x00 || mode)[0..4]) mod 10^6, shown as six digits with leading zeros and a space between the triples. A nonce and a commitment travel as 43 base64url characters; the body of SAS_COMMIT is the compact JSON object with the member c, SAS_NONCE nM and SAS_REVEAL nD. c = SHA-256(nD).",
    commits,
    codes: rows,
    reveals,
    nonces,
  };
}

// ── frames ───────────────────────────────────────────────────────────────────

function buildFrames(): unknown {
  const encode = [1, 2, 16, 48].map((n) => {
    const body = cat(
      ...Array.from({ length: Math.ceil(n / 16) }, (_, i) =>
        mat(`frame ${n}.${i}`),
      ),
    ).slice(0, n);
    return { noise: hex(body), frame: hex(refFrameEncode(body)!) };
  });
  const limits = [0, 1, 255, 256, 65534, 65535, 65536, 65537].map((len) => {
    const body = new Uint8Array(len).fill(0x5a);
    const f = refFrameEncode(body);
    return {
      len,
      want:
        f === null
          ? { refused: true }
          : { header: hex(f.slice(0, 2)), frameSha256: hex(sha256(f)) },
    };
  });
  if (REF_MAX_FRAME !== 65535) throw new Error("frame limit");
  const f = (n: number, fillByte = 0xab): string =>
    hex(refFrameEncode(new Uint8Array(n).fill(fillByte))!);
  const streams: [string, string][] = [
    ["one-frame", f(5)],
    ["two-frames", f(3, 1) + f(4, 2)],
    ["three-frames-one-byte-each", f(1, 1) + f(1, 2) + f(1, 3)],
    ["empty-stream", ""],
    ["one-byte-header-only", "00"],
    ["header-without-body", "0005"],
    ["partial-body", f(5).slice(0, -2)],
    ["frame-then-partial", f(3) + f(5).slice(0, 8)],
    ["frame-then-header", f(3) + "0007"],
    ["zero-length", "0000"],
    ["zero-length-after-frame", f(2) + "0000" + f(2)],
    ["frame-before-zero-length", f(2, 7) + "0000"],
  ];
  const decode = streams.map(([id, stream]) => {
    const r = refFrameDecode(hexBytes(stream));
    return {
      id,
      stream,
      want:
        "error" in r
          ? { error: r.error }
          : { frames: r.frames.map(hex), rest: hex(r.rest) },
    };
  });
  return {
    note: "A frame is u16be len || Noise message, len 1..65535. `decode` reads a byte stream: it returns the complete frames and the unread rest; a zero length closes the session with peer_bad_frame, wherever it occurs.",
    encode,
    limits,
    decode,
  };
}

// ── records ──────────────────────────────────────────────────────────────────

interface RecIn {
  type: number;
  flags?: number;
  body?: Bytes;
}

function buildRecords(): unknown {
  const parse = [
    "800100",
    "0004010000000000000001",
    "000200",
    "0100ff",
    "00",
    "0001",
    "",
    "80ff00",
    "000000",
    "000102",
    "000180",
    "0001fe",
    "0001ff",
    "000103aa",
  ].map((plain) => {
    const r = refRecordParse(hexBytes(plain));
    return {
      plaintext: plain,
      want:
        r === null || (r.flags & 0xfe) !== 0
          ? { error: "peer_bad_frame" }
          : {
              type: x4(r.type),
              more: (r.flags & 1) === 1,
              body: hex(r.body),
            },
    };
  });
  // Encode round trip.
  for (const p of parse) {
    if ("error" in (p.want as object)) continue;
    const r = refRecordParse(hexBytes(p.plaintext))!;
    check("record round trip", hex(refRecordEncode(r)), p.plaintext);
  }

  const typesTable = REF_TYPES.map((t) => ({
    from: x4(t.from),
    to: x4(t.to),
    name: t.name,
    modes: t.modes.join(""),
    ...(t.bodyLen !== undefined ? { bodyLen: t.bodyLen } : {}),
  }));

  const sessions: unknown[] = [];
  const run = (id: string, mode: PeerMode, records: RecIn[]) => {
    const out = refRecordSession(
      mode,
      records.map((r) => ({
        type: r.type,
        flags: r.flags ?? 0,
        body: bytesOf(r.body ?? ""),
      })),
    );
    sessions.push({
      id,
      mode,
      records: records.map((r) => ({
        type: x4(r.type),
        ...(r.flags ? { flags: r.flags } : {}),
        body: r.body ?? "",
      })),
      want:
        "close" in out
          ? { close: out.close, at: out.after }
          : {
              delivered: out.delivered.map((d) => ({
                type: x4(d.type),
                length: d.body.length,
                sha256: hex(sha256(d.body)),
              })),
            },
    });
  };
  const ping = "0102030405060708";
  // Every defined type in each mode it is allowed in, then in each it is not.
  const sample = (t: number, len?: number): RecIn => ({
    type: t,
    body: t === 0x80fe ? "" : fill("5a", len ?? 8),
  });
  for (const mode of ["a", "v", "p", "c"] as const) {
    run(`${mode}-hello`, mode, [sample(0x8001, 12)]);
    run(`${mode}-ping-pong`, mode, [
      { type: 4, body: ping },
      { type: 5, body: ping },
    ]);
    run(`${mode}-rekey-close`, mode, [
      { type: 0x80fe },
      { type: 0x80ff, body: hex(utf8('{"code":"peer_bye"}')) },
    ]);
  }
  run("a-ring-trust-candidates", "a", [
    sample(2, 20),
    sample(3, 20),
    sample(6, 20),
  ]);
  run(
    "a-transfer-range",
    "a",
    [0x20, 0x21, 0x22, 0x23, 0x24, 0x25].map((t) => sample(t, 9)),
  );
  run("c-transfer", "c", [sample(0x20, 9)]);
  run("a-app-low", "a", [sample(0x0100, 5), sample(0x7fff, 5)]);
  run("a-app-critical", "a", [sample(0x8100, 5), sample(0xfffd, 5)]);
  run("c-app", "c", [sample(0x0100, 5), sample(0x8100, 5)]);
  run("v-vouch", "v", [sample(0x8010, 30), sample(0x8011, 20)]);
  run("v-sas", "v", [
    sample(0x8014, 50),
    sample(0x8015, 50),
    sample(0x8016, 50),
  ]);
  run("p-sas-confirm-contact", "p", [
    sample(0x8014, 50),
    sample(0x8015, 50),
    sample(0x8016, 50),
    sample(0x8012, 2),
    sample(0x13, 40),
  ]);
  run("v-sync-range", "v", [
    sample(0x30, 90),
    sample(0x31, 90),
    sample(0x3f, 90),
  ]);
  // Mode rules.
  const notAllowed: [string, PeerMode, number][] = [
    ["v-ring", "v", 2],
    ["p-ring", "p", 2],
    ["v-trust", "v", 3],
    ["p-candidates", "p", 6],
    ["a-vouch-req", "a", 0x8010],
    ["p-vouch-result", "p", 0x8011],
    ["a-sas-commit", "a", 0x8014],
    ["c-sas-nonce", "c", 0x8015],
    ["a-confirm", "a", 0x8012],
    ["v-confirm", "v", 0x8012],
    ["a-contact", "a", 0x13],
    ["v-transfer", "v", 0x20],
    ["p-transfer-cancel", "p", 0x25],
    ["a-keyring-wrap", "a", 0x30],
    ["p-sync-range", "p", 0x31],
    ["c-sync-range-top", "c", 0x3f],
    ["v-app", "v", 0x0100],
    ["p-app-critical", "p", 0x8100],
    ["v-app-top", "v", 0x7fff],
  ];
  for (const [id, mode, t] of notAllowed)
    run(`not-allowed-${id}`, mode, [sample(t, 8)]);
  // Unknown types: critical closes, non-critical is ignored.
  for (const t of [
    0x8000, 0x8002, 0x800f, 0x8013, 0x8017, 0x8021, 0x80fd, 0x8030, 0xfffe,
    0xffff,
  ])
    run(`unknown-critical-${x4(t)}`, "a", [
      sample(0x8001, 12),
      { type: t, body: "00" },
    ]);
  for (const t of [0x0000, 0x0001, 0x0007, 0x0012, 0x0026, 0x0040, 0x00ff])
    run(`unknown-non-critical-${x4(t)}-ignored`, "a", [
      { type: t, body: "0011" },
      sample(0x8001, 12),
    ]);
  run("unknown-non-critical-more-chain-ignored", "v", [
    { type: 0x0007, flags: 1, body: "01" },
    { type: 0x0007, flags: 0, body: "02" },
    sample(0x8001, 5),
  ]);
  // Flags.
  for (const flags of [2, 4, 0x80, 0xfe, 0xff, 3])
    run(`flags-${flags.toString(16)}`, "a", [
      { type: 0x8001, flags, body: "00" },
    ]);
  run("flags-before-type-check", "a", [{ type: 0x8002, flags: 2, body: "00" }]);
  // MORE continuation.
  run("more-two-parts", "a", [
    { type: 0x0100, flags: 1, body: "0102" },
    { type: 0x0100, flags: 0, body: "03" },
  ]);
  run("more-three-parts-then-record", "a", [
    { type: 0x0100, flags: 1, body: "01" },
    { type: 0x0100, flags: 1, body: "02" },
    { type: 0x0100, flags: 0, body: "03" },
    { type: 0x0101, body: "04" },
  ]);
  run("more-open-at-end-delivers-nothing", "a", [
    { type: 0x0100, flags: 1, body: "01" },
  ]);
  run("more-then-other-type", "a", [
    { type: 0x0100, flags: 1, body: "01" },
    { type: 0x0101, flags: 0, body: "02" },
  ]);
  run("more-then-hello", "a", [
    { type: 0x0100, flags: 1, body: "01" },
    { type: 0x8001, flags: 0, body: "7b7d" },
  ]);
  run("more-empty-parts", "a", [
    { type: 0x0100, flags: 1, body: "" },
    { type: 0x0100, flags: 0, body: "" },
  ]);
  // Chain cap: MAX_CHAIN_RECORDS (18) records in one MORE chain; empty parts keep the size low.
  const chain = (n: number): RecIn[] =>
    Array.from({ length: n }, (_, k) => ({
      type: 0x0100,
      flags: k === n - 1 ? 0 : 1,
      body: "",
    }));
  run("chain-18-records-delivers", "a", chain(18));
  run("chain-19-records-closes", "a", chain(19));
  run("more-on-not-allowed-type", "v", [
    { type: 0x0100, flags: 1, body: "01" },
  ]);
  // Size: at the limit and over it.
  const half = REF_MAX_PEER_MESSAGE / 2;
  run("size-exactly-1-mib-in-two", "a", [
    { type: 0x0100, flags: 1, body: fill("11", half) },
    { type: 0x0100, flags: 0, body: fill("22", half) },
  ]);
  run("size-1-mib-plus-one-in-two", "a", [
    { type: 0x0100, flags: 1, body: fill("11", half) },
    { type: 0x0100, flags: 0, body: fill("22", half + 1) },
  ]);
  run("size-over-while-still-more", "a", [
    { type: 0x0100, flags: 1, body: fill("11", half) },
    { type: 0x0100, flags: 1, body: fill("22", half + 1) },
    { type: 0x0100, flags: 0, body: "00" },
  ]);
  run("size-single-record-65535", "a", [
    { type: 0x0100, body: fill("33", 65532) },
  ]);
  // Fixed-size bodies.
  for (const [id, t, body] of [
    ["ping-7", 4, fill("00", 7)],
    ["ping-9", 4, fill("00", 9)],
    ["ping-empty", 4, ""],
    ["pong-7", 5, fill("00", 7)],
    ["rekey-with-body", 0x80fe, "00"],
  ] as const)
    run(`body-${id}`, "a", [{ type: t, body }]);
  run("body-ping-split-across-more", "a", [
    { type: 4, flags: 1, body: "01020304" },
    { type: 4, flags: 0, body: "05060708" },
  ]);
  return {
    note: "A Noise transport plaintext is u16be type || u8 flags || body. Flag bit 0 is MORE; any other bit closes with peer_bad_frame. A body is {fill, count} (one hex byte repeated) where it is large. `types` is the type table; a type outside it is unknown, critical when bit 0x8000 is set. In `sessions` each record is read in order and `at` is the 0-based index of the record that closed the session. Checks run per record: flags, then a continuation of another type (peer_bad_frame), then the type (unknown critical, mode), then the running size over 1 MiB (peer_bad_frame), then, on the last record of a chain, a fixed body length (peer_bad_frame). An unknown non-critical type is dropped, MORE chain and all. delivered lists the reassembled messages as type, length and SHA-256.",
    maxMessage: REF_MAX_PEER_MESSAGE,
    types: typesTable,
    parse,
    sessions,
  };
}

// ── relay envelopes ──────────────────────────────────────────────────────────

function buildRelay(): unknown {
  const a = mat("relay a").slice(0, 24);
  const b = mat("relay b").slice(0, 24);
  const c = mat("relay c").slice(0, 24);
  const noise = mat("relay noise").slice(0, 20);
  const pingData = mat("relay ping").slice(0, 8);
  const msgs: [string, "toRoom" | "toClient", RelayMessage][] = [
    ["send", "toRoom", { op: "send", to: a, session: 1, noise }],
    [
      "send-session-max",
      "toRoom",
      { op: "send", to: b, session: 0xffffffff, noise: noise.slice(0, 1) },
    ],
    ["send-session-zero", "toRoom", { op: "send", to: c, session: 0, noise }],
    [
      "send-session-endian",
      "toRoom",
      { op: "send", to: a, session: 0x01020304, noise },
    ],
    ["list", "toRoom", { op: "list" }],
    ["ping", "toRoom", { op: "ping", data: pingData }],
    ["recv", "toClient", { op: "recv", from: a, session: 0x0a0b0c0d, noise }],
    ["members-0", "toClient", { op: "members", devices: [] }],
    ["members-1", "toClient", { op: "members", devices: [a] }],
    ["members-3", "toClient", { op: "members", devices: [a, b, c] }],
    ["ring", "toClient", { op: "ring", epoch: 7 }],
    ["ring-big", "toClient", { op: "ring", epoch: 9007199254740991 }],
    ["pong", "toClient", { op: "pong", data: pingData }],
    ["gone", "toClient", { op: "gone", device: b }],
    ["limit-rate", "toClient", { op: "limit", reason: 1 }],
    ["limit-person", "toClient", { op: "limit", reason: 2 }],
    ["limit-product", "toClient", { op: "limit", reason: 3 }],
    ["limit-paused", "toClient", { op: "limit", reason: 4 }],
  ];
  const view = (m: RelayMessage): Record<string, unknown> => {
    const o: Record<string, unknown> = { op: m.op };
    if ("to" in m) o.to = hex(m.to);
    if ("from" in m) o.from = hex(m.from);
    if ("session" in m) o.session = m.session;
    if ("noise" in m) o.noise = hex(m.noise);
    if ("data" in m) o.data = hex(m.data);
    if ("devices" in m) o.devices = m.devices.map(hex);
    if ("epoch" in m) o.epoch = m.epoch;
    if ("device" in m) o.device = hex(m.device);
    if ("reason" in m) o.reason = m.reason;
    return o;
  };
  const messages = msgs.map(([id, dir, m]) => {
    const bytes = refRelayEncode(m);
    const back = refRelayDecode(dir, bytes);
    if (back === null)
      throw new Error(`peerMatrix relay ${id}: round trip refused`);
    check(`relay ${id}`, view(back), view(m));
    return { id, dir, bytes: hex(bytes), message: view(m) };
  });

  const refusedIn: [string, "toRoom" | "toClient", Bytes][] = [
    ["empty", "toRoom", ""],
    ["unknown-op-00", "toRoom", "00"],
    ["unknown-op-04", "toRoom", "0400"],
    ["unknown-op-ff", "toClient", "ff"],
    ["send-no-body", "toRoom", "01"],
    ["send-to-only", "toRoom", "01" + "aa".repeat(24)],
    ["send-no-noise", "toRoom", "01" + "aa".repeat(24) + "00000001"],
    ["send-short-to", "toRoom", "01" + "aa".repeat(23) + "00000001ff"],
    ["list-with-body", "toRoom", "0200"],
    ["ping-7", "toRoom", "03" + "00".repeat(7)],
    ["ping-9", "toRoom", "03" + "00".repeat(9)],
    ["ping-empty", "toRoom", "03"],
    ["client-sends-recv", "toRoom", "81" + "aa".repeat(24) + "00000001ff"],
    ["client-sends-pong", "toRoom", "84" + "00".repeat(8)],
    ["client-sends-limit", "toRoom", "8601"],
    ["room-sends-send", "toClient", "01" + "aa".repeat(24) + "00000001ff"],
    ["room-sends-list", "toClient", "02"],
    ["room-sends-ping", "toClient", "03" + "00".repeat(8)],
    ["recv-no-noise", "toClient", "81" + "aa".repeat(24) + "00000001"],
    ["members-no-count", "toClient", "82"],
    ["members-count-1-no-device", "toClient", "8201"],
    ["members-count-2-one-device", "toClient", "8202" + "aa".repeat(24)],
    ["members-count-1-two-devices", "toClient", "8201" + "aa".repeat(48)],
    ["members-trailing-byte", "toClient", "8201" + "aa".repeat(24) + "00"],
    ["ring-7-bytes", "toClient", "83" + "00".repeat(7)],
    ["ring-9-bytes", "toClient", "83" + "00".repeat(9)],
    ["pong-7", "toClient", "84" + "00".repeat(7)],
    ["gone-23", "toClient", "85" + "aa".repeat(23)],
    ["gone-25", "toClient", "85" + "aa".repeat(25)],
    ["limit-0", "toClient", "8600"],
    ["limit-5", "toClient", "8605"],
    ["limit-empty", "toClient", "86"],
    ["limit-two-bytes", "toClient", "860101"],
  ];
  const refused = refusedIn.map(([id, dir, bytes]) => {
    if (refRelayDecode(dir, bytesOf(bytes)) !== null)
      throw new Error(`peerMatrix relay ${id}: reference accepts it`);
    return { id, dir, bytes };
  });
  // The size limit: a message is at most 65,564 bytes (op, 24, 4 and a 65,535-byte frame).
  const sizeRow = (id: string, total: number) => {
    const body = new Uint8Array(total).fill(0x44);
    body[0] = 0x01;
    body.set(a, 1);
    body.set([0, 0, 0, 9], 25);
    const m = refRelayDecode("toRoom", body);
    return {
      id,
      dir: "toRoom",
      total,
      bytes: { prefix: hex(body.slice(0, 29)), fill: "44" },
      want: m === null ? { refused: true } : { ok: true },
    };
  };
  const sizes = [
    30,
    65563,
    REF_RELAY_MAX_MESSAGE,
    REF_RELAY_MAX_MESSAGE + 1,
    70000,
  ].map((t) => sizeRow(`send-${t}`, t));
  check(
    "relay max",
    sizes.map((s) => JSON.stringify(s.want)),
    [
      '{"ok":true}',
      '{"ok":true}',
      '{"ok":true}',
      '{"refused":true}',
      '{"refused":true}',
    ],
  );
  return {
    note: "One binary WebSocket message is an envelope: op byte, then the layout of 15.7. A device is its 24 decoded device-id bytes. MEMBERS carries the count n as one byte; PONG echoes the 8 bytes of the PING it answers. `dir` is the sender: toRoom (a client to the room) or toClient. `messages` encode and decode both ways; `refused` rows decode to nothing; `sizes` rows are an op, a 24-byte device, a session and a run of `fill` bytes up to `total` bytes, whole. A message over 65,564 bytes is refused.",
    maxMessage: REF_RELAY_MAX_MESSAGE,
    messages,
    refused,
    sizes,
  };
}

// ── handshake payloads ───────────────────────────────────────────────────────

interface PayloadIn {
  id: string;
  mode: "a" | "v" | "p";
  message: 1 | 2 | 3;
  text?: string;
  hex?: string;
  pad?: { prefix: string; fill: string; count: number; suffix: string };
}

function buildPayloads(): unknown {
  const cert = "e30.e30.c2ln";
  const A = (message: 2 | 3, text: string, id: string): PayloadIn => ({
    id,
    mode: "a",
    message,
    text,
  });
  const rows: PayloadIn[] = [
    { id: "msg1-v1", mode: "a", message: 1, text: '{"v":1}' },
    { id: "msg1-v-mode", mode: "v", message: 1, text: '{"v":1}' },
    {
      id: "msg1-unknown-member-ignored",
      mode: "p",
      message: 1,
      text: '{"v":1,"x":[1,2]}',
    },
    {
      id: "msg1-with-whitespace",
      mode: "a",
      message: 1,
      text: ' {\n"v" : 1\n} ',
    },
    { id: "msg1-version-2", mode: "a", message: 1, text: '{"v":2}' },
    { id: "msg1-version-string", mode: "a", message: 1, text: '{"v":"1"}' },
    { id: "msg1-version-missing", mode: "a", message: 1, text: "{}" },
    {
      id: "msg1-cert-present",
      mode: "a",
      message: 1,
      text: `{"v":1,"cert":"${cert}"}`,
    },
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["ring/1","trust/1","cand/1","vouch/1","app/1"]}`,
      "a-msg2-full",
    ),
    A(3, `{"v":1,"cert":"${cert}","ring":1,"caps":[]}`, "a-msg3-empty-caps"),
    A(
      2,
      `{"caps":["app/1"],"ring":9007199254740991,"cert":"${cert}","v":1}`,
      "a-member-order-free",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["app/1"],"extra":{"k":null}}`,
      "a-unknown-member-ignored",
    ),
    A(2, `{"v":1,"ring":7,"caps":["app/1"]}`, "a-cert-missing"),
    A(2, `{"v":1,"cert":"","ring":7,"caps":["app/1"]}`, "a-cert-empty"),
    A(2, `{"v":1,"cert":7,"ring":7,"caps":["app/1"]}`, "a-cert-not-string"),
    A(2, `{"v":1,"cert":"${cert}","caps":["app/1"]}`, "a-ring-missing"),
    A(2, `{"v":1,"cert":"${cert}","ring":0,"caps":["app/1"]}`, "a-ring-zero"),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":-1,"caps":["app/1"]}`,
      "a-ring-negative",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7.5,"caps":["app/1"]}`,
      "a-ring-fraction",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":"7","caps":["app/1"]}`,
      "a-ring-string",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":9007199254740992,"caps":["app/1"]}`,
      "a-ring-over-safe-integer",
    ),
    A(2, `{"v":1,"cert":"${cert}","ring":7}`, "a-caps-missing"),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":"app/1"}`,
      "a-caps-not-array",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":[1]}`,
      "a-caps-entry-not-string",
    ),
    A(
      3,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["app/1"],"v":1}`,
      "a-duplicate-member",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["app/1"],}`,
      "a-trailing-comma",
    ),
    A(2, `[1]`, "a-not-an-object"),
    A(2, `"x"`, "a-string-top-level"),
    A(2, ``, "a-empty"),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["app/1"]} x`,
      "a-trailing-garbage",
    ),
    A(
      2,
      `{"v":1,"cert":"${cert}","ring":7,"caps":["app/1"],"n":1e400}`,
      "a-number-out-of-range",
    ),
    { id: "v-msg2", mode: "v", message: 2, text: '{"v":1,"caps":["vouch/1"]}' },
    {
      id: "p-msg3",
      mode: "p",
      message: 3,
      text: '{"v":1,"caps":["app/1","cand/1"]}',
    },
    {
      id: "v-cert-refused",
      mode: "v",
      message: 2,
      text: `{"v":1,"caps":["vouch/1"],"cert":"${cert}"}`,
    },
    {
      id: "p-cert-refused",
      mode: "p",
      message: 3,
      text: `{"v":1,"caps":[],"cert":"${cert}"}`,
    },
    { id: "v-caps-missing", mode: "v", message: 2, text: '{"v":1}' },
    {
      id: "p-ring-ignored",
      mode: "p",
      message: 2,
      text: '{"v":1,"caps":[],"ring":7}',
    },
  ];
  const capsRow = (id: string, caps: unknown): PayloadIn => ({
    id,
    mode: "v",
    message: 2,
    text: JSON.stringify({ v: 1, caps }),
  });
  const caps32 = Array.from({ length: 32 }, (_, i) => `c${i}/1`);
  rows.push(
    capsRow("caps-32-entries", caps32),
    capsRow("caps-33-entries", [...caps32, "c32/1"]),
    capsRow("caps-no-slash", ["app"]),
    capsRow("caps-upper-case", ["App/1"]),
    capsRow("caps-no-version", ["app/"]),
    capsRow("caps-version-letters", ["app/x"]),
    capsRow("caps-empty-name", ["/1"]),
    capsRow("caps-two-slashes", ["a/b/1"]),
    capsRow("caps-space", ["app/1 "]),
    capsRow("caps-digits-in-name", ["xfer2/10"]),
    capsRow("caps-hyphen-in-name", ["a-b/1"]),
    capsRow("caps-duplicate-entries-kept", ["app/1", "app/1"]),
    {
      id: "bom",
      mode: "v",
      message: 2,
      hex: "efbbbf" + hex(utf8('{"v":1,"caps":[]}')),
    },
    {
      id: "invalid-utf8",
      mode: "v",
      message: 2,
      hex: hex(utf8('{"v":1,"caps":[],"x":"')) + "ff" + hex(utf8('"}')),
    },
    {
      id: "overlong-utf8",
      mode: "v",
      message: 2,
      hex: hex(utf8('{"v":1,"caps":[],"x":"')) + "c0af" + hex(utf8('"}')),
    },
    {
      id: "lone-surrogate-escape",
      mode: "v",
      message: 2,
      text: '{"v":1,"caps":[],"x":"\\ud800"}',
    },
    {
      id: "raw-control-character",
      mode: "v",
      message: 2,
      text: '{"v":1,"caps":[],"x":"a\tb"}',
    },
    {
      id: "valid-non-ascii",
      mode: "v",
      message: 2,
      text: '{"v":1,"caps":[],"x":"é中"}',
    },
  );
  const padRow = (id: string, count: number): PayloadIn => ({
    id,
    mode: "v",
    message: 2,
    pad: { prefix: '{"v":1,"caps":[],"x":"', fill: "a", count, suffix: '"}' },
  });
  const overhead = '{"v":1,"caps":[],"x":""}'.length;
  rows.push(
    padRow("size-8192", REF_MAX_PAYLOAD - overhead),
    padRow("size-8193", REF_MAX_PAYLOAD - overhead + 1),
    padRow("size-65536", 65536),
  );
  const payloads = rows.map((r) => {
    const bytes =
      r.hex !== undefined
        ? hexBytes(r.hex)
        : utf8(
            r.pad !== undefined
              ? r.pad.prefix + r.pad.fill.repeat(r.pad.count) + r.pad.suffix
              : r.text!,
          );
    const v = refHandshakePayload(r.mode, r.message, bytes);
    return {
      id: r.id,
      mode: r.mode,
      message: r.message,
      ...(r.hex !== undefined ? { payloadHex: r.hex } : {}),
      ...(r.text !== undefined ? { payload: r.text } : {}),
      ...(r.pad !== undefined ? { payloadPad: r.pad } : {}),
      length: bytes.length,
      want: v.ok
        ? {
            ok: true,
            ...(r.message === 1 ? {} : { caps: v.caps }),
            ...(v.ring !== undefined ? { ring: v.ring } : {}),
            ...(v.cert !== undefined ? { cert: v.cert } : {}),
          }
        : { ok: false },
    };
  });
  const interIn: [string, string[], string[]][] = [
    [
      "all-v1-caps",
      ["ring/1", "trust/1", "cand/1", "vouch/1", "app/1"],
      ["app/1", "ring/1", "vouch/1"],
    ],
    ["disjoint", ["ring/1"], ["trust/1"]],
    ["empty-local", [], ["app/1"]],
    ["empty-remote", ["app/1"], []],
    ["version-must-match", ["app/1", "ring/2"], ["app/2", "ring/2"]],
    [
      "duplicates-once",
      ["app/1", "app/1", "ring/1"],
      ["ring/1", "app/1", "app/1"],
    ],
    [
      "byte-order",
      ["b/1", "a/10", "a/2", "a/1"],
      ["a/1", "a/10", "a/2", "b/1"],
    ],
  ];
  const intersection = interIn.map(([id, local, remote]) => ({
    id,
    local,
    remote,
    want: refCapsIntersection(local!, remote!),
  }));
  return {
    note: "Handshake payloads (15.5): strict JSON of 15.1/1.2, an object, at most 8 KiB of UTF-8. Message 1 needs v = 1 and no cert; messages 2 and 3 need v = 1 and caps (at most 32 entries matching ^[a-z0-9]+/[0-9]+$). Mode a adds cert (a non-empty string; its verification is cases.json peerCertCases) and ring (an integer from 1 to 2^53 - 1); modes v and p refuse a cert. Unknown members are ignored. `payload` is the text, `payloadHex` the raw bytes where the text is not valid UTF-8, `payloadPad` the text prefix + count x fill + suffix. `want.caps` is the list as sent; the session uses `intersection`: the entries both lists hold, once each, in byte order.",
    maxPayload: REF_MAX_PAYLOAD,
    payloads,
    intersection,
  };
}

// ── lanAddresses (§15.4.1) ───────────────────────────────────────────────────

function buildLanAddresses(): unknown {
  // [id, remote, local (or null for none), allowLoopback, known answer: the key, or null to refuse].
  // The answer is written by hand and the reference must agree with it.
  type Row = [string, string, string | null, boolean, string | null];
  const own = "2001:db8:1:2::9";
  const rows: Row[] = [
    // IPv4: RFC 1918 and its edges.
    ["v4-10-low", "10.0.0.1", null, false, "10.0.0.1"],
    ["v4-10-high", "10.255.255.254", null, false, "10.255.255.254"],
    ["v4-172-16", "172.16.0.1", null, false, "172.16.0.1"],
    ["v4-172-31", "172.31.255.254", null, false, "172.31.255.254"],
    ["v4-172-15", "172.15.255.255", null, false, null],
    ["v4-172-32", "172.32.0.1", null, false, null],
    ["v4-192-168", "192.168.1.2", null, false, "192.168.1.2"],
    ["v4-192-167", "192.167.255.255", null, false, null],
    ["v4-192-169", "192.169.0.1", null, false, null],
    ["v4-link-local", "169.254.1.1", null, false, null],
    ["v4-cgnat", "100.64.0.1", null, false, null],
    ["v4-public", "8.8.8.8", null, false, null],
    ["v4-this-network", "0.0.0.0", null, false, null],
    ["v4-multicast", "224.0.0.251", null, false, null],
    ["v4-broadcast", "255.255.255.255", null, false, null],
    ["v4-loopback-off", "127.0.0.1", null, false, null],
    ["v4-loopback-on", "127.0.0.1", null, true, "127.0.0.1"],
    ["v4-loopback-high-on", "127.255.255.254", null, true, "127.255.255.254"],
    ["v4-public-loopback-flag", "8.8.8.8", null, true, null],
    // IPv4 text that is not an address.
    ["v4-leading-zero", "192.168.01.2", null, false, null],
    ["v4-octet-256", "192.168.1.256", null, false, null],
    ["v4-three-octets", "192.168.1", null, false, null],
    ["v4-zone", "192.168.1.2%en0", null, false, null],
    ["text-empty", "", null, false, null],
    ["text-name", "printer.local", null, false, null],
    // IPv4-mapped: judged as IPv4.
    ["mapped-lan", "::ffff:192.168.1.2", null, false, "192.168.1.2"],
    ["mapped-hex", "::ffff:c0a8:102", null, false, "192.168.1.2"],
    ["mapped-upper", "::FFFF:192.168.1.2", null, false, "192.168.1.2"],
    ["mapped-long", "0:0:0:0:0:ffff:c0a8:102", null, false, "192.168.1.2"],
    ["mapped-public", "::ffff:8.8.8.8", null, false, null],
    ["mapped-loopback-off", "::ffff:127.0.0.1", null, false, null],
    ["mapped-loopback-on", "::ffff:127.0.0.1", null, true, "127.0.0.1"],
    ["compatible-not-mapped", "::192.168.1.2", null, false, null],
    ["nat64", "64:ff9b::c0a8:102", null, false, null],
    ["nat64-dotted", "64:ff9b::192.168.1.2", null, false, null],
    // IPv6 link-local, ULA and the rest.
    ["v6-link-local-zone", "fe80::1%en0", null, false, "fe80::1%en0"],
    ["v6-link-local-upper", "FE80::0001", null, false, "fe80::1"],
    ["v6-link-local-top", "febf::1", null, false, "febf::1"],
    ["v6-below-link-local", "fe7f::1", null, false, null],
    ["v6-site-local", "fec0::1", null, false, null],
    ["v6-ula", "fd12::5", null, false, "fd12::5"],
    ["v6-ula-fc", "fc00::1", null, false, "fc00::1"],
    ["v6-fe00", "fe00::1", null, false, null],
    ["v6-loopback-off", "::1", null, false, null],
    ["v6-loopback-on", "::1", null, true, "::1"],
    ["v6-unspecified-off", "::", null, false, null],
    ["v6-unspecified-on", "::", null, true, null],
    ["v6-multicast", "ff02::fb", null, false, null],
    ["v6-zone-empty", "fe80::1%", null, false, null],
    ["v6-brackets", "[fe80::1]", null, false, null],
    ["v6-two-gaps", "fe80::1::2", null, false, null],
    ["v6-nine-groups", "1:2:3:4:5:6:7:8:9", null, false, null],
    ["v6-eight-groups-and-gap", "1:2:3:4:5:6:7::8", null, false, null],
    ["v6-group-too-long", "fd12::12345", null, false, null],
    // The key is RFC 5952 text.
    [
      "key-first-longest-run",
      "fd00:0:0:0:1:0:0:1",
      null,
      false,
      "fd00::1:0:0:1",
    ],
    ["key-tie-first-run", "fd00:0:0:1:1:0:0:1", null, false, "fd00::1:1:0:0:1"],
    [
      "key-single-zero-kept",
      "fd00:0:1:1:1:1:1:1",
      null,
      false,
      "fd00:0:1:1:1:1:1:1",
    ],
    [
      "key-trailing-run",
      "FD00:0000:0000:0000:0000:0000:0000:0000",
      null,
      false,
      "fd00::",
    ],
    ["key-dotted-tail", "fd00::192.168.1.2", null, false, "fd00::c0a8:102"],
    ["key-zone-dropped", "fd00::5%wlan0", null, false, "fd00::5"],
    // A global address dials only on the same /64 as the socket's own address.
    ["global-same-64", "2001:db8:1:2::5", own, false, "2001:db8:1:2::5"],
    [
      "global-same-64-loopback-flag",
      "2001:db8:1:2::5",
      own,
      true,
      "2001:db8:1:2::5",
    ],
    [
      "global-same-64-local-zone",
      "2001:db8:1:2::5",
      `${own}%en0`,
      false,
      "2001:db8:1:2::5",
    ],
    ["global-other-64", "2001:db8:1:2::5", "2001:db8:1:3::9", false, null],
    ["global-no-local", "2001:db8:1:2::5", null, false, null],
    ["global-local-ipv4", "2001:db8:1:2::5", "192.168.1.9", false, null],
    [
      "global-local-mapped",
      "2001:db8:1:2::5",
      "::ffff:192.168.1.9",
      false,
      null,
    ],
    ["global-local-not-an-address", "2001:db8:1:2::5", "en0", false, null],
    ["global-local-link-local", "2001:db8:1:2::5", "fe80::9", false, null],
    ["global-3fff", "3fff::1", "3fff::2", false, "3fff::1"],
    ["global-other-isp", "2600:1700::1", "2600:1700::2", false, "2600:1700::1"],
    ["global-outside-2000-3", "4000::1", "4000::2", false, null],
    [
      "global-teredo-same-64",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:0:4136:e378::9",
      false,
      null,
    ],
    [
      "global-6to4-same-64",
      "2002:c0a8:102::1",
      "2002:c0a8:102::2",
      false,
      null,
    ],
    [
      "global-2001-0db8-is-not-teredo",
      "2001:db8::1",
      "2001:db8::2",
      false,
      "2001:db8::1",
    ],
    ["link-local-ignores-local", "fe80::1", own, false, "fe80::1"],
    // The key of a link-local address keeps its zone; every other key drops it.
    ["key-link-local-zone-case", "FE80::1%EN0", null, false, "fe80::1%EN0"],
    ["key-link-local-zone-number", "fe80::1%12", null, false, "fe80::1%12"],
    ["key-link-local-no-zone", "fe80::1", null, false, "fe80::1"],
    [
      "zone-15-characters",
      "fe80::1%abcdefghijklmno",
      null,
      false,
      "fe80::1%abcdefghijklmno",
    ],
    ["zone-16-characters", "fe80::1%abcdefghijklmnop", null, false, null],
    ["zone-with-space", "fe80::1%en 0", null, false, null],
    ["zone-with-tab", "fe80::1%en\t0", null, false, null],
    ["zone-with-control", "fe80::1%en\u0001", null, false, null],
    ["zone-with-delete", "fe80::1%en\u007f", null, false, null],
    ["zone-non-ascii", "fe80::1%\u00e9n0", null, false, null],
    ["zone-trailing-newline", "fe80::1%en0\n", null, false, null],
    ["zone-double", "fe80::1%en0%en1", null, false, null],
    ["zone-only-percent", "fe80::1%%", null, false, null],
    ["zone-no-address", "%en0", null, false, null],
    ["zone-on-ula-dropped", "fd00::5%en0", null, false, "fd00::5"],
    // A mapped address with a zone is ambiguous, so it is refused.
    ["mapped-zone", "::ffff:10.0.0.1%en0", null, false, null],
    ["mapped-hex-zone", "::ffff:a00:1%en0", null, false, null],
    // A ULA address is routed. With a known local address it must share its /64.
    [
      "ula-local-same-64",
      "fd00:1:2:3::5",
      "fd00:1:2:3::9",
      false,
      "fd00:1:2:3::5",
    ],
    ["ula-local-other-64", "fd00:1:2:3::5", "fd00:1:2:4::9", false, null],
    ["ula-local-other-ula", "fd00:1:2:3::5", "fd01:1:2:3::9", false, null],
    ["ula-local-global", "fd00:1:2:3::5", "2001:db8:1:2::9", false, null],
    ["ula-local-link-local", "fd00:1:2:3::5", "fe80::9", false, null],
    ["ula-local-ipv4", "fd00:1:2:3::5", "192.168.1.9", false, null],
    ["ula-local-not-an-address", "fd00:1:2:3::5", "en0", false, null],
    [
      "ula-local-same-64-zone",
      "fd00:1:2:3::5",
      "fd00:1:2:3::9%en0",
      false,
      "fd00:1:2:3::5",
    ],
    ["ula-fc-local-same-64", "fc00::1", "fc00::2", false, "fc00::1"],
    ["ula-fc-local-other-64", "fc00::1", "fc00:0:0:1::2", false, null],
    // Where parsers differ: each of these is refused, and in every language.
    ["diff-v4-trailing-newline", "10.0.0.1\n", null, false, null],
    ["diff-v6-trailing-newline", "fe80::1\n", null, false, null],
    ["diff-v4-nul", "10.0.0.1\u0000", null, false, null],
    ["diff-v6-nul", "fe80::1\u0000", null, false, null],
    ["diff-v4-leading-space", " 10.0.0.1", null, false, null],
    ["diff-v4-trailing-space", "10.0.0.1 ", null, false, null],
    ["diff-v6-trailing-space", "fe80::1 ", null, false, null],
    ["diff-v4-tab", "10.0.0.1\t", null, false, null],
    ["diff-v4-unicode-digits", "\uff11\uff10.0.0.1", null, false, null],
    ["diff-v4-arabic-digits", "10.0.0.\u0661", null, false, null],
    ["diff-v6-unicode-digits", "fd\u0660\u0660::1", null, false, null],
    ["diff-v4-port", "10.0.0.1:80", null, false, null],
    ["diff-v6-bracket-port", "[fe80::1]:80", null, false, null],
    ["diff-v6-port-unbracketed", "fd00::1:80", null, false, "fd00::1:80"],
    ["diff-v4-hex-octet", "0x0a.0.0.1", null, false, null],
    ["diff-v4-hex-whole", "0xa000001", null, false, null],
    ["diff-v4-decimal-whole", "167772161", null, false, null],
    ["diff-v4-short", "10.1", null, false, null],
    ["diff-v4-five-octets", "10.0.0.1.1", null, false, null],
    ["diff-v4-prefix-length", "10.0.0.1/8", null, false, null],
    ["diff-v4-trailing-dot", "10.0.0.1.", null, false, null],
    ["diff-v6-trailing-dot", "fd00::1.", null, false, null],
    ["diff-v6-dotted-leading-zero", "::ffff:010.0.0.1", null, false, null],
    ["diff-v6-dotted-mid", "::10.0.0.1:1", null, false, null],
    ["diff-v6-three-colons", "fd00:::1", null, false, null],
    ["diff-v6-prefix-length", "fd00::1/64", null, false, null],
    ["diff-v6-sign", "+fd00::1", null, false, null],
    ["diff-v6-isatap", "fe80::5efe:10.0.0.1", null, false, "fe80::5efe:a00:1"],
    [
      "diff-v6-isatap-global",
      "2001:db8:1:2:0:5efe:10.0.0.1",
      own,
      false,
      "2001:db8:1:2:0:5efe:a00:1",
    ],
    ["diff-percent-only", "%", null, false, null],
  ];
  // Hand-written /64 keys for a few rows; the rest come from the reference.
  const groups = new Map<string, string | null>([
    ["global-same-64", "2001:db8:1:2::/64"],
    ["ula-local-same-64", "fd00:1:2:3::/64"],
    ["v6-link-local-zone", "fe80::/10%en0"],
    ["key-link-local-no-zone", "fe80::/10"],
    ["v4-10-low", "10.0.0.0/24"],
    ["mapped-lan", "192.168.1.0/24"],
    ["diff-v6-isatap", "fe80::/10"],
  ]);
  const out = rows.map(([id, remote, local, allowLoopback, key]) => {
    const got = refLanVerdict(remote, local, allowLoopback);
    check(`lanAddresses ${id}`, got, { dial: key !== null, key });
    const group = refGroupKey(got.key);
    if (groups.has(id))
      check(`lanAddresses group ${id}`, group, groups.get(id));
    return {
      id,
      remote,
      ...(local !== null ? { local } : {}),
      allowLoopback,
      dial: got.dial,
      key: got.key,
      group,
    };
  });
  return {
    note: "LAN addresses (15.4.1): lanVerdict(remote, local, allowLoopback) -> {dial, key}, applied to an accepted socket before it takes a slot or is read, to a dialled address's text before connect and again to the connected socket before its first byte. `remote` is the socket's peer address as text and `local` its own address (absent: unknown). Spelling: a zone is `%` and 1 to 15 characters of U+0021 to U+007E other than `%`; an empty or longer zone, a second `%`, a control, a space or a non-ASCII character, a zone on IPv4 and a zone on an IPv4-mapped address are malformed and refused; the grammar is strict (RFC 3986 IPv4address and IPv6address): no whitespace, NUL, port, prefix length, trailing dot, brackets, non-ASCII digits or leading-zero octet. IPv4-mapped (::ffff:0:0/96) is judged as its IPv4 address. IPv4: 10/8, 172.16/12, 192.168/16, and 127/8 only with allowLoopback. IPv6: fe80::/10; fc00::/7, which with a known `local` must be IPv6 (not mapped) in the same /64; ::1 only with allowLoopback; an address in 2000::/3, outside 2001::/32 (Teredo) and 2002::/16 (6to4), only when `local` is IPv6 (not mapped) in the same /64. Anything else, and text that is not an address, is refused. `key` is the per-address connection count key: dotted IPv4, or RFC 5952 lower-case IPv6 text without its zone, except that a link-local (fe80::/10) key keeps its zone; null when `dial` is false. `group` is the per-group count key of a key: `fe80::/10%zone` for a link-local key (`fe80::/10` with no zone), `a.b.c.0/24` for an IPv4 key, `<masked address>/64` for any other IPv6 key, and null for no key. `candidates` holds the rule for a CANDIDATES entry (15.6).",
    rows: out,
    candidates: buildCandidates(),
  };
}

function buildCandidates(): unknown {
  const nic = (
    address: string,
    prefix: number,
    up = true,
    tunnel = false,
  ): RefInterface => ({ address, prefix, up, tunnel });
  const sets: Record<string, RefInterface[]> = {
    // Wi-Fi with IPv4 only.
    v4: [nic("192.168.1.9", 24)],
    // A dual-stack LAN: IPv4, ULA, a global prefix and the link-local address.
    dual: [
      nic("192.168.1.9", 24),
      nic("fd00:1:2:3::9", 64),
      nic("2001:db8:1:2::9", 64),
      nic("fe80::9", 64),
    ],
    // The same Wi-Fi beside a VPN (a tunnel with a RFC 1918 subnet of its own).
    vpn: [nic("192.168.1.9", 24), nic("10.8.0.2", 24, true, true)],
    // The interface is down.
    down: [nic("192.168.1.9", 24, false)],
    // A subnet that is not RFC 1918, and a Teredo prefix.
    public: [nic("8.8.8.9", 24), nic("2001:0:4136:e378::9", 64)],
    // A ULA prefix with a zero group in it.
    zero: [nic("fd00:1:0:1::9", 64)],
    none: [],
  };
  // [id, entry, interface set, dialled]
  const rows: [string, string, string, boolean][] = [
    ["v4-in-subnet", "192.168.1.20:5000", "v4", true],
    ["v4-port-1024", "192.168.1.20:1024", "v4", true],
    ["v4-port-65535", "192.168.1.20:65535", "v4", true],
    ["v4-other-subnet", "192.168.2.20:5000", "v4", false],
    ["v4-rfc1918-elsewhere", "10.0.0.1:5000", "v4", false],
    ["v4-rfc1918-elsewhere-ssh-port", "10.0.0.1:22", "v4", false],
    ["v4-own-address", "192.168.1.9:5000", "v4", false],
    ["v4-no-interfaces", "192.168.1.20:5000", "none", false],
    ["v4-interface-down", "192.168.1.20:5000", "down", false],
    ["v4-tunnel-subnet", "10.8.0.5:5000", "vpn", false],
    ["v4-lan-beside-tunnel", "192.168.1.20:5000", "vpn", true],
    ["v4-public-subnet", "8.8.8.8:5000", "public", false],
    ["v6-ula-in-subnet", "[fd00:1:2:3::5]:5000", "dual", true],
    ["v6-ula-other-64", "[fd00:1:2:4::5]:5000", "dual", false],
    ["v6-global-in-subnet", "[2001:db8:1:2::5]:5000", "dual", true],
    ["v6-global-other-64", "[2001:db8:1:3::5]:5000", "dual", false],
    ["v6-own-address", "[fd00:1:2:3::9]:5000", "dual", false],
    ["v6-own-global-address", "[2001:db8:1:2::9]:5000", "dual", false],
    ["v6-ipv4-only-interface", "[fd00:1:2:3::5]:5000", "v4", false],
    ["v6-teredo-in-subnet", "[2001:0:4136:e378::5]:5000", "public", false],
    ["v6-single-zero-group", "[fd00:1:0:1:1:1:1:1]:5000", "zero", true],
    ["v6-link-local", "[fe80::5]:5000", "dual", false],
    ["v6-link-local-isatap", "[fe80::5efe:c0a8:114]:5000", "dual", false],
    ["v6-loopback", "[::1]:5000", "dual", false],
    // Spelling of the port: plain decimal, 1024 to 65535.
    ["port-0", "192.168.1.20:0", "v4", false],
    ["port-22", "192.168.1.20:22", "v4", false],
    ["port-80", "192.168.1.20:80", "v4", false],
    ["port-1023", "192.168.1.20:1023", "v4", false],
    ["port-65536", "192.168.1.20:65536", "v4", false],
    ["port-99999", "192.168.1.20:99999", "v4", false],
    ["port-100000", "192.168.1.20:100000", "v4", false],
    ["port-leading-zero", "192.168.1.20:05000", "v4", false],
    ["port-plus", "192.168.1.20:+5000", "v4", false],
    ["port-minus", "192.168.1.20:-5000", "v4", false],
    ["port-space", "192.168.1.20: 5000", "v4", false],
    ["port-trailing-space", "192.168.1.20:5000 ", "v4", false],
    ["port-trailing-newline", "192.168.1.20:5000\n", "v4", false],
    ["port-nul", "192.168.1.20:5000\u0000", "v4", false],
    ["port-hex", "192.168.1.20:0x1388", "v4", false],
    ["port-exponent", "192.168.1.20:5e3", "v4", false],
    ["port-fraction", "192.168.1.20:5000.0", "v4", false],
    ["port-fullwidth", "192.168.1.20:\uff15\uff10\uff10\uff10", "v4", false],
    ["port-missing", "192.168.1.20", "v4", false],
    ["port-empty", "192.168.1.20:", "v4", false],
    ["port-twice", "192.168.1.20:5000:5000", "v4", false],
    ["port-v6-missing", "[fd00:1:2:3::5]", "dual", false],
    ["port-v6-empty", "[fd00:1:2:3::5]:", "dual", false],
    ["port-v6-trailing-junk", "[fd00:1:2:3::5]:5000x", "dual", false],
    // Spelling of the address.
    ["v4-brackets", "[192.168.1.20]:5000", "v4", false],
    ["v4-leading-zero", "192.168.01.20:5000", "v4", false],
    ["v4-trailing-dot", "192.168.1.20.:5000", "v4", false],
    ["v4-leading-space", " 192.168.1.20:5000", "v4", false],
    ["v4-hostname", "printer.local:5000", "v4", false],
    ["v4-empty-host", ":5000", "v4", false],
    ["v4-zone", "192.168.1.20%en0:5000", "v4", false],
    ["v6-no-brackets", "fd00:1:2:3::5:5000", "dual", false],
    ["v6-double-brackets", "[[fd00:1:2:3::5]]:5000", "dual", false],
    ["v6-empty-brackets", "[]:5000", "dual", false],
    ["v6-zone", "[fd00:1:2:3::5%en0]:5000", "dual", false],
    ["v6-empty-zone", "[fd00:1:2:3::5%]:5000", "dual", false],
    ["v6-upper-case", "[FD00:1:2:3::5]:5000", "dual", false],
    ["v6-long-form", "[fd00:1:2:3:0:0:0:5]:5000", "dual", false],
    ["v6-leading-zeros", "[fd00:0001:2:3::5]:5000", "dual", false],
    ["v6-extra-zero-group", "[fd00:1:2:3::0:5]:5000", "dual", false],
    ["v6-dotted-tail", "[fd00:1:2:3::0.0.0.5]:5000", "dual", false],
    ["v6-single-zero-compressed", "[fd00:1::1:1:1:1:1]:5000", "zero", false],
    ["v6-shorter-run-compressed", "[2001:db8:0:0:1:0:0:1]:5000", "dual", false],
    ["v6-mapped", "[::ffff:192.168.1.20]:5000", "dual", false],
    ["v6-mapped-hex", "[::ffff:c0a8:114]:5000", "dual", false],
    ["v6-trailing-newline", "[fd00:1:2:3::5]:5000\n", "dual", false],
    ["v6-nul", "[fd00:1:2:3::5\u0000]:5000", "dual", false],
    ["entry-empty", "", "dual", false],
    ["entry-colon", ":", "dual", false],
  ];
  const out = rows.map(([id, entry, set, dialled]) => {
    const interfaces = sets[set]!;
    const got = refCandidateTarget(entry, interfaces);
    check(`lanAddresses candidates ${id}`, got !== null, dialled);
    return { id, entry, interfaces, target: got };
  });
  return {
    note: "CANDIDATES entries (15.6, 15.4.1): candidateTarget(entry, interfaces) -> {host, port} or null. `interfaces` lists the device's own addresses, one per entry: `{address, prefix, up, tunnel}`, `tunnel` meaning a VPN, tunnel, point-to-point or pseudo-interface. An entry is dialled only when all hold: it is `a.b.c.d:port` or `[addr]:port` (brackets only around IPv6) with a plain decimal port from 1024 to 65535 (no sign, no leading zero, no space, no other character); an IPv6 address is in RFC 5952 text, has no zone, is not IPv4-mapped and is not in fe80::/10; the address is not one of the device's own; it lies inside the subnet (address and prefix) of an up, non-tunnel interface address; and lanVerdict(address, that interface address, false) allows it. `target.host` is the address as dialled.",
    rows: out,
  };
}

// ── mdnsAnswers (§15.4 "Addresses") ──────────────────────────────────────────

function buildMdnsAnswers(): unknown {
  const I1 = "p1-aaaaaaaaaaaaaaaa";
  const I2 = "p1-bbbbbbbbbbbbbbbb";
  const H1 = `${I1}.local`;
  const H2 = `${I2}.local`;
  const SVC = "_pkeypeer._tcp.local";
  const LL = "fe80::1c2:3ff:fe4:5a6";
  const LL_TEXT = LL;
  const a = (name: string, address: string, ttl = 120): RefDnsRecord => ({
    name,
    type: "A",
    ttl,
    address,
  });
  const aaaa = (name: string, address: string, ttl = 120): RefDnsRecord => ({
    name,
    type: "AAAA",
    ttl,
    address,
  });
  const ptr = (ttl: number): RefDnsRecord => ({
    name: SVC,
    type: "PTR",
    ttl,
    target: `${I1}.${SVC}`,
  });
  const srv: RefDnsRecord = {
    name: `${I1}.${SVC}`,
    type: "SRV",
    ttl: 120,
    port: 40123,
    target: H1,
  };
  const txt: RefDnsRecord = {
    name: `${I1}.${SVC}`,
    type: "TXT",
    ttl: 4500,
    txt: ["v=1", "m=a"],
  };
  const ll = (name: string, address: string): RefLearned => ({ name, address });
  /** Four addresses held for the first host: the most a name keeps. */
  const held4 = ["2", "3", "4", "5"].map((n) => ll(H1, `192.168.1.${n}`));

  // A known answer for the encoder, written by hand from RFC 1035 (a compressed PTR, then an A).
  const knownCompressed = refDnsEncode({
    answers: [
      { name: SVC, type: "PTR", ttl: 4500, target: `i.${SVC}` },
      { name: "h.local", type: "A", ttl: 120, address: "192.168.1.20" },
    ],
    compress: true,
  });
  // h.local: "h" then a pointer to "local" at offset 27; the A record follows.
  const wantHex =
    "000084000000000200000000" +
    "095f706b657970656572045f746370056c6f63616c00" +
    "000c0001000011940004" +
    "0169c00c" +
    "0168c01b" + // h + pointer to "local" (offset 27)
    "00018001" +
    "00000078" +
    "0004" +
    "c0a80114";
  check("mdnsAnswers known compressed encoding", hex(knownCompressed), wantHex);

  type Row = {
    id: string;
    records: RefDnsRecord[];
    additionals?: RefDnsRecord[];
    compress?: boolean;
    source: string;
    zone: string | null;
    prior?: RefLearned[];
    /** The known answer: the table for the name(s) after the packet. */
    learned: RefLearned[];
  };
  const rows: Row[] = [
    {
      id: "a-equals-source",
      records: [a(H1, "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "a-not-source",
      records: [a(H1, "192.168.1.99")],
      source: "192.168.1.20",
      zone: null,
      learned: [],
    },
    {
      id: "a-equals-source-and-another-a-dropped",
      records: [a(H1, "192.168.1.99"), a(H1, "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "a-in-additional-section",
      records: [ptr(4500), srv, txt],
      additionals: [a(H1, "10.0.0.7")],
      source: "10.0.0.7",
      zone: null,
      learned: [ll(H1, "10.0.0.7")],
    },
    {
      id: "aaaa-link-local-equals-source-takes-zone",
      records: [aaaa(H1, LL)],
      source: LL,
      zone: "en0",
      learned: [ll(H1, `${LL_TEXT}%en0`)],
    },
    {
      id: "aaaa-link-local-kept-global-dropped",
      records: [aaaa(H1, "2001:db8:1:2::5"), aaaa(H1, LL)],
      source: LL,
      zone: "wlan0",
      learned: [ll(H1, `${LL_TEXT}%wlan0`)],
    },
    {
      id: "aaaa-global-alone-dropped",
      records: [aaaa(H1, "2001:db8:1:2::5")],
      source: LL,
      zone: "en0",
      learned: [],
    },
    {
      id: "aaaa-link-local-no-arrival-zone-dropped",
      records: [aaaa(H1, LL)],
      source: LL,
      zone: null,
      learned: [],
    },
    {
      id: "aaaa-ula-equals-source-has-no-zone",
      records: [aaaa(H1, "fd12:0:0:0:0:0:0:5")],
      source: "fd12::5",
      zone: "en0",
      learned: [ll(H1, "fd12::5")],
    },
    {
      id: "a-in-ipv6-packet-dropped",
      records: [a(H1, "192.168.1.20"), aaaa(H1, LL)],
      source: LL,
      zone: "en0",
      learned: [ll(H1, `${LL_TEXT}%en0`)],
    },
    {
      id: "a-alone-in-ipv6-packet-dropped",
      records: [a(H1, "192.168.1.20")],
      source: LL,
      zone: "en0",
      learned: [],
    },
    {
      id: "aaaa-in-ipv4-packet-dropped",
      records: [aaaa(H1, LL), a(H1, "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "two-names-same-source",
      records: [a(H1, "172.20.0.9"), a(H2, "172.20.0.9")],
      source: "172.20.0.9",
      zone: null,
      learned: [ll(H1, "172.20.0.9"), ll(H2, "172.20.0.9")],
    },
    {
      id: "repeat-is-not-a-second-address",
      records: [a(H1, "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      prior: [ll(H1, "192.168.1.20")],
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "new-address-follows-in-first-seen-order",
      records: [aaaa(H1, "fd12:0:0:0:0:0:0:7")],
      source: "fd12::7",
      zone: "en0",
      prior: [ll(H1, "192.168.1.20")],
      learned: [ll(H1, "192.168.1.20"), ll(H1, "fd12::7")],
    },
    {
      id: "fourth-address-is-kept",
      records: [a(H1, "192.168.1.9")],
      source: "192.168.1.9",
      zone: null,
      prior: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, `${LL_TEXT}%en0`),
      ],
      learned: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, `${LL_TEXT}%en0`),
        ll(H1, "192.168.1.9"),
      ],
    },
    {
      id: "fifth-address-is-dropped",
      records: [a(H1, "192.168.1.9")],
      source: "192.168.1.9",
      zone: null,
      prior: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, `${LL_TEXT}%en0`),
        ll(H1, "fd12::5"),
      ],
      learned: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, `${LL_TEXT}%en0`),
        ll(H1, "fd12::5"),
      ],
    },
    {
      id: "cap-is-per-name",
      records: [a(H2, "192.168.1.9")],
      source: "192.168.1.9",
      zone: null,
      prior: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, "192.168.1.4"),
        ll(H1, "192.168.1.5"),
      ],
      learned: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, "192.168.1.4"),
        ll(H1, "192.168.1.5"),
        ll(H2, "192.168.1.9"),
      ],
    },
    {
      id: "compressed-names",
      records: [ptr(4500), srv, txt, a(H1, "192.168.1.20"), aaaa(H1, LL)],
      compress: true,
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "compressed-names-link-local",
      records: [ptr(4500), srv, txt],
      additionals: [a(H1, "192.168.1.20"), aaaa(H1, LL)],
      compress: true,
      source: LL,
      zone: "en0",
      learned: [ll(H1, `${LL_TEXT}%en0`)],
    },
    {
      id: "goodbye-teaches-nothing",
      records: [ptr(0)],
      source: "192.168.1.20",
      zone: null,
      learned: [],
    },
    {
      id: "goodbye-beside-a-live-address",
      records: [ptr(0)],
      additionals: [a(H1, "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    // An IPv4-mapped source is judged as its IPv4 address.
    {
      id: "mapped-source-a-equals-ipv4",
      records: [a(H1, "192.168.1.20")],
      source: "::ffff:192.168.1.20",
      zone: "en0",
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "mapped-source-hex-form",
      records: [a(H1, "192.168.1.20")],
      source: "::ffff:c0a8:114",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "mapped-source-a-not-equal",
      records: [a(H1, "192.168.1.99")],
      source: "::ffff:192.168.1.20",
      zone: null,
      learned: [],
    },
    {
      id: "mapped-source-aaaa-of-mapped-address-dropped",
      records: [aaaa(H1, "::ffff:c0a8:114"), a(H1, "192.168.1.20")],
      source: "::ffff:192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    // An address record with TTL 0 removes that address, under the equality rule.
    {
      id: "address-goodbye-removes",
      records: [a(H1, "192.168.1.20", 0)],
      source: "192.168.1.20",
      zone: null,
      prior: [ll(H1, "192.168.1.20")],
      learned: [],
    },
    {
      id: "address-goodbye-keeps-the-others-in-order",
      records: [a(H1, "192.168.1.3", 0)],
      source: "192.168.1.3",
      zone: null,
      prior: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, "192.168.1.4"),
      ],
      learned: [ll(H1, "192.168.1.2"), ll(H1, "192.168.1.4")],
    },
    {
      id: "address-goodbye-link-local-takes-zone",
      records: [aaaa(H1, LL, 0)],
      source: LL,
      zone: "en0",
      prior: [ll(H1, `${LL_TEXT}%en0`)],
      learned: [],
    },
    {
      id: "address-goodbye-other-zone-removes-nothing",
      records: [aaaa(H1, LL, 0)],
      source: LL,
      zone: "wlan0",
      prior: [ll(H1, `${LL_TEXT}%en0`)],
      learned: [ll(H1, `${LL_TEXT}%en0`)],
    },
    {
      id: "address-goodbye-not-from-source-is-ignored",
      records: [a(H1, "192.168.1.20", 0)],
      source: "192.168.1.99",
      zone: null,
      prior: [ll(H1, "192.168.1.20")],
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "address-goodbye-of-unheld-address-learns-nothing",
      records: [a(H1, "192.168.1.20", 0)],
      source: "192.168.1.20",
      zone: null,
      learned: [],
    },
    {
      id: "address-goodbye-then-return-goes-last",
      records: [a(H1, "192.168.1.2", 0), a(H1, "192.168.1.2")],
      source: "192.168.1.2",
      zone: null,
      prior: [
        ll(H1, "192.168.1.2"),
        ll(H1, "192.168.1.3"),
        ll(H1, "192.168.1.4"),
        ll(H1, "192.168.1.5"),
      ],
      learned: [
        ll(H1, "192.168.1.3"),
        ll(H1, "192.168.1.4"),
        ll(H1, "192.168.1.5"),
        ll(H1, "192.168.1.2"),
      ],
    },
    // Names compare case-insensitively by ASCII fold, and are held in lower case.
    {
      id: "name-case-is-folded",
      records: [a(H1.toUpperCase(), "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "name-case-matches-the-held-name",
      records: [a(H1.toUpperCase(), "192.168.1.20")],
      source: "192.168.1.20",
      zone: null,
      prior: [ll(H1, "192.168.1.20")],
      learned: [ll(H1, "192.168.1.20")],
    },
    {
      id: "name-case-shares-the-cap",
      records: [a(H1.toUpperCase(), "192.168.1.9")],
      source: "192.168.1.9",
      zone: null,
      prior: held4,
      learned: held4,
    },
    {
      id: "name-case-goodbye-removes",
      records: [a(H1.toUpperCase(), "192.168.1.20", 0)],
      source: "192.168.1.20",
      zone: null,
      prior: [ll(H1, "192.168.1.20")],
      learned: [],
    },
  ];
  const out = rows.map((r) => {
    const packet = refDnsEncode({
      answers: r.records,
      ...(r.additionals !== undefined ? { additionals: r.additionals } : {}),
      ...(r.compress === true ? { compress: true } : {}),
    });
    const got = refMdnsLearn(packet, r.source, r.zone, r.prior ?? []);
    check(`mdnsAnswers ${r.id}`, got, r.learned);
    return {
      id: r.id,
      packet: hex(packet),
      source: r.source,
      zone: r.zone,
      ...(r.prior !== undefined ? { prior: r.prior } : {}),
      learned: got,
    };
  });
  // A compressed packet is shorter than the same message without compression, or the row proves nothing.
  const sample = rows.find((r) => r.id === "compressed-names")!;
  const flat = refDnsEncode({ answers: sample.records });
  const packed = refDnsEncode({ answers: sample.records, compress: true });
  check("mdnsAnswers compression shrinks", packed.length < flat.length, true);
  return {
    note: "mDNS address learning (15.4 Addresses). `packet` is one mDNS response as lower-case hex (header, then the answer and additional sections; names may be compressed, RFC 1035 4.1.4). `source` is the packet's source address as text and `zone` the interface it arrived on (null: none). A browser believes an A or AAAA record only when its address equals `source` (so an A record is never believed in an IPv6 packet, nor an AAAA in an IPv4 packet); the section a record sits in does not matter. A link-local (fe80::/10) address is learned as `<RFC 5952 text>%<zone>`; any other address has no zone. A name keeps at most 4 addresses, of any family, in first-seen order, and a repeat is not a second address. Learning is by that equality alone; there is no address filter at learn time, the dial-time check (15.4.1) decides what may be dialled. `source` may be an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, or the hex form), which is judged as its IPv4 address: an A record equal to it is learned, an AAAA record never is. An address record with TTL 0 removes that address (the same text, so a link-local address with the same zone) when it passes the same equality test, and learns nothing; records apply in packet order. A PTR goodbye (TTL 0) teaches none and removes none. `prior` (absent: nothing held) is the table the browser held before the packet, in first-seen order; `learned` is the table after it: the `{name, address}` entries in first-seen order. Names compare case-insensitively by ASCII fold (A-Z only) and are held, and shown in `learned`, in lower case. A link-local `source` with `zone` null learns nothing (no arrival interface names the host). The roster filter, the per-source limit on new names and the SRV port range need a roster, a clock and SRV records, which these rows do not model: each SDK tests them itself. Rows need an own DNS codec: Node, Python, Kotlin JVM and Godot GDScript run them; Swift and Android leave address learning to the OS resolver.",
    rows: out,
  };
}

// ── vouch (CC-15.0c; WIRE-CONTRACT-V5 §15.6.1) ───────────────────────────────

const VOUCH_SLUG = "demo";
const vouchSigner = refVouchSigner(mat("vouch d signing"));
const vouchOtherSigner = refVouchSigner(mat("vouch other signing"));
const VOUCH_AGREE = b64u(refX25519Public(mat("vouch d agree")));
const VOUCH_DEVICE = devId("vouch d device");
const VOUCH_OTHER_DEVICE = devId("vouch other device");
const vouchHandle = (label: string): string =>
  `nr_${b64u(mat(label).slice(0, 16))}`;
const VOUCH_REQUEST = vouchHandle("vouch request");
const VOUCH_OTHER_REQUEST = vouchHandle("vouch other request");

interface VouchHello {
  label?: string;
  platform: string;
}
const VOUCH_HELLO: VouchHello = { label: "Ana's Switch", platform: "linux" };

type Body = Record<string, unknown>;

/** The ed25519 signature over the joined proof lines, even when a field breaks the line format. */
function vouchSig(o: {
  signer?: typeof vouchSigner;
  purpose?: string;
  slug?: string;
  device?: string;
  hHex: string;
  request?: string;
}): string {
  const text = [
    "pkey-proof/1",
    o.purpose ?? "vouch",
    o.slug ?? VOUCH_SLUG,
    o.device ?? VOUCH_DEVICE,
    `${b64u(hexBytes(o.hHex))}.${o.request ?? VOUCH_REQUEST}`,
    "-",
  ].join("\n");
  return (o.signer ?? vouchSigner).sign(utf8(text));
}

/** A copy of `s` with its last character changed so the unused low bits are not zero. */
function dirtyLastChar(s: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return s.slice(0, -1) + A[A.indexOf(s.slice(-1)) ^ 1]!;
}

function buildVouch(): unknown {
  const nv = buildNoiseVectors() as {
    handshakes: { id: string; handshakeHash: string }[];
  };
  const hOf = (id: string): string =>
    nv.handshakes.find((h) => h.id === id)!.handshakeHash;
  const H = hOf("mode-v");
  const OTHER_H = hOf("mode-a");

  // ── requests ──
  interface ReqIn {
    id: string;
    note: string;
    hello?: VouchHello;
    slug?: string;
    hHex?: string;
    /** Edit the body object after it is signed. */
    edit?: (b: Body) => void;
    /** Sign this instead of the body's own values. */
    sigOf?: Partial<Parameters<typeof vouchSig>[0]>;
    /** Replace the body text, given the valid compact text. */
    text?: (valid: string) => string;
    hex?: (validHex: string) => string;
    /** Pad the body with an unknown member to exactly this many bytes. */
    padTo?: number;
    /** `ok`, or the reference's reason prefix. */
    want: string;
  }
  const requests: Record<string, unknown>[] = [];
  const addReq = (r: ReqIn): void => {
    const hello = r.hello ?? VOUCH_HELLO;
    const slug = r.slug ?? VOUCH_SLUG;
    const hHex = r.hHex ?? H;
    const body: Body = {
      v: 1,
      request: VOUCH_REQUEST,
      deviceId: VOUCH_DEVICE,
      signKey: vouchSigner.signKey,
      agreeKey: VOUCH_AGREE,
      ...(hello.label !== undefined ? { label: hello.label } : {}),
      platform: hello.platform,
    };
    body.sig = vouchSig({ hHex: H, ...(r.sigOf ?? {}) });
    r.edit?.(body);
    let text = JSON.stringify(body);
    const row: Record<string, unknown> = {
      id: r.id,
      note: r.note,
      slug,
      hHex,
      hello,
    };
    let bytes: Uint8Array;
    if (r.padTo !== undefined) {
      const prefix = `${text.slice(0, -1)},"pad":"`;
      const suffix = '"}';
      const count = r.padTo - utf8(prefix).length - utf8(suffix).length;
      row.bodyPad = { prefix, fill: "a", count, suffix };
      row.length = r.padTo;
      bytes = utf8(prefix + "a".repeat(count) + suffix);
    } else if (r.hex !== undefined) {
      const hex = r.hex(bytesHex(utf8(text)));
      row.bodyHex = hex;
      bytes = hexBytes(hex);
    } else {
      if (r.text) text = r.text(text);
      row.body = text;
      bytes = utf8(text);
    }
    const got = refVouchRequest({ slug, hHex, hello, body: bytes });
    if (r.want === "ok") {
      if (!got.ok)
        throw new Error(
          `vouch request ${r.id}: reference refuses (${got.reason})`,
        );
      row.verdict = "ok";
      row.result = got.result;
    } else {
      if (got.ok || !got.reason.startsWith(r.want))
        throw new Error(
          `vouch request ${r.id}: reference gives ${JSON.stringify(got)}, wanted ${r.want}`,
        );
      row.verdict = "refuse";
      row.close = "peer_bad_frame";
      row.reason = got.reason;
    }
    requests.push(row);
  };
  const has = (b: Body, ...keys: string[]): void => {
    for (const k of keys) delete b[k];
  };
  const u = (hex: string): string => b64u(hexBytes(hex));

  addReq({ id: "valid", note: "The shape a conforming D sends.", want: "ok" });
  addReq({
    id: "valid-no-label",
    note: "No label in the HELLO and none in the request.",
    hello: { platform: "linux" },
    want: "ok",
  });
  addReq({
    id: "valid-label-cleaned-both",
    note: "A zero-width and a bidi character in both labels: both are cleaned and equal.",
    hello: { label: "Ana\u200b's\u202e Switch", platform: "linux" },
    want: "ok",
  });
  addReq({
    id: "valid-label-cleaned-differs-raw",
    note: "The raw labels differ (zero-width character, doubled spaces) and are equal after cleaning.",
    edit: (b) => {
      b.label = "  Ana\u200b's   Switch ";
    },
    want: "ok",
  });
  addReq({
    id: "valid-label-nfc-nfd",
    note: "NFC in the HELLO, NFD in the request: equal after NFC.",
    hello: { label: "Zo\u00eb's Mac", platform: "linux" },
    edit: (b) => {
      b.label = "Zoë's Mac";
    },
    want: "ok",
  });
  addReq({
    id: "valid-label-emptied",
    note: "A label with nothing left after cleaning is no label: the HELLO had none.",
    hello: { platform: "linux" },
    edit: (b) => {
      b.label = "\u200b\u202e";
    },
    want: "ok",
  });
  addReq({
    id: "valid-label-cut-at-64",
    note: "Labels equal in their first 64 code points are equal: the cut comes after cleaning.",
    hello: { label: "a".repeat(64) + "b", platform: "linux" },
    edit: (b) => {
      b.label = "a".repeat(64) + "c";
    },
    want: "ok",
  });
  addReq({
    id: "valid-platform-unknown-both",
    note: "A platform outside the allowed characters shows as Unknown in both, so they are equal.",
    hello: { label: "Ana's Switch", platform: "Win<10>" },
    edit: (b) => {
      b.platform = "\u0001other";
    },
    want: "ok",
  });
  addReq({
    id: "valid-platform-known",
    note: "A known platform spelling.",
    hello: { label: "Ana's Switch", platform: "visionos" },
    want: "ok",
  });
  addReq({
    id: "valid-unknown-members-ignored",
    note: "Unknown members, including the retired userCode and pop, are ignored.",
    edit: (b) => {
      b.userCode = "ABCD-EFGH";
      b.pop = "x";
      b.extra = { a: [1, 2, 3] };
    },
    want: "ok",
  });
  addReq({
    id: "valid-member-order",
    note: "The member order does not matter.",
    text: (t) => {
      const o = JSON.parse(t) as Body;
      return JSON.stringify(Object.fromEntries(Object.entries(o).reverse()));
    },
    want: "ok",
  });
  addReq({
    id: "valid-whitespace",
    note: "JSON whitespace between tokens is allowed.",
    text: (t) => JSON.stringify(JSON.parse(t), null, 2),
    want: "ok",
  });
  addReq({
    id: "valid-size-4096",
    note: "A body of exactly 4096 bytes is read.",
    padTo: 4096,
    want: "ok",
  });
  addReq({
    id: "size-4097",
    note: "4096 bytes and one more: refused before it is parsed.",
    padTo: 4097,
    want: "size",
  });

  // JSON and the body as a whole.
  addReq({
    id: "not-an-object-array",
    note: "A JSON array.",
    text: () => "[]",
    want: "object",
  });
  addReq({
    id: "not-an-object-null",
    note: "JSON null.",
    text: () => "null",
    want: "object",
  });
  addReq({ id: "empty-body", note: "No bytes.", text: () => "", want: "json" });
  addReq({
    id: "byte-order-mark",
    note: "A BOM before the object.",
    text: (t) => `\ufeff${t}`,
    want: "bom",
  });
  addReq({
    id: "invalid-utf8",
    note: "A 0xff byte inside a string.",
    hex: (h) => {
      const b = Buffer.from(h, "hex");
      b[b.indexOf("Ana")] = 0xff;
      return b.toString("hex");
    },
    want: "utf8",
  });
  addReq({
    id: "duplicate-key",
    note: "The member request twice.",
    text: (t) => t.replace(/}$/, `,"request":"${VOUCH_REQUEST}"}`),
    want: "json",
  });
  addReq({
    id: "trailing-comma",
    note: "A trailing comma.",
    text: (t) => t.replace(/}$/, ",}"),
    want: "json",
  });
  addReq({
    id: "lone-surrogate-escape",
    note: "A lone surrogate escape in the label.",
    text: (t) => t.replace("Ana's", "\\ud800"),
    want: "json",
  });

  // v
  addReq({
    id: "version-2",
    note: "v is 2.",
    edit: (b) => {
      b.v = 2;
    },
    want: "version",
  });
  addReq({
    id: "version-missing",
    note: "No v.",
    edit: (b) => has(b, "v"),
    want: "version",
  });
  addReq({
    id: "version-string",
    note: 'v is the string "1".',
    edit: (b) => {
      b.v = "1";
    },
    want: "version",
  });

  // request
  const reqRow = (id: string, note: string, value: unknown | undefined): void =>
    addReq({
      id,
      note,
      sigOf: typeof value === "string" ? { request: value } : {},
      edit: (b) => {
        if (value === undefined) delete b.request;
        else b.request = value;
      },
      want: "request",
    });
  reqRow("request-missing", "No request.", undefined);
  reqRow(
    "request-21-chars",
    "The handle is one character short.",
    VOUCH_REQUEST.slice(0, -1),
  );
  reqRow(
    "request-23-chars",
    "The handle is one character long.",
    `${VOUCH_REQUEST}A`,
  );
  reqRow(
    "request-wrong-prefix",
    "nx_ instead of nr_.",
    `nx_${VOUCH_REQUEST.slice(3)}`,
  );
  reqRow(
    "request-bad-character",
    "A + in the handle.",
    `${VOUCH_REQUEST.slice(0, -1)}+`,
  );
  reqRow(
    "request-padded",
    "A base64 padding character.",
    `${VOUCH_REQUEST.slice(0, -1)}=`,
  );
  reqRow(
    "request-trailing-newline",
    "A newline after a valid handle.",
    `${VOUCH_REQUEST}\n`,
  );
  reqRow(
    "request-non-ascii",
    "A non-ASCII letter in the handle.",
    `${VOUCH_REQUEST.slice(0, -1)}\u00e9`,
  );
  reqRow("request-number", "The handle is a number.", 7);

  // deviceId
  const devRow = (id: string, note: string, value: unknown | undefined): void =>
    addReq({
      id,
      note,
      sigOf: typeof value === "string" ? { device: value } : {},
      edit: (b) => {
        if (value === undefined) delete b.deviceId;
        else b.deviceId = value;
      },
      want: "device-id",
    });
  devRow("device-id-missing", "No deviceId.", undefined);
  devRow(
    "device-id-31-chars",
    "One character short.",
    VOUCH_DEVICE.slice(0, -1),
  );
  devRow("device-id-33-chars", "One character long.", `${VOUCH_DEVICE}A`);
  devRow(
    "device-id-bad-character",
    "A + in the id.",
    `${VOUCH_DEVICE.slice(0, -1)}+`,
  );
  addReq({
    id: "device-id-not-the-signed-one",
    note: "A well-formed deviceId that is not the one the proof covers: the proof fails.",
    edit: (b) => {
      b.deviceId = VOUCH_OTHER_DEVICE;
    },
    want: "sig",
  });

  // signKey
  addReq({
    id: "sign-key-missing",
    note: "No signKey.",
    edit: (b) => has(b, "signKey"),
    want: "sign-key",
  });
  addReq({
    id: "sign-key-padded",
    note: "The key with a padding character.",
    edit: (b) => {
      b.signKey = `${vouchSigner.signKey}=`;
    },
    want: "sign-key",
  });
  addReq({
    id: "sign-key-not-canonical",
    note: "The last character carries non-zero unused bits.",
    edit: (b) => {
      b.signKey = dirtyLastChar(vouchSigner.signKey);
    },
    want: "sign-key",
  });
  addReq({
    id: "sign-key-small-order",
    note: "The identity point as the key.",
    edit: (b) => {
      b.signKey = u(`01${"00".repeat(31)}`);
    },
    want: "sign-key",
  });
  addReq({
    id: "sign-key-other",
    note: "A valid key that did not sign.",
    edit: (b) => {
      b.signKey = vouchOtherSigner.signKey;
    },
    want: "sig",
  });

  // agreeKey (not under the signature, so each row has a valid proof)
  addReq({
    id: "agree-key-missing",
    note: "No agreeKey.",
    edit: (b) => has(b, "agreeKey"),
    want: "agree-key",
  });
  addReq({
    id: "agree-key-padded",
    note: "The key with a padding character.",
    edit: (b) => {
      b.agreeKey = `${VOUCH_AGREE}=`;
    },
    want: "agree-key",
  });
  addReq({
    id: "agree-key-not-canonical-base64",
    note: "The last character carries non-zero unused bits.",
    edit: (b) => {
      b.agreeKey = dirtyLastChar(VOUCH_AGREE);
    },
    want: "agree-key",
  });
  addReq({
    id: "agree-key-low-order-zero",
    note: "u = 0.",
    edit: (b) => {
      b.agreeKey = u("00".repeat(32));
    },
    want: "agree-key",
  });
  addReq({
    id: "agree-key-low-order-one",
    note: "u = 1.",
    edit: (b) => {
      b.agreeKey = u(`01${"00".repeat(31)}`);
    },
    want: "agree-key",
  });
  addReq({
    id: "agree-key-low-order-high-bit",
    note: "u = 1 with bit 255 set: low-order whichever way bit 255 is read.",
    edit: (b) => {
      b.agreeKey = u(`01${"00".repeat(30)}80`);
    },
    want: "agree-key",
  });
  {
    const hi = Uint8Array.from(Buffer.from(VOUCH_AGREE, "base64url"));
    hi[31] = hi[31]! | 0x80;
    addReq({
      id: "agree-key-bit-255-set",
      note: "A good key with bit 255 set: the same point to a loose reader, a different spelling.",
      edit: (b) => {
        b.agreeKey = b64u(hi);
      },
      want: "agree-key-spelling",
    });
  }
  addReq({
    id: "agree-key-u-above-p",
    note: "u = p + 2, with bit 255 clear: not the canonical spelling of any point.",
    edit: (b) => {
      b.agreeKey = u(`ef${"ff".repeat(30)}7f`);
    },
    want: "agree-key-spelling",
  });
  addReq({
    id: "agree-key-u-max",
    note: "u = 2^255 - 1.",
    edit: (b) => {
      b.agreeKey = u(`ff${"ff".repeat(30)}7f`);
    },
    want: "agree-key-spelling",
  });

  // label and platform against the HELLO
  addReq({
    id: "label-number",
    note: "The label is a number.",
    edit: (b) => {
      b.label = 5;
    },
    want: "label",
  });
  addReq({
    id: "label-null",
    note: "The label is null.",
    edit: (b) => {
      b.label = null;
    },
    want: "label",
  });
  addReq({
    id: "label-differs-from-hello",
    note: "Another label than the HELLO showed.",
    edit: (b) => {
      b.label = "Ana's Deck";
    },
    want: "hello-label",
  });
  addReq({
    id: "label-case-differs-from-hello",
    note: "The same words in another case.",
    edit: (b) => {
      b.label = "ana's switch";
    },
    want: "hello-label",
  });
  addReq({
    id: "label-added-after-hello",
    note: "The HELLO had no label and the request has one.",
    hello: { platform: "linux" },
    edit: (b) => {
      b.label = "Ana's Switch";
    },
    want: "hello-label",
  });
  addReq({
    id: "label-dropped-after-hello",
    note: "The HELLO had a label and the request has none.",
    edit: (b) => has(b, "label"),
    want: "hello-label",
  });
  addReq({
    id: "platform-missing",
    note: "No platform.",
    edit: (b) => has(b, "platform"),
    want: "platform",
  });
  addReq({
    id: "platform-number",
    note: "The platform is a number.",
    edit: (b) => {
      b.platform = 1;
    },
    want: "platform",
  });
  addReq({
    id: "platform-differs-from-hello",
    note: "Another platform than the HELLO showed.",
    edit: (b) => {
      b.platform = "windows";
    },
    want: "hello-platform",
  });
  addReq({
    id: "platform-trailing-newline",
    note: "A newline after a valid platform is not the platform.",
    edit: (b) => {
      b.platform = "linux\n";
    },
    want: "hello-platform",
  });
  addReq({
    id: "platform-known-vs-unknown",
    note: "The HELLO's platform shows as Unknown and the request names a real one.",
    hello: { label: "Ana's Switch", platform: "Win<10>" },
    edit: (b) => {
      b.platform = "windows";
    },
    want: "hello-platform",
  });
  addReq({
    id: "platform-over-32",
    note: "33 allowed characters show as Unknown, so a request with the same text still equals the HELLO.",
    hello: { label: "Ana's Switch", platform: "a".repeat(33) },
    edit: (b) => {
      b.platform = "b".repeat(40);
    },
    want: "ok",
  });

  // sig
  addReq({
    id: "sig-missing",
    note: "No sig.",
    edit: (b) => has(b, "sig"),
    want: "sig",
  });
  addReq({
    id: "sig-number",
    note: "The sig is a number.",
    edit: (b) => {
      b.sig = 1;
    },
    want: "sig",
  });
  addReq({
    id: "sig-padded",
    note: "A padding character after the signature.",
    edit: (b) => {
      b.sig = `${b.sig as string}=`;
    },
    want: "sig:sig-encoding",
  });
  addReq({
    id: "sig-scalar-not-reduced",
    note: "S + L: the same signature to a loose verifier, refused by a strict one.",
    edit: (b) => {
      const s = Uint8Array.from(Buffer.from(b.sig as string, "base64url"));
      let n = 0n;
      for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(s[32 + i]!);
      n += 2n ** 252n + 27742317777372353535851937790883648493n;
      for (let i = 0; i < 32; i++) {
        s[32 + i] = Number(n & 0xffn);
        n >>= 8n;
      }
      b.sig = b64u(s);
    },
    want: "sig:sig-scalar",
  });
  addReq({
    id: "sig-bit-flipped",
    note: "One signature character changed.",
    edit: (b) => {
      const s = b.sig as string;
      b.sig = `${s.slice(0, 10)}${s[10] === "A" ? "B" : "A"}${s.slice(11)}`;
    },
    want: "sig",
  });
  addReq({
    id: "sig-over-another-h",
    note: "Signed over another session's handshake hash.",
    sigOf: { hHex: OTHER_H },
    want: "sig",
  });
  addReq({
    id: "replayed-into-another-session",
    note: "A body that was valid in one session, presented in a session with another handshake hash.",
    hHex: OTHER_H,
    want: "sig",
  });
  addReq({
    id: "sig-over-another-purpose",
    note: "A proof of purpose nearby-approve.",
    sigOf: { purpose: "nearby-approve" },
    want: "sig",
  });
  addReq({
    id: "sig-over-another-slug",
    note: "Signed for another product.",
    sigOf: { slug: "djdl" },
    want: "sig",
  });
  addReq({
    id: "sig-checked-for-another-slug",
    note: "A valid proof for this product, checked in a session of another product.",
    slug: "djdl",
    want: "sig",
  });
  addReq({
    id: "sig-over-another-device",
    note: "Signed for another device id.",
    sigOf: { device: VOUCH_OTHER_DEVICE },
    want: "sig",
  });
  addReq({
    id: "sig-over-another-request",
    note: "Signed for another request handle.",
    sigOf: { request: VOUCH_OTHER_REQUEST },
    want: "sig",
  });
  addReq({
    id: "sig-by-another-key",
    note: "Signed by a key that is not the signKey.",
    sigOf: { signer: vouchOtherSigner },
    want: "sig",
  });

  // ── results ──
  const results: Record<string, unknown>[] = [];
  const addRes = (
    id: string,
    note: string,
    body: { text: string } | { hex: string },
    want: { status: string } | { refuse: "peer_bad_frame" },
  ): void => {
    const bytes = "text" in body ? utf8(body.text) : hexBytes(body.hex);
    check(`vouch result ${id}`, refVouchResult(bytes), want);
    results.push({
      id,
      note,
      ...("text" in body ? { body: body.text } : { bodyHex: body.hex }),
      ...want,
    });
  };
  const st = (s: string, extra = ""): { text: string } => ({
    text: `{"status":${JSON.stringify(s)}${extra}}`,
  });
  addRes("approved", "The three statuses D shows.", st("approved"), {
    status: "approved",
  });
  addRes("denied", "As above.", st("denied"), { status: "denied" });
  addRes("expired", "As above.", st("expired"), { status: "expired" });
  addRes(
    "unknown-status",
    "Any other string is read as denied.",
    st("pending"),
    { status: "denied" },
  );
  addRes(
    "unknown-status-case",
    "Status names are case-sensitive.",
    st("Approved"),
    { status: "denied" },
  );
  addRes("unknown-status-padded", "A space after the name.", st("approved "), {
    status: "denied",
  });
  addRes("unknown-status-empty", "The empty string.", st(""), {
    status: "denied",
  });
  addRes(
    "retired-status-not-nearby",
    "A sender no longer sends it; a receiver reads it as denied.",
    st("not_nearby"),
    { status: "denied" },
  );
  addRes("retired-status-device-limit", "Same.", st("device_limit"), {
    status: "denied",
  });
  addRes("retired-status-choose", "Same.", st("choose"), { status: "denied" });
  addRes(
    "extra-members-ignored",
    "Members other than status are ignored.",
    st("approved", ',"deviceLabel":"x","n":[1]'),
    { status: "approved" },
  );
  addRes(
    "whitespace",
    "JSON whitespace around the object.",
    { text: ' \n{"status" : "denied"}\t' },
    { status: "denied" },
  );
  addRes(
    "status-missing",
    "No status member.",
    { text: "{}" },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "status-number",
    "A number.",
    { text: '{"status":1}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "status-null",
    "null.",
    { text: '{"status":null}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "status-true",
    "true.",
    { text: '{"status":true}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "status-array",
    "An array holding a status.",
    { text: '{"status":["approved"]}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "status-object",
    "An object.",
    { text: '{"status":{"v":"approved"}}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "body-array",
    "The body is an array.",
    { text: '[{"status":"approved"}]' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "body-string",
    "The body is a string.",
    { text: '"approved"' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "body-null",
    "The body is null.",
    { text: "null" },
    { refuse: "peer_bad_frame" },
  );
  addRes("body-empty", "No bytes.", { hex: "" }, { refuse: "peer_bad_frame" });
  addRes(
    "duplicate-status",
    "status twice.",
    { text: '{"status":"approved","status":"denied"}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "trailing-garbage",
    "Text after the object.",
    { text: '{"status":"approved"}x' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "byte-order-mark",
    "A BOM before the object.",
    { text: '\ufeff{"status":"approved"}' },
    { refuse: "peer_bad_frame" },
  );
  addRes(
    "invalid-utf8",
    "A 0xff byte in an extra member.",
    {
      hex:
        bytesHex(utf8('{"status":"approved","x":"')) +
        "ff" +
        bytesHex(utf8('"}')),
    },
    { refuse: "peer_bad_frame" },
  );

  // ── flows ──
  const flows: Record<string, unknown>[] = [];
  const caps = ["app/1", "vouch/1"];
  const hs = (capsD: string[], capsM: string[]): RefFlowStep => ({
    ev: "handshake",
    capsD,
    capsM,
  });
  const ev = (
    e:
      | "shown"
      | "picked"
      | "wrong-pick"
      | "none-match"
      | "timeout"
      | "confirmed",
  ): RefFlowStep => ({ ev: e });
  const rec = (
    dir: "d2m" | "m2d",
    type: string,
    extra: { status?: "approved" | "denied" | "expired"; bytes?: number } = {},
  ): RefFlowStep => ({ dir, type, ...extra });
  const REQ = (): RefFlowStep => rec("d2m", "8010");
  const RES = (s: "approved" | "denied" | "expired"): RefFlowStep =>
    rec("m2d", "8011", { status: s });
  const WRAP = (t = "0030", bytes = 200): RefFlowStep =>
    rec("m2d", t, { bytes });
  const addFlow = (
    id: string,
    note: string,
    steps: RefFlowStep[],
    want: RefFlowWant,
  ): void => {
    check(`vouch flow ${id}`, refVouchFlow(steps), want);
    flows.push({ id, note, steps, want });
  };
  const ok = (delivered: number[]): RefFlowWant => ({
    close: null,
    at: null,
    delivered,
  });
  const bad = (
    close: string,
    at: number,
    delivered: number[] = [],
  ): RefFlowWant => ({ close, at, delivered });

  addFlow(
    "happy-path",
    "The order of rule 7: code shown, request, pick, result, wrap held until D confirms the account.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      WRAP(),
      ev("confirmed"),
    ],
    ok([2, 4, 5]),
  );
  addFlow(
    "happy-path-pick-first",
    "The pick comes before the request arrives: the request is delivered on arrival.",
    [hs(caps, caps), ev("shown"), ev("picked"), REQ(), RES("approved")],
    ok([3, 4]),
  );
  addFlow(
    "happy-path-wrap-after-confirm",
    "A wrap that arrives after D confirmed is delivered at once.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      ev("confirmed"),
      WRAP(),
    ],
    ok([2, 4, 6]),
  );
  addFlow(
    "happy-path-sync-types",
    "0x0030 and every type up to 0x003f are carried.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      ev("confirmed"),
      WRAP("0031"),
      WRAP("003f"),
    ],
    ok([2, 4, 6, 7]),
  );
  addFlow(
    "request-held-until-pick",
    "No pick: the request is never handed to the host.",
    [hs(caps, caps), ev("shown"), REQ()],
    ok([]),
  );
  addFlow(
    "request-never-delivered-after-wrong-pick",
    "A pick of a decoy closes peer_bye; the held request is never delivered.",
    [hs(caps, caps), ev("shown"), REQ(), ev("wrong-pick")],
    bad("peer_bye", 3),
  );
  addFlow(
    "none-match-closes",
    "None of these match closes peer_bye.",
    [hs(caps, caps), ev("shown"), REQ(), ev("none-match")],
    bad("peer_bye", 3),
  );
  addFlow(
    "code-timeout",
    "No pick in 120 s closes peer_timeout.",
    [hs(caps, caps), ev("shown"), REQ(), ev("timeout")],
    bad("peer_timeout", 3),
  );
  addFlow(
    "request-from-m",
    "VOUCH_REQ sent by M: D refuses it.",
    [hs(caps, caps), rec("m2d", "8010")],
    bad("peer_not_allowed", 1),
  );
  addFlow(
    "request-twice",
    "A repeated VOUCH_REQ.",
    [hs(caps, caps), ev("shown"), REQ(), REQ()],
    bad("peer_bad_frame", 3),
  );
  addFlow(
    "request-twice-after-pick",
    "A repeated VOUCH_REQ after the pick.",
    [hs(caps, caps), ev("shown"), REQ(), ev("picked"), REQ()],
    bad("peer_bad_frame", 4, [2]),
  );
  addFlow(
    "result-from-d",
    "VOUCH_RESULT sent by D: M refuses it.",
    [hs(caps, caps), ev("shown"), rec("d2m", "8011", { status: "approved" })],
    bad("peer_not_allowed", 2),
  );
  addFlow(
    "result-before-request",
    "VOUCH_RESULT before D sent its request.",
    [hs(caps, caps), ev("shown"), RES("approved")],
    bad("peer_not_allowed", 2),
  );
  addFlow(
    "result-twice",
    "A second VOUCH_RESULT.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("denied"),
      RES("denied"),
    ],
    bad("peer_bad_frame", 5, [2, 4]),
  );
  addFlow(
    "result-denied-is-delivered",
    "A denied result is shown to D.",
    [hs(caps, caps), ev("shown"), REQ(), ev("picked"), RES("denied")],
    ok([2, 4]),
  );
  addFlow(
    "wrap-before-result",
    "A wrap before any result.",
    [hs(caps, caps), ev("shown"), REQ(), ev("picked"), WRAP()],
    bad("peer_not_allowed", 4, [2]),
  );
  addFlow(
    "wrap-before-request",
    "A wrap with no request at all.",
    [hs(caps, caps), ev("shown"), WRAP()],
    bad("peer_not_allowed", 2),
  );
  addFlow(
    "wrap-after-denied",
    "A wrap after a denied result.",
    [hs(caps, caps), ev("shown"), REQ(), ev("picked"), RES("denied"), WRAP()],
    bad("peer_not_allowed", 5, [2, 4]),
  );
  addFlow(
    "wrap-after-expired",
    "A wrap after an expired result.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("expired"),
      WRAP("0035"),
    ],
    bad("peer_not_allowed", 5, [2, 4]),
  );
  addFlow(
    "wrap-from-d",
    "A wrap sent by D.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      rec("d2m", "0030", { bytes: 10 }),
    ],
    bad("peer_not_allowed", 5, [2, 4]),
  );
  addFlow(
    "wrap-held-without-confirm",
    "Records after approved are held, not delivered, until D's person confirms the account.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      WRAP(),
      WRAP("0031"),
    ],
    ok([2, 4]),
  );
  const manyWraps = (n: number, bytes = 10): RefFlowStep[] =>
    Array.from({ length: n }, () => WRAP("0030", bytes));
  addFlow(
    "held-16-records",
    "Sixteen held records are kept.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      ...manyWraps(16),
      ev("confirmed"),
    ],
    ok([2, 4, ...Array.from({ length: 16 }, (_, i) => 5 + i)]),
  );
  addFlow(
    "held-17th-record",
    "The seventeenth held record closes peer_busy.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      ...manyWraps(17),
    ],
    bad("peer_busy", 21, [2, 4]),
  );
  addFlow(
    "held-16-kib",
    "Held bodies of exactly 16 KiB are kept.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      WRAP("0030", 8192),
      WRAP("0031", 8192),
    ],
    ok([2, 4]),
  );
  addFlow(
    "held-over-16-kib",
    "One byte more than 16 KiB held closes peer_busy.",
    [
      hs(caps, caps),
      ev("shown"),
      REQ(),
      ev("picked"),
      RES("approved"),
      WRAP("0030", 8192),
      WRAP("0031", 8193),
    ],
    bad("peer_busy", 6, [2, 4]),
  );
  addFlow(
    "vouch-1-both",
    "vouch/1 among other capabilities on both sides.",
    [hs(["app/1", "vouch/1", "vouch/2"], ["vouch/1"]), ev("shown")],
    ok([]),
  );
  addFlow(
    "vouch-1-missing-on-d",
    "D lists no vouch/1: M closes peer_not_allowed before any SAS record.",
    [hs(["app/1"], caps), ev("shown")],
    bad("peer_not_allowed", 0),
  );
  addFlow(
    "vouch-1-missing-on-m",
    "M lists no vouch/1.",
    [hs(caps, ["app/1"]), ev("shown")],
    bad("peer_not_allowed", 0),
  );
  addFlow(
    "vouch-2-only",
    "A later vouch/2 is not read as vouch/1.",
    [hs(["vouch/2"], ["vouch/2"]), ev("shown")],
    bad("peer_not_allowed", 0),
  );
  addFlow(
    "no-capabilities",
    "Neither side lists a capability.",
    [hs([], []), ev("shown")],
    bad("peer_not_allowed", 0),
  );

  // ── finish ──
  const finish: Record<string, unknown>[] = [];
  const addFin = (
    id: string,
    note: string,
    r: {
      http: number | null;
      body?: string | null;
      keysRetried?: boolean;
      discoveryNearby?: boolean;
    },
    result: RefFinishResult,
  ): void => {
    const row: RefFinishRow = {
      keysRetried: r.keysRetried ?? false,
      http: r.http,
      body: r.body ?? null,
      discoveryNearby: r.discoveryNearby ?? true,
    };
    check(`vouch finish ${id}`, refVouchFinish(row), result);
    finish.push({ id, note, ...row, result });
  };
  const code = (c: string): string => JSON.stringify({ code: c });
  addFin(
    "approved",
    "200 approved: send approved.",
    { http: 200, body: '{"status":"approved","deviceLabel":null}' },
    { send: "approved" },
  );
  addFin(
    "approved-after-keys-retry",
    "The retry after registering keys answers approved.",
    {
      http: 200,
      body: '{"status":"approved","deviceLabel":"Ana"}',
      keysRetried: true,
    },
    { send: "approved" },
  );
  addFin("deny-204", "204: send denied.", { http: 204 }, { send: "denied" });
  addFin(
    "not-nearby",
    "403 not_nearby: send denied (the code is not told to D).",
    { http: 403, body: code("not_nearby") },
    { send: "denied" },
  );
  addFin(
    "device-limit",
    "403 device_limit: send denied.",
    { http: 403, body: code("device_limit") },
    { send: "denied" },
  );
  addFin(
    "not-found-discovery-nearby",
    "404 while discovery still names nearby and nearbyApprove: send expired.",
    { http: 404, body: code("not_found") },
    { send: "expired" },
  );
  addFin(
    "not-found-device-mismatch",
    "404 for a deviceId, signKey or agreeKey that is not D's reads the same: send expired.",
    { http: 404, body: code("not_found") },
    { send: "expired" },
  );
  addFin(
    "not-found-discovery-lost",
    "404 after discovery lost nearby: close and stop the advert.",
    { http: 404, body: code("not_found"), discoveryNearby: false },
    { close: true, stopAdvert: true },
  );
  addFin(
    "choose",
    "200 choose: nothing sent; M shows the choice and calls again.",
    { http: 200, body: '{"status":"choose","choices":[]}' },
    { wait: "choice" },
  );
  addFin(
    "keys-required-first",
    "The first 409 device_keys_required: register keys and call again.",
    { http: 409, body: code("device_keys_required") },
    { wait: "keys" },
  );
  addFin(
    "keys-required-again",
    "A second 409 device_keys_required after the retry: close.",
    { http: 409, body: code("device_keys_required"), keysRetried: true },
    { close: true, stopAdvert: false },
  );
  addFin(
    "license-choice-required",
    "409 license_choice_required (a lost mint): show the choice again and call again.",
    { http: 409, body: code("license_choice_required") },
    { wait: "choice" },
  );
  addFin(
    "license-choice-required-after-keys",
    "The same after a keys retry.",
    { http: 409, body: code("license_choice_required"), keysRetried: true },
    { wait: "choice" },
  );
  addFin(
    "conflict-other",
    "Any other 409 closes.",
    { http: 409, body: code("conflict") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "conflict-no-body",
    "A 409 with no body closes.",
    { http: 409 },
    { close: true, stopAdvert: false },
  );
  addFin(
    "account-required",
    "403 account_required: close.",
    { http: 403, body: code("account_required") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "forbidden-other",
    "A 403 with another code: close.",
    { http: 403, body: code("forbidden") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "bad-request",
    "400 bad_request: close.",
    { http: 400, body: code("bad_request") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "invalid-grant",
    "400 invalid_grant: close.",
    { http: 400, body: code("invalid_grant") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "unauthorized",
    "401: close.",
    { http: 401 },
    { close: true, stopAdvert: false },
  );
  addFin(
    "rate-limited",
    "429: close.",
    { http: 429, body: code("rate_limited") },
    { close: true, stopAdvert: false },
  );
  addFin(
    "unavailable",
    "503: close.",
    { http: 503 },
    { close: true, stopAdvert: false },
  );
  addFin(
    "server-error",
    "500: close.",
    { http: 500 },
    { close: true, stopAdvert: false },
  );
  addFin(
    "no-answer",
    "No answer: close.",
    { http: null },
    { close: true, stopAdvert: false },
  );
  addFin(
    "ok-unknown-status",
    "A 200 with a status M does not know: close.",
    { http: 200, body: '{"status":"pending"}' },
    { close: true, stopAdvert: false },
  );
  addFin(
    "ok-no-body",
    "A 200 with no body: close.",
    { http: 200 },
    { close: true, stopAdvert: false },
  );
  addFin(
    "ok-not-json",
    "A 200 whose body is not JSON: close.",
    { http: 200, body: "approved" },
    { close: true, stopAdvert: false },
  );
  addFin(
    "no-content-after-keys",
    "A 204 after the keys retry: send denied.",
    { http: 204, keysRetried: true },
    { send: "denied" },
  );
  addFin(
    "created",
    "A status M does not map (201): close.",
    { http: 201, body: '{"status":"approved"}' },
    { close: true, stopAdvert: false },
  );

  return {
    note: "Mode v: the vouch (15.6.1). `requests`: M's check of a VOUCH_REQ body, `{id, slug, hHex, hello, body | bodyHex | bodyPad, verdict, close?, result?}`; `hHex` is the session's handshake hash (the mode-v handshake of noise-vectors.json), `hello` the members of D's HELLO, cleaned by 15.6 before they are compared. A refusal closes `peer_bad_frame` and calls no route. The proof is the `vouch` proof of 12.11.1 over `<b64url h>.<request>`. `results`: D's reading of a VOUCH_RESULT body, `{id, body | bodyHex, status | refuse}`. `flows`: the order, direction and gating of rule 7, 8 and 12 on one session, `{id, steps, want}`; a step is an event (`handshake` with both capability lists, `shown`, `picked`, `wrong-pick`, `none-match`, `timeout`, `confirmed`) or a record (`dir` d2m or m2d, `type` as four hex digits: 8010 VOUCH_REQ, 8011 VOUCH_RESULT with its `status`, 0030 to 003f the Sync records with their `bytes`); `want` is the close code the receiving side sends and the step index it closes at, and the indices of the records handed to the host in order. `finish`: what M does with the answer to nearby/approve, `{id, keysRetried, http, body, discoveryNearby, result}` with `result` one of `{send}`, `{wait}` or `{close, stopAdvert}`; a problem body names its refusal in `code`.",
    requests,
    results,
    flows,
    finish,
  };
}

export function buildPeerMatrix(): unknown {
  return {
    peerMatrixVersion: 1,
    description:
      "pkey-peer/1 byte-level rules (WIRE-CONTRACT-V5 sections 15.4 to 15.7 and 15.9; plans/CC-01-cloud-connect.md 2.4, 2.6, 2.7, 2.9). Hex fields are lower-case. `adverts`: `names` (the mode-a instance: p1- and the first 16 characters of the lower-case RFC 4648 base32, no padding, of HMAC-SHA256(K_disc, 'pkey-peer/1 disc' || 0x00 || u64be(epoch) || the 24 device-id bytes)), `epochs` (now / 900), `tags` (the h value), `txt` (TXT parsing), `instances` (the name shape) and `browse` (which roster device an instance belongs to); `prologue`; `psk`; `sas` (the code with its commit and reveal rows); `frames` (TCP framing); `records` (flags, MORE, the critical and mode rules, the 1 MiB limit); `relayEnvelopes`; `handshakePayloads`; `lanAddresses` (which peer addresses a device dials or accepts, and the per-address count key); `mdnsAnswers` (which A and AAAA records a browser believes); `vouch` (the mode-v vouch of 15.6.1: `requests`, `results`, `flows`, `finish`). A device id is 32 base64url characters and is hashed and sent as its 24 decoded bytes. The device proof is device-proof.json. Append-only: a new row keeps peerMatrixVersion; a changed row or rule bumps it.",
    adverts: buildAdverts(),
    prologue: buildPrologue(),
    psk: buildPsk(),
    sas: buildSas(),
    frames: buildFrames(),
    records: buildRecords(),
    relayEnvelopes: buildRelay(),
    handshakePayloads: buildPayloads(),
    lanAddresses: buildLanAddresses(),
    mdnsAnswers: buildMdnsAnswers(),
    vouch: buildVouch(),
  };
}
