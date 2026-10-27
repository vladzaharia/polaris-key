// Two PeerSessions wired in memory: the three modes end to end, plus the refusals the matrix
// cannot show (silent bad PSK, first record not HELLO, the SAS commit-reveal, rekey).
import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import {
  HandshakeLimiter,
  NoiseHandshake,
  peerNoiseProtocol,
  peerPrologue,
  PeerChannel,
  RECORD,
  encodeRecord,
  webCryptoNoisePorts,
  webCryptoX25519,
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
      expect(est.caps).toEqual(["app/1", "ring/1"]);
      const type = mode === "v" ? RECORD.VOUCH_RESULT : RECORD.CONFIRM;
      await d.s.sendRecord(type, utf8("{}"));
      await pump(d, m);
      expect(of(m, "record")).toHaveLength(1);
    });
  }

  it("refuses a host record before the code is settled", async () => {
    const d = side("v", "initiator", rnd());
    const m = side("v", "responder", rnd());
    await d.s.start();
    // Stop the exchange after both HELLOs: the initiator's commit is in flight.
    await m.s.receive(d.out.splice(0)[0]!);
    await d.s.receive(m.out.splice(0)[0]!);
    await m.s.receive(d.out.splice(0)[0]!);
    await d.s.receive(m.out.splice(0)[0]!);
    // d now holds its HELLO and commit; m gets VOUCH_REQ-like data before the SAS: refuse.
    await expect(m.s.sendRecord(RECORD.VOUCH_RESULT, NONE)).rejects.toThrow();
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

  it("limits an approver to five handshakes a minute", () => {
    let t = 0;
    const l = new HandshakeLimiter(5, () => t);
    expect([1, 2, 3, 4, 5, 6].map(() => l.allow())).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    t = 61;
    expect(l.allow()).toBe(true);
  });
});
