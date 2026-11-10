// Local links end to end, in memory (WIRE-CONTRACT-V5 §15.12): CPace to a mode-q pairing with the
// consent and LOCAL_LINK exchange, then mode l under the link it made; the pin, a wrong code, a
// decline, a peer without `local/1`, the shared listener's trial order and its limiter. The
// byte-level rows are noise-vectors.json `cpace` and peer-matrix.json `local`.
import { describe, expect, it } from "vitest";
import {
  HandshakeLimiter,
  MAX_LOCAL_LINKS,
  NoiseHandshake,
  PeerChannel,
  RECORD,
  cpaceGenerator,
  cpaceIsk,
  cpacePrsCode,
  cpacePsk,
  cpaceScalar,
  cpaceShare,
  encodeRecord,
  parseRecord,
  peerNoiseProtocol,
  peerPrologue,
  webCryptoNoisePorts,
  webCryptoX25519,
  type LocalLink,
  type SessionEvent,
} from "../src/peer/index.js";

const SLUG = "djdl";
const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Side {
  ch: PeerChannel;
  seen: SessionEvent[];
  out: Uint8Array[];
}
type Options = ConstructorParameters<typeof PeerChannel>[0];

/** One end of a session, its wire in `out` and its events in `events`. */
function side(o: Partial<Options> & Pick<Options, "mode" | "role">): Side {
  const x: Side = { ch: undefined as never, seen: [], out: [] };
  x.ch = new PeerChannel({
    slug: SLUG,
    caps: ["app/1"],
    hello: { platform: "test", app: "demo" },
    send: (frame) => x.out.push(frame),
    onEvent: (e) => x.seen.push(e),
    ...o,
  });
  return x;
}

/** Carry each side's output to the other until both are quiet. */
async function pump(a: Side, b: Side): Promise<void> {
  for (let n = 0; n < 200 && a.out.length + b.out.length > 0; n++) {
    const toB = a.out.splice(0);
    const toA = b.out.splice(0);
    for (const m of toB) await b.ch.receive(m);
    for (const m of toA) await a.ch.receive(m);
  }
}

const of = <T extends SessionEvent["type"]>(x: Side, type: T) =>
  x.seen.filter((e) => e.type === type) as Extract<SessionEvent, { type: T }>[];
const closed = (x: Side) => of(x, "closed")[0];

/** CPace between a joiner and a shower: the PSK and ISK each holds. */
async function cpace(joinerCode: string, showerCode: string) {
  const sid = webCryptoNoisePorts.random(10);
  const ci = peerPrologue(SLUG, "q");
  const gJ = await cpaceGenerator(cpacePrsCode(joinerCode), ci, sid);
  const gS = await cpaceGenerator(cpacePrsCode(showerCode), ci, sid);
  const ya = cpaceScalar();
  const yb = cpaceScalar();
  const Ya = (await cpaceShare(ya, gJ))!;
  const Yb = (await cpaceShare(yb, gS))!;
  const iskJ = (await cpaceIsk({
    sid,
    scalar: ya,
    ya: Ya,
    yb: Yb,
    role: "initiator",
  }))!;
  const iskS = (await cpaceIsk({
    sid,
    scalar: yb,
    ya: Ya,
    yb: Yb,
    role: "responder",
  }))!;
  return {
    joiner: { psk: await cpacePsk(iskJ, SLUG), isk: iskJ },
    shower: { psk: await cpacePsk(iskS, SLUG), isk: iskS },
  };
}

async function pairSides(o: {
  joinerCode?: string;
  showerCode?: string;
  joinerCats?: string[];
  showerCats?: string[];
  showerHeld?: number;
  showerElapsed?: number;
  permit?: () => boolean;
}) {
  const c = await cpace(o.joinerCode ?? "123456", o.showerCode ?? "123456");
  const jKey = rnd();
  const sKey = rnd();
  const joiner = side({
    mode: "q",
    role: "initiator",
    staticKey: jKey,
    pair: {
      ...c.joiner,
      held: 0,
      elapsed: 0,
      cats: o.joinerCats ?? ["docs"],
      label: "Anna",
    },
  });
  const shower = side({
    mode: "q",
    role: "responder",
    staticKey: sKey,
    pair: {
      ...c.shower,
      held: o.showerHeld ?? 0,
      elapsed: o.showerElapsed ?? 0,
      permit: o.permit ?? (() => true),
      cats: o.showerCats ?? ["docs", "music"],
      label: "Bo",
    },
  });
  return { joiner, shower, jKey, sKey };
}

type Pairing = Awaited<ReturnType<typeof pairSides>>;

/** Both handshakes, both persons' answers, then the exchange; the shower's person may decline. */
async function settle(p: Pairing, shower: "confirm" | "decline" = "confirm") {
  await p.joiner.ch.start();
  await pump(p.joiner, p.shower);
  await p.joiner.ch.confirmPairing();
  await (shower === "confirm"
    ? p.shower.ch.confirmPairing()
    : p.shower.ch.declinePairing());
  await pump(p.joiner, p.shower);
  return p;
}

/** Pair two devices; returns what each stored. */
const pairUp = async () => settle(await pairSides({}));

describe("a mode-q pairing", () => {
  it("makes one link secret on both sides, with each other's keys, label and shared categories", async () => {
    const { joiner, shower, jKey, sKey } = await pairUp();
    expect(of(shower, "guess")).toEqual([{ type: "guess", opens: true }]);
    for (const x of [joiner, shower]) {
      const est = of(x, "established")[0]!;
      expect(est.helloAuthenticated).toBe(false);
      expect(est.caps).toContain("local/1");
    }
    const lj = of(joiner, "local-link")[0]!;
    const ls = of(shower, "local-link")[0]!;
    expect(lj.secret).toHaveLength(32);
    expect(Array.from(lj.secret)).toEqual(Array.from(ls.secret));
    const jPub = await webCryptoX25519.publicKey(jKey);
    const sPub = await webCryptoX25519.publicKey(sKey);
    expect(Array.from(lj.ownKey)).toEqual(Array.from(jPub));
    expect(Array.from(lj.peerKey)).toEqual(Array.from(sPub));
    expect(Array.from(ls.peerKey)).toEqual(Array.from(jPub));
    expect(lj.label).toBe("Bo");
    expect(ls.label).toBe("Anna");
    expect(lj.cats).toEqual(["docs"]);
    expect(ls.cats).toEqual(["docs"]);
    // Each side closed after it stored the link.
    expect(closed(joiner)).toMatchObject({ code: "peer_bye" });
    expect(closed(shower)).toMatchObject({ code: "peer_bye" });
  });

  it("makes a new link for every pairing", async () => {
    const a = await pairUp();
    const b = await pairUp();
    expect(Array.from(of(a.joiner, "local-link")[0]!.secret)).not.toEqual(
      Array.from(of(b.joiner, "local-link")[0]!.secret),
    );
  });

  it("a wrong code is one failed guess: the shower closes silently, the joiner never sees a transport", async () => {
    const p = await pairSides({ joinerCode: "123457", showerCode: "123456" });
    await p.joiner.ch.start();
    await pump(p.joiner, p.shower);
    expect(of(p.shower, "guess")).toEqual([{ type: "guess", opens: false }]);
    expect(closed(p.shower)).toMatchObject({
      code: "handshake_failed",
      byPeer: false,
    });
    expect(p.shower.out).toHaveLength(0);
    expect(of(p.shower, "established")).toHaveLength(0);
    expect(of(p.shower, "local-link")).toHaveLength(0);
  });

  it("never tries the tag without a permit or past 30 s, and tries it once with one", async () => {
    for (const o of [{ permit: () => false }, { showerElapsed: 30 }]) {
      const p = await pairSides(o);
      await p.joiner.ch.start();
      await pump(p.joiner, p.shower);
      expect(of(p.shower, "guess")).toHaveLength(0);
      expect(closed(p.shower)).toMatchObject({ code: "handshake_failed" });
    }
    let asked = 0;
    const p = await pairSides({
      permit: () => {
        asked++;
        return true;
      },
    });
    await p.joiner.ch.start();
    await pump(p.joiner, p.shower);
    expect(asked).toBe(1);
  });

  it("refuses a mode-q responder without a permit and any pairing without an elapsed time", async () => {
    const c = await cpace("123456", "123456");
    const mk = (pair: Record<string, unknown>) => () =>
      side({
        mode: "q",
        role: "responder",
        staticKey: rnd(),
        pair: pair as never,
      });
    const base = { ...c.shower, held: 0, cats: [] };
    expect(mk({ ...base, elapsed: 0 })).toThrow(RangeError);
    expect(mk({ ...base, permit: () => true })).toThrow(RangeError);
  });

  it("a decline closes both sides peer_bye and stores nothing", async () => {
    const p = await settle(await pairSides({}), "decline");
    expect(closed(p.shower)).toMatchObject({ code: "peer_bye", byPeer: false });
    expect(closed(p.joiner)).toMatchObject({ code: "peer_bye", byPeer: true });
    expect(of(p.joiner, "local-link")).toHaveLength(0);
    expect(of(p.shower, "local-link")).toHaveLength(0);
  });

  it("a side that holds the most links refuses a valid LOCAL_LINK and stores nothing", async () => {
    const p = await settle(await pairSides({ showerHeld: MAX_LOCAL_LINKS }));
    expect(of(p.shower, "local-link")).toHaveLength(0);
    expect(closed(p.shower)).toMatchObject({ code: "peer_not_allowed" });
  });

  it("owns every record: the host cannot send one", async () => {
    const { joiner } = await pairSides({});
    await expect(joiner.ch.sendRecord(0x0100, utf8("{}"))).rejects.toThrow();
  });

  it("a peer without local/1 closes the session before any consent", async () => {
    const c = await cpace("123456", "123456");
    const shower = side({
      mode: "q",
      role: "responder",
      staticKey: rnd(),
      pair: {
        ...c.shower,
        held: 0,
        elapsed: 0,
        permit: () => true,
        cats: [],
        label: "Bo",
      },
    });
    const raw = new NoiseHandshake({
      role: "initiator",
      protocol: peerNoiseProtocol("q"),
      prologue: peerPrologue(SLUG, "q"),
      psk: c.joiner.psk,
      staticKey: rnd(),
    });
    await shower.ch.receive(await raw.writeMessage(utf8('{"v":1}')));
    await raw.readMessage(shower.out.splice(0)[0]!);
    await shower.ch.receive(await raw.writeMessage(utf8('{"v":1,"caps":[]}')));
    const tp = await raw.transport();
    const hello = encodeRecord({
      type: RECORD.HELLO,
      flags: 0,
      body: utf8('{"platform":"test","app":"demo","maxMessage":1048576}'),
    });
    await shower.ch.receive(await tp.send.encrypt(new Uint8Array(0), hello));
    expect(of(shower, "established")).toHaveLength(0);
    expect(closed(shower)).toMatchObject({ code: "peer_not_allowed" });
    // The CLOSE record names the code (after the session's own HELLO).
    const types: number[] = [];
    for (const m of shower.out.splice(0))
      types.push(
        parseRecord(await tp.receive.decrypt(new Uint8Array(0), m))!.type,
      );
    expect(types).toEqual([RECORD.HELLO, RECORD.CLOSE]);
  });
});

describe("mode l under the link a pairing made", () => {
  async function links() {
    const { joiner, shower } = await pairUp();
    const lj = of(joiner, "local-link")[0]!;
    const ls = of(shower, "local-link")[0]!;
    return { lj, ls };
  }
  const link = (
    secret: Uint8Array,
    ownKey: Uint8Array,
    peerKey: Uint8Array,
  ): LocalLink => ({
    secret,
    ownKey,
    peerKey,
  });
  // The pairing events carry public keys; a later session needs the private ones, which the host
  // kept. Here a fresh pair of keys stands in, with the same secret.
  async function pairOfKeys() {
    const a = rnd();
    const b = rnd();
    return {
      a,
      b,
      aPub: await webCryptoX25519.publicKey(a),
      bPub: await webCryptoX25519.publicKey(b),
    };
  }

  it("opens a session, shows the stored label as unauthenticated display data and carries records", async () => {
    const { lj } = await links();
    const k = await pairOfKeys();
    const initiator = side({
      mode: "l",
      role: "initiator",
      locals: [link(lj.secret, k.a, k.bPub)],
    });
    const decoy = link(rnd(), rnd(), rnd());
    const responder = side({
      mode: "l",
      role: "responder",
      locals: [decoy, link(lj.secret, k.b, k.aPub)],
      admission: new HandshakeLimiter(),
    });
    await initiator.ch.start();
    await pump(initiator, responder);
    const ei = of(initiator, "established")[0]!;
    const er = of(responder, "established")[0]!;
    expect(ei.localIndex).toBe(0);
    expect(er.localIndex).toBe(1);
    expect(ei.helloAuthenticated).toBe(false);
    expect(Array.from(er.remoteStatic)).toEqual(Array.from(k.aPub));
    await initiator.ch.sendRecord(0x0100, utf8("hi"));
    await pump(initiator, responder);
    expect(of(responder, "record")[0]).toMatchObject({ recordType: 0x0100 });
    // Local-link sessions never carry the pairing records.
    await expect(
      initiator.ch.sendRecord(RECORD.CONFIRM, utf8("{}")),
    ).resolves.toBeUndefined();
    await pump(initiator, responder);
    expect(closed(responder)).toMatchObject({ code: "peer_not_allowed" });
  });

  it("a peer key that is not the stored one ends the session peer_revoked and sends nothing", async () => {
    const { lj } = await links();
    const k = await pairOfKeys();
    const other = await pairOfKeys();
    const initiator = side({
      mode: "l",
      role: "initiator",
      locals: [link(lj.secret, k.a, other.aPub)],
    });
    const responder = side({
      mode: "l",
      role: "responder",
      locals: [link(lj.secret, k.b, k.aPub)],
      admission: new HandshakeLimiter(),
    });
    await initiator.ch.start();
    await pump(initiator, responder);
    expect(closed(initiator)).toMatchObject({ code: "peer_revoked" });
    expect(of(initiator, "established")).toHaveLength(0);
  });

  it("another link's secret opens nothing: the responder closes silently", async () => {
    const k = await pairOfKeys();
    const initiator = side({
      mode: "l",
      role: "initiator",
      locals: [link(rnd(), k.a, k.bPub)],
    });
    const responder = side({
      mode: "l",
      role: "responder",
      locals: [link(rnd(), k.b, k.aPub)],
      admission: new HandshakeLimiter(),
    });
    await initiator.ch.start();
    await pump(initiator, responder);
    expect(closed(responder)).toMatchObject({ code: "handshake_failed" });
    expect(responder.out).toHaveLength(0);
  });

  it("the shared listener tries local links after its contacts, behind the limiter", async () => {
    const { lj } = await links();
    const k = await pairOfKeys();
    const locals = [0, 1].map(() => link(rnd(), rnd(), rnd()));
    const mine = link(lj.secret, k.b, k.aPub);
    const mk = (admission: HandshakeLimiter) =>
      side({
        mode: "c",
        role: "responder",
        contacts: [{ secret: rnd(), agreeKey: "x".repeat(43) }],
        locals: [...locals, mine],
        admission,
        staticKey: rnd(),
      });
    const init = () =>
      side({
        mode: "l",
        role: "initiator",
        locals: [link(lj.secret, k.a, k.bPub)],
      });
    const ok = mk(new HandshakeLimiter());
    const i1 = init();
    await i1.ch.start();
    await pump(i1, ok);
    expect(of(ok, "established")[0]!.localIndex).toBe(2);

    const busy = mk(new HandshakeLimiter(0));
    const i2 = init();
    await i2.ch.start();
    await pump(i2, busy);
    expect(closed(busy)).toMatchObject({ code: "peer_busy" });
    expect(of(busy, "established")).toHaveLength(0);
  });

  describe("a listener with no account key: the source group's budget first (§15.10)", () => {
    // One initiator holding a link that the responder either holds (`opens`) or does not.
    async function attempt(
      limiter: HandshakeLimiter,
      group: string | undefined,
      opens: boolean,
    ) {
      const k = await pairOfKeys();
      const secret = rnd();
      const initiator = side({
        mode: "l",
        role: "initiator",
        locals: [link(secret, k.a, k.bPub)],
      });
      let tries = 0;
      const ports = {
        ...webCryptoNoisePorts,
        aead: {
          ...webCryptoNoisePorts.aead,
          open: (...a: Parameters<typeof webCryptoNoisePorts.aead.open>) => {
            tries++;
            return webCryptoNoisePorts.aead.open(...a);
          },
        },
      };
      const responder = side({
        mode: "l",
        role: "responder",
        locals: [link(opens ? secret : rnd(), k.b, k.aPub)],
        admission: limiter,
        ports,
        ...(group !== undefined ? { admissionGroup: group } : {}),
      });
      await initiator.ch.start();
      await pump(initiator, responder);
      return { responder, tries: () => tries };
    }
    const clock = () => {
      const c = { t: 0 };
      return { c, limiter: new HandshakeLimiter(5, 4, () => c.t) };
    };

    it("a group that sent two message 1s is refused the third before any secret is tried; another group is not", async () => {
      const { c, limiter } = clock();
      for (const t of [0, 1]) {
        c.t = t;
        const r = await attempt(limiter, "g1", false);
        expect(closed(r.responder)).toMatchObject({ code: "handshake_failed" });
      }
      c.t = 2;
      const third = await attempt(limiter, "g1", true);
      expect(closed(third.responder)).toMatchObject({ code: "peer_busy" });
      expect(third.tries()).toBe(0);
      const other = await attempt(limiter, "g2", true);
      expect(of(other.responder, "established")).toHaveLength(1);
      // The window slides: a minute on, the group is heard again.
      c.t = 70;
      const later = await attempt(limiter, "g1", true);
      expect(of(later.responder, "established")).toHaveLength(1);
    });

    it("a trial that opens is not counted against the group, and only a failed trial spends the shared budget", async () => {
      const { c, limiter } = clock();
      // Three opening attempts from one group inside a minute (a group allows two failures).
      for (let i = 0; i < 3; i++) {
        c.t = i;
        const r = await attempt(limiter, "g1", true);
        expect(of(r.responder, "established")).toHaveLength(1);
      }
      // Five groups, one failure each, use the shared budget; a sixth is refused behind it.
      for (let i = 0; i < 5; i++) {
        c.t = 10 + i;
        const r = await attempt(limiter, `f${i}`, false);
        expect(closed(r.responder)).toMatchObject({ code: "handshake_failed" });
      }
      c.t = 20;
      const six = await attempt(limiter, "f5", true);
      expect(closed(six.responder)).toMatchObject({ code: "peer_busy" });
      expect(six.tries()).toBe(0);
    });

    it("one group can use two of the shared five, not all of it", async () => {
      const { c, limiter } = clock();
      for (let i = 0; i < 6; i++) {
        c.t = i;
        await attempt(limiter, "noisy", false);
      }
      c.t = 7;
      const legit = await attempt(limiter, "quiet", true);
      expect(of(legit.responder, "established")).toHaveLength(1);
    });

    it("without a group the shared limiter counts the attempt as before", async () => {
      const { c, limiter } = clock();
      for (let i = 0; i < 5; i++) {
        c.t = i;
        await attempt(limiter, undefined, true);
      }
      c.t = 6;
      const r = await attempt(limiter, undefined, true);
      expect(closed(r.responder)).toMatchObject({ code: "peer_busy" });
    });
  });

  it("refuses constructions that name no link, too many links or no limiter", () => {
    const l = link(rnd(), rnd(), rnd());
    const mk =
      (o: Partial<ConstructorParameters<typeof PeerChannel>[0]>) => () =>
        side({ mode: "l", role: "initiator", ...o });
    expect(mk({})).toThrow(RangeError);
    expect(mk({ locals: [l, l] })).toThrow(RangeError);
    expect(mk({ role: "responder", locals: [l] })).toThrow(RangeError);
    expect(
      mk({
        role: "responder",
        locals: Array.from({ length: MAX_LOCAL_LINKS + 1 }, () => l),
        admission: new HandshakeLimiter(),
      }),
    ).toThrow(RangeError);
    expect(mk({ locals: [{ ...l, secret: new Uint8Array(31) }] })).toThrow(
      RangeError,
    );
  });
});
