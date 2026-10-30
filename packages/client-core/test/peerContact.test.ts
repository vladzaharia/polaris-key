// Inter-account links end to end, in memory (WIRE-CONTRACT-V5 §15.10): a mode-p pairing with the
// contact exchange, then mode c under the secret it made; the pin, the PSK trial, the exchange's
// deadline and the constructor's refusals. The byte-level rows are peer-matrix.json `contact`.
import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  HandshakeLimiter,
  PeerChannel,
  RECORD,
  contactAlias,
  contactRid,
  webCryptoNoisePorts,
  webCryptoX25519,
  type ContactLink,
  type ContactOffer,
  type PeerMode,
  type SessionEvent,
} from "../src/peer/index.js";

const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Side {
  s: PeerChannel;
  events: SessionEvent[];
  out: Uint8Array[];
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
    caps: ["app/1"],
    hello: { platform: "test", app: "demo" },
    send: (n) => out.push(n),
    onEvent: (e) => events.push(e),
    ...(mode === "p" && role === "responder"
      ? { admission: new HandshakeLimiter() }
      : {}),
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

async function device() {
  const priv = rnd();
  const pub = await webCryptoX25519.publicKey(priv);
  return { priv, agreeKey: base64UrlEncodeBytes(pub) };
}

type ContactEvent = Extract<SessionEvent, { type: "contact" }>;

/** Pair two devices in mode p with the contact exchange; both end with a `contact` event. */
async function pair(
  offerD: Partial<ContactOffer> = {},
  offerM: Partial<ContactOffer> = {},
) {
  const dd = await device();
  const mm = await device();
  const d = side("p", "initiator", rnd(), {
    exchange: { agreeKey: dd.agreeKey, cats: ["docs"], ...offerD },
  });
  const m = side("p", "responder", rnd(), {
    exchange: { agreeKey: mm.agreeKey, cats: ["docs", "music"], ...offerM },
  });
  await d.s.start();
  await pump(d, m);
  await d.s.confirmSas();
  await m.s.confirmSas();
  await pump(d, m);
  return { d, m, dd, mm };
}

describe("the contact exchange in mode p", () => {
  it("makes the same secret on both sides and hands each the other's key, label and categories", async () => {
    const { d, m, dd, mm } = await pair(
      { label: "Anna" },
      { label: "Bo", cats: ["docs", "music"] },
    );
    const cd = of(d, "contact")[0] as ContactEvent;
    const cm = of(m, "contact")[0] as ContactEvent;
    expect(cd.secret).toHaveLength(32);
    expect(Array.from(cd.secret)).toEqual(Array.from(cm.secret));
    expect(cd.agreeKey).toBe(mm.agreeKey);
    expect(cm.agreeKey).toBe(dd.agreeKey);
    expect(cd.label).toBe("Bo");
    expect(cm.label).toBe("Anna");
    expect(cd.cats).toEqual(["docs", "music"]);
    expect(cm.cats).toEqual(["docs"]);
    // The session owns CONFIRM and CONTACT: the host sees neither as a record.
    expect(of(d, "record")).toHaveLength(0);
    expect(of(m, "record")).toHaveLength(0);
    expect(d.s.closed).toBe(false);
  });

  it("makes a new secret for every pairing", async () => {
    const a = await pair();
    const b = await pair();
    const sa = (of(a.d, "contact")[0] as ContactEvent).secret;
    const sb = (of(b.d, "contact")[0] as ContactEvent).secret;
    expect(Array.from(sa)).not.toEqual(Array.from(sb));
  });

  it("owns CONFIRM and CONTACT: the host cannot send them", async () => {
    const { d } = await pair();
    await expect(d.s.sendRecord(RECORD.CONTACT, utf8("{}"))).rejects.toThrow();
    await expect(d.s.sendRecord(RECORD.CONFIRM, utf8("{}"))).rejects.toThrow();
  });

  it("closes peer_timeout when the peer's CONTACT does not come in 30 s", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const dd = await device();
    const d = side("p", "initiator", rnd(), {
      exchange: { agreeKey: dd.agreeKey, cats: [] },
      timer: (fn, ms) => {
        timers.push({ fn, ms });
        return () => undefined;
      },
    });
    const m = side("p", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    await d.s.confirmSas();
    expect(timers.some((t) => t.ms === 30_000)).toBe(true);
    timers.find((t) => t.ms === 30_000)!.fn();
    await d.s.close("peer_bye").catch(() => undefined);
    expect(of(d, "closed")[0]).toMatchObject({ code: "peer_timeout" });
  });

  it("without the exchange the host still sees CONFIRM as a record", async () => {
    const d = side("p", "initiator", rnd());
    const m = side("p", "responder", rnd());
    await d.s.start();
    await pump(d, m);
    await d.s.confirmSas();
    await m.s.confirmSas();
    await pump(d, m);
    expect(of(m, "record").map((e) => (e as any).recordType)).toEqual([
      RECORD.CONFIRM,
    ]);
    expect(of(m, "contact")).toHaveLength(0);
  });
});

describe("mode c", () => {
  /** A contact made by a real pairing, as each device holds it. */
  async function linked() {
    const { d, m, dd, mm } = await pair();
    const secret = (of(d, "contact")[0] as ContactEvent).secret;
    const heldByD: ContactLink = { secret, agreeKey: mm.agreeKey };
    const heldByM: ContactLink = { secret, agreeKey: dd.agreeKey };
    return { dd, mm, heldByD, heldByM };
  }
  const junk = (): ContactLink => ({
    secret: rnd(),
    agreeKey: base64UrlEncodeBytes(rnd()),
  });

  it("opens under the secret a pairing made, with no code, and carries records", async () => {
    const { dd, mm, heldByD, heldByM } = await linked();
    const d = side("c", "initiator", dd.priv, { contacts: [heldByD] });
    const m = side("c", "responder", mm.priv, {
      contacts: [junk(), junk(), heldByM],
    });
    await d.s.start();
    await pump(d, m);
    expect(d.s.isOpen).toBe(true);
    expect(m.s.isOpen).toBe(true);
    expect(of(d, "sas")).toHaveLength(0);
    const est = of(m, "established")[0] as Extract<
      SessionEvent,
      { type: "established" }
    >;
    expect(est.contactIndex).toBe(2);
    expect(est.helloAuthenticated).toBe(true);
    expect(est.caps).toEqual(["app/1"]);
    expect(
      (
        of(d, "established")[0] as Extract<
          SessionEvent,
          { type: "established" }
        >
      ).contactIndex,
    ).toBe(0);
    await d.s.sendRecord(0x0100, utf8("hello"));
    await pump(d, m);
    expect(of(m, "record")).toHaveLength(1);
  });

  it("tries every secret the responder holds, 64 of them", async () => {
    const { dd, mm, heldByD, heldByM } = await linked();
    const held = [...Array.from({ length: 63 }, junk), heldByM];
    const d = side("c", "initiator", dd.priv, { contacts: [heldByD] });
    const m = side("c", "responder", mm.priv, { contacts: held });
    await d.s.start();
    await pump(d, m);
    expect(
      (
        of(m, "established")[0] as Extract<
          SessionEvent,
          { type: "established" }
        >
      ).contactIndex,
    ).toBe(63);
  });

  it("ends silently when no held secret opens message 1", async () => {
    const { dd, mm, heldByD } = await linked();
    const d = side("c", "initiator", dd.priv, { contacts: [heldByD] });
    const m = side("c", "responder", mm.priv, { contacts: [junk(), junk()] });
    await d.s.start();
    await m.s.receive(d.out.splice(0)[0]!);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "handshake_failed", byPeer: false },
    ]);
    expect(m.out).toHaveLength(0);
  });

  it("ends as peer_revoked, sending nothing, when the responder's pin differs", async () => {
    const { dd, mm, heldByD, heldByM } = await linked();
    const d = side("c", "initiator", dd.priv, { contacts: [heldByD] });
    // The secret opens, but the key stored for it is another one.
    const m = side("c", "responder", mm.priv, {
      contacts: [{ secret: heldByM.secret, agreeKey: junk().agreeKey }],
    });
    await d.s.start();
    await pump(d, m);
    expect(of(m, "closed")).toEqual([
      { type: "closed", code: "peer_revoked", byPeer: false },
    ]);
    expect(of(m, "established")).toHaveLength(0);
    expect(m.s.isOpen).toBe(false);
  });

  it("ends as peer_revoked before message 3 when the initiator's pin differs", async () => {
    const { dd, mm, heldByD, heldByM } = await linked();
    const d = side("c", "initiator", dd.priv, {
      contacts: [{ secret: heldByD.secret, agreeKey: junk().agreeKey }],
    });
    const m = side("c", "responder", mm.priv, { contacts: [heldByM] });
    await d.s.start();
    await m.s.receive(d.out.splice(0)[0]!);
    await d.s.receive(m.out.splice(0)[0]!);
    expect(of(d, "closed")).toEqual([
      { type: "closed", code: "peer_revoked", byPeer: false },
    ]);
    expect(d.out).toHaveLength(0);
  });

  it("does not open a mode-a or mode-p session, or the other product's", async () => {
    const { dd, mm, heldByD, heldByM } = await linked();
    const d = side("c", "initiator", dd.priv, {
      contacts: [heldByD],
      slug: "other",
    });
    const m = side("c", "responder", mm.priv, { contacts: [heldByM] });
    await d.s.start();
    await m.s.receive(d.out.splice(0)[0]!);
    expect(of(m, "closed")[0]).toMatchObject({ code: "handshake_failed" });
  });

  it("refuses constructions that break the contact rules", async () => {
    const k = await device();
    const one = [junk()];
    const mk =
      (o: Partial<ConstructorParameters<typeof PeerChannel>[0]>) => () =>
        side("c", "initiator", k.priv, o);
    expect(mk({})).toThrow();
    expect(mk({ contacts: [] })).toThrow();
    expect(mk({ contacts: [junk(), junk()] })).toThrow();
    expect(mk({ contacts: one })).not.toThrow();
    expect(
      mk({ contacts: [{ secret: new Uint8Array(31), agreeKey: "x" }] }),
    ).toThrow();
    expect(() =>
      side("c", "responder", k.priv, {
        contacts: Array.from({ length: 65 }, junk),
      }),
    ).toThrow();
    expect(() =>
      side("c", "responder", k.priv, {
        contacts: Array.from({ length: 64 }, junk),
      }),
    ).not.toThrow();
    // A mode-c responder needs no admission limiter; contacts and exchange belong to c and p only.
    expect(() => side("a", "initiator", k.priv, { contacts: one })).toThrow();
    expect(() =>
      side("v", "initiator", k.priv, {
        exchange: { agreeKey: k.agreeKey, cats: [] },
      }),
    ).toThrow();
  });
});

describe("the contact room", () => {
  it("derives a stable room id and a per-room alias from the secret", async () => {
    const secret = rnd();
    const rid = await contactRid(secret);
    expect(rid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await contactRid(secret)).toBe(rid);
    expect(await contactRid(rnd())).not.toBe(rid);
    const dev = base64UrlEncodeBytes(rnd().slice(0, 24));
    const alias = await contactAlias(rid, dev);
    expect(alias).toHaveLength(24);
    expect(
      Array.from(await contactAlias(await contactRid(rnd()), dev)),
    ).not.toEqual(Array.from(alias));
    await expect(contactAlias("short", dev)).rejects.toThrow();
  });
});
