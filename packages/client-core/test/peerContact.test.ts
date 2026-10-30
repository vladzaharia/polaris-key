// Inter-account links end to end, in memory (WIRE-CONTRACT-V5 §15.10): a mode-p pairing with the
// contact exchange, then mode c under the secret it made; the pin, the PSK trial, the exchange's
// deadline and the constructor's refusals. The byte-level rows are peer-matrix.json `contact`.
import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  ContactExchange,
  HandshakeLimiter,
  MAX_CONTACTS,
  MAX_PENDING_CONTACTS,
  PENDING_CONTACT_SECONDS,
  browseContactInstance,
  contactInstance,
  contactTrialOrder,
  dropStalePending,
  promoteContact,
  storeContact,
  type StoredContact,
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
    ...((mode === "p" || mode === "c") && role === "responder"
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
  keys?: {
    dd: Awaited<ReturnType<typeof device>>;
    mm: Awaited<ReturnType<typeof device>>;
  },
) {
  const dd = keys?.dd ?? (await device());
  const mm = keys?.mm ?? (await device());
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
    // A contact's HELLO is display data: the host shows the label it stored (§15.10).
    expect(est.helloAuthenticated).toBe(false);
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
    // 64 held and 8 pending: 72 secrets at most.
    expect(() =>
      side("c", "responder", k.priv, {
        contacts: Array.from({ length: 73 }, junk),
      }),
    ).toThrow();
    expect(() =>
      side("c", "responder", k.priv, {
        contacts: Array.from({ length: 72 }, junk),
      }),
    ).not.toThrow();
    // A contact responder trials secrets on unauthenticated input: it needs an admission limiter.
    expect(
      () =>
        new PeerChannel({
          mode: "c",
          role: "responder",
          slug: "djdl",
          staticKey: k.priv,
          contacts: one,
          hello: { platform: "test", app: "demo" },
          send: () => undefined,
          onEvent: () => undefined,
        }),
    ).toThrow(/admission/);
    // Contacts and exchange belong to c and p only (and to a mode-a responder, the shared listener).
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

// ── A pairing with a peer already held is pending (B1) ───────────────────────────────────────

const key = (n: number): string =>
  base64UrlEncodeBytes(new Uint8Array(32).fill(n));
const sec = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const entry = (
  k: number,
  s: number,
  extra: Partial<StoredContact> = {},
): StoredContact => ({
  agreeKey: key(k),
  secret: sec(s),
  cats: [],
  ...extra,
});

describe("a pairing with a peer the host already holds", () => {
  it("tells the session a held peer is a re-pair, in the contact event", async () => {
    const dd = await device();
    const mm = await device();
    // M already holds D's key; D holds nothing.
    const { d, m } = await pair({}, { held: [dd.agreeKey] }, { dd, mm });
    expect((of(m, "contact")[0] as ContactEvent).pending).toBe(true);
    expect((of(d, "contact")[0] as ContactEvent).pending).toBe(false);
  });

  it("accepts a re-pair at 64 contacts and refuses a new peer there, storing nothing", async () => {
    const dd = await device();
    const mm = await device();
    const full = Array.from({ length: MAX_CONTACTS }, (_, i) => key(i + 1));
    const again = await pair(
      {},
      { held: [...full.slice(1), dd.agreeKey] },
      { dd, mm },
    );
    expect((of(again.m, "contact")[0] as ContactEvent).pending).toBe(true);
    const fresh = await pair({}, { held: full }, { dd, mm });
    expect(of(fresh.m, "contact")).toHaveLength(0);
    expect(of(fresh.m, "closed")[0]).toMatchObject({
      code: "peer_not_allowed",
    });
  });

  it("the exchange guard: new, held and full", () => {
    const own = key(250);
    const body = (k: string): Uint8Array =>
      new TextEncoder().encode(JSON.stringify({ v: 1, agreeKey: k, cats: [] }));
    const run = (held: string[], k: string) => {
      const x = new ContactExchange(own, held);
      x.step({ event: "own-confirm" });
      x.step({ event: "peer-confirm" });
      return x.step({ event: "peer-contact", body: body(k) });
    };
    expect(run([], key(1)).stored).toMatchObject({ pending: false });
    expect(run([key(1)], key(1)).stored).toMatchObject({ pending: true });
    const sixtyFour = Array.from({ length: 64 }, (_, i) => key(i + 1));
    expect(run(sixtyFour, key(64)).stored).toMatchObject({ pending: true });
    expect(run(sixtyFour, key(200))).toEqual({
      sends: [],
      close: "peer_not_allowed",
    });
  });
});

describe("the contact list", () => {
  it("adds a new peer as active, refuses it at 64", () => {
    const r = storeContact([], entry(1, 1), 100);
    expect(r).toMatchObject({ ok: true, pending: false });
    const sixtyFour = Array.from({ length: 64 }, (_, i) => entry(i + 1, i + 1));
    expect(storeContact(sixtyFour, entry(200, 9), 100)).toEqual({
      ok: false,
      reason: "full",
    });
  });

  it("keeps the held contact when the same peer is paired again, as pending", () => {
    const held = [entry(1, 1), entry(2, 2)];
    const r = storeContact(held, entry(1, 7, { label: "New" }), 500);
    if (!r.ok) throw new Error("full");
    expect(r.pending).toBe(true);
    expect(r.contacts).toHaveLength(3);
    // The held contact is untouched: same secret, no label.
    expect(r.contacts[0]).toBe(held[0]);
    expect(r.contacts[2]).toMatchObject({
      agreeKey: key(1),
      pendingSince: 500,
      label: "New",
    });
    // At 64 a held peer's re-pair is stored; nothing is added to the 64.
    const sixtyFour = Array.from({ length: 64 }, (_, i) => entry(i + 1, i + 1));
    const again = storeContact(sixtyFour, entry(5, 99), 500);
    expect(again).toMatchObject({ ok: true, pending: true });
  });

  it("holds one pending contact per key; a newer pairing replaces it", () => {
    let l: StoredContact[] = [entry(1, 1)];
    for (const [s, t] of [
      [7, 10],
      [8, 20],
    ] as const) {
      const r = storeContact(l, entry(1, s), t);
      if (!r.ok) throw new Error("full");
      l = r.contacts;
    }
    expect(l.filter((c) => c.pendingSince !== undefined)).toHaveLength(1);
    expect(l[1]!.secret[0]).toBe(8);
  });

  it("keeps at most 8 pending, dropping the oldest", () => {
    let l: StoredContact[] = Array.from({ length: 10 }, (_, i) =>
      entry(i + 1, i + 1),
    );
    for (let i = 0; i < 10; i++) {
      const r = storeContact(l, entry(i + 1, 100 + i), 1000 + i);
      if (!r.ok) throw new Error("full");
      l = r.contacts;
    }
    const pend = l.filter((c) => c.pendingSince !== undefined);
    expect(pend).toHaveLength(MAX_PENDING_CONTACTS);
    expect(pend.map((c) => c.pendingSince)).toEqual([
      1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
    ]);
  });

  it("promotes a pending contact into the held one's place, only on that key", () => {
    const l = [
      entry(1, 1),
      entry(2, 2),
      entry(1, 7, { pendingSince: 5, label: "New" }),
    ];
    const out = promoteContact(l, key(1));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ agreeKey: key(1), label: "New" });
    expect(out[0]!.secret[0]).toBe(7);
    expect(out[0]!.pendingSince).toBeUndefined();
    expect(out[1]).toBe(l[1]);
    expect(promoteContact(l, key(2))).toEqual(l);
  });

  it("drops a pending contact 24 h after it was stored", () => {
    const l = [entry(1, 1), entry(1, 7, { pendingSince: 1000 })];
    expect(
      dropStalePending(l, 1000 + PENDING_CONTACT_SECONDS - 1),
    ).toHaveLength(2);
    expect(dropStalePending(l, 1000 + PENDING_CONTACT_SECONDS)).toHaveLength(1);
  });

  it("tries the held contacts first, then the pending ones", () => {
    const l = [entry(1, 1, { pendingSince: 5 }), entry(2, 2), entry(3, 3)];
    expect(contactTrialOrder(l).map((c) => c.agreeKey)).toEqual([
      key(2),
      key(3),
      key(1),
    ]);
  });

  it("an attacker's pending contact never replaces the held one: the pin fails under its secret", async () => {
    // B holds A's key. X pairs with A, claiming B's key: A stores it pending, with X's secret.
    const a = await device();
    const b = await device();
    const x = await device();
    const bSecret = rnd();
    const xSecret = rnd();
    let list: StoredContact[] = [
      { agreeKey: b.agreeKey, secret: bSecret, cats: ["docs"], label: "B" },
    ];
    const r = storeContact(
      list,
      { agreeKey: b.agreeKey, secret: xSecret, cats: [], label: "Mom" },
      1000,
    );
    if (!r.ok) throw new Error("full");
    list = r.contacts;
    // X dials A under xSecret with X's own static key: the pin (B's key) fails.
    const order = contactTrialOrder(list);
    const dialA = side("c", "initiator", x.priv, {
      contacts: [{ secret: xSecret, agreeKey: a.agreeKey }],
    });
    const listenA = side("c", "responder", a.priv, {
      contacts: order.map((c) => ({ secret: c.secret, agreeKey: c.agreeKey })),
    });
    await dialA.s.start();
    await pump(dialA, listenA);
    expect(of(listenA, "established")).toHaveLength(0);
    expect(of(listenA, "closed")[0]).toMatchObject({ code: "peer_revoked" });
    // Nothing was promoted; the held contact is still B's, with B's secret.
    expect(list.find((c) => c.pendingSince === undefined)!.secret).toBe(
      bSecret,
    );
    // B's own handshake under the new secret (if B really paired) does promote.
    const real = side("c", "initiator", b.priv, {
      contacts: [{ secret: xSecret, agreeKey: a.agreeKey }],
    });
    const listenA2 = side("c", "responder", a.priv, {
      contacts: order.map((c) => ({ secret: c.secret, agreeKey: c.agreeKey })),
    });
    await real.s.start();
    await pump(real, listenA2);
    const est = of(listenA2, "established")[0] as Extract<
      SessionEvent,
      { type: "established" }
    >;
    expect(order[est.contactIndex!]!.pendingSince).toBe(1000);
    expect(
      promoteContact(list, order[est.contactIndex!]!.agreeKey)[0]!.secret,
    ).toBe(xSecret);
  });

  it("browses pending contacts too", async () => {
    const l = [entry(1, 1), entry(1, 7, { pendingSince: 5 })];
    const order = contactTrialOrder(l);
    const name = await contactInstance(sec(7), sec(1), 3);
    expect(
      await browseContactInstance(
        name,
        order.map((c) => ({
          secret: c.secret,
          agreeKey: new Uint8Array(32).fill(1),
        })),
        3 * 900,
      ),
    ).toEqual({ contact: 1, epochBack: 0 });
  });
});
