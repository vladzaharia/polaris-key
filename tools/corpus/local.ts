// `peer-matrix.json` section `local` (CC-29.2 and CC-29.3; WIRE-CONTRACT-V5 §15.12, §15.4, §15.5,
// §15.6): account-free local pairing. The codecs: `codes`, `qr`, `adverts`, `txt`, `body`,
// `secrets` and `handshakePayloads`; the machines: `exchange`, `pin`, `trialOrder`, `window`,
// `gate` and `records`. Every row is recomputed through `reference/local.ts` (`node:crypto` only;
// nothing from client-core), and the HKDF step is also checked against `crypto.hkdfSync`.

import { hkdfSync } from "node:crypto";
import {
  REF_LOCAL_BODY_MAX,
  REF_LOCAL_CODE_DIGITS,
  REF_LOCAL_JOIN_BROWSE_SECONDS,
  REF_LOCAL_JOIN_CANDIDATES,
  REF_LOCAL_MAX_CATS,
  REF_LOCAL_PAIR_FAILURES,
  REF_LOCAL_PAIR_SECONDS,
  REF_LOCAL_QR_SECRET_BYTES,
  REF_MAX_CONTACT_SECRETS,
  REF_MAX_LINK_SECRETS,
  REF_MAX_LIVE_LOCAL_ADVERTS,
  REF_MAX_LOCAL_LINKS,
  type RefLink,
  type ExchangeEvent,
  type BudgetJoin,
  type GateEvent,
  type GateOp,
  type JoinIn,
  type RecordMode,
  type TrialIn,
  type WindowEvent,
  REF_RECORD_ROWS,
  refCodeDisplay,
  refCodeParse,
  refLinkBody,
  refLinkSecret,
  refDialBudget,
  refLocalAdmission,
  REF_ADMISSION_GROUP_PER_MINUTE,
  REF_ADMISSION_SHARED_PER_MINUTE,
  REF_ADMISSION_WAITING,
  REF_ADMISSION_WINDOW_SECONDS,
  type AdmissionEvent,
  refLocalBrowse,
  refLocalExchange,
  refLocalGate,
  refLocalJoin,
  refLocalPin,
  refLocalRecord,
  refLocalTrial,
  refLocalWindow,
  refLocalInstance,
  refLocalNegotiate,
  refLocalPayload,
  refNameplate,
  refNameplateText,
  refPairInstance,
  refParseLocalTxt,
  refParseTxtQ,
  refPassword,
  refPasswordText,
  refQrParse,
  refQrText,
} from "./reference/local.js";
import {
  bytesHex,
  hexBytes,
  refX25519Public,
  sha256,
} from "./reference/noise.js";
import { REF_X25519_LOW_ORDER_HEX } from "./reference/peer.js";
import {
  REF_MAX_PAYLOAD,
  cat,
  refAdvertEpoch,
  utf8,
} from "./reference/peerMatrix.js";
import { buildNoiseVectors } from "./noise.js";
import { buildLocalXfer } from "./xfer.js";

const hex = bytesHex;
/** Fixed test material: SHA-256 of a label. Never used outside this file. */
const mat = (label: string): Uint8Array =>
  sha256(utf8(`pkey-peer/1 local vector ${label}`));
/** A real X25519 public key from a label. */
const linkKey = (label: string): Uint8Array => refX25519Public(mat(label));

function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `local ${label}: reference gives ${JSON.stringify(got)}, row says ${JSON.stringify(want)}`,
    );
}

// ── codes ────────────────────────────────────────────────────────────────────

function buildCodes(): unknown {
  const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);
  const np: { id: string; stream: Uint8Array; inUse?: number[] }[] = [
    { id: "first-byte-under-100", stream: bytes(48) },
    { id: "zero", stream: bytes(0) },
    { id: "99", stream: bytes(99) },
    { id: "100-is-0", stream: bytes(100) },
    { id: "199-is-99", stream: bytes(199) },
    { id: "150-is-50", stream: bytes(150) },
    { id: "200-is-redrawn", stream: bytes(200, 7) },
    { id: "255-is-redrawn", stream: bytes(255, 254, 199, 1) },
    { id: "all-redrawn-runs-out", stream: bytes(200, 201, 255) },
    { id: "empty-stream", stream: bytes() },
    { id: "in-use-is-redrawn", stream: bytes(48, 7), inUse: [48] },
    {
      id: "in-use-by-byte-100-is-redrawn",
      stream: bytes(148, 12),
      inUse: [48],
    },
    { id: "free-after-two-in-use", stream: bytes(1, 2, 3), inUse: [1, 2] },
    { id: "in-use-runs-out", stream: bytes(5), inUse: [5] },
    {
      id: "ninety-nine-in-use",
      stream: bytes(10, 42),
      inUse: Array.from({ length: 100 }, (_, i) => i).filter((i) => i !== 42),
    },
    {
      id: "all-100-in-use-takes-any",
      stream: bytes(10),
      inUse: Array.from({ length: 100 }, (_, i) => i),
    },
    {
      id: "all-100-in-use-still-redraws-200",
      stream: bytes(230, 77),
      inUse: Array.from({ length: 100 }, (_, i) => i),
    },
  ];
  const u32 = (n: number): Uint8Array =>
    Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const pw: { id: string; stream: Uint8Array }[] = [
    { id: "zero", stream: u32(0) },
    { id: "one", stream: u32(1) },
    { id: "leading-zeros", stream: u32(42) },
    { id: "999999", stream: u32(999_999) },
    { id: "1000000-wraps", stream: u32(1_000_000) },
    { id: "mid", stream: u32(2_147_483_648) },
    { id: "last-accepted", stream: u32(4_293_999_999) },
    { id: "first-redrawn", stream: cat(u32(4_294_000_000), u32(5)) },
    { id: "max-redrawn", stream: cat(u32(0xffffffff), u32(123_456)) },
    {
      id: "three-redrawn",
      stream: cat(
        u32(4_294_000_000),
        u32(4_294_967_295),
        u32(4_294_500_000),
        u32(77),
      ),
    },
    { id: "all-redrawn-runs-out", stream: u32(4_294_000_001) },
    { id: "short-stream", stream: Uint8Array.of(1, 2, 3) },
    { id: "empty-stream", stream: new Uint8Array(0) },
  ];
  const display: [string, string][] = [
    ["48", "123456"],
    ["00", "000000"],
    ["00", "000102"],
    ["99", "999999"],
    ["07", "070707"],
  ];
  const parse: [string, string][] = [
    ["spaced", "4812 3456"],
    ["no-space", "48123456"],
    ["hyphen", "4812-3456"],
    ["space-and-hyphen", "4812 - 3456"],
    ["leading-and-trailing-spaces", "  4812 3456  "],
    ["spaces-everywhere", "4 8 1 2 3 4 5 6"],
    ["hyphens-everywhere", "4-8-1-2-3-4-5-6"],
    ["leading-zeros", "0000 0000"],
    ["seven-digits", "4812 345"],
    ["nine-digits", "4812 34567"],
    ["empty", ""],
    ["only-spaces", "    "],
    ["letters", "4812 345a"],
    ["letter-o-for-zero", "4812 3O56"],
    ["tab", "4812\t3456"],
    ["newline", "4812 3456\n"],
    ["no-break-space", "4812\u00a03456"],
    ["en-dash", "4812\u20133456"],
    ["minus-sign", "4812\u22123456"],
    ["underscore", "4812_3456"],
    ["dot", "4812.3456"],
    ["plus", "+4812 3456"],
    [
      "arabic-indic-digits",
      "\u0664\u0668\u0661\u0662 \u0663\u0664\u0665\u0666",
    ],
    ["fullwidth-digits", "\uff14\uff18\uff11\uff12\uff13\uff14\uff15\uff16"],
    ["superscript-digit", "4812 345\u00b2"],
    ["combining-mark", "4812 3456\u0301"],
    ["zero-width-space", "4812\u200b3456"],
  ];
  return {
    digits: REF_LOCAL_CODE_DIGITS,
    nameplate: np.map((r) => {
      const d = refNameplate(r.stream, r.inUse ?? []);
      return {
        id: r.id,
        stream: hex(r.stream),
        inUse: (r.inUse ?? []).map(refNameplateText),
        want: {
          nameplate: d.value === null ? null : refNameplateText(d.value),
          consumed: d.consumed,
        },
      };
    }),
    password: pw.map((r) => {
      const d = refPassword(r.stream);
      return {
        id: r.id,
        stream: hex(r.stream),
        want: {
          password: d.value === null ? null : refPasswordText(d.value),
          consumed: d.consumed,
        },
      };
    }),
    display: display.map(([n, p]) => ({
      id: `${n}-${p}`,
      nameplate: n,
      password: p,
      want: refCodeDisplay(n, p),
    })),
    parse: parse.map(([id, text]) => {
      const v = refCodeParse(text);
      return {
        id,
        text,
        want: v.ok
          ? { ok: true, nameplate: v.nameplate, password: v.password }
          : { ok: false },
      };
    }),
  };
}

// ── qr ───────────────────────────────────────────────────────────────────────

function buildQr(): unknown {
  const sid = mat("qr sid").slice(0, 10);
  const instance = refPairInstance(sid);
  const secret = mat("qr secret").slice(0, 16);
  const text = refQrText("demo", instance, secret);
  const lower = text.toLowerCase();
  const [, , inst, sec] = text.split(":") as [string, string, string, string];
  // The secret with its last character changed so the two unused low bits are not zero.
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const dirty = (s: string): string =>
    s.slice(0, -1) + A[(A.indexOf(s.slice(-1)) + 1) % 32]!;
  const make = [
    ["demo", sid, secret],
    ["demo", mat("qr sid 2").slice(0, 10), mat("qr secret 2").slice(0, 16)],
    ["a", sid, new Uint8Array(16)],
    ["a-b-c-0", sid, new Uint8Array(16).fill(255)],
    ["x".repeat(64), sid, secret],
  ] as const;
  const parse: [string, string, string][] = [
    ["upper-case", text, "demo"],
    ["lower-case", lower, "demo"],
    ["mixed-case", text.slice(0, 20) + lower.slice(20), "demo"],
    ["other-app", text, "other"],
    ["other-app-prefix", text, "dem"],
    ["other-app-lower-case-source", lower, "other"],
    ["wrong-scheme", text.replace("PKP1", "PKP2"), "demo"],
    ["wrong-scheme-lower", text.replace("PKP1", "PKL1"), "demo"],
    ["scheme-missing", text.slice(5), "demo"],
    ["three-fields", `PKP1:DEMO:${inst}${sec}`, "demo"],
    ["five-fields", `${text}:X`, "demo"],
    ["empty-slug", `PKP1::${inst}:${sec}`, "demo"],
    ["slug-with-space", `PKP1:DE MO:${inst}:${sec}`, "demo"],
    ["slug-underscore", `PKP1:DE_MO:${inst}:${sec}`, "demo"],
    ["slug-leading-hyphen", `PKP1:-DEMO:${inst}:${sec}`, "demo"],
    [
      "slug-65-characters",
      `PKP1:${"A".repeat(65)}:${inst}:${sec}`,
      "a".repeat(65),
    ],
    ["instance-15", `PKP1:DEMO:${inst.slice(0, 15)}:${sec}`, "demo"],
    ["instance-17", `PKP1:DEMO:${inst}A:${sec}`, "demo"],
    ["instance-digit-1", `PKP1:DEMO:${inst.slice(0, 15)}1:${sec}`, "demo"],
    ["instance-with-p1-prefix", `PKP1:DEMO:P1-${inst}:${sec}`, "demo"],
    ["secret-25", `PKP1:DEMO:${inst}:${sec.slice(0, 25)}`, "demo"],
    ["secret-27", `PKP1:DEMO:${inst}:${sec}A`, "demo"],
    ["secret-low-bits-set", `PKP1:DEMO:${inst}:${dirty(sec)}`, "demo"],
    ["secret-digit-8", `PKP1:DEMO:${inst}:${sec.slice(0, 25)}8`, "demo"],
    ["secret-padded", `PKP1:DEMO:${inst}:${sec}=`, "demo"],
    ["leading-space", ` ${text}`, "demo"],
    ["trailing-newline", `${text}\n`, "demo"],
    ["url-form", `https://example.test/${text}`, "demo"],
    ["empty", "", "demo"],
    ["only-scheme", "PKP1", "demo"],
    ["other-app-and-bad-secret", `PKP1:OTHER:${inst}:${dirty(sec)}`, "demo"],
  ];
  return {
    secretBytes: REF_LOCAL_QR_SECRET_BYTES,
    make: make.map(([slug, s, k]) => {
      const inst2 = refPairInstance(s);
      return {
        id: `${slug.length > 8 ? `slug-${slug.length}` : slug}-${hex(k).slice(0, 8)}`,
        slug,
        sid: hex(s),
        instance: inst2,
        secret: hex(k),
        want: refQrText(slug, inst2, k),
      };
    }),
    parse: parse.map(([id, t, own]) => ({
      id,
      text: t,
      own,
      want: refQrParse(t, own),
    })),
  };
}

// ── adverts ──────────────────────────────────────────────────────────────────

function buildAdverts(): unknown {
  const NOW = 1761300450;
  const E = refAdvertEpoch(NOW);
  const sids = ["a", "b", "zero", "ones"].map((l): [string, Uint8Array] => [
    l,
    l === "zero"
      ? new Uint8Array(10)
      : l === "ones"
        ? new Uint8Array(10).fill(255)
        : mat(`pair sid ${l}`).slice(0, 10),
  ]);
  const pairing = sids.map(([id, sid]) => ({
    id,
    sid: hex(sid),
    instance: refPairInstance(sid),
  }));
  const linkOf = (label: string): RefLink & { keyHex: string } => {
    const peerKey = linkKey(`${label} peer key`);
    return { secret: mat(`${label} secret`), peerKey, keyHex: hex(peerKey) };
  };
  const a = linkOf("a");
  const b = linkOf("b");
  const c = linkOf("c");
  const wire = (l: RefLink): { secret: string; peerKey: string } => ({
    secret: hex(l.secret),
    peerKey: hex(l.peerKey),
  });
  const nameRow = (
    id: string,
    secret: Uint8Array,
    key: Uint8Array,
    epoch: number,
  ) => ({
    id,
    secret: hex(secret),
    ownLinkKey: hex(key),
    epoch,
    instance: refLocalInstance(secret, key, epoch),
  });
  const names = [
    nameRow("a-epoch", a.secret, a.peerKey, E),
    nameRow("a-epoch-minus-1", a.secret, a.peerKey, E - 1),
    nameRow("a-epoch-zero", a.secret, a.peerKey, 0),
    nameRow("b-epoch", b.secret, b.peerKey, E),
    nameRow("c-epoch-large", c.secret, c.peerKey, 1956999),
    // The two devices of a link publish different names: the advertiser's own key is in the HMAC.
    nameRow("same-secret-other-device", a.secret, b.peerKey, E),
  ];
  if (names[5]!.instance === names[0]!.instance)
    throw new Error("local: advertiser key does not change the name");
  const inst = (l: RefLink, epochBack: number): string =>
    refLocalInstance(l.secret, l.peerKey, E - epochBack);
  const held = [a, b, c];
  const browse: unknown[] = [];
  const brow = (
    id: string,
    links: RefLink[],
    instance: string,
    now = NOW,
  ): void => {
    browse.push({
      id,
      links: links.map(wire),
      now,
      instance,
      want: refLocalBrowse(instance, links, now),
    });
  };
  brow("current-epoch", held, inst(b, 0));
  brow("previous-epoch", held, inst(c, 1));
  brow("two-epochs-back", held, inst(a, 2));
  brow("next-epoch", held, inst(a, -1));
  brow("first-link", held, inst(a, 0));
  brow("not-a-link", held, "p1-aaaaaaaaaaaaaaaa");
  brow("wrong-shape", held, "p1-AAAAAAAAAAAAAAAA");
  brow("no-links", [], inst(a, 0));
  brow("same-secret-other-key", [a], refLocalInstance(a.secret, b.peerKey, E));
  // A contact-advert name for the same secret and key is not a local-link name (other label).
  brow("pairing-name-is-not-a-link-name", held, refPairInstance(sids[0]![1]));
  // Two links with one secret and key: the first in held order wins.
  brow("held-order-first-wins", [a, { ...a }], inst(a, 0));
  const many = Array.from({ length: REF_MAX_LOCAL_LINKS + 1 }, (_, i) =>
    linkOf(`many ${i}`),
  );
  brow(
    "link-32-is-tried",
    many.slice(0, REF_MAX_LOCAL_LINKS),
    inst(many[REF_MAX_LOCAL_LINKS - 1]!, 0),
  );
  brow("link-33-is-not-tried", many, inst(many[REF_MAX_LOCAL_LINKS]!, 0));
  brow(
    "link-32-previous-epoch",
    many.slice(0, REF_MAX_LOCAL_LINKS),
    inst(many[REF_MAX_LOCAL_LINKS - 1]!, 1),
  );
  brow("epoch-boundary-now-899", held, inst(a, 0), 899);
  brow(
    "epoch-boundary-now-900",
    held,
    refLocalInstance(a.secret, a.peerKey, 0),
    900,
  );
  return {
    epochSeconds: 900,
    maxLinks: REF_MAX_LOCAL_LINKS,
    maxLive: REF_MAX_LIVE_LOCAL_ADVERTS,
    pairing,
    names,
    browse,
  };
}

// ── txt ──────────────────────────────────────────────────────────────────────

function buildTxt(): unknown[] {
  const h = "0123456789abcdef";
  const rows: [string, "txt" | "local", string[]][] = [
    ["q", "txt", ["v=1", "m=q", `h=${h}`, "n=48"]],
    ["q-reordered", "txt", ["n=48", "m=q", "v=1", `h=${h}`]],
    ["q-nameplate-zero", "txt", ["v=1", "m=q", `h=${h}`, "n=00"]],
    ["q-nameplate-missing", "txt", ["v=1", "m=q", `h=${h}`]],
    ["q-nameplate-one-digit", "txt", ["v=1", "m=q", `h=${h}`, "n=4"]],
    ["q-nameplate-three-digits", "txt", ["v=1", "m=q", `h=${h}`, "n=481"]],
    ["q-nameplate-letters", "txt", ["v=1", "m=q", `h=${h}`, "n=4a"]],
    ["q-nameplate-empty", "txt", ["v=1", "m=q", `h=${h}`, "n="]],
    [
      "q-nameplate-fullwidth",
      "txt",
      ["v=1", "m=q", `h=${h}`, "n=\uff14\uff18"],
    ],
    ["q-nameplate-padded", "txt", ["v=1", "m=q", `h=${h}`, "n= 4"]],
    ["q-tag-missing", "txt", ["v=1", "m=q", "n=48"]],
    ["q-tag-upper-case", "txt", ["v=1", "m=q", "h=0123456789ABCDEF", "n=48"]],
    ["q-tag-15-characters", "txt", ["v=1", "m=q", `h=${h.slice(1)}`, "n=48"]],
    ["q-tag-17-characters", "txt", ["v=1", "m=q", `h=${h}0`, "n=48"]],
    ["q-version-2", "txt", ["v=2", "m=q", `h=${h}`, "n=48"]],
    ["q-version-missing", "txt", ["m=q", `h=${h}`, "n=48"]],
    ["q-duplicate-nameplate", "txt", ["v=1", "m=q", `h=${h}`, "n=48", "n=49"]],
    ["q-duplicate-mode", "txt", ["v=1", "m=q", "m=q", `h=${h}`, "n=48"]],
    ["q-unknown-key-ignored", "txt", ["v=1", "m=q", `h=${h}`, "n=48", "x=1"]],
    [
      "q-entry-without-equals-ignored",
      "txt",
      ["v=1", "m=q", `h=${h}`, "n=48", "flag"],
    ],
    ["q-mode-upper-case", "txt", ["v=1", "m=Q", `h=${h}`, "n=48"]],
    ["q-key-case-sensitive", "txt", ["v=1", "m=q", `h=${h}`, "N=48"]],
    // `n` is read for m=q only: another mode ignores it, and a refused one is not made valid.
    ["a-nameplate-ignored", "txt", ["v=1", "m=a", "n=zz"]],
    ["v-nameplate-ignored", "txt", ["v=1", "m=v", `h=${h}`, "n=zz"]],
    ["p-nameplate-ignored", "txt", ["v=1", "m=p", `h=${h}`, "n=zz"]],
    ["a", "txt", ["v=1", "m=a"]],
    ["p", "txt", ["v=1", "m=p", `h=${h}`]],
    ["c-is-unknown-mode", "txt", ["v=1", "m=c"]],
    ["l-is-unknown-mode", "txt", ["v=1", "m=l"]],
    ["empty", "txt", []],
    ["l", "local", ["v=1", "m=l"]],
    ["l-reordered", "local", ["m=l", "v=1"]],
    ["l-tag-ignored", "local", ["v=1", "m=l", `h=${h}`]],
    ["l-bad-tag-ignored", "local", ["v=1", "m=l", "h=zz"]],
    ["l-nameplate-ignored", "local", ["v=1", "m=l", "n=48"]],
    ["l-unknown-key-ignored", "local", ["v=1", "m=l", "x=anything"]],
    ["l-entry-without-equals-ignored", "local", ["v=1", "m=l", "flag"]],
    ["l-empty-key-ignored", "local", ["=x", "v=1", "m=l"]],
    ["l-value-with-equals", "local", ["v=1", "m=l", "note=a=b"]],
    ["l-version-2", "local", ["v=2", "m=l"]],
    ["l-version-padded", "local", ["v=01", "m=l"]],
    ["l-version-missing", "local", ["m=l"]],
    ["l-mode-missing", "local", ["v=1"]],
    ["l-mode-upper-case", "local", ["v=1", "m=L"]],
    ["l-key-case-sensitive", "local", ["V=1", "M=l"]],
    ["l-duplicate-version", "local", ["v=1", "v=1", "m=l"]],
    ["l-duplicate-mode", "local", ["v=1", "m=l", "m=l"]],
    ["l-refuses-q", "local", ["v=1", "m=q", `h=${h}`, "n=48"]],
    ["l-refuses-c", "local", ["v=1", "m=c"]],
    ["l-refuses-a", "local", ["v=1", "m=a"]],
    ["l-empty", "local", []],
  ];
  return rows.map(([id, parser, entries]) => ({
    id,
    parser,
    entries,
    want: parser === "txt" ? refParseTxtQ(entries) : refParseLocalTxt(entries),
  }));
}

// ── body ─────────────────────────────────────────────────────────────────────

interface BodyIn {
  id: string;
  text?: string;
  hex?: string;
  pad?: { prefix: string; fill: string; count: number; suffix: string };
}

/** The bytes of a text, hex or padded row. */
function rowBytes(r: BodyIn): Uint8Array {
  if (r.hex !== undefined) return hexBytes(r.hex);
  const p = r.pad;
  return utf8(
    p ? [p.prefix, p.fill.repeat(p.count), p.suffix].join("") : r.text!,
  );
}

/** The row's input as the file spells it: `<key>` the text, `<key>Hex` raw bytes, `<key>Pad`. */
function rowEcho(r: BodyIn, key: "body" | "payload"): Record<string, unknown> {
  return {
    ...(r.hex !== undefined ? { [`${key}Hex`]: r.hex } : {}),
    ...(r.text !== undefined ? { [key]: r.text } : {}),
    ...(r.pad !== undefined ? { [`${key}Pad`]: r.pad } : {}),
  };
}

function buildBody(): unknown[] {
  const body = (o: Record<string, unknown>): string => JSON.stringify(o);
  const ok = (extra: Record<string, unknown> = {}): string =>
    body({ v: 1, cats: [], ...extra });
  const cats8 = [
    "photos",
    "docs",
    "music",
    "video",
    "notes",
    "a-b",
    "x1",
    "2024",
  ];
  const E = (id: string, extra: Record<string, unknown> = {}): BodyIn => ({
    id,
    text: ok(extra),
  });
  const T = (id: string, text: string): BodyIn => ({ id, text });
  const rows: BodyIn[] = [
    E("minimal"),
    E("label", { label: "Anna" }),
    E("label-cleaned", { label: "  Anna\u200b  Phone " }),
    E("label-nothing-left", { label: "\u200b\u200b" }),
    E("label-empty", { label: "" }),
    E("cats", { cats: ["photos", "docs"] }),
    E("cats-8", { cats: cats8 }),
    E("cat-32-characters", { cats: ["a".repeat(32)] }),
    E("cat-1-character", { cats: ["a"] }),
    T("member-order-free", `{"cats":["docs"],"v":1,"label":"Bo"}`),
    E("unknown-member-ignored", { x: { k: [1, null] } }),
    // A key is never part of the body; one that is there is an unknown member.
    E("agree-key-member-ignored", { agreeKey: "x".repeat(43) }),
    E("cats-9", { cats: [...cats8, "extra"] }),
    E("cat-33-characters", { cats: ["a".repeat(33)] }),
    E("cat-empty", { cats: [""] }),
    E("cat-upper-case", { cats: ["Photos"] }),
    E("cat-underscore", { cats: ["my_docs"] }),
    E("cat-space", { cats: ["my docs"] }),
    E("cat-non-ascii", { cats: ["caf\u00e9"] }),
    E("cat-not-string", { cats: [1] }),
    E("cat-repeated", { cats: ["docs", "docs"] }),
    T("cats-missing", body({ v: 1 })),
    E("cats-not-array", { cats: "docs" }),
    E("cats-null", { cats: null }),
    T("v-missing", body({ cats: [] })),
    E("v-2", { v: 2 }),
    E("v-string", { v: "1" }),
    E("label-number", { label: 7 }),
    E("label-null", { label: null }),
    T("duplicate-member", `{"v":1,"cats":[],"v":1}`),
    T("trailing-comma", `{"v":1,"cats":[],}`),
    T("not-an-object", "[1]"),
    T("empty", ""),
    T("trailing-garbage", `${ok()} x`),
    { id: "bom", hex: "efbbbf" + hex(utf8(ok())) },
    {
      id: "invalid-utf8",
      hex: hex(utf8(`{"v":1,"cats":[],"x":"`)) + "ff" + hex(utf8('"}')),
    },
  ];
  // A body of exactly `total` bytes: the minimal body with one long string member.
  const sized = (id: string, total: number): BodyIn => ({
    id,
    pad: {
      prefix: ok({ x: "" }).slice(0, -2),
      fill: "a",
      count: total - ok({ x: "" }).length,
      suffix: '"}',
    },
  });
  rows.push(
    sized("size-4096", REF_LOCAL_BODY_MAX),
    sized("size-4097", REF_LOCAL_BODY_MAX + 1),
  );
  return rows.map((r) => {
    const bytes = rowBytes(r);
    const v = refLinkBody(bytes);
    return {
      id: r.id,
      ...rowEcho(r, "body"),
      length: bytes.length,
      want: v.ok
        ? {
            ok: true,
            ...(v.label !== undefined ? { label: v.label } : {}),
            cats: v.cats,
          }
        : { ok: false },
    };
  });
}

// ── secrets ──────────────────────────────────────────────────────────────────

function buildSecrets(): unknown[] {
  const h = mat("h");
  const isk = cat(mat("isk 1"), mat("isk 2"));
  const kA = linkKey("link a");
  const kB = linkKey("link b");
  // Keys whose first bytes order the other way round from a text spelling of them.
  const kHigh = Uint8Array.of(0xf4, ...new Array<number>(31).fill(0x11));
  const kLow = Uint8Array.of(0x68, ...new Array<number>(31).fill(0x22));
  const rows: {
    id: string;
    h: Uint8Array;
    isk: Uint8Array;
    a: Uint8Array;
    b: Uint8Array;
  }[] = [
    { id: "basic", h, isk, a: kA, b: kB },
    { id: "keys-swapped", h, isk, a: kB, b: kA },
    { id: "other-handshake-hash", h: mat("h2"), isk, a: kA, b: kB },
    { id: "other-isk", h, isk: cat(mat("isk 3"), mat("isk 4")), a: kA, b: kB },
    {
      id: "isk-last-bit",
      h,
      isk: Uint8Array.from(isk, (x, i) => (i === 63 ? x ^ 1 : x)),
      a: kA,
      b: kB,
    },
    { id: "other-key", h, isk, a: kA, b: linkKey("link c") },
    { id: "byte-order", h, isk, a: kHigh, b: kLow },
    { id: "byte-order-swapped", h, isk, a: kLow, b: kHigh },
    { id: "equal-keys", h, isk, a: kA, b: kA },
  ];
  // The inputs a real pairing has (§15.12): h is the handshake hash of the mode-q handshake of
  // noise-vectors.json `cpace.handshakes`, ISK its CPace attempt's and the keys its static keys,
  // so a port that wires the session to the formula checks the whole chain.
  const nv = buildNoiseVectors() as {
    cpace: {
      handshakes: {
        mode: string;
        handshakeHash: string;
        isk: string;
        initStaticPublic: string;
        respStaticPublic: string;
      }[];
    };
  };
  const q = nv.cpace.handshakes.find((x) => x.mode === "q")!;
  rows.push({
    id: "real-pairing-inputs",
    h: hexBytes(q.handshakeHash),
    isk: hexBytes(q.isk),
    a: hexBytes(q.initStaticPublic),
    b: hexBytes(q.respStaticPublic),
  });
  return rows.map((r) => {
    const secret = refLinkSecret(r.h, r.isk, r.a, r.b);
    const [lo, hi] = hex(r.a) <= hex(r.b) ? [r.a, r.b] : [r.b, r.a];
    const cross = new Uint8Array(
      hkdfSync(
        "sha256",
        r.isk,
        r.h,
        cat(utf8("pkey-peer/1 local"), Uint8Array.of(0), lo, hi),
        32,
      ),
    );
    check(`secret ${r.id}`, hex(secret), hex(cross));
    return {
      id: r.id,
      h: hex(r.h),
      isk: hex(r.isk),
      keyA: hex(r.a),
      keyB: hex(r.b),
      secret: hex(secret),
    };
  });
}

// ── handshakePayloads ────────────────────────────────────────────────────────

function buildHandshakePayloads(): unknown {
  interface PIn {
    id: string;
    mode: "q" | "l";
    message: 1 | 2 | 3;
    text?: string;
    hex?: string;
  }
  const rows: PIn[] = [
    { id: "q-msg1", mode: "q", message: 1, text: '{"v":1}' },
    {
      id: "q-msg1-unknown-member-ignored",
      mode: "q",
      message: 1,
      text: '{"v":1,"x":[1]}',
    },
    {
      id: "q-msg1-cert-present",
      mode: "q",
      message: 1,
      text: '{"v":1,"cert":"e30.e30.c2ln"}',
    },
    { id: "q-msg1-version-2", mode: "q", message: 1, text: '{"v":2}' },
    {
      id: "q-msg1-version-1-point-0",
      mode: "q",
      message: 1,
      text: '{"v":1.0}',
    },
    { id: "q-msg2", mode: "q", message: 2, text: '{"v":1,"caps":["local/1"]}' },
    { id: "q-msg3", mode: "q", message: 3, text: '{"v":1,"caps":["local/1"]}' },
    {
      id: "q-msg2-more-caps",
      mode: "q",
      message: 2,
      text: '{"v":1,"caps":["local/1","app/1"]}',
    },
    {
      id: "q-msg2-empty-caps",
      mode: "q",
      message: 2,
      text: '{"v":1,"caps":[]}',
    },
    { id: "q-msg2-caps-missing", mode: "q", message: 2, text: '{"v":1}' },
    {
      id: "q-msg2-cert-refused",
      mode: "q",
      message: 2,
      text: '{"v":1,"cert":"e30.e30.c2ln","caps":["local/1"]}',
    },
    {
      id: "q-msg3-cert-refused",
      mode: "q",
      message: 3,
      text: '{"v":1,"cert":"e30.e30.c2ln","ring":1,"caps":["local/1"]}',
    },
    {
      id: "q-msg2-ring-ignored",
      mode: "q",
      message: 2,
      text: '{"v":1,"ring":3,"caps":["local/1"]}',
    },
    {
      id: "q-msg2-cap-shape",
      mode: "q",
      message: 2,
      text: '{"v":1,"caps":["Local/1"]}',
    },
    {
      id: "q-msg2-version-1-exponent",
      mode: "q",
      message: 2,
      text: '{"v":1e0,"caps":["local/1"]}',
    },
    { id: "q-msg2-not-an-object", mode: "q", message: 2, text: '["local/1"]' },
    {
      id: "q-msg2-bom",
      mode: "q",
      message: 2,
      hex: "efbbbf" + hex(utf8('{"v":1,"caps":["local/1"]}')),
    },
    { id: "l-msg1", mode: "l", message: 1, text: '{"v":1}' },
    { id: "l-msg2", mode: "l", message: 2, text: '{"v":1,"caps":["app/1"]}' },
    {
      id: "l-msg3-xfer",
      mode: "l",
      message: 3,
      text: '{"v":1,"caps":["app/1","xfer/1"]}',
    },
    {
      id: "l-msg2-empty-caps",
      mode: "l",
      message: 2,
      text: '{"v":1,"caps":[]}',
    },
    { id: "l-msg2-caps-missing", mode: "l", message: 2, text: '{"v":1}' },
    {
      id: "l-msg1-cert-present",
      mode: "l",
      message: 1,
      text: '{"v":1,"cert":"e30.e30.c2ln"}',
    },
    {
      id: "l-msg2-cert-refused",
      mode: "l",
      message: 2,
      text: '{"v":1,"cert":"e30.e30.c2ln","caps":["app/1"]}',
    },
    {
      id: "l-msg2-version-missing",
      mode: "l",
      message: 2,
      text: '{"caps":["app/1"]}',
    },
    {
      id: "l-msg2-33-caps",
      mode: "l",
      message: 2,
      text: JSON.stringify({
        v: 1,
        caps: Array.from({ length: 33 }, (_, i) => `c${i}/1`),
      }),
    },
    {
      id: "l-msg2-32-caps",
      mode: "l",
      message: 2,
      text: JSON.stringify({
        v: 1,
        caps: Array.from({ length: 32 }, (_, i) => `c${i}/1`),
      }),
    },
  ];
  const payloads = rows.map((r) => {
    const bytes = rowBytes(r);
    const v = refLocalPayload(r.message, bytes);
    return {
      id: r.id,
      mode: r.mode,
      message: r.message,
      ...rowEcho(r, "payload"),
      length: bytes.length,
      want: v.ok
        ? { ok: true, ...(r.message === 1 ? {} : { caps: v.caps }) }
        : { ok: false },
    };
  });
  const neg: [string, "q" | "l", string[], string[]][] = [
    ["q-both-local", "q", ["local/1"], ["local/1"]],
    ["q-extra-caps", "q", ["local/1", "app/1"], ["app/1", "local/1", "xfer/1"]],
    ["q-remote-lacks-local", "q", ["local/1"], ["app/1"]],
    ["q-local-lacks-local", "q", ["app/1"], ["local/1", "app/1"]],
    ["q-empty-remote", "q", ["local/1"], []],
    ["q-empty-local", "q", [], ["local/1"]],
    ["q-local-2-is-not-local-1", "q", ["local/1"], ["local/2"]],
    ["l-app-and-xfer", "l", ["app/1", "xfer/1"], ["xfer/1", "app/1"]],
    ["l-app-only", "l", ["app/1", "xfer/1"], ["app/1"]],
    ["l-xfer-only", "l", ["xfer/1"], ["app/1", "xfer/1"]],
    ["l-disjoint-is-allowed", "l", ["app/1"], ["xfer/1"]],
    ["l-empty-remote-is-allowed", "l", ["app/1"], []],
    ["l-no-local-cap-needed", "l", ["app/1"], ["app/1", "local/1"]],
  ];
  return {
    note: "Handshake payloads of modes q and l (15.5, 15.12): the rules of a non-account mode, strict JSON of at most 8 KiB, an object; message 1 needs v = 1 (the integer token) and no cert; messages 2 and 3 need v = 1 and caps (at most 32 entries matching ^[a-z0-9]+/[0-9]+$); a cert refuses; ring and unknown members are ignored. `negotiate`: the session's capabilities, the entries both lists hold, once each, in byte order; in mode q a side whose capabilities lack local/1 closes peer_not_allowed after HELLO, before any consent prompt; mode l has no mandatory capability.",
    maxPayload: REF_MAX_PAYLOAD,
    payloads,
    negotiate: neg.map(([id, mode, local, remote]) => ({
      id,
      mode,
      local,
      remote,
      want: refLocalNegotiate(mode, local, remote),
    })),
  };
}

// ── exchange ─────────────────────────────────────────────────────────────────

type StepIn =
  | { event: "own-confirm" }
  | { event: "own-decline" }
  | { event: "peer-confirm" }
  | { event: "peer-link"; body: string }
  | { event: "timeout-confirm" }
  | { event: "timeout-exchange" };

function buildExchange(): unknown[] {
  const good = JSON.stringify({ v: 1, label: "Anna", cats: ["docs", "music"] });
  const noLabel = JSON.stringify({ v: 1, cats: ["docs"] });
  const own = { event: "own-confirm" } as const;
  const decline = { event: "own-decline" } as const;
  const peer = { event: "peer-confirm" } as const;
  const link = (body: string): StepIn => ({ event: "peer-link", body });
  const tc = { event: "timeout-confirm" } as const;
  const te = { event: "timeout-exchange" } as const;
  const rows: {
    id: string;
    steps: StepIn[];
    held?: number;
    cats?: string[];
  }[] = [
    { id: "own-confirms-first", steps: [own, peer, link(good)] },
    { id: "peer-confirms-first", steps: [peer, own, link(good)] },
    { id: "link-is-sent-by-the-later-confirm", steps: [peer, own] },
    {
      id: "link-then-more-events-is-quiet",
      steps: [own, peer, link(good), own, peer, tc, te],
    },
    {
      id: "stores-the-categories-both-listed",
      steps: [own, peer, link(good)],
      cats: ["music", "photos", "docs"],
    },
    {
      id: "no-category-in-common",
      steps: [own, peer, link(good)],
      cats: ["photos"],
    },
    { id: "no-categories-here", steps: [own, peer, link(good)], cats: [] },
    {
      id: "label-is-optional",
      steps: [own, peer, link(noLabel)],
      cats: ["docs"],
    },
    {
      id: "label-cleaned",
      steps: [
        own,
        peer,
        link(JSON.stringify({ v: 1, label: "  Bo\u200b  Phone ", cats: [] })),
      ],
    },
    { id: "link-before-any-confirm", steps: [link(good)] },
    { id: "link-before-peer-confirm", steps: [own, link(good)] },
    { id: "link-before-own-confirm", steps: [peer, link(good)] },
    { id: "peer-confirm-twice", steps: [peer, peer] },
    { id: "peer-confirm-twice-after-own", steps: [own, peer, peer] },
    {
      id: "link-twice-is-quiet-after-the-first",
      steps: [own, peer, link(good), link(good)],
    },
    { id: "body-invalid", steps: [own, peer, link("{}")] },
    {
      id: "body-bad-category",
      steps: [own, peer, link(good.replace("docs", "Docs"))],
    },
    {
      id: "body-too-many-categories",
      steps: [
        own,
        peer,
        link(
          JSON.stringify({
            v: 1,
            cats: Array.from({ length: 9 }, (_, i) => `c${i}`),
          }),
        ),
      ],
    },
    {
      id: "body-carries-a-key-is-ignored",
      steps: [
        own,
        peer,
        link(JSON.stringify({ v: 1, cats: [], agreeKey: "x".repeat(43) })),
      ],
    },
    { id: "decline-before-own-confirm", steps: [decline] },
    { id: "decline-after-peer-confirm", steps: [peer, decline] },
    {
      id: "decline-then-peer-events-is-quiet",
      steps: [decline, peer, link(good)],
    },
    {
      id: "decline-after-own-confirm-is-not-an-event",
      steps: [own, decline, peer, link(good)],
    },
    { id: "confirm-timeout-before-any-confirm", steps: [tc] },
    { id: "confirm-timeout-after-own-confirm", steps: [own, tc] },
    { id: "confirm-timeout-after-peer-confirm", steps: [peer, tc] },
    {
      id: "confirm-timeout-after-both-is-quiet",
      steps: [own, peer, tc, link(good)],
    },
    { id: "exchange-timeout-before-both-is-quiet", steps: [own, te] },
    { id: "exchange-timeout-after-both", steps: [own, peer, te] },
    {
      id: "exchange-timeout-after-the-link-is-quiet",
      steps: [own, peer, link(good), te],
    },
    { id: "after-close-nothing-happens", steps: [peer, peer, own, link(good)] },
    // At 32 held links a valid body closes peer_not_allowed and stores nothing; the body rules
    // come first.
    { id: "at-31-is-stored", steps: [own, peer, link(good)], held: 31 },
    { id: "at-32-is-refused", steps: [own, peer, link(good)], held: 32 },
    { id: "at-33-is-refused", steps: [own, peer, link(good)], held: 33 },
    {
      id: "invalid-body-at-32-is-a-bad-frame",
      steps: [own, peer, link("{}")],
      held: 32,
    },
    {
      id: "full-and-early-link-is-a-bad-frame",
      steps: [own, link(good)],
      held: 32,
    },
  ];
  return rows.map((r) => {
    const events: ExchangeEvent[] = r.steps.map((x) =>
      x.event === "peer-link" ? { event: "peer-link", body: utf8(x.body) } : x,
    );
    const held = r.held ?? 0;
    const cats = r.cats ?? ["docs", "music"];
    return {
      id: r.id,
      held,
      cats,
      steps: r.steps,
      // One entry per step: what this side sends then (`CONFIRM`, `LOCAL_LINK`), the code it
      // closes with, and the link it stores (the label and the categories both sides listed).
      want: refLocalExchange(events, held, cats),
    };
  });
}

// ── pin ──────────────────────────────────────────────────────────────────────

function buildPin(): unknown[] {
  const K1 = linkKey("pin peer 1");
  const K2 = linkKey("pin peer 2");
  const OWN = linkKey("pin own");
  const flip = (b: Uint8Array): Uint8Array => {
    const c = b.slice();
    c[31] = c[31]! ^ 1;
    return c;
  };
  const l: [
    string,
    "initiator" | "responder",
    Uint8Array[],
    number,
    Uint8Array,
  ][] = [
    ["l-initiator-key-matches", "initiator", [K1], 0, K1],
    ["l-responder-key-matches", "responder", [K1, K2], 1, K2],
    ["l-initiator-key-differs", "initiator", [K1], 0, K2],
    ["l-responder-key-differs", "responder", [K1], 0, K2],
    ["l-one-bit-differs", "responder", [K1], 0, flip(K1)],
    [
      "l-top-bit-differs",
      "initiator",
      [K1],
      0,
      Uint8Array.from(K1, (x, i) => (i === 31 ? x ^ 0x80 : x)),
    ],
    // The pin is against the link whose secret opened the session, not against any held key.
    ["l-another-held-links-key", "responder", [K1, K2], 0, K2],
    ["l-own-key-is-not-the-peers", "initiator", [K1], 0, OWN],
  ];
  // The initiator checks after message 2, the responder after message 3; before the transport
  // exists nothing is sent.
  const verdict = (v: ReturnType<typeof refLocalPin>) =>
    v.ok ? { ok: true } : { ok: false, close: v.close, sends: v.sends };
  const after = (role: "initiator" | "responder"): number =>
    role === "initiator" ? 2 : 3;
  const rows = l.map(([id, role, held, matched, remote]) => ({
    id,
    mode: "l",
    role,
    held: held.map(hex),
    matched,
    remoteStatic: hex(remote),
    checkedAfter: after(role),
    want: verdict(refLocalPin("l", held[matched]!, remote)),
  }));
  // Mode q: a remote static key equal to this side's own link key ends the handshake silently.
  const q: [string, "initiator" | "responder", Uint8Array][] = [
    ["q-initiator-remote-is-own-key", "initiator", OWN],
    ["q-responder-remote-is-own-key", "responder", OWN],
    ["q-initiator-remote-is-another-key", "initiator", K1],
    ["q-responder-remote-is-another-key", "responder", K2],
    ["q-one-bit-differs", "responder", flip(OWN)],
  ];
  return [
    ...rows,
    ...q.map(([id, role, remote]) => ({
      id,
      mode: "q",
      role,
      own: hex(OWN),
      remoteStatic: hex(remote),
      checkedAfter: after(role),
      want: verdict(refLocalPin("q", new Uint8Array(0), remote, OWN)),
    })),
  ];
}

// ── trialOrder ───────────────────────────────────────────────────────────────

function buildTrialOrder(): unknown[] {
  const n = (c: string, count: number): string[] =>
    Array.from({ length: count }, () => c);
  const rows: ({ id: string } & TrialIn)[] = [
    {
      id: "account-key-first",
      account: ["k", "k"],
      contacts: n("c", 3),
      locals: n("l", 3),
      opens: { mode: "a", key: 0 },
      limiter: "admit",
    },
    {
      id: "previous-account-key",
      account: ["k", "k"],
      contacts: n("c", 1),
      locals: n("l", 1),
      opens: { mode: "a", key: 1 },
      limiter: "admit",
    },
    {
      id: "absent-account-key-is-skipped",
      account: [null, "k"],
      contacts: [],
      locals: n("l", 2),
      opens: { mode: "a", key: 1 },
      limiter: "admit",
    },
    {
      id: "contact-before-local-links",
      account: ["k", "k"],
      contacts: n("c", 3),
      locals: n("l", 3),
      opens: { mode: "c", contact: 2 },
      limiter: "admit",
    },
    {
      id: "local-link-after-contacts",
      account: ["k", "k"],
      contacts: n("c", 3),
      locals: n("l", 3),
      opens: { mode: "l", link: 0 },
      limiter: "admit",
    },
    {
      id: "local-link-after-account-keys-only",
      account: ["k", "k"],
      contacts: [],
      locals: n("l", 3),
      opens: { mode: "l", link: 2 },
      limiter: "admit",
    },
    {
      id: "local-only-host",
      account: null,
      contacts: [],
      locals: n("l", 3),
      opens: { mode: "l", link: 1 },
      limiter: "admit",
    },
    {
      id: "contacts-and-locals-no-account",
      account: null,
      contacts: n("c", 2),
      locals: n("l", 2),
      opens: { mode: "l", link: 1 },
      limiter: "admit",
    },
    {
      id: "first-local-link",
      account: null,
      contacts: [],
      locals: n("l", 5),
      opens: { mode: "l", link: 0 },
      limiter: "admit",
    },
    {
      id: "last-of-32-is-tried",
      account: null,
      contacts: [],
      locals: n("l", 32),
      opens: { mode: "l", link: 31 },
      limiter: "admit",
    },
    {
      id: "33rd-local-link-is-not-tried",
      account: null,
      contacts: [],
      locals: n("l", 33),
      opens: { mode: "l", link: 32 },
      limiter: "admit",
    },
    {
      id: "last-of-72-contacts-is-tried",
      account: null,
      contacts: n("c", 72),
      locals: n("l", 2),
      opens: { mode: "c", contact: 71 },
      limiter: "admit",
    },
    {
      id: "73rd-contact-is-not-tried",
      account: null,
      contacts: n("c", 73),
      locals: n("l", 2),
      opens: { mode: "c", contact: 72 },
      limiter: "admit",
    },
    {
      id: "the-104th-secret-is-tried",
      account: null,
      contacts: n("c", 72),
      locals: n("l", 32),
      opens: { mode: "l", link: 31 },
      limiter: "admit",
    },
    {
      id: "nothing-opens-it-tries-all-104",
      account: ["k", "k"],
      contacts: n("c", 72),
      locals: n("l", 32),
      opens: null,
      limiter: "admit",
    },
    {
      id: "nothing-opens-it-more-than-104",
      account: ["k", "k"],
      contacts: n("c", 80),
      locals: n("l", 40),
      opens: null,
      limiter: "admit",
    },
    {
      id: "nothing-opens-it-account-only",
      account: ["k", "k"],
      contacts: [],
      locals: [],
      opens: null,
      limiter: "admit",
    },
    {
      id: "nothing-opens-it-no-secrets-no-account",
      account: null,
      contacts: [],
      locals: [],
      opens: null,
      limiter: "admit",
    },
    {
      id: "limiter-refuses-before-any-secret",
      account: ["k", "k"],
      contacts: n("c", 2),
      locals: n("l", 2),
      opens: { mode: "c", contact: 0 },
      limiter: "refuse",
    },
    {
      id: "limiter-covers-local-links",
      account: null,
      contacts: [],
      locals: n("l", 2),
      opens: { mode: "l", link: 0 },
      limiter: "refuse",
    },
    {
      id: "limiter-does-not-touch-an-account-peer",
      account: ["k", "k"],
      contacts: n("c", 2),
      locals: n("l", 2),
      opens: { mode: "a", key: 0 },
      limiter: "refuse",
    },
    {
      id: "limiter-after-failed-account-keys",
      account: ["k", "k"],
      contacts: [],
      locals: n("l", 1),
      opens: { mode: "l", link: 0 },
      limiter: "refuse",
    },
    {
      id: "no-secrets-skips-the-limiter",
      account: ["k", "k"],
      contacts: [],
      locals: [],
      opens: null,
      limiter: "refuse",
    },
  ];
  return rows.map(({ id, ...i }) => ({ id, ...i, want: refLocalTrial(i) }));
}

// ── window ───────────────────────────────────────────────────────────────────

function buildWindow(): unknown[] {
  const o = (t: number): WindowEvent => ({ event: "open", t });
  const c1 = (t: number, valid = true): WindowEvent => ({
    event: "c1",
    t,
    valid,
  });
  const m1 = (t: number, opens: boolean, id?: number): WindowEvent => ({
    event: "msg1",
    t,
    ...(id !== undefined ? { id } : {}),
    opens,
  });
  const ab = (t: number, id?: number): WindowEvent => ({
    event: "abandon",
    t,
    ...(id !== undefined ? { id } : {}),
  });
  const bg = (t: number, id?: number): WindowEvent => ({
    event: "begin-guess",
    t,
    ...(id !== undefined ? { id } : {}),
  });
  const go = (t: number, id?: number): WindowEvent => ({
    event: "guess-opened",
    t,
    ...(id !== undefined ? { id } : {}),
  });
  const gf = (t: number, id?: number): WindowEvent => ({
    event: "guess-failed",
    t,
    ...(id !== undefined ? { id } : {}),
  });
  const rot = (t: number): WindowEvent => ({ event: "rotated", t });
  const se = (t: number, stored: boolean): WindowEvent => ({
    event: "session-end",
    t,
    stored,
  });
  const tick = (t: number): WindowEvent => ({ event: "tick", t });
  const cl = (t: number): WindowEvent => ({ event: "close", t });
  const fail = (t: number): WindowEvent[] => [
    c1(t),
    m1(t + 1, false),
    rot(t + 1),
  ];
  const rows: { id: string; events: WindowEvent[] }[] = [
    { id: "opens", events: [o(0)] },
    {
      id: "an-old-attempts-message-1-is-denied-and-never-tried",
      events: [o(0), c1(1), tick(31), c1(32), bg(33, 1), m1(34, false, 1)],
    },
    {
      id: "an-old-attempts-abandon-does-not-clear-the-new-holder",
      events: [o(0), c1(1), tick(31), c1(32), ab(33, 1), c1(34), bg(35)],
    },
    {
      id: "stalled-a-then-b-admitted-then-a-message-1",
      events: [o(0), c1(1), c1(2), tick(31), c1(32), bg(33, 1), bg(34, 2)],
    },
    {
      id: "a-guess-is-counted-when-permitted",
      events: [o(0), c1(1), bg(2)],
    },
    {
      id: "one-permit-per-attempt",
      events: [o(0), c1(1), bg(2), bg(3)],
    },
    {
      id: "a-guess-that-opens-is-refunded",
      events: [o(0), c1(1), bg(2), go(3)],
    },
    {
      id: "a-permitted-guess-that-fails-rotates",
      events: [o(0), c1(1), bg(2), gf(3), rot(3)],
    },
    {
      id: "five-permits-refunded-count-nothing",
      events: [
        o(0),
        ...[1, 11, 21, 31, 41].flatMap((t) => [
          c1(t),
          bg(t + 1),
          go(t + 1),
          se(t + 2, false),
          rot(t + 2),
        ]),
      ],
    },
    {
      id: "five-permits-without-a-refund-close-the-window",
      events: [
        o(0),
        ...[1, 11, 21, 31].flatMap((t) => [
          c1(t),
          bg(t + 1),
          gf(t + 1),
          rot(t + 1),
        ]),
        c1(41),
        bg(42),
        gf(43),
        c1(44),
      ],
    },
    {
      id: "abandon-after-a-permit-is-a-failed-guess",
      events: [o(0), c1(1), bg(2), ab(3)],
    },
    {
      id: "a-permitted-guess-with-no-verdict-is-failed-at-30-s",
      events: [o(0), c1(1), bg(2), tick(31)],
    },
    {
      id: "a-verdict-after-the-expiry-changes-nothing",
      events: [o(0), c1(298), bg(299), tick(301), gf(302)],
    },
    {
      id: "a-closed-windows-connection-cannot-touch-the-next-window",
      events: [o(0), c1(1), cl(5), o(6), bg(7, 1), ab(8, 1), c1(9), bg(10)],
    },
    {
      id: "c1-during-rotation-is-busy-and-uncounted",
      events: [o(0), c1(1), m1(2, false), c1(3), c1(4), rot(5), c1(6)],
    },
    {
      id: "rotated-is-idempotent",
      events: [o(0), c1(1), m1(2, false), rot(3), rot(4), c1(5)],
    },
    { id: "rotated-with-no-rotation-is-quiet", events: [o(0), rot(1)] },
    {
      id: "a-session-that-ends-without-a-link-holds-the-window-until-rotated",
      events: [
        o(0),
        c1(1),
        m1(2, true),
        se(20, false),
        c1(21),
        rot(22),
        c1(23),
      ],
    },
    {
      id: "closing-during-a-rotation-drops-it",
      events: [o(0), c1(1), m1(2, false), cl(3), rot(4), c1(5)],
    },
    { id: "second-open-while-open", events: [o(0), o(10)] },
    { id: "c1-before-open", events: [c1(0)] },
    {
      id: "good-attempt-reaches-the-transport",
      events: [o(0), c1(1), m1(2, true)],
    },
    {
      id: "good-attempt-then-link-stored-closes-the-window",
      events: [o(0), c1(1), m1(2, true), se(20, true)],
    },
    {
      id: "session-ends-without-a-link-rotates-and-reopens",
      events: [
        o(0),
        c1(1),
        m1(2, true),
        se(20, false),
        rot(20),
        c1(21),
        m1(22, true),
      ],
    },
    {
      id: "session-ends-without-a-link-counts-no-failure",
      events: [o(0), c1(1), m1(2, true), se(20, false)],
    },
    {
      id: "wrong-code-is-one-failure-and-rotates",
      events: [o(0), c1(1), m1(2, false)],
    },
    { id: "two-failures", events: [o(0), ...fail(1), ...fail(5)] },
    {
      id: "four-failures-keep-the-window-open",
      events: [o(0), ...fail(1), ...fail(15), ...fail(30), ...fail(45)],
    },
    {
      id: "fifth-failure-closes-the-window",
      events: [
        o(0),
        ...fail(1),
        ...fail(15),
        ...fail(30),
        ...fail(45),
        ...fail(61),
      ],
    },
    {
      id: "c1-after-too-many-tries",
      events: [
        o(0),
        ...fail(1),
        ...fail(15),
        ...fail(30),
        ...fail(45),
        ...fail(61),
        c1(70),
      ],
    },
    {
      id: "a-new-window-after-too-many-tries-starts-clean",
      events: [
        o(0),
        ...fail(1),
        ...fail(15),
        ...fail(30),
        ...fail(45),
        ...fail(61),
        o(100),
        c1(101),
      ],
    },
    {
      id: "good-attempt-between-failures-does-not-reset-them",
      events: [
        o(0),
        ...fail(1),
        c1(15),
        m1(16, true),
        se(30, false),
        rot(30),
        ...fail(40),
      ],
    },
    {
      id: "invalid-c1-counts-nothing-and-rotates-nothing",
      events: [o(0), c1(1, false)],
    },
    {
      id: "invalid-c1-does-not-hold-the-window",
      events: [o(0), c1(1, false), c1(2), m1(3, true)],
    },
    {
      id: "second-c1-while-an-attempt-holds-is-busy",
      events: [o(0), c1(1), c1(2)],
    },
    {
      id: "invalid-c1-while-an-attempt-holds-is-busy",
      events: [o(0), c1(1), c1(2, false)],
    },
    {
      id: "second-c1-while-a-session-holds-is-busy",
      events: [o(0), c1(1), m1(2, true), c1(3)],
    },
    {
      id: "busy-c1-does-not-count-against-the-limiter",
      events: [o(0), c1(1), c1(2), c1(3), c1(4), c1(5), c1(6), ab(7), c1(8)],
    },
    {
      id: "attempt-abandoned-before-message-1-counts-nothing",
      events: [o(0), c1(1), ab(5)],
    },
    {
      id: "abandoned-attempt-frees-the-window",
      events: [o(0), c1(1), ab(5), c1(6), m1(7, true)],
    },
    {
      id: "attempt-times-out-after-30-s",
      events: [o(0), c1(1), tick(31), c1(32)],
    },
    {
      id: "attempt-still-holds-at-29-s",
      events: [o(0), c1(1), tick(30), c1(31)],
    },
    {
      id: "late-message-1-after-the-deadline-is-ignored",
      events: [o(0), c1(1), bg(40)],
    },
    {
      id: "message-1-without-an-attempt-is-ignored",
      events: [o(0), m1(1, false)],
    },
    {
      id: "five-c1-a-minute-are-admitted",
      events: [
        o(0),
        c1(1, false),
        c1(2, false),
        c1(3, false),
        c1(4, false),
        c1(5, false),
      ],
    },
    {
      id: "sixth-c1-in-a-minute-is-limited",
      events: [
        o(0),
        c1(1, false),
        c1(2, false),
        c1(3, false),
        c1(4, false),
        c1(5, false),
        c1(6, false),
      ],
    },
    {
      id: "limiter-counts-from-the-first-admitted",
      events: [
        o(0),
        c1(1, false),
        c1(2, false),
        c1(3, false),
        c1(4, false),
        c1(5, false),
        c1(60, false),
        c1(61, false),
      ],
    },
    {
      id: "limiter-frees-after-60-s",
      events: [
        o(0),
        c1(1, false),
        c1(2, false),
        c1(3, false),
        c1(4, false),
        c1(5, false),
        c1(61),
      ],
    },
    {
      id: "limited-c1-does-not-extend-the-limiter",
      events: [
        o(0),
        c1(1, false),
        c1(2, false),
        c1(3, false),
        c1(4, false),
        c1(5, false),
        c1(30, false),
        c1(61),
      ],
    },
    {
      id: "window-expires-at-300-s",
      events: [o(0), tick(299), tick(300), c1(301)],
    },
    { id: "window-open-at-299-s", events: [o(0), c1(299)] },
    { id: "c1-at-300-s-is-closed", events: [o(0), c1(300)] },
    {
      id: "expiry-closes-a-connection-that-has-not-reached-the-transport",
      events: [o(0), c1(299), tick(300)],
    },
    {
      id: "a-session-runs-on-past-the-expiry",
      events: [o(0), c1(290), m1(291, true), tick(310), se(320, false)],
    },
    {
      id: "session-past-the-expiry-stores-a-link",
      events: [o(0), c1(290), m1(291, true), tick(310), se(320, true)],
    },
    {
      id: "open-while-a-session-holds-after-expiry",
      events: [o(0), c1(290), m1(291, true), tick(310), o(311)],
    },
    { id: "open-after-expiry", events: [o(0), tick(301), o(302), c1(303)] },
    {
      id: "failure-after-expiry-is-not-counted",
      events: [o(0), c1(298), tick(301), m1(302, false)],
    },
    { id: "person-closes-the-window", events: [o(0), cl(10), c1(11)] },
    {
      id: "person-closes-with-an-attempt-running",
      events: [o(0), c1(1), cl(5), m1(6, false)],
    },
    { id: "close-twice", events: [o(0), cl(10), cl(11)] },
    {
      id: "reopen-after-close-resets-the-count",
      events: [o(0), ...fail(1), cl(10), o(11)],
    },
    {
      id: "rotation-after-every-failure-and-every-declined-session",
      events: [
        o(0),
        ...fail(1),
        c1(15),
        m1(16, true),
        se(30, false),
        rot(30),
        ...fail(40),
      ],
    },
  ];
  return rows.map((r) => ({
    id: r.id,
    steps: r.events,
    // One entry per event: what it decided (`result`, and the attempt `id` of an `attempt`), and
    // the window after it: open, who holds it (an `attempt` from a valid C1 until its guess or its
    // 30 s, a `session` from a guess that opens until it ends, `rotating` from a failed guess or a
    // session without a link until `rotated`), the guesses counted so far and the rotations in
    // this window, and why it is closed. `host` is what the person hears.
    want: refLocalWindow(r.events),
  }));
}

// ── join ─────────────────────────────────────────────────────────────────────

function buildJoin(): unknown[] {
  const inst = (l: string): string =>
    refPairInstance(mat(`join ${l}`).slice(0, 10));
  const ad = (
    l: string,
    n = "48",
    h: "current" | "previous" | "other" = "current",
  ) => ({
    instance: inst(l),
    h,
    n,
  });
  const code = { kind: "code", nameplate: "48" } as const;
  const qr = (l: string) => ({ kind: "qr", instance: inst(l) }) as const;
  const rows: ({ id: string } & JoinIn)[] = [
    {
      id: "code-matches-one-advert",
      input: code,
      adverts: [ad("a")],
      dials: ["transport"],
    },
    { id: "code-no-advert", input: code, adverts: [], dials: [] },
    {
      id: "code-other-nameplate",
      input: code,
      adverts: [ad("a", "49")],
      dials: [],
    },
    {
      id: "code-other-product",
      input: code,
      adverts: [ad("a", "48", "other")],
      dials: [],
    },
    {
      id: "code-previous-epoch-tag",
      input: code,
      adverts: [ad("a", "48", "previous")],
      dials: ["transport"],
    },
    {
      id: "code-first-seen-is-dialled-first",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["before-c2", "transport"],
    },
    {
      id: "code-first-reaches-the-transport",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["transport"],
    },
    {
      id: "code-two-fail-before-c2-is-not-found",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["before-c2", "before-c2"],
    },
    {
      id: "code-first-fails-after-c2-then-second-fails-before",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["after-c2", "before-c2"],
    },
    {
      id: "code-first-fails-before-then-second-after-c2",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["before-c2", "after-c2"],
    },
    {
      id: "code-wrong-code-on-both",
      input: code,
      adverts: [ad("a"), ad("b")],
      dials: ["after-c2", "after-c2"],
    },
    {
      id: "code-third-match-is-never-dialled",
      input: code,
      adverts: [ad("a"), ad("b"), ad("c")],
      dials: ["before-c2", "before-c2", "transport"],
    },
    {
      id: "code-one-failure-after-c2",
      input: code,
      adverts: [ad("a")],
      dials: ["after-c2"],
    },
    {
      id: "code-one-failure-before-c2",
      input: code,
      adverts: [ad("a")],
      dials: ["before-c2"],
    },
    {
      id: "code-skips-non-matching-adverts",
      input: code,
      adverts: [ad("x", "11"), ad("a"), ad("y", "48", "other"), ad("b")],
      dials: ["before-c2", "transport"],
    },
    {
      id: "code-repeated-instance-is-kept-once",
      input: code,
      adverts: [ad("a"), ad("a"), ad("b")],
      dials: ["before-c2", "transport"],
    },
    {
      id: "code-keeps-at-most-8",
      input: code,
      adverts: Array.from({ length: 10 }, (_, i) => ad(`m${i}`)),
      dials: ["before-c2", "before-c2"],
    },
    {
      id: "qr-matches-its-instance",
      input: qr("a"),
      adverts: [ad("a"), ad("b")],
      dials: ["transport"],
    },
    {
      id: "qr-ignores-the-nameplate",
      input: qr("b"),
      adverts: [ad("a", "48"), ad("b", "99")],
      dials: ["transport"],
    },
    {
      id: "qr-no-such-instance",
      input: qr("z"),
      adverts: [ad("a"), ad("b")],
      dials: [],
    },
    {
      id: "qr-other-product-tag",
      input: qr("a"),
      adverts: [ad("a", "48", "other")],
      dials: [],
    },
    {
      id: "qr-wrong-secret-fails-after-c2",
      input: qr("a"),
      adverts: [ad("a")],
      dials: ["after-c2"],
    },
    {
      id: "code-did-not-parse",
      input: { kind: "invalid" },
      adverts: [ad("a")],
      dials: [],
    },
    { id: "qr-was-not-ok", input: { kind: "invalid" }, adverts: [], dials: [] },
  ];
  return rows.map(({ id, ...i }) => ({ id, ...i, want: refLocalJoin(i) }));
}

// ── joinBudget ───────────────────────────────────────────────────────────────

function buildJoinBudget(): unknown[] {
  const code = (nameplate: string): BudgetJoin["input"] => ({
    kind: "code",
    nameplate,
  });
  const rows: { id: string; joins: BudgetJoin[] }[] = [
    {
      id: "a-first-join-is-allowed",
      joins: [{ t: 0, input: code("48"), dials: 2 }],
    },
    {
      id: "two-dials-spend-the-budget",
      joins: [
        { t: 0, input: code("48"), dials: 2 },
        { t: 10, input: code("48"), dials: 1 },
      ],
    },
    {
      id: "one-dial-at-a-time-spends-it-over-two-joins",
      joins: [
        { t: 0, input: code("48"), dials: 1 },
        { t: 10, input: code("48"), dials: 1 },
        { t: 20, input: code("48"), dials: 1 },
      ],
    },
    {
      id: "a-join-with-no-dial-spends-nothing",
      joins: [
        { t: 0, input: code("48"), dials: 0 },
        { t: 10, input: code("48"), dials: 0 },
        { t: 20, input: code("48"), dials: 2 },
        { t: 30, input: code("48"), dials: 1 },
      ],
    },
    {
      id: "the-budget-is-per-nameplate",
      joins: [
        { t: 0, input: code("48"), dials: 2 },
        { t: 1, input: code("49"), dials: 2 },
        { t: 2, input: code("48"), dials: 1 },
        { t: 3, input: code("49"), dials: 1 },
      ],
    },
    {
      id: "the-budget-frees-after-300-s",
      joins: [
        { t: 0, input: code("48"), dials: 2 },
        { t: 299, input: code("48"), dials: 1 },
        { t: 300, input: code("48"), dials: 1 },
      ],
    },
    {
      id: "a-refused-join-does-not-extend-the-budget",
      joins: [
        { t: 0, input: code("48"), dials: 2 },
        { t: 200, input: code("48"), dials: 1 },
        { t: 300, input: code("48"), dials: 1 },
      ],
    },
    {
      id: "a-qr-is-never-limited",
      joins: [
        { t: 0, input: { kind: "qr" }, dials: 2 },
        { t: 1, input: { kind: "qr" }, dials: 2 },
        { t: 2, input: { kind: "qr" }, dials: 2 },
      ],
    },
    {
      id: "a-qr-does-not-spend-a-code-budget",
      joins: [
        { t: 0, input: { kind: "qr" }, dials: 2 },
        { t: 1, input: code("48"), dials: 2 },
      ],
    },
  ];
  return rows.map((r) => ({
    id: r.id,
    joins: r.joins,
    want: refDialBudget(r.joins),
  }));
}

// ── admission (a listener that holds no account key) ─────────────────────────

function buildAdmission(): unknown[] {
  const m = (t: number, group: string, opens = false): AdmissionEvent => ({
    t,
    group,
    opens,
  });
  const rel = (t: number, release: number): AdmissionEvent => ({ t, release });
  const later = (t: number, group: string, opens: boolean): AdmissionEvent => ({
    t,
    group,
    opens,
    later: true,
  });
  const settle = (t: number, at: number): AdmissionEvent => ({ t, settle: at });
  const rows: { id: string; events: AdmissionEvent[] }[] = [
    {
      id: "a-group-gets-two-a-minute",
      events: [m(0, "g1"), m(1, "g1"), m(2, "g1"), m(3, "g1")],
    },
    {
      id: "the-group-window-slides",
      events: [
        m(0, "g1"),
        m(10, "g1"),
        m(30, "g1"),
        m(65, "g1"),
        m(66, "g1"),
        m(75, "g1"),
      ],
    },
    {
      id: "another-group-is-not-touched",
      events: [m(0, "g1"), m(1, "g1"), m(2, "g1"), m(3, "g2"), m(4, "g2")],
    },
    {
      id: "a-refused-message-is-not-counted",
      events: [m(0, "g1"), m(1, "g1"), m(2, "g1"), m(3, "g1"), m(70, "g1")],
    },
    {
      id: "an-opening-trial-is-refunded",
      events: [
        m(0, "g1", true),
        m(1, "g1", true),
        m(2, "g1", true),
        m(3, "g1"),
        m(4, "g1"),
        m(5, "g1"),
      ],
    },
    {
      id: "one-group-spends-two-of-the-shared-five",
      events: [
        m(0, "g1"),
        m(1, "g1"),
        m(2, "g1"),
        m(3, "g1"),
        m(4, "g2"),
        m(5, "g2"),
        m(6, "g3"),
        m(7, "g4"),
      ],
    },
    {
      id: "five-failures-close-the-shared-budget",
      events: [
        m(0, "g1"),
        m(1, "g1"),
        m(2, "g2"),
        m(3, "g2"),
        m(4, "g3"),
        m(5, "g4"),
        m(6, "g5", true),
        m(70, "g5"),
        m(71, "g5"),
      ],
    },
    {
      id: "the-group-is-asked-before-the-shared-budget",
      events: [
        m(0, "g1"),
        m(1, "g1"),
        m(2, "g2"),
        m(3, "g2"),
        m(4, "g3"),
        m(5, "g1"),
        m(6, "g4"),
      ],
    },
    {
      id: "four-waiting-then-a-release",
      events: [
        m(0, "g1", true),
        m(1, "g2", true),
        m(2, "g3", true),
        m(3, "g4", true),
        m(4, "g5", true),
        rel(5, 0),
        m(6, "g5", true),
        rel(7, 0),
        rel(8, 6),
      ],
    },
    {
      id: "a-hit-spends-no-shared-budget",
      events: [
        m(0, "g1", true),
        m(1, "g2", true),
        m(2, "g3", true),
        rel(3, 0),
        rel(4, 1),
        rel(5, 2),
        m(6, "g1"),
        m(7, "g2"),
        m(8, "g3"),
        m(9, "g4"),
        m(10, "g5"),
        m(11, "g6"),
      ],
    },
    {
      // The refund reaches the group's live count even after other messages came in between.
      id: "a-refund-after-other-messages",
      events: [
        later(0, "g1", true),
        m(1, "g2"),
        m(2, "g3"),
        settle(3, 0),
        m(4, "g1"),
        m(5, "g1"),
        m(6, "g1"),
      ],
    },
    {
      id: "a-late-failure-spends-the-shared-budget-when-settled",
      events: [
        later(0, "g1", false),
        m(1, "g2"),
        settle(2, 0),
        m(3, "g1"),
        m(4, "g1"),
      ],
    },
    {
      id: "failures-leave-the-shared-window-by-time",
      events: [
        m(0, "g1"),
        m(10, "g1"),
        m(20, "g2"),
        m(30, "g2"),
        m(40, "g3"),
        m(45, "g4"),
        m(65, "g4"),
        m(66, "g5"),
        m(75, "g5"),
      ],
    },
  ];
  return rows.map((r) => ({
    id: r.id,
    events: r.events,
    want: refLocalAdmission(r.events),
  }));
}

// ── gate ─────────────────────────────────────────────────────────────────────

function buildGate(): unknown[] {
  const doc = (connect: unknown): unknown => ({ services: { connect } });
  const on = doc({
    enabled: true,
    lan: true,
    relay: false,
    interAccount: false,
    localPairing: true,
    endpoints: { identity: null, devices: null, ticket: null },
  });
  const off = doc({
    enabled: true,
    lan: true,
    relay: false,
    interAccount: false,
    localPairing: false,
    endpoints: { identity: null, devices: null, ticket: null },
  });
  const absent = doc({
    enabled: true,
    lan: true,
    relay: false,
    interAccount: false,
    endpoints: { identity: null, devices: null, ticket: null },
  });
  const read = (body: unknown): GateEvent => ({ read: "ok", body });
  const nf: GateEvent = { read: "not-found" };
  const err: GateEvent = { read: "error" };
  const call = (c: GateOp): GateEvent => ({ call: c });
  const gated: GateOp[] = [
    "pair",
    "join",
    "advertise-q",
    "advertise-l",
    "browse-q",
    "browse-l",
    "dial-l",
    "answer-l",
  ];
  const managed: GateOp[] = ["list", "rename", "remove", "set-reachable"];
  const rows: {
    id: string;
    start: "on" | "off" | "none";
    steps: GateEvent[];
  }[] = [
    { id: "no-cached-document-is-off", start: "none", steps: gated.map(call) },
    { id: "cached-off-refuses", start: "off", steps: gated.map(call) },
    { id: "cached-on-allows", start: "on", steps: gated.map(call) },
    {
      id: "managing-links-is-never-gated-when-off",
      start: "off",
      steps: managed.map(call),
    },
    {
      id: "managing-links-is-never-gated-with-no-document",
      start: "none",
      steps: managed.map(call),
    },
    {
      id: "read-true-turns-it-on",
      start: "none",
      steps: [read(on), call("pair")],
    },
    {
      id: "read-false-keeps-it-off",
      start: "none",
      steps: [read(off), call("pair")],
    },
    {
      id: "member-absent-reads-as-false",
      start: "none",
      steps: [read(absent), call("pair")],
    },
    {
      id: "connect-disabled-reads-as-false",
      start: "on",
      steps: [read(doc({ enabled: false })), call("pair")],
    },
    {
      id: "services-missing-reads-as-false",
      start: "on",
      steps: [read({}), call("pair")],
    },
    {
      id: "connect-missing-reads-as-false",
      start: "on",
      steps: [read({ services: {} }), call("join")],
    },
    {
      id: "body-not-an-object-reads-as-false",
      start: "on",
      steps: [read("on"), call("pair")],
    },
    {
      id: "body-null-reads-as-false",
      start: "on",
      steps: [read(null), call("pair")],
    },
    {
      id: "string-true-is-not-true",
      start: "none",
      steps: [read(doc({ enabled: true, localPairing: "true" })), call("pair")],
    },
    {
      id: "number-one-is-not-true",
      start: "none",
      steps: [read(doc({ enabled: true, localPairing: 1 })), call("pair")],
    },
    {
      id: "member-true-with-the-service-disabled-reads-as-false",
      start: "none",
      steps: [read(doc({ enabled: false, localPairing: true })), call("pair")],
    },
    {
      id: "member-true-without-enabled-reads-as-false",
      start: "none",
      steps: [read(doc({ localPairing: true })), call("pair")],
    },
    {
      id: "enabled-as-a-string-reads-as-false",
      start: "none",
      steps: [read(doc({ enabled: "true", localPairing: true })), call("pair")],
    },
    {
      id: "connect-as-an-array-reads-as-false",
      start: "on",
      steps: [read(doc([true, true])), call("pair")],
    },
    {
      id: "connect-as-a-string-reads-as-false",
      start: "on",
      steps: [read(doc("enabled")), call("pair")],
    },
    {
      id: "read-false-withdraws",
      start: "on",
      steps: [call("pair"), read(off), call("pair")],
    },
    {
      id: "read-false-when-already-off-has-no-effect",
      start: "off",
      steps: [read(off)],
    },
    {
      id: "read-true-when-already-on-has-no-effect",
      start: "on",
      steps: [read(on), call("dial-l")],
    },
    {
      id: "not-found-clears-a-cached-true",
      start: "on",
      steps: [nf, call("advertise-l")],
    },
    { id: "not-found-when-off-has-no-effect", start: "off", steps: [nf] },
    { id: "not-found-with-none-has-no-effect", start: "none", steps: [nf] },
    {
      id: "error-keeps-a-cached-true",
      start: "on",
      steps: [err, call("pair")],
    },
    {
      id: "error-keeps-a-cached-false",
      start: "off",
      steps: [err, call("pair")],
    },
    {
      id: "error-keeps-no-document",
      start: "none",
      steps: [err, call("pair")],
    },
    {
      id: "offline-keeps-working-over-several-errors",
      start: "on",
      steps: [err, err, err, call("answer-l"), call("browse-l")],
    },
    {
      id: "off-then-on-again",
      start: "on",
      steps: [read(off), read(on), call("pair")],
    },
    {
      id: "on-off-not-found-on",
      start: "none",
      steps: [read(on), read(off), nf, read(on), call("join")],
    },
  ];
  return rows.map((r) => ({
    id: r.id,
    start: r.start,
    steps: r.steps,
    // One entry per step: the cached answer after it (`on`, `off`, or `none` for no cached
    // document), the result of a call (`ok` or the typed N/A `local-pairing-off`), and, for a
    // read that cleared a cached true, the effects the SDK performs.
    want: refLocalGate(r.start, r.steps),
  }));
}

// ── records ──────────────────────────────────────────────────────────────────

function buildRecords(): unknown[] {
  const modes: RecordMode[] = ["q", "l"];
  const types: [string, number][] = [
    ...REF_RECORD_ROWS.flatMap((r): [string, number][] => {
      const ts = [r.from];
      if (r.to !== r.from) ts.push(r.to);
      return ts.map((t) => [
        `${r.name.toLowerCase()}-${t.toString(16).padStart(4, "0")}`,
        t,
      ]);
    }),
    ["unknown-non-critical-0007", 0x0007],
    ["unknown-non-critical-00ff", 0x00ff],
    ["unknown-critical-8020", 0x8020],
    ["unknown-critical-80fd", 0x80fd],
    ["reserved-fffe", 0xfffe],
    ["reserved-ffff", 0xffff],
    ["app-0101", 0x0101],
    ["app-critical-8101", 0x8101],
    ["xfer-0023", 0x0023],
  ];
  const rows: { id: string; mode: RecordMode; type: number }[] = [];
  for (const mode of modes)
    for (const [name, type] of types)
      rows.push({ id: `${mode}-${name}`, mode, type });
  // The other modes' view of the two new rows (CONFIRM and LOCAL_LINK).
  for (const mode of ["a", "v", "p", "c"] as RecordMode[])
    for (const [name, type] of [
      ["confirm-8012", 0x8012],
      ["local-link-0014", 0x0014],
      ["xfer-0020", 0x0020],
    ] as const)
      rows.push({ id: `${mode}-${name}`, mode, type });
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    type: r.type.toString(16).padStart(4, "0"),
    // `allowed` (with the capability the session needs for it), a close code, or `ignored` (an
    // unknown type without the critical bit).
    want: refLocalRecord(r.mode, r.type),
  }));
}

export function buildLocal(): unknown {
  for (let k = 0; k < REF_X25519_LOW_ORDER_HEX.length; k++)
    if (REF_X25519_LOW_ORDER_HEX[k]!.length !== 64)
      throw new Error("local: low-order reference");
  return {
    note: "Account-free local pairing (15.12, 15.4, 15.5). `codes`: `nameplate` (a byte stream drawn one byte at a time: 200 or more is drawn again, then mod 100; a nameplate in `inUse` is drawn again unless all 100 are in use; `want.consumed` is the bytes read and a null nameplate means the stream ran out), `password` (4 bytes a draw as a u32be, drawn again at 4294000000 or more, then mod 10^6, written with leading zeros), `display` (two groups of four digits, one space) and `parse` (a typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits; nothing else, another script's digits included). `qr`: `make` (PKP1:SLUG:INSTANCE:SECRET in upper case, the instance's 16 base32 characters and the secret's 26 with the two unused low bits zero) and `parse` (fold ASCII case, four fields split at ':', then ok, other-app when the slug is well formed but not `own`, or invalid; the secret's last character must keep its low two bits zero). `adverts`: `pairing` (the m=q instance p1- + the 16 base32 characters of the window's 10 bytes), `names` (the m=l instance p1- + the first 16 characters of the lower-case base32 of HMAC-SHA256(secret, 'pkey-peer/1 ldisc' || 0x00 || u64be(epoch) || the advertiser's own link key)) and `browse` (which held link, in held order and among the first 32, an instance belongs to in the current or previous epoch; each link lists its `secret` and the peer's link key `peerKey`, the key the peer advertises with). `txt`: `parser` txt is parseTxt (m = a, v, p or q; for q `h` is 16 lower-case hex characters and `n` exactly two ASCII digits; n is read for q only; c and l are unknown modes there), `parser` local is parseLocalTxt (v=1 and m=l; no h and no n are read); an entry splits at its first '='; one without '=' or with an empty key is ignored; a repeated key refuses. `body`: a LOCAL_LINK body, strict JSON of at most 4 KiB, v = 1, an optional label cleaned as a HELLO label (nothing left means none), cats an array of at most 8 distinct strings of ^[a-z0-9-]{1,32}$; unknown members are ignored. `secrets`: HKDF-SHA256(salt = h, ikm = ISK (64 bytes), info = 'pkey-peer/1 local' || 0x00 || lo || hi), 32 bytes, lo and hi the two link public keys by unsigned byte order (the row real-pairing-inputs uses the mode-q handshake of noise-vectors.json `cpace.handshakes`). `handshakePayloads`: the payloads of modes q and l and the capability negotiation. `exchange`: one side's pairing events in order (own-confirm, own-decline, peer-confirm, peer-link with the body text, timeout-confirm: the 120 s from the first byte ran out, timeout-exchange: the 30 s after both CONFIRMs ran out), with `held` the local links the device holds and `cats` this side's approved categories; `want` has one entry per step: what that step makes this side send (CONFIRM, LOCAL_LINK, the second once this side's CONFIRM is sent and the peer's read), the code it closes with, and the link it stores (`label`, and `cats` the entries both sides listed in byte order, then peer_bye); after a close nothing more happens, so a side that stored the first valid LOCAL_LINK (and closed peer_bye) never answers a second one (row link-twice-is-quiet-after-the-first); a decline before this side's CONFIRM closes peer_bye. `pin`: mode l checks the remote static key against the peer link key of the link whose secret opened the session (after message 2 for the initiator, after message 3 for the responder): a mismatch is peer_revoked and nothing is sent; mode q ends the handshake silently when the remote static key is this side's own link key. `trialOrder`: the shared listener's trial of message 1: account discKeys (null = none; two tried), then contact secrets (72 tried), then local-link secrets (32 tried), at most 104 secrets after the account keys; `opens` names the key whose tag verifies; `limiter` is what the contact limiter says to a contact or local-link trial; `want.tried` lists a:<i>, c:<i> and l:<i> in order, `dummy` the dummy trials that follow a miss so a silent close costs 106 trials (2 + 72 + 32) whatever the host holds (0 on a hit, on peer_busy and for a host with no contact or local-link secret, which the limiter does not cover), `hit` the key that decided, `slot` whether the connection holds a limiter slot until message 3 (a contact or local-link hit), `close` the silent end (peer_busy when the limiter refused before any secret was tried, handshake_failed otherwise). `window`: the pairing window's machine over events with a monotonic time t in seconds (open, c1 with `valid`, begin-guess, guess-opened, guess-failed, msg1 (begin-guess then its verdict, `opens`), abandon, rotated, session-end with `stored`, tick, close). A c1 that admits an attempt hands out its `id` (1, 2, ... across windows); an event that names an attempt carries its `id`, and without one it names the latest attempt handed out. A guess is counted when it is permitted (begin-guess, `permit`), before its tag is tried, and only the holder's own attempt is permitted, once; any other id, an expired or closed attempt, answers `denied` and its tag is never tried. A guess that opens is refunded (guess-opened); one that does not, and a connection that ends after its permit, is a failed guess (guess-failed, abandon), and the fifth closes the window. `want` has one entry per event: `result` (opened, already-open, closed, busy, limited, refused, attempt, permit, denied, transport, failed, too-many-tries), `id`, `open`, `holder` (attempt from a valid C1 until its guess or 30 s; session from a guess that opens until it ends; rotating, busy and uncounted, from a failed guess or a session that ends without a link until rotated, which the host sends once the new password, QR secret and both generators are ready), `failures` (guesses counted), `rotations`, `closed` (expired at 300 s, too-many-tries, stored, person) and `host`; a window admits at most 5 C1s in any 60 s, counted when it admits them. `joinBudget`: joins in time order; per nameplate at most 2 dials in any 300 s across joins (a join with no dial spends none, a refused join records none and answers pairing-code-failed without browsing), a QR is never limited; `want` has `allowed` and `used`, the dials of the nameplate in the last 300 s before the join. `join`: the joiner: `input` is what the reader said (a code's nameplate, a QR's instance or invalid), `adverts` the m=q adverts seen in first-seen order (`h` current, previous or other, `n` the nameplate), `dials` how each dial ends (transport, before-c2, after-c2); `want` has the instances kept (matching h and the nameplate or the instance, at most 8, once each), those dialled (at most 2, in order), whether anything was browsed, and the result: transport, pairing-code-failed (an invalid input, or no transport and an attempt failed after C2) or pairing-not-found. `gate`: the cached discovery answer (`start` on, off or none) over reads (ok with the discovery body, not-found, error) and calls; services.connect.localPairing is true only as the boolean true while services.connect.enabled is the boolean true; an ok read replaces the answer, a not-found clears it, an error changes nothing; a read that leaves a cached true behind has the effects close-windows, withdraw-adverts and end-sessions; a call that opens, joins, advertises, browses, dials or answers needs on and otherwise answers local-pairing-off, and list, rename, remove and set-reachable are never gated. `admission`: a listener that holds no account key (15.10, \"Admission\") over events in monotonic seconds, `{t, group, opens}` (a message 1 from a source group; `opens` whether a secret's tag verifies), `{t, group, opens, later: true}` (the same, but the trial's verdict comes later: the message is counted as it arrives and a step of `tried` has no `hit`), `{t, settle}` (the verdict of the `later` event at that index: step `settled` with `hit` = its `opens`; an opening trial refunds that group's count in the group's live list, at the time it settles, and takes a waiting slot; a failed one spends the shared budget) or `{t, release}` (the waiting slot of the event at that index is given back); a group gets `admissionGroupPerMinute` message 1s in any `admissionWindowSeconds`, counted as they arrive and not counted again once the trial opens or when refused; behind that the shared limiter, spent only by a failed trial (`admissionSharedPerMinute` in the window), also refuses while `admissionWaiting` opened trials wait for message 3; `want` has one step per event: `result` (tried, refused, released), `hit` (tried: the trial opened and holds a slot), `by` (refused: group, checked first, or shared), then the group's count, the failed trials counted and the connections waiting after the step. A refusal closes silently as peer_busy and no secret is tried. `xfer`: Direct Transfer rows of mode l, in the shape and run of the `xfer` section of 15.11 (a runner that has no mode l skips them): mode l is allowed and the category rule of mode c applies. `records`: the mode rules of 15.6 for q and l (and the new rows in the other modes): a known type in a mode that does not allow it closes peer_not_allowed, an unknown type with the critical bit closes peer_unknown_critical and any other is ignored; `needs` is the capability the session must hold. Append-only: a new row keeps peerMatrixVersion; a changed row or rule bumps it.",
    constants: {
      pairSeconds: REF_LOCAL_PAIR_SECONDS,
      codeDigits: REF_LOCAL_CODE_DIGITS,
      pairFailures: REF_LOCAL_PAIR_FAILURES,
      qrSecretBytes: REF_LOCAL_QR_SECRET_BYTES,
      joinCandidates: REF_LOCAL_JOIN_CANDIDATES,
      joinBrowseSeconds: REF_LOCAL_JOIN_BROWSE_SECONDS,
      maxLinks: REF_MAX_LOCAL_LINKS,
      maxLiveAdverts: REF_MAX_LIVE_LOCAL_ADVERTS,
      maxContactSecrets: REF_MAX_CONTACT_SECRETS,
      maxLinkSecrets: REF_MAX_LINK_SECRETS,
      bodyMax: REF_LOCAL_BODY_MAX,
      maxCats: REF_LOCAL_MAX_CATS,
      exchangeSeconds: 30,
      admissionGroupPerMinute: REF_ADMISSION_GROUP_PER_MINUTE,
      admissionSharedPerMinute: REF_ADMISSION_SHARED_PER_MINUTE,
      admissionWaiting: REF_ADMISSION_WAITING,
      admissionWindowSeconds: REF_ADMISSION_WINDOW_SECONDS,
    },
    codes: buildCodes(),
    qr: buildQr(),
    adverts: buildAdverts(),
    txt: buildTxt(),
    body: buildBody(),
    secrets: buildSecrets(),
    handshakePayloads: buildHandshakePayloads(),
    exchange: buildExchange(),
    pin: buildPin(),
    trialOrder: buildTrialOrder(),
    admission: buildAdmission(),
    xfer: buildLocalXfer(),
    window: buildWindow(),
    join: buildJoin(),
    joinBudget: buildJoinBudget(),
    gate: buildGate(),
    records: buildRecords(),
  };
}
