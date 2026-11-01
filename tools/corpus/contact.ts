// `peer-matrix.json` section `contact` (CC-19.1; WIRE-CONTRACT-V5 §15.10, §15.7 contact rooms,
// §15.4 the contact advert): the contact secret, the `CONTACT` body, the categories, the order of
// the pairing exchange, the contact advert (name, TXT, browse), the room id, the alias and the
// ticket body. Every row is recomputed through `reference/contact.ts` (`node:crypto` only; nothing
// from client-core), and the HKDF step is also checked against `crypto.hkdfSync`.

import { hkdfSync } from "node:crypto";
import {
  REF_CONTACT_BODY_MAX,
  REF_MAX_CONTACTS,
  REF_MAX_CONTACT_CATS,
  REF_MAX_PENDING,
  REF_MAX_SECRETS,
  REF_PENDING_SECONDS,
  REF_TICKET_BODY_MAX,
  type ExchangeEvent,
  type RefContact,
  refContactAlias,
  refContactBody,
  refContactBrowse,
  refContactCategories,
  refContactExchange,
  refContactInstance,
  refContactRid,
  refContactSecret,
  refContactStore,
  refListener,
  refPin,
  type StoreOp,
  type RefStore,
  type ListenerIn,
  refContactTicketBody,
  refContactTxt,
} from "./reference/contact.js";
import {
  REF_X25519_LOW_ORDER_HEX,
  refX25519LowOrder,
} from "./reference/peer.js";
import {
  bytesHex,
  hexBytes,
  refX25519Public,
  sha256,
} from "./reference/noise.js";
import { cat, refAdvertEpoch, utf8 } from "./reference/peerMatrix.js";
import { buildNoiseVectors } from "./noise.js";

const hex = bytesHex;
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from(s, "base64url"));
/** Fixed test material: SHA-256 of a label. Never used outside this file. */
const mat = (label: string): Uint8Array =>
  sha256(utf8(`pkey-peer/1 contact vector ${label}`));
/** A real X25519 public key from a label, as the 43-character wire spelling. */
const agree = (label: string): string => b64u(refX25519Public(mat(label)));
/** A 32-character device id from a label (24 bytes of material). */
const devId = (label: string): string => b64u(mat(label).slice(0, 24));

function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `contact ${label}: reference gives ${JSON.stringify(got)}, row says ${JSON.stringify(want)}`,
    );
}

/** A copy of `s` with its last character changed so the unused low bits are not zero. */
function dirtyLastChar(s: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return s.slice(0, -1) + A[A.indexOf(s.slice(-1)) ^ 1]!;
}

// ── secrets ──────────────────────────────────────────────────────────────────

function buildSecrets(): unknown[] {
  const h = mat("h");
  const nD = mat("nD");
  const nM = mat("nM");
  const kA = agree("device a");
  const kB = agree("device b");
  // Two keys whose base64url spellings sort the other way round from their bytes ('9' < 'a' as
  // text, but 0xf4.. > 0x68.. as bytes): the order is the bytes', not the text's.
  const kHigh = b64u(Uint8Array.of(0xf4, ...new Array<number>(31).fill(0x11)));
  const kLow = b64u(Uint8Array.of(0x68, ...new Array<number>(31).fill(0x22)));
  if (!(kHigh < kLow))
    throw new Error("contact: text order row is not inverted");
  const rows: {
    id: string;
    h: Uint8Array;
    nD: Uint8Array;
    nM: Uint8Array;
    a: string;
    b: string;
  }[] = [
    { id: "basic", h, nD, nM, a: kA, b: kB },
    { id: "keys-swapped", h, nD, nM, a: kB, b: kA },
    { id: "other-handshake-hash", h: mat("h2"), nD, nM, a: kA, b: kB },
    { id: "other-nD", h, nD: mat("nD2"), nM, a: kA, b: kB },
    { id: "other-nM", h, nD, nM: mat("nM2"), a: kA, b: kB },
    // ikm is nD then nM: swapping them is another secret.
    { id: "nonces-swapped", h, nD: nM, nM: nD, a: kA, b: kB },
    { id: "other-key", h, nD, nM, a: kA, b: agree("device c") },
    { id: "byte-order-not-text-order", h, nD, nM, a: kHigh, b: kLow },
    { id: "byte-order-not-text-order-swapped", h, nD, nM, a: kLow, b: kHigh },
  ];
  // The inputs a real pairing has (§15.10): h is the handshake hash of noise-vectors.json's mode-p
  // handshake and the nonces are peer-matrix.json `sas` row p-0's, so a port that wires the
  // session to the formula checks the whole chain, not the formula with free material.
  const nv = buildNoiseVectors() as {
    handshakes: { mode: string; handshakeHash: string }[];
  };
  rows.push({
    id: "real-pairing-inputs",
    h: hexBytes(nv.handshakes.find((x) => x.mode === "p")!.handshakeHash),
    nD: sha256(utf8("pkey-peer/1 matrix vector nD 0")),
    nM: sha256(utf8("pkey-peer/1 matrix vector nM 0")),
    a: kA,
    b: kB,
  });
  return rows.map((r) => {
    const secret = refContactSecret(r.h, r.nD, r.nM, unb64u(r.a), unb64u(r.b));
    const [lo, hi] =
      hex(unb64u(r.a)) <= hex(unb64u(r.b)) ? [r.a, r.b] : [r.b, r.a];
    // hkdfSync takes the salt, ikm and info in its own order; this is the cross-check.
    const cross = new Uint8Array(
      hkdfSync(
        "sha256",
        cat(r.nD, r.nM),
        r.h,
        cat(
          utf8("pkey-peer/1 contact"),
          Uint8Array.of(0),
          unb64u(lo),
          unb64u(hi),
        ),
        32,
      ),
    );
    check(`secret ${r.id}`, hex(secret), hex(cross));
    return {
      id: r.id,
      h: hex(r.h),
      nD: hex(r.nD),
      nM: hex(r.nM),
      agreeKeyA: r.a,
      agreeKeyB: r.b,
      secret: hex(secret),
    };
  });
}

// ── bodies ───────────────────────────────────────────────────────────────────

interface BodyIn {
  id: string;
  text?: string;
  hex?: string;
  pad?: { prefix: string; fill: string; count: number; suffix: string };
  own?: string;
}

function buildBodies(): unknown[] {
  const K = agree("peer");
  const OWN = agree("own");
  const body = (o: Record<string, unknown>): string => JSON.stringify(o);
  const ok = (extra: Record<string, unknown> = {}): string =>
    body({ v: 1, agreeKey: K, cats: [], ...extra });
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
  const lowOrder = (k: number, top = false): string => {
    const u = hexBytes(REF_X25519_LOW_ORDER_HEX[k]!);
    if (top) u[31] = u[31]! | 0x80;
    return b64u(u);
  };
  const rows: BodyIn[] = [
    { id: "minimal", text: ok() },
    { id: "label", text: ok({ label: "Anna" }) },
    { id: "cats", text: ok({ cats: ["photos", "docs"] }) },
    { id: "cats-8", text: ok({ cats: cats8 }) },
    { id: "cat-32-characters", text: ok({ cats: ["a".repeat(32)] }) },
    { id: "cat-1-character", text: ok({ cats: ["a"] }) },
    {
      id: "member-order-free",
      text: `{"cats":["docs"],"agreeKey":"${K}","v":1,"label":"Bo"}`,
    },
    { id: "unknown-member-ignored", text: ok({ x: { k: [1, null] } }) },
    { id: "cats-9", text: ok({ cats: [...cats8, "extra"] }) },
    { id: "cat-33-characters", text: ok({ cats: ["a".repeat(33)] }) },
    { id: "cat-empty", text: ok({ cats: [""] }) },
    { id: "cat-upper-case", text: ok({ cats: ["Photos"] }) },
    { id: "cat-underscore", text: ok({ cats: ["my_docs"] }) },
    { id: "cat-space", text: ok({ cats: ["my docs"] }) },
    { id: "cat-non-ascii", text: ok({ cats: ["café"] }) },
    { id: "cat-not-string", text: ok({ cats: [1] }) },
    { id: "cat-repeated", text: ok({ cats: ["docs", "docs"] }) },
    { id: "cats-missing", text: body({ v: 1, agreeKey: K }) },
    { id: "cats-not-array", text: ok({ cats: "docs" }) },
    { id: "cats-null", text: ok({ cats: null }) },
    { id: "v-missing", text: body({ agreeKey: K, cats: [] }) },
    { id: "v-2", text: ok({ v: 2 }) },
    { id: "v-string", text: ok({ v: "1" }) },
    { id: "agree-missing", text: body({ v: 1, cats: [] }) },
    { id: "agree-not-string", text: ok({ agreeKey: 7 }) },
    { id: "agree-42-characters", text: ok({ agreeKey: K.slice(0, 42) }) },
    { id: "agree-44-characters", text: ok({ agreeKey: `${K}A` }) },
    { id: "agree-padded", text: ok({ agreeKey: `${K}=` }) },
    { id: "agree-non-canonical", text: ok({ agreeKey: dirtyLastChar(K) }) },
    { id: "agree-standard-alphabet", text: ok({ agreeKey: `+${K.slice(1)}` }) },
    { id: "agree-low-order-zero", text: ok({ agreeKey: lowOrder(0) }) },
    { id: "agree-low-order-one", text: ok({ agreeKey: lowOrder(1) }) },
    {
      id: "agree-low-order-top-bit",
      text: ok({ agreeKey: lowOrder(5, true) }),
    },
    { id: "agree-is-own", text: ok({ agreeKey: OWN }), own: OWN },
    { id: "agree-is-not-own", text: ok(), own: OWN },
    { id: "label-number", text: ok({ label: 7 }) },
    { id: "label-null", text: ok({ label: null }) },
    {
      id: "duplicate-member",
      text: `{"v":1,"agreeKey":"${K}","cats":[],"v":1}`,
    },
    { id: "trailing-comma", text: `{"v":1,"agreeKey":"${K}","cats":[],}` },
    { id: "not-an-object", text: "[1]" },
    { id: "empty", text: "" },
    { id: "trailing-garbage", text: `${ok()} x` },
    { id: "bom", hex: "efbbbf" + hex(utf8(ok())) },
    {
      id: "invalid-utf8",
      hex:
        hex(utf8(`{"v":1,"agreeKey":"${K}","cats":[],"x":"`)) +
        "ff" +
        hex(utf8('"}')),
    },
  ];
  const overhead = ok({ x: "" }).length;
  const padRow = (id: string, count: number): BodyIn => ({
    id,
    pad: {
      prefix: ok({ x: "" }).slice(0, -2),
      fill: "a",
      count,
      suffix: '"}',
    },
  });
  rows.push(
    padRow("size-4096", REF_CONTACT_BODY_MAX - overhead),
    padRow("size-4097", REF_CONTACT_BODY_MAX - overhead + 1),
  );
  return rows.map((r) => {
    const bytes =
      r.hex !== undefined
        ? hexBytes(r.hex)
        : utf8(
            r.pad !== undefined
              ? r.pad.prefix + r.pad.fill.repeat(r.pad.count) + r.pad.suffix
              : r.text!,
          );
    const v = refContactBody(bytes, r.own);
    return {
      id: r.id,
      ...(r.hex !== undefined ? { bodyHex: r.hex } : {}),
      ...(r.text !== undefined ? { body: r.text } : {}),
      ...(r.pad !== undefined ? { bodyPad: r.pad } : {}),
      length: bytes.length,
      ...(r.own !== undefined ? { own: r.own } : {}),
      want: v.ok
        ? {
            ok: true,
            agreeKey: v.agreeKey,
            ...(v.label !== undefined ? { label: v.label } : {}),
            cats: v.cats,
          }
        : { ok: false },
    };
  });
}

function buildCategories(): unknown[] {
  const rows: [string, string[], string[]][] = [
    ["both", ["docs", "photos"], ["photos", "docs"]],
    ["partial", ["docs", "photos", "music"], ["music", "video"]],
    ["disjoint", ["docs"], ["photos"]],
    ["empty-local", [], ["docs"]],
    ["empty-remote", ["docs"], []],
    ["both-empty", [], []],
    ["byte-order", ["b", "a1", "a-", "a"], ["a", "a-", "a1", "b"]],
    ["digits-before-letters", ["b", "1"], ["1", "b"]],
  ];
  return rows.map(([id, local, remote]) => ({
    id,
    local,
    remote,
    want: refContactCategories(local!, remote!),
  }));
}

// ── exchange ─────────────────────────────────────────────────────────────────

type StepIn =
  | { event: "own-confirm" }
  | { event: "peer-confirm" }
  | { event: "peer-contact"; body: string }
  | { event: "timeout" };

function buildExchange(): unknown[] {
  const sixtyFour = Array.from({ length: REF_MAX_CONTACTS }, (_, i) =>
    agree(`held ${i}`),
  );
  const K = agree("peer");
  const OWN = agree("own");
  const good = JSON.stringify({
    v: 1,
    agreeKey: K,
    label: "Anna",
    cats: ["docs"],
  });
  const ownKey = JSON.stringify({ v: 1, agreeKey: OWN, cats: [] });
  const own = { event: "own-confirm" } as const;
  const peer = { event: "peer-confirm" } as const;
  const contact = (body: string): StepIn => ({ event: "peer-contact", body });
  const timeout = { event: "timeout" } as const;
  const heldRows: [string, StepIn[], string[]][] = [
    // The peer's key is one the host holds: stored pending, at any count.
    ["repair-held-peer-is-pending", [own, peer, contact(good)], [K]],
    ["new-peer-with-others-held", [own, peer, contact(good)], [agree("other")]],
    [
      "repair-at-64-is-pending",
      [own, peer, contact(good)],
      [...sixtyFour.slice(1), K],
    ],
    [
      "new-peer-at-63-is-stored",
      [own, peer, contact(good)],
      sixtyFour.slice(1),
    ],
    // At 64 a new peer is refused when its CONTACT is read; nothing is stored.
    ["new-peer-at-64-refused", [own, peer, contact(good)], sixtyFour],
    // A body that breaks the rules is still peer_bad_frame, at any count.
    ["invalid-body-at-64", [own, peer, contact("{}")], sixtyFour],
    [
      "after-full-refusal-nothing-happens",
      [own, peer, contact(good), peer],
      sixtyFour,
    ],
  ];
  const rows: [string, StepIn[]][] = [
    ["own-confirms-first", [own, peer, contact(good)]],
    ["peer-confirms-first", [peer, own, contact(good)]],
    ["contact-then-timeout-is-quiet", [own, peer, contact(good), timeout]],
    ["contact-before-any-confirm", [contact(good)]],
    ["contact-before-peer-confirm", [own, contact(good)]],
    ["contact-before-own-confirm", [peer, contact(good)]],
    ["peer-confirm-twice", [peer, peer]],
    ["peer-confirm-twice-after-own", [own, peer, peer]],
    ["contact-twice", [own, peer, contact(good), contact(good)]],
    ["body-invalid", [own, peer, contact("{}")]],
    [
      "body-with-bad-category",
      [own, peer, contact(good.replace("docs", "Docs"))],
    ],
    ["body-is-own-key", [own, peer, contact(ownKey)]],
    ["timeout-after-own-confirm", [own, timeout]],
    ["timeout-after-both-confirms", [own, peer, timeout]],
    ["timeout-before-own-confirm-is-quiet", [peer, timeout]],
    ["timeout-before-any-confirm-is-quiet", [timeout]],
    ["after-close-nothing-happens", [peer, peer, own, contact(good)]],
  ];
  return [
    ...rows.map(([id, steps]): [string, StepIn[], string[]] => [id, steps, []]),
    ...heldRows,
  ].map(([id, steps, held]) => {
    const events: ExchangeEvent[] = steps.map((s) =>
      s.event === "peer-contact"
        ? { event: "peer-contact", body: utf8(s.body) }
        : s,
    );
    return {
      id,
      own: OWN,
      held,
      steps,
      // One entry per step: what this side sends then, and where it closes or stores. `sends`
      // are the records `CONFIRM` and `CONTACT`; `close` is the code this side closes with;
      // `stored.pending` is true when the peer's key is one the host holds (`held`).
      want: refContactExchange(events, OWN, held),
    };
  });
}

// ── the contact list, pending contacts ───────────────────────────────────────

/**
 * Keys and secrets here are small integers n: the 32 bytes all equal to n (the key's wire
 * spelling is base64url of them). `start` lists the held contacts as `[key, secret]`.
 */
function buildStore(): unknown[] {
  type Pair = [number, number];
  const full = Array.from(
    { length: REF_MAX_CONTACTS },
    (_, i): Pair => [i + 1, i + 1],
  );
  const pair = (
    key: number,
    secret: number,
    now: number,
    label?: string,
  ): StoreOp => ({
    op: "pair",
    agreeKey: b64u(new Uint8Array(32).fill(key)),
    secret: String(secret),
    ...(label !== undefined ? { label } : {}),
    now,
  });
  const promote = (key: number): StoreOp => ({
    op: "promote",
    agreeKey: b64u(new Uint8Array(32).fill(key)),
  });
  const drop = (now: number): StoreOp => ({ op: "drop", now });
  const rows: {
    id: string;
    start: Pair[];
    startPending?: [number, number, number][];
    ops: StoreOp[];
  }[] = [
    { id: "new-peer-is-active", start: [], ops: [pair(1, 101, 10)] },
    {
      id: "held-peer-is-pending",
      start: [
        [1, 1],
        [2, 2],
      ],
      ops: [pair(1, 101, 10)],
    },
    {
      id: "full-refuses-a-new-peer",
      start: full,
      ops: [pair(200, 200, 10)],
    },
    {
      id: "full-allows-a-re-pair",
      start: full,
      ops: [pair(5, 201, 10)],
    },
    {
      id: "newer-pending-replaces-older-of-the-same-key",
      start: [[1, 1]],
      ops: [pair(1, 101, 10), pair(1, 102, 20)],
    },
    {
      id: "promote-replaces-in-the-held-place",
      start: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      ops: [pair(2, 102, 10, "New"), promote(2)],
    },
    {
      id: "promote-without-pending-changes-nothing",
      start: [
        [1, 1],
        [2, 2],
      ],
      ops: [promote(2), promote(9)],
    },
    {
      id: "promote-takes-only-its-key",
      start: [
        [1, 1],
        [2, 2],
      ],
      ops: [pair(1, 101, 10), pair(2, 102, 11), promote(2)],
    },
    {
      id: "pending-drops-after-24h",
      start: [[1, 1]],
      ops: [
        pair(1, 101, 1000),
        drop(1000 + REF_PENDING_SECONDS - 1),
        drop(1000 + REF_PENDING_SECONDS),
      ],
    },
    {
      id: "ninth-pending-drops-the-oldest",
      start: Array.from({ length: 10 }, (_, i): Pair => [i + 1, i + 1]),
      ops: Array.from({ length: REF_MAX_PENDING + 1 }, (_, i) =>
        pair(i + 1, 101 + i, 1000 + i),
      ),
    },
    {
      id: "trial-order-is-held-then-pending-at-72",
      start: full,
      ops: Array.from({ length: REF_MAX_PENDING }, (_, i) =>
        pair(i + 1, 101 + i, 1000 + i),
      ),
    },
    {
      id: "a-pair-after-a-promote-starts-again",
      start: [[1, 1]],
      ops: [pair(1, 101, 10), promote(1), pair(1, 102, 20)],
    },
  ];
  return rows.map((r) => {
    const startState: RefStore = {
      active: r.start.map(([k, sec]) => ({
        agreeKey: b64u(new Uint8Array(32).fill(k)),
        secret: String(sec),
      })),
      pending: [],
    };
    return {
      id: r.id,
      start: r.start,
      ops: r.ops.map((o) =>
        o.op === "pair"
          ? {
              op: "pair",
              key: [...unb64u(o.agreeKey)][0],
              secret: Number(o.secret),
              ...(o.label !== undefined ? { label: o.label } : {}),
              now: o.now,
            }
          : o.op === "promote"
            ? { op: "promote", key: [...unb64u(o.agreeKey)][0] }
            : o,
      ),
      want: refContactStore(startState, r.ops).map((w) => ({
        ...(w.result !== undefined ? { result: w.result } : {}),
        active: w.active.map(Number),
        pending: w.pending.map(Number),
        order: w.order.map(Number),
      })),
    };
  });
}

// ── the shared listener ──────────────────────────────────────────────────────

function buildListener(): unknown[] {
  const rows: ({ id: string } & ListenerIn)[] = [
    {
      id: "current-account-key-first",
      account: ["k", "k"],
      contacts: ["c", "c", "c"],
      opens: { mode: "a", key: 0 },
      limiter: "admit",
    },
    {
      id: "previous-account-key",
      account: ["k", "k"],
      contacts: ["c"],
      opens: { mode: "a", key: 1 },
      limiter: "admit",
    },
    {
      id: "absent-key-is-skipped",
      account: [null, "k"],
      contacts: ["c"],
      opens: { mode: "a", key: 1 },
      limiter: "admit",
    },
    {
      id: "contact-after-both-account-keys",
      account: ["k", "k"],
      contacts: ["c", "c", "c"],
      opens: { mode: "c", contact: 2 },
      limiter: "admit",
    },
    {
      id: "contact-only-host",
      account: null,
      contacts: ["c", "c"],
      opens: { mode: "c", contact: 1 },
      limiter: "admit",
    },
    {
      id: "limiter-refuses-before-any-contact-secret",
      account: ["k", "k"],
      contacts: ["c", "c"],
      opens: { mode: "c", contact: 0 },
      limiter: "refuse",
    },
    {
      id: "limiter-does-not-touch-an-account-peer",
      account: ["k", "k"],
      contacts: ["c", "c"],
      opens: { mode: "a", key: 0 },
      limiter: "refuse",
    },
    {
      id: "nothing-opens-it",
      account: ["k", "k"],
      contacts: ["c", "c"],
      opens: null,
      limiter: "admit",
    },
    {
      id: "nothing-opens-it-no-contacts",
      account: ["k", "k"],
      contacts: [],
      opens: null,
      limiter: "admit",
    },
    {
      id: "last-of-72-is-tried",
      account: null,
      contacts: Array.from({ length: REF_MAX_SECRETS }, () => "c"),
      opens: { mode: "c", contact: REF_MAX_SECRETS - 1 },
      limiter: "admit",
    },
  ];
  return rows.map(({ id, ...i }) => ({ id, ...i, want: refListener(i) }));
}

// ── the pin ──────────────────────────────────────────────────────────────────

function buildPin(): unknown[] {
  const K1 = mat("pin peer 1");
  const K2 = mat("pin peer 2");
  const flip = (b: Uint8Array): Uint8Array => {
    const c = b.slice();
    c[31] = c[31]! ^ 1;
    return c;
  };
  const rows: [
    string,
    "initiator" | "responder",
    Uint8Array[],
    number,
    Uint8Array,
  ][] = [
    ["initiator-key-matches", "initiator", [K1], 0, K1],
    ["responder-key-matches", "responder", [K1, K2], 1, K2],
    ["initiator-key-differs", "initiator", [K1], 0, K2],
    ["responder-key-differs", "responder", [K1], 0, K2],
    ["one-bit-differs", "responder", [K1], 0, flip(K1)],
    // The pin is against the contact whose secret opened the session, not against any held key.
    ["another-held-contacts-key", "responder", [K1, K2], 0, K2],
  ];
  return rows.map(([id, role, held, matched, remote]) => {
    const ok = refPin(b64u(held[matched]!), remote);
    return {
      id,
      role,
      held: held.map(b64u),
      matched,
      remoteStatic: b64u(remote),
      // The initiator checks after message 2, the responder after message 3; before the transport
      // exists nothing is sent.
      checkedAfter: role === "initiator" ? 2 : 3,
      want: ok ? { ok: true } : { ok: false, close: "peer_revoked", sends: 0 },
    };
  });
}

// ── adverts ──────────────────────────────────────────────────────────────────

type Held = RefContact & { keyText: string };

function buildAdverts(): unknown {
  const NOW = 1761300450;
  const E = refAdvertEpoch(NOW);
  const contactOf = (label: string): Held => {
    const keyText = agree(`${label} key`);
    return {
      secret: mat(`${label} secret`),
      agreeKey: unb64u(keyText),
      keyText,
    };
  };
  const wire = (c: Held) => ({ secret: hex(c.secret), agreeKey: c.keyText });
  const a = contactOf("a");
  const b = contactOf("b");
  const c = contactOf("c");

  const nameRow = (
    id: string,
    secret: Uint8Array,
    keyText: string,
    epoch: number,
  ) => ({
    id,
    secret: hex(secret),
    agreeKey: keyText,
    epoch,
    instance: refContactInstance(secret, unb64u(keyText), epoch),
  });
  const names = [
    nameRow("a-epoch", a.secret, a.keyText, E),
    nameRow("a-epoch-minus-1", a.secret, a.keyText, E - 1),
    nameRow("a-epoch-zero", a.secret, a.keyText, 0),
    nameRow("b-epoch", b.secret, b.keyText, E),
    nameRow("c-epoch-large", c.secret, c.keyText, 1956999),
    // The two devices of a link publish different names: the advertiser's own key is in the HMAC.
    nameRow("same-secret-other-device", a.secret, b.keyText, E),
  ];
  if (names[5]!.instance === names[0]!.instance)
    throw new Error("contact: advertiser key does not change the name");
  const txt: [string, string[]][] = [
    ["contact", ["v=1", "m=c"]],
    ["contact-reordered", ["m=c", "v=1"]],
    ["contact-tag-ignored", ["v=1", "m=c", "h=0123456789abcdef"]],
    ["contact-unknown-key-ignored", ["v=1", "m=c", "x=anything"]],
    ["entry-without-equals-ignored", ["v=1", "m=c", "flag"]],
    ["empty-key-ignored", ["=x", "v=1", "m=c"]],
    ["value-with-equals", ["v=1", "m=c", "note=a=b"]],
    ["version-2", ["v=2", "m=c"]],
    ["version-missing", ["m=c"]],
    ["version-padded", ["v=01", "m=c"]],
    ["mode-missing", ["v=1"]],
    ["mode-account", ["v=1", "m=a"]],
    ["mode-pair", ["v=1", "m=p", "h=0123456789abcdef"]],
    ["mode-upper", ["v=1", "m=C"]],
    ["key-case-sensitive", ["V=1", "M=c"]],
    ["duplicate-version", ["v=1", "v=1", "m=c"]],
    ["duplicate-mode", ["v=1", "m=c", "m=c"]],
    ["empty", []],
  ];

  const held = [a, b, c];
  const browse: unknown[] = [];
  const brow = (
    id: string,
    contacts: Held[],
    now: number,
    instance: string,
  ): void => {
    const want = refContactBrowse(instance, contacts, now);
    browse.push({
      id,
      contacts: contacts.map(wire),
      now,
      instance,
      want,
    });
  };
  const inst = (ct: RefContact, epochBack: number, now = NOW): string =>
    refContactInstance(ct.secret, ct.agreeKey, refAdvertEpoch(now) - epochBack);
  brow("current-epoch", held, NOW, inst(b, 0));
  brow("previous-epoch", held, NOW, inst(c, 1));
  brow("two-epochs-back", held, NOW, inst(a, 2));
  brow("next-epoch", held, NOW, inst(a, -1));
  brow("first-contact", held, NOW, inst(a, 0));
  brow("not-a-contact", held, NOW, "p1-aaaaaaaaaaaaaaaa");
  brow("wrong-shape", held, NOW, "p1-AAAAAAAAAAAAAAAA");
  brow("no-contacts", [], NOW, inst(a, 0));
  // The advertiser's key is the contact's: a name made with another key does not match.
  brow(
    "same-secret-other-key",
    [a],
    NOW,
    refContactInstance(a.secret, b.agreeKey, E),
  );
  // Two contacts with the same secret: the first in held order wins.
  const twin = { ...a, keyText: a.keyText };
  brow("held-order-first-wins", [a, twin], NOW, inst(a, 0));
  // The 73rd secret (64 held and 8 pending make 72) is never tried.
  const many = Array.from({ length: REF_MAX_SECRETS + 1 }, (_, i) =>
    contactOf(`many ${i}`),
  );
  brow(
    "secret-72-is-tried",
    many.slice(0, REF_MAX_SECRETS),
    NOW,
    inst(many[REF_MAX_SECRETS - 1]!, 0),
  );
  brow("secret-73-is-not-tried", many, NOW, inst(many[REF_MAX_SECRETS]!, 0));
  brow(
    "secret-72-previous-epoch",
    many.slice(0, REF_MAX_SECRETS),
    NOW,
    inst(many[REF_MAX_SECRETS - 1]!, 1),
  );
  return {
    epochSeconds: 900,
    maxSecrets: REF_MAX_SECRETS,
    maxLive: 8,
    names,
    txt: txt.map(([id, entries]) => ({
      id,
      entries,
      want: refContactTxt(entries),
    })),
    browse,
  };
}

// ── rooms ────────────────────────────────────────────────────────────────────

function buildRooms(): unknown {
  const rid = ["room a", "room b", "room c"].map((l) => {
    const secret = mat(l);
    const r = refContactRid(secret);
    const cross = b64u(
      new Uint8Array(
        hkdfSync(
          "sha256",
          secret,
          new Uint8Array(0),
          utf8("pkey-peer/1 room"),
          32,
        ),
      ).slice(0, 16),
    );
    check(`rid ${l}`, r, cross);
    if (r.length !== 22) throw new Error("contact: rid is not 22 characters");
    return { id: l.replace(" ", "-"), secret: hex(secret), rid: r };
  });
  const dev = ["device 1", "device 2"].map(devId);
  const alias = rid.flatMap((r) =>
    dev.map((d, k) => ({
      id: `${r.id}-device-${k + 1}`,
      rid: r.rid,
      deviceId: d,
      alias: refContactAlias(r.rid, d),
    })),
  );
  // An alias differs per room and per device, and is not the device id.
  const seen = new Set(alias.map((r) => r.alias));
  if (seen.size !== alias.length) throw new Error("contact: alias collision");
  for (const r of alias) {
    if (r.alias.length !== 48) throw new Error("contact: alias is 24 bytes");
    check(
      `alias ${r.id}`,
      r.alias,
      hex(sha256(unb64u(r.rid), unb64u(r.deviceId)).slice(0, 24)),
    );
  }
  return { rid, alias };
}

interface TicketIn {
  id: string;
  text?: string;
  hex?: string;
}

function buildTickets(): unknown[] {
  const RID = refContactRid(mat("room a"));
  const rows: TicketIn[] = [
    { id: "valid", text: JSON.stringify({ room: "c", rid: RID }) },
    { id: "member-order-free", text: `{"rid":"${RID}","room":"c"}` },
    { id: "with-whitespace", text: ` { "room" : "c" , "rid" : "${RID}" } ` },
    { id: "room-account", text: JSON.stringify({ room: "a", rid: RID }) },
    { id: "room-upper-case", text: JSON.stringify({ room: "C", rid: RID }) },
    { id: "room-missing", text: JSON.stringify({ rid: RID }) },
    { id: "rid-missing", text: JSON.stringify({ room: "c" }) },
    {
      id: "rid-21-characters",
      text: JSON.stringify({ room: "c", rid: RID.slice(0, 21) }),
    },
    {
      id: "rid-23-characters",
      text: JSON.stringify({ room: "c", rid: `${RID}A` }),
    },
    {
      id: "rid-non-canonical",
      text: JSON.stringify({ room: "c", rid: dirtyLastChar(RID) }),
    },
    { id: "rid-padded", text: JSON.stringify({ room: "c", rid: `${RID}==` }) },
    { id: "rid-not-string", text: JSON.stringify({ room: "c", rid: 7 }) },
    {
      id: "unknown-member",
      text: JSON.stringify({ room: "c", rid: RID, x: 1 }),
    },
    { id: "duplicate-member", text: `{"room":"c","rid":"${RID}","room":"c"}` },
    { id: "empty-object", text: "{}" },
    { id: "not-an-object", text: `"${RID}"` },
    { id: "empty", text: "" },
    { id: "trailing-comma", text: `{"room":"c","rid":"${RID}",}` },
    {
      id: "bom",
      hex: "efbbbf" + hex(utf8(JSON.stringify({ room: "c", rid: RID }))),
    },
    {
      id: "size-256",
      text: JSON.stringify({ room: "c", rid: RID }).padEnd(
        REF_TICKET_BODY_MAX,
        " ",
      ),
    },
    {
      id: "size-257",
      text: JSON.stringify({ room: "c", rid: RID }).padEnd(
        REF_TICKET_BODY_MAX + 1,
        " ",
      ),
    },
  ];
  return rows.map((r) => {
    const bytes = r.hex !== undefined ? hexBytes(r.hex) : utf8(r.text!);
    const v = refContactTicketBody(bytes);
    return {
      id: r.id,
      ...(r.hex !== undefined ? { bodyHex: r.hex } : {}),
      ...(r.text !== undefined ? { body: r.text } : {}),
      length: bytes.length,
      want: v.ok ? { ok: true, rid: v.rid } : { ok: false },
    };
  });
}

export function buildContact(): unknown {
  // The low-order list is the reference's; a key that is one of its points must be refused.
  for (let k = 0; k < REF_X25519_LOW_ORDER_HEX.length; k++)
    if (!refX25519LowOrder(hexBytes(REF_X25519_LOW_ORDER_HEX[k]!)))
      throw new Error("contact: low-order reference");
  return {
    note: "Inter-account links (15.10, 15.7 contact rooms, 15.4 the contact advert). `secrets` (the row real-pairing-inputs uses the handshake hash of noise-vectors.json mode-p and the nonces of the sas row p-0): the contact secret, HKDF-SHA256(salt = h, ikm = nD || nM, info = 'pkey-peer/1 contact' || 0x00 || lo || hi), 32 bytes, with h, nD, nM in lower-case hex and the two agreeKeys in the 43-character wire spelling; lo and hi are the 32 raw key bytes by unsigned byte order, so swapping the keys changes nothing and the order is not that of the text. `bodies`: a CONTACT body, `{id, body | bodyHex | bodyPad, length, own?, want}`; `want` is `{ok:false}` or `{ok, agreeKey, label?, cats}`; `own` is the reader's own agreeKey (an equal one refuses). `categories`: a link's categories, the entries both lists hold, once each, in byte order. `exchange`: one side's pairing events in order, `{id, own, steps, want}`; a step is own-confirm, peer-confirm, peer-contact (with its `body` text) or timeout (30 s after this side's CONFIRM, with no CONTACT read yet); `want` has one entry per step with what that step makes this side send (`CONFIRM`, `CONTACT`), the code it closes with, and the contact it stores; after a close nothing more happens. `held` lists the agreeKey of every active contact the host holds: a peer in it is a re-pair and `stored.pending` is true, at any count; a peer not in it is stored (`pending` false) unless 64 are held, when the side closes `peer_not_allowed` at the CONTACT and stores nothing; a body that breaks the rules is `peer_bad_frame` first. `adverts`: `names` (the instance p1- and the first 16 characters of the lower-case base32 of HMAC-SHA256(secret, 'pkey-peer/1 cdisc' || 0x00 || u64be(epoch) || the advertiser's 32 agreeKey bytes)), `txt` (parseContactTxt: v=1 and m=c, no h) and `browse` (which held contact an instance belongs to, in the current or previous epoch, among the first 72 secrets: the held contacts in held order, then the pending ones). `store`: the contact list with pending contacts (15.10): keys and secrets are small integers n, the 32 bytes all equal to n; `start` is the held contacts as [key, secret]; `ops` are pair (a pairing result: a new peer is active, or refused when 64 are held; a held peer is stored pending, one pending per key, at most 8, the oldest goes), promote (a handshake under a pending secret passed the pin: it replaces the held contact of its key in place) and drop (pending contacts stored 86400 s ago or earlier go); `want` is, per op, the result of a pair, the secrets held in order, the pending secrets in the order stored, and `order`, the held then the pending, at most 72, which is the order a responder tries secrets and a browser tests names. `listener`: the shared listener's trial of message 1 (15.5, 15.10): `account` lists the discKeys (null = none; only the first two are tried) or is null for a host without an account; `contacts` lists the secrets in `order`; `opens` names the one key whose tag verifies; `limiter` is what the contact-trial limiter says; `want.tried` is every key a tag was tried under in order (`a:<i>` account key, `c:<i>` contact), `hit` the key that decided, `slot` whether the connection still holds a limiter slot after message 1 (a contact hit holds it until message 3; a refused or failed trial holds none) and `close` the silent end (`peer_busy` when the limiter refused before any contact secret was tried, `handshake_failed` when no tag verified). `pin`: the remote static key against the agreeKey of the contact whose secret opened the session: a mismatch is `peer_revoked` and nothing is sent; the initiator checks after message 2, the responder after message 3. `rooms`: `rid` (base64url of the first 16 bytes of HKDF-SHA256(salt empty, ikm secret, info 'pkey-peer/1 room')) and `alias` (the first 24 bytes of SHA-256(rid bytes || deviceId bytes) as 48 hex characters; rid is its 16 decoded bytes and deviceId its 24). `tickets`: the contact ticket-request body, strict JSON of at most 256 bytes with exactly `room` = 'c' and a canonical 22-character `rid`. Append-only: a new row keeps peerMatrixVersion; a changed row or rule bumps it.",
    constants: {
      maxContacts: REF_MAX_CONTACTS,
      maxCats: REF_MAX_CONTACT_CATS,
      maxPending: REF_MAX_PENDING,
      maxSecrets: REF_MAX_SECRETS,
      pendingSeconds: REF_PENDING_SECONDS,
      bodyMax: REF_CONTACT_BODY_MAX,
      ticketBodyMax: REF_TICKET_BODY_MAX,
      maxLiveAdverts: 8,
      leaseBytes: 1_048_576,
      roomIdleSeconds: 2_592_000,
      exchangeSeconds: 30,
    },
    secrets: buildSecrets(),
    bodies: buildBodies(),
    categories: buildCategories(),
    exchange: buildExchange(),
    store: buildStore(),
    listener: buildListener(),
    pin: buildPin(),
    adverts: buildAdverts(),
    rooms: buildRooms(),
    tickets: buildTickets(),
  };
}
