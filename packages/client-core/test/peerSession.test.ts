// Two PeerSessions wired in memory: the three modes end to end, plus the refusals the matrix
// cannot show (silent bad PSK, first record not HELLO, the SAS commit-reveal, rekey).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import {
  HandshakeLimiter,
  NoiseHandshake,
  peerNoiseProtocol,
  peerPrologue,
  PEER_CLOSE_CODES,
  PeerChannel,
  RECORD,
  encodeRecord,
  webCryptoNoisePorts,
  webCryptoX25519,
  type PeerHello,
  type PeerMode,
  type SessionEvent,
} from "../src/peer/index.js";

const KID = "peer-test-2026";
const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const NOW = 1_700_001_000;
const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const NONE = new Uint8Array(0);

let PEM = "";
let trust: TrustSet = {};
let signKey = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----`;
  signKey = base64UrlEncodeBytes(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  trust = { [KID]: signKey };
});

interface Side {
  s: PeerChannel;
  events: SessionEvent[];
  out: Uint8Array[];
}

async function device(id: string) {
  const priv = rnd();
  const pub = await webCryptoX25519.publicKey(priv);
  const certJws = await signJws(
    {
      iss: "key.plrs.im",
      aud: "djdl",
      sub: SUB,
      deviceId: id,
      signKey,
      agreeKey: base64UrlEncodeBytes(pub),
      ringEpoch: 1,
      issuedAt: NOW - 10,
      expiresAt: NOW + 1000,
    },
    PEM,
    KID,
    "pkey-peer+jws",
  );
  return { priv, certJws, id };
}

function side(
  mode: PeerMode,
  role: "initiator" | "responder",
  priv: Uint8Array,
  extra: Partial<ConstructorParameters<typeof PeerChannel>[0]> = {},
): Side {
  const events: SessionEvent[] = [];
  const out: Uint8Array[] = [];
  const s = new PeerChannel({
    mode,
    role,
    slug: "djdl",
    staticKey: priv,
    caps: ["app/1", "ring/1"],
    hello: { platform: "test", app: "demo" },
    send: (n) => out.push(n),
    onEvent: (e) => events.push(e),
    now: () => NOW,
    ...(mode !== "a" && role === "responder"
      ? { admission: new HandshakeLimiter() }
      : {}),
    ...extra,
  });
  return { s, events, out };
}

/** Deliver until both outboxes are empty. */
async function pump(a: Side, b: Side): Promise<void> {
  for (let i = 0; i < 200 && (a.out.length > 0 || b.out.length > 0); i++) {
    for (const m of a.out.splice(0)) await b.s.receive(m);
    for (const m of b.out.splice(0)) await a.s.receive(m);
  }
}
const of = (x: Side, type: SessionEvent["type"]) =>
  x.events.filter((e) => e.type === type);

describe("PeerSession modes v and p", () => {
  for (const mode of ["v", "p"] as const) {
    it(`mode ${mode}: both sides show the same code, then records flow`, async () => {
      const d = side(mode, "initiator", rnd());
      const m = side(mode, "responder", rnd());
      await d.s.start();
      await pump(d, m);
      const sd = of(d, "sas")[0] as Extract<SessionEvent, { type: "sas" }>;
      const sm = of(m, "sas")[0] as Extract<SessionEvent, { type: "sas" }>;
      expect(sd.display).toMatch(/^\d{3} \d{3}$/);
      expect(sd.code).toBe(sm.code);
      const est = of(d, "established")[0] as Extract<
        SessionEvent,
        { type: "established" }
      >;
      // Mode v adds `vouch/1` itself (rule 1).
      expect(est.caps).toEqual(
        mode === "v" ? ["app/1", "ring/1", "vouch/1"] : ["app/1", "ring/1"],
      );
      // Nothing flows until the person confirms; an inbound record is held, not refused.
      await expect(d.s.sendRecord(RECORD.VOUCH_RESULT, NONE)).rejects.toThrow();
      await d.s.confirmSas();
      await pump(d, m);
      expect(of(m, "record")).toHaveLength(0);
      await m.s.confirmSas();
      await pump(d, m);
      // mode p: the confirmation itself sent CONFIRM, held at m until m confirmed.
      expect(of(m, "record").map((e) => (e as any).recordType)).toEqual(
        mode === "p" ? [RECORD.CONFIRM] : [],
      );
      expect(of(d, "record").map((e) => (e as any).recordType)).toEqual(
        mode === "p" ? [RECORD.CONFIRM] : [],
      );
    });
  }

  it("holds an inbound host record until this side confirms, then delivers it", async () => {
    const d = side("v", "initiator", rnd());
    const m = side("v", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    await d.s.confirmSas();
    await d.s.sendRecord(RECORD.VOUCH_REQ, utf8("{}"));
    await pump(d, m);
    expect(of(m, "record")).toHaveLength(0);
    expect(m.s.closed).toBe(false);
    await m.s.confirmSas();
    expect(of(m, "record")).toHaveLength(1);
  });

  it("marks HELLO display data unauthenticated and cleans the label", async () => {
    const d = side("v", "initiator", rnd(), {
      hello: {
        platform: "t",
        app: "a",
        label: "  Cafe\u0301 \u202eTV\u0000  ",
      },
    });
    const m = side("v", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    const est = of(m, "established")[0] as any;
    expect(est.helloAuthenticated).toBe(false);
    expect(est.hello.label).toBe("Caf\u00e9 TV");
  });

  /** A mode-v pair after the HELLO exchange, `hello` being the requester's. */
  async function helloPair(hello?: Partial<PeerHello>) {
    const d = side("v", "initiator", rnd(), {
      hello: { platform: "t", app: "a", ...hello },
    });
    const m = side("v", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    return { d, m, est: of(m, "established")[0] as any };
  }

  it("holds at most 16 KiB before the confirmation, then closes peer_busy", async () => {
    const { d, m } = await helloPair();
    await d.s.confirmSas();
    await d.s.sendRecord(RECORD.VOUCH_REQ, new Uint8Array(8 * 1024));
    await pump(d, m);
    expect(m.s.closed).toBe(false);
    await d.s.sendRecord(RECORD.VOUCH_REQ, new Uint8Array(8 * 1024 + 1));
    await pump(d, m);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_busy", byPeer: false },
    ]);
  });

  it("shows only a known-shaped platform and a cleaned app in modes v and p", async () => {
    for (const [platform, app, wantPlatform, wantApp] of [
      ["macos", "Demo", "macos", "Demo"],
      ["Android 14.1_x+y-z", "a", "Android 14.1_x+y-z", "a"],
      ["x".repeat(33), "a", "Unknown", "a"],
      ["<b>ok</b>", "a", "Unknown", "a"],
      ["mac\u202eos", "a", "Unknown", "a"],
      ["", "a", "Unknown", "a"],
      ["linux", "  Pay\u202e\u0000ment  ", "linux", "Payment"],
      ["linux", "\u202e\u0000", "linux", "Unknown"],
      ["linux", "a".repeat(100), "linux", "a".repeat(64)],
    ] as const) {
      const { est } = await helloPair({ platform, app });
      expect([est.hello.platform, est.hello.app]).toEqual([
        wantPlatform,
        wantApp,
      ]);
    }
  });

  it("refuses a HELLO over 4 KiB in modes v and p, not in mode a", async () => {
    for (const mode of ["v", "p"] as const) {
      const d = side(mode, "initiator", rnd(), {
        hello: { platform: "t", app: "a", label: "x".repeat(4100) },
      });
      const m = side(mode, "responder", rnd());
      await d.s.start();
      await pump(d, m);
      expect(of(m, "established")).toHaveLength(0);
      expect(of(m, "closed")).toEqual([
        { type: "closed", code: "peer_bad_frame", byPeer: false },
      ]);
    }
    expect((await helloPair({ label: "x".repeat(4000) })).est).toBeDefined();
  });

  it("an approver needs an admission limiter", () => {
    expect(() =>
      side("v", "responder", rnd(), { admission: undefined }),
    ).toThrow();
  });

  it("refuses over the limit and past the pending cap, and releases on confirm", async () => {
    let t = 0;
    const lim = new HandshakeLimiter(5, 2, () => t);
    const mk = () => side("v", "responder", rnd(), { admission: lim });
    const hello = async () => {
      const m = mk();
      const d = side("v", "initiator", rnd());
      await d.s.start();
      await pump(d, m);
      return { d, m };
    };
    const one = await hello();
    await hello();
    const third = mk();
    const d3 = side("v", "initiator", rnd());
    await d3.s.start();
    await pump(d3, third);
    expect(third.out).toEqual([]);
    expect(of(third, "closed")).toEqual([
      { type: "closed", code: "peer_busy", byPeer: false },
    ]);
    await one.m.s.confirmSas();
    expect(lim.begin()).not.toBeNull();
    t = 61;
  });

  it("closes with peer_timeout when the transport or the code takes too long", async () => {
    const fns: (() => void)[] = [];
    const timer = (fn: () => void) => {
      fns.push(fn);
      return () => undefined;
    };
    const m = side("v", "responder", rnd(), { timer });
    const d = side("v", "initiator", rnd());
    await d.s.start();
    await m.s.receive(d.out.splice(0)[0]!);
    fns[0]!();
    await m.s.close();
    expect(of(m, "closed")[0]).toEqual({
      type: "closed",
      code: "peer_timeout",
      byPeer: false,
    });
  });
});

describe("PeerSession mode a", () => {
  it("admits both certificates, answers PING, rekeys and closes", async () => {
    const A = await device("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await device("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const k = rnd();
    const acct = (me: typeof A) => ({
      trust,
      expectedAud: "djdl",
      certJws: me.certJws,
      ownSub: SUB,
      ownDeviceId: me.id,
      heldRing: () => null,
      discKeys: [k],
    });
    const a = side("a", "initiator", A.priv, {
      account: acct(A),
      rekeyMessages: 2,
    });
    const b = side("a", "responder", B.priv, { account: acct(B) });
    await a.s.start();
    await pump(a, b);
    const est = of(a, "established")[0] as Extract<
      SessionEvent,
      { type: "established" }
    >;
    expect(est.peerDeviceId).toBe(B.id);
    await a.s.sendRecord(0x0100, utf8("one"));
    await a.s.sendRecord(0x0100, utf8("two"));
    await a.s.sendRecord(0x0100, utf8("three"));
    await pump(a, b);
    expect(of(b, "record").map((e) => (e as any).body.length)).toEqual([
      3, 3, 5,
    ]);
    await b.s.sendRecord(RECORD.PING, new Uint8Array(8));
    await pump(a, b);
    await a.s.close();
    await pump(a, b);
    expect(of(b, "closed")).toEqual([
      { type: "closed", code: "peer_bye", byPeer: true },
    ]);
  });

  it("a wrong discovery key ends the responder silently", async () => {
    const A = await device("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await device("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const acct = (me: typeof A, k: Uint8Array) => ({
      trust,
      expectedAud: "djdl",
      certJws: me.certJws,
      ownSub: SUB,
      ownDeviceId: me.id,
      heldRing: () => null,
      discKeys: [k],
    });
    const a = side("a", "initiator", A.priv, { account: acct(A, rnd()) });
    const b = side("a", "responder", B.priv, { account: acct(B, rnd()) });
    await a.s.start();
    await pump(a, b);
    expect(b.out).toEqual([]);
    expect(of(b, "closed")).toEqual([
      { type: "closed", code: "handshake_failed", byPeer: false },
    ]);
  });

  it("the responder also tries the previous discovery key", async () => {
    const A = await device("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await device("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const old = rnd();
    const acct = (me: typeof A, ks: Uint8Array[]) => ({
      trust,
      expectedAud: "djdl",
      certJws: me.certJws,
      ownSub: SUB,
      ownDeviceId: me.id,
      heldRing: () => null,
      discKeys: ks,
    });
    const a = side("a", "initiator", A.priv, { account: acct(A, [old]) });
    const b = side("a", "responder", B.priv, {
      account: acct(B, [rnd(), old]),
    });
    await a.s.start();
    await pump(a, b);
    expect(of(b, "established")).toHaveLength(1);
  });
});

describe("PeerSession mode a: keys", () => {
  it("skips an absent previous discovery key", async () => {
    const A = await device("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await device("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const k = rnd();
    const acct = (me: typeof A, ks: (Uint8Array | null)[]) => ({
      trust,
      expectedAud: "djdl",
      certJws: me.certJws,
      ownSub: SUB,
      ownDeviceId: me.id,
      heldRing: () => null,
      discKeys: ks,
    });
    const a = side("a", "initiator", A.priv, { account: acct(A, [k]) });
    const b = side("a", "responder", B.priv, { account: acct(B, [k, null]) });
    await a.s.start();
    await pump(a, b);
    expect(of(b, "established")).toHaveLength(1);
    // And a wrong current key with a null previous one fails cleanly.
    const c = side("a", "initiator", A.priv, { account: acct(A, [rnd()]) });
    const d = side("a", "responder", B.priv, { account: acct(B, [k, null]) });
    await c.s.start();
    await pump(c, d);
    expect(of(d, "closed")).toHaveLength(1);
  });
});

describe("PeerSession mode a: held roster", () => {
  it("refuses a peer when the held roster is unusable, and asks for a fresh one", async () => {
    const A = await device("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await device("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const k = rnd();
    const acct = (me: typeof A, held: boolean) => ({
      trust,
      expectedAud: "djdl",
      certJws: me.certJws,
      ownSub: SUB,
      ownDeviceId: me.id,
      heldRing: () => (held ? { jws: "not-a-roster", epoch: 1 } : null),
      discKeys: [k],
    });
    const a = side("a", "initiator", A.priv, { account: acct(A, false) });
    const b = side("a", "responder", B.priv, { account: acct(B, true) });
    await a.s.start();
    await pump(a, b);
    expect(of(b, "ring-wanted")).toHaveLength(1);
    expect(of(b, "established")).toHaveLength(0);
    expect(of(b, "closed")).toHaveLength(1);
    // With no roster at all (first run) the certificate alone admits, and a roster is wanted.
    const c = side("a", "initiator", A.priv, { account: acct(A, false) });
    const d = side("a", "responder", B.priv, { account: acct(B, false) });
    await c.s.start();
    await pump(c, d);
    expect(of(d, "established")).toHaveLength(1);
    expect(of(d, "ring-wanted")).toHaveLength(1);
  });
});

describe("PeerSession refusals", () => {
  it("closes when the first record is not HELLO, and says so", async () => {
    const m = side("p", "responder", rnd());
    const raw = new NoiseHandshake({
      role: "initiator",
      protocol: peerNoiseProtocol("p"),
      prologue: peerPrologue("djdl", "p"),
      staticKey: rnd(),
    });
    await m.s.receive(await raw.writeMessage(utf8('{"v":1}')));
    await raw.readMessage(m.out.splice(0)[0]!);
    const caps = utf8('{"v":1,"caps":[]}');
    await m.s.receive(await raw.writeMessage(caps));
    const tp = await raw.transport();
    // The responder's HELLO is out; answer with a PING instead of HELLO.
    await m.s.receive(
      await tp.send.encrypt(
        NONE,
        encodeRecord({ type: RECORD.PING, flags: 0, body: new Uint8Array(8) }),
      ),
    );
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_bad_frame", byPeer: false },
    ]);
    // HELLO, then CLOSE {"code":"peer_bad_frame"}.
    await tp.receive.decrypt(NONE, m.out[0]!);
    const close = await tp.receive.decrypt(NONE, m.out[1]!);
    expect(new TextDecoder().decode(close.slice(3))).toBe(
      '{"code":"peer_bad_frame"}',
    );
  });

  it("limits an approver to five handshakes a minute on a monotonic clock", () => {
    let t = 0;
    const l = new HandshakeLimiter(5, 99, () => t);
    expect([1, 2, 3, 4, 5, 6].map(() => l.begin() !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    t = 61;
    expect(l.begin()).not.toBeNull();
  });
});

describe("PeerSession vouch hooks (mode v)", () => {
  it("lists vouch/1 itself and exposes the order guard, mode v only", () => {
    const v = side("v", "initiator", rnd());
    const p = side("p", "initiator", rnd());
    expect(v.s.vouch?.role).toBe("requester");
    expect(side("v", "responder", rnd()).s.vouch?.role).toBe("approver");
    expect(p.s.vouch).toBeNull();
  });

  it("handshakeHash() is the same value on both ends once established, and a copy", async () => {
    const d = side("v", "initiator", rnd());
    const m = side("v", "responder", rnd());
    expect(() => d.s.handshakeHash()).toThrow();
    await d.s.start();
    await pump(d, m);
    const h = d.s.handshakeHash();
    expect(h).toHaveLength(32);
    expect(h).toEqual(m.s.handshakeHash());
    h.fill(0);
    expect(d.s.handshakeHash()).toEqual(m.s.handshakeHash());
  });

  it("holdSas stops after HELLO; startSas() sends the commit and the code follows", async () => {
    const d = side("v", "initiator", rnd(), { holdSas: true });
    const m = side("v", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    expect(of(d, "established")).toHaveLength(1);
    expect(of(m, "established")).toHaveLength(1);
    expect(of(d, "sas")).toHaveLength(0);
    expect(of(m, "sas")).toHaveLength(0);
    expect(d.s.closed || m.s.closed).toBe(false);
    await d.s.startSas();
    await pump(d, m);
    const sd = of(d, "sas")[0] as Extract<SessionEvent, { type: "sas" }>;
    const sm = of(m, "sas")[0] as Extract<SessionEvent, { type: "sas" }>;
    expect(sd.code).toBe(sm.code);
    // A second start is refused and closes the session.
    await d.s.startSas();
    expect(of(d, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
  });

  it("choosing one of two held approvers starts the SAS on that session only", async () => {
    const d1 = side("v", "initiator", rnd(), { holdSas: true });
    const m1 = side("v", "responder", rnd());
    const d2 = side("v", "initiator", rnd(), { holdSas: true });
    const m2 = side("v", "responder", rnd());
    await d1.s.start();
    await d2.s.start();
    await pump(d1, m1);
    await pump(d2, m2);
    await d1.s.startSas();
    await pump(d1, m1);
    await d2.s.close("peer_bye");
    await pump(d2, m2);
    expect(of(m1, "sas")).toHaveLength(1);
    expect(of(m2, "sas")).toHaveLength(0);
    expect(of(m2, "closed")).toEqual([
      { type: "closed", code: "peer_bye", byPeer: true },
    ]);
  });

  it("refuses startSas() before established, without holdSas, and holdSas outside mode v", async () => {
    const early = side("v", "initiator", rnd(), { holdSas: true });
    await early.s.start();
    await early.s.startSas();
    expect(of(early, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
    const plain = side("v", "initiator", rnd());
    const m = side("v", "responder", rnd());
    await plain.s.start();
    await pump(plain, m);
    await plain.s.startSas();
    expect(of(plain, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
    expect(() => side("p", "initiator", rnd(), { holdSas: true })).toThrow(
      RangeError,
    );
    expect(() => side("v", "responder", rnd(), { holdSas: true })).toThrow(
      RangeError,
    );
  });

  it("closes peer_not_allowed after HELLO and before any SAS record when the peer lacks vouch/1", async () => {
    const m = side("v", "responder", rnd());
    const raw = new NoiseHandshake({
      role: "initiator",
      protocol: peerNoiseProtocol("v"),
      prologue: peerPrologue("djdl", "v"),
      staticKey: rnd(),
    });
    await m.s.receive(await raw.writeMessage(utf8('{"v":1}')));
    await raw.readMessage(m.out.splice(0)[0]!);
    await m.s.receive(await raw.writeMessage(utf8('{"v":1,"caps":["app/1"]}')));
    const tp = await raw.transport();
    const hello = utf8('{"platform":"t","app":"a","maxMessage":1048576}');
    await m.s.receive(
      await tp.send.encrypt(
        NONE,
        encodeRecord({ type: RECORD.HELLO, flags: 0, body: hello }),
      ),
    );
    expect(of(m, "established")).toHaveLength(0);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
    // Its own HELLO, then CLOSE: no SAS record.
    const types: number[] = [];
    for (const out of m.out) {
      const rec = await tp.receive.decrypt(NONE, out);
      types.push((rec[0]! << 8) | rec[1]!);
    }
    expect(types).toEqual([RECORD.HELLO, RECORD.CLOSE]);
  });

  it("keeps PEER_CLOSE_CODES equal to the registry's peer kind", () => {
    const reg = JSON.parse(
      readFileSync(
        new URL("../../../conformance/parity/errors.json", import.meta.url),
        "utf8",
      ),
    ) as { codes: { code: string; kind: string }[] };
    const peer = reg.codes
      .filter((e) => e.kind === "peer")
      .map((e) => e.code)
      .sort();
    expect([...PEER_CLOSE_CODES].sort()).toEqual(peer);
  });
});
