// The shared listener of WIRE-CONTRACT-V5 §15.10: one responder serves the account's mode a and
// the device's contacts (mode c). The mode is only in the prologue, so the responder decides by
// trying: the account's keys first, then the contact secrets in the order given. A contact trial
// is admitted by the limiter before any secret is tried. Also what mode c refuses (RING, TRUST).
import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import {
  HandshakeLimiter,
  NoiseHandshake,
  PeerChannel,
  RECORD,
  encodeRecord,
  peerNoiseProtocol,
  peerPrologue,
  peerPsk,
  webCryptoNoisePorts,
  webCryptoX25519,
  type ContactLink,
  type SessionEvent,
} from "../src/peer/index.js";

const KID = "peer-test-2026";
const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const NOW = 1_700_001_000;
const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const NONE = new Uint8Array(0);
const HELLO = utf8('{"platform":"t","app":"a","maxMessage":1048576}');

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

async function acctDevice(id: string) {
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
const acct = (me: { certJws: string; id: string }, k: Uint8Array) => ({
  trust,
  expectedAud: "djdl",
  certJws: me.certJws,
  ownSub: SUB,
  ownDeviceId: me.id,
  heldRing: () => null,
  discKeys: [k] as (Uint8Array | null)[],
});

function side(
  mode: "a" | "c",
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
    caps: ["app/1"],
    hello: { platform: "test", app: "demo" },
    send: (n) => out.push(n),
    onEvent: (e) => events.push(e),
    now: () => NOW,
    ...extra,
  });
  return { s, events, out };
}

async function pump(a: Side, b: Side): Promise<void> {
  for (let i = 0; i < 200 && (a.out.length > 0 || b.out.length > 0); i++) {
    for (const m of a.out.splice(0)) await b.s.receive(m);
    for (const m of b.out.splice(0)) await a.s.receive(m);
  }
}
const of = (x: Side, type: SessionEvent["type"]) =>
  x.events.filter((e) => e.type === type);

async function agreeOf(priv: Uint8Array): Promise<string> {
  return base64UrlEncodeBytes(await webCryptoX25519.publicKey(priv));
}
const junk = (): ContactLink => ({
  secret: rnd(),
  agreeKey: base64UrlEncodeBytes(rnd()),
});

describe("the shared listener", () => {
  it("opens an account peer in mode a when contacts are also held", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await acctDevice("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const k = rnd();
    const a = side("a", "initiator", A.priv, { account: acct(A, k) });
    const b = side("a", "responder", B.priv, {
      account: acct(B, k),
      contacts: [junk(), junk()],
      admission: new HandshakeLimiter(),
    });
    await a.s.start();
    await pump(a, b);
    const est = of(b, "established")[0] as Extract<
      SessionEvent,
      { type: "established" }
    >;
    expect(est.peerDeviceId).toBe(A.id);
    expect(est.contactIndex).toBeUndefined();
    expect(est.helloAuthenticated).toBe(true);
  });

  it("opens a contact peer in mode c on the same listener, whatever advert it dialled", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const dd = rnd();
    const ddKey = await agreeOf(dd);
    const secret = rnd();
    const b = side("a", "responder", A.priv, {
      account: acct(A, rnd()),
      contacts: [junk(), { secret, agreeKey: ddKey }],
      admission: new HandshakeLimiter(),
    });
    const d = side("c", "initiator", dd, {
      contacts: [{ secret, agreeKey: await agreeOf(A.priv) }],
    });
    await d.s.start();
    await pump(d, b);
    const est = of(b, "established")[0] as Extract<
      SessionEvent,
      { type: "established" }
    >;
    expect(est.contactIndex).toBe(1);
    expect(est.helloAuthenticated).toBe(false);
    expect(est.peerDeviceId).toBeUndefined();
    // The session is a contact session now: it carries app records, and mode c's table applies.
    await d.s.sendRecord(0x0100, utf8("x"));
    await pump(d, b);
    expect(of(b, "record")).toHaveLength(1);
  });

  it("tries the account's keys before the contacts: an account PSK wins and takes no limiter slot", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const B = await acctDevice("HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA");
    const k = rnd();
    const limiter = new HandshakeLimiter(1, 1);
    // A contact secret equal to the account's PSK still never decides: the prologue says mode a.
    const b = side("a", "responder", B.priv, {
      account: acct(B, k),
      contacts: [
        { secret: await peerPsk(k, "djdl"), agreeKey: await agreeOf(A.priv) },
      ],
      admission: limiter,
    });
    const a = side("a", "initiator", A.priv, { account: acct(A, k) });
    await a.s.start();
    await pump(a, b);
    expect(of(b, "established")).toHaveLength(1);
    expect((of(b, "established")[0] as any).contactIndex).toBeUndefined();
    // No slot was taken: the one the limiter has is still free.
    expect(limiter.begin()).not.toBeNull();
  });

  it("admits a contact trial through the limiter before it tries any secret", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const dd = rnd();
    const secret = rnd();
    const mk = (limiter: HandshakeLimiter) =>
      side("a", "responder", A.priv, {
        account: acct(A, rnd()),
        contacts: [{ secret, agreeKey: "x".repeat(43) }],
        admission: limiter,
      });
    const dial = async () => {
      const d = side("c", "initiator", dd, {
        contacts: [{ secret, agreeKey: await agreeOf(A.priv) }],
      });
      await d.s.start();
      return d.out.splice(0)[0]!;
    };
    // A refused attempt: peer_busy, not handshake_failed, so no secret was tried; nothing sent.
    const full = new HandshakeLimiter(0, 4);
    const busy = mk(full);
    await busy.s.receive(await dial());
    expect(of(busy, "closed")).toEqual([
      { type: "closed", code: "peer_busy", byPeer: false },
    ]);
    expect(busy.out).toHaveLength(0);
    // An admitted attempt whose tag fails every secret: handshake_failed.
    const ok = mk(new HandshakeLimiter());
    const raw = new NoiseHandshake({
      role: "initiator",
      protocol: peerNoiseProtocol("c"),
      prologue: peerPrologue("djdl", "c"),
      psk: rnd(),
      staticKey: dd,
    });
    await ok.s.receive(await raw.writeMessage(utf8('{"v":1}')));
    expect(of(ok, "closed")).toEqual([
      { type: "closed", code: "handshake_failed", byPeer: false },
    ]);
    expect(ok.out).toHaveLength(0);
  });

  it("holds a limiter slot until message 3 and caps the connections that wait for it", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const limiter = new HandshakeLimiter(99, 2);
    const waiting: Side[] = [];
    const devs: { priv: Uint8Array; secret: Uint8Array }[] = [];
    for (let i = 0; i < 3; i++) devs.push({ priv: rnd(), secret: rnd() });
    const contacts = await Promise.all(
      devs.map(async (d) => ({
        secret: d.secret,
        agreeKey: await agreeOf(d.priv),
      })),
    );
    const m1 = async (i: number): Promise<Uint8Array> => {
      const d = side("c", "initiator", devs[i]!.priv, {
        contacts: [
          { secret: devs[i]!.secret, agreeKey: await agreeOf(A.priv) },
        ],
      });
      await d.s.start();
      return d.out.splice(0)[0]!;
    };
    for (let i = 0; i < 3; i++) {
      const b = side("a", "responder", A.priv, {
        account: acct(A, rnd()),
        contacts,
        admission: limiter,
      });
      await b.s.receive(await m1(i));
      waiting.push(b);
    }
    // Two waiting for message 3 filled the cap; the third was refused.
    expect(waiting[0]!.out).toHaveLength(1);
    expect(waiting[1]!.out).toHaveLength(1);
    expect(of(waiting[2]!, "closed")).toEqual([
      { type: "closed", code: "peer_busy", byPeer: false },
    ]);
    // Closing a waiting connection frees its slot.
    await waiting[0]!.s.close();
    expect(limiter.begin()).not.toBeNull();
  });

  it("frees the slot when the transport exists", async () => {
    const A = await acctDevice("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    const dd = rnd();
    const secret = rnd();
    const limiter = new HandshakeLimiter(99, 1);
    const b = side("a", "responder", A.priv, {
      account: acct(A, rnd()),
      contacts: [{ secret, agreeKey: await agreeOf(dd) }],
      admission: limiter,
    });
    const d = side("c", "initiator", dd, {
      contacts: [{ secret, agreeKey: await agreeOf(A.priv) }],
    });
    await d.s.start();
    await pump(d, b);
    expect(b.s.isOpen).toBe(true);
    expect(limiter.begin()).not.toBeNull();
  });
});

describe("mode c refuses what only an account session has", () => {
  async function rawContact(code: number) {
    const dd = rnd();
    const mm = rnd();
    const secret = rnd();
    const m = side("c", "responder", mm, {
      contacts: [{ secret, agreeKey: await agreeOf(dd) }],
      admission: new HandshakeLimiter(),
    });
    const raw = new NoiseHandshake({
      role: "initiator",
      protocol: peerNoiseProtocol("c"),
      prologue: peerPrologue("djdl", "c"),
      psk: secret,
      staticKey: dd,
    });
    await m.s.receive(await raw.writeMessage(utf8('{"v":1}')));
    await raw.readMessage(m.out.splice(0)[0]!);
    await m.s.receive(await raw.writeMessage(utf8('{"v":1,"caps":[]}')));
    const tp = await raw.transport();
    const send = async (type: number, body: Uint8Array) =>
      m.s.receive(
        await tp.send.encrypt(NONE, encodeRecord({ type, flags: 0, body })),
      );
    await send(RECORD.HELLO, HELLO);
    expect(m.s.isOpen).toBe(true);
    await send(code, utf8("{}"));
    return m;
  }

  it("closes peer_not_allowed on RING, without touching a roster", async () => {
    const m = await rawContact(RECORD.RING);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
    expect(of(m, "ring")).toHaveLength(0);
  });

  it("closes peer_not_allowed on TRUST, without handing the host a document", async () => {
    const m = await rawContact(RECORD.TRUST);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
    expect(of(m, "trust-unverified")).toHaveLength(0);
  });
});
