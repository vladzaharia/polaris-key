// @pkey-feature connect.local
// The kit API of pairing with a code (CC-29.15; WIRE-CONTRACT-V5 §15.12): what a host needs to draw
// the "Pair with a Code" screens. Two clients with no credential on 127.0.0.1 over an in-process
// mDNS network, with the windows' clocks and random sources injected, cover the shower (the code's
// reason, expiry and failures, `renew()`, `onInterrupted`, `onEnd`), the joiner (the reason of a
// `pairing-code-failed`, `dialsLeft`, cancel, the reason of a `peer-closed`) and the list
// (`onChange`, the gate, the stored platform, the cap, management that is never gated).
import { createServer, connect, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedError } from "@polaris-key/client-core";
import {
  advertEpoch,
  encodeFrame,
  makeQr,
  pairingInstance,
  productTag,
} from "@polaris-key/client-core/peer";
import { base64UrlDecode } from "@polaris-key/jws";
import type { PolarisKeyClient } from "../../src/client.js";
import { PLATFORM_VALUES } from "../../src/constants.generated.js";
import {
  LocalPairingError,
  type LocalCode,
  type LocalOffer,
  type LocalPairHandle,
  type LocalPaired,
} from "../../src/connect/index.js";
import { resetLocalBudgets } from "../../src/connect/localLinks.js";
import { localTag, type LocalLinkStore } from "../../src/connect/localState.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  PRODUCT,
  T0,
  makeClient,
  until,
} from "../lanFixtures.js";
import { tmpDir } from "../lanFixtures.js";

// Wraps the CPace calls the joiner makes so a test can see their secrets and act when one returns.
const spy = vi.hoisted(() => ({
  made: {} as Record<string, Uint8Array[]>,
  after: {} as Record<string, (() => void) | undefined>,
  isk: new Set<Uint8Array>(),
}));
vi.mock("@polaris-key/client-core/peer", async (orig) => {
  const m = await orig<typeof import("@polaris-key/client-core/peer")>();
  const note = (name: string, v: Uint8Array | null): void => {
    if (v === null) return;
    (spy.made[name] ??= []).push(v);
  };
  return {
    ...m,
    cpaceScalar: (...a: Parameters<typeof m.cpaceScalar>) => {
      const v = m.cpaceScalar(...a);
      note("cpaceScalar", v);
      return v;
    },
    cpaceGenerator: async (...a: Parameters<typeof m.cpaceGenerator>) => {
      const v = await m.cpaceGenerator(...a);
      note("cpaceGenerator", v);
      spy.after.cpaceGenerator?.();
      return v;
    },
    cpaceIsk: async (...a: Parameters<typeof m.cpaceIsk>) => {
      const v = await m.cpaceIsk(...a);
      if (a[0].role === "initiator" && v !== null) {
        spy.isk.add(v);
        note("cpaceIsk", v);
      }
      return v;
    },
    cpacePsk: async (...a: Parameters<typeof m.cpacePsk>) => {
      const v = await m.cpacePsk(...a);
      if (spy.isk.has(a[0])) {
        note("cpacePsk", v);
        spy.after.cpacePsk?.();
      }
      return v;
    },
  };
});

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

let dirs: string[] = [];
let clients: PolarisKeyClient[] = [];
let handles: LocalPairHandle[] = [];
let servers: Server[] = [];
let sockets: Socket[] = [];

beforeEach(() => {
  resetLocalBudgets();
  spy.made = {};
  spy.after = {};
  spy.isk.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});
afterEach(async () => {
  const stops = handles.splice(0).map((h) => h.stop().catch(() => undefined));
  await Promise.all(stops);
  const ends: { destroy?(): void; close?(): void }[] = [
    ...sockets.splice(0),
    ...servers.splice(0),
    ...clients.splice(0),
  ];
  for (const e of ends) (e.destroy ?? e.close)?.call(e);
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world(localPairing = true) {
  const worker = new MultiWorker();
  worker.localPairing = localPairing;
  const [a, b] = await Promise.all(
    ["1", "2"].map((n) => makeClient(worker, n, dirs, { noToken: true })),
  );
  clients.push(a!, b!);
  for (const c of [a!, b!]) await c.discover();
  return { worker, a: a!, b: b!, net: new MemoryMdnsNetwork() };
}
type World = Awaited<ReturnType<typeof world>>;

/** A timer that holds the timers whose length `held` accepts, and lets the test fire them. */
function heldTimers(held: (ms: number) => boolean) {
  const all: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    timer: (fn: () => void, ms: number): (() => void) => {
      if (held(ms)) {
        const t = { fn, ms, live: true };
        all.push(t);
        return () => {
          t.live = false;
        };
      }
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    fire(): void {
      for (const t of all.splice(0))
        if (t.live) {
          t.live = false;
          t.fn();
        }
    },
  };
}

/** Byte draws of one: the scripted nameplate bytes first. Everything else is real randomness. */
const scripted =
  (bytes: number[]) =>
  (n: number): Uint8Array =>
    n === 1 && bytes.length > 0
      ? Uint8Array.of(bytes.shift()!)
      : globalThis.crypto.getRandomValues(new Uint8Array(n));

interface Shown {
  codes: LocalCode[];
  offers: LocalOffer[];
  linked: LocalPaired[];
  failed: string[];
  ends: string[];
  interrupted: number[];
  handle: LocalPairHandle;
}

const collect = (s: Shown) => ({
  onCode: (code: LocalCode) => void s.codes.push(code),
  onConfirm: (o: LocalOffer) => void s.offers.push(o),
  onLinked: (l: LocalPaired) => void s.linked.push(l),
  onFailed: (f: { reason: string }) => void s.failed.push(f.reason),
  onEnd: (e: { reason: string }) => void s.ends.push(e.reason),
  onInterrupted: (n: number) => void s.interrupted.push(n),
});

async function show(
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  extra: Record<string, unknown> = {},
): Promise<Shown> {
  const s = {
    codes: [],
    offers: [],
    linked: [],
    failed: [],
    ends: [],
    interrupted: [],
  } as unknown as Shown;
  const pairing = {
    categories: ["notes"],
    label: "Ana",
    mdns: net.adapter(),
    ...LOOP,
    ...collect(s),
    ...extra,
  };
  s.handle = await c.cloudConnect.localLinks.pair(pairing);
  handles.push(s.handle);
  return s;
}

function dial(
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  how: { code: string } | { qr: string },
  seen: LocalOffer[] = [],
  extra: Record<string, unknown> = {},
) {
  const joining = {
    categories: ["notes"],
    label: "Bo",
    mdns: net.adapter(),
    ...LOOP,
    ...how,
    onConfirm: (o: LocalOffer) => void seen.push(o),
    ...extra,
  };
  return c.cloudConnect.localLinks.join(joining);
}

const advertOf = (net: MemoryMdnsNetwork) =>
  [...net.adverts.values()].find((a) => a.txt.includes("m=q"))!;
const qrAdverts = (net: MemoryMdnsNetwork) =>
  [...net.adverts.values()].filter((a) => a.txt.includes("m=q"));

/** One counted wrong guess: the joiner hears `wrong`, the window rotates. */
const wrongGuess = async (w: World, fill = 7): Promise<void> => {
  const qr = makeQr(
    PRODUCT,
    advertOf(w.net).instance,
    new Uint8Array(16).fill(fill),
  );
  await expect(dial(w.b, w.net, { qr })).rejects.toMatchObject({
    code: "pairing-code-failed",
    reason: "wrong",
  });
};

const wrongPassword = (code: string): string => {
  const digits = code.replace(" ", "");
  return digits.slice(0, -1) + (digits.endsWith("0") ? "1" : "0");
};

async function pairUp(
  w: World,
  s: Shown,
  how: { code: string } | { qr: string },
) {
  const offersB: LocalOffer[] = [];
  const before = s.offers.length;
  const joined = dial(w.b, w.net, how, offersB);
  await until(() => s.offers.length === before + 1 && offersB.length === 1);
  await Promise.all([s.offers[before]!.confirm(), offersB[0]!.confirm()]);
  const mine = await joined;
  await until(() => s.linked.length === 1);
  return mine;
}

/** A connection that sends a first message the window refuses; resolves when it has closed. */
async function junk(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const s = connect(port, "127.0.0.1", () =>
      s.write(encodeFrame(Uint8Array.of(1, 2, 3))),
    );
    s.on("error", () => undefined);
    s.on("close", () => resolve());
  });
}

const bytes = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const addLink = (st: LocalLinkStore, i: number, platform?: string) =>
  st.add({
    ownKey: bytes(32, 1),
    ownPublic: bytes(32, 2),
    peerKey: Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i : 9)),
    secret: bytes(32, 4),
    cats: [],
    now: T0,
    ...(platform !== undefined ? { platform } : {}),
  });

/** A join of nameplate 48 that dials a dead advert: it spends one dial and finds nothing. */
const deadJoin = (w: World) =>
  expect(
    dial(w.b, w.net, { code: "4812 3456" }, [], { browseSeconds: 0.2 }),
  ).rejects.toMatchObject({ code: "pairing-not-found" });

describe("the shower: the code, the window and renew()", () => {
  it("a code says why it is on show, when the window ends and how many guesses were counted", async () => {
    const w = await world();
    const hold = heldTimers((ms) => ms > 100_000 && ms <= 120_000);
    const s = await show(w.a, w.net, { seconds: 299, timer: hold.timer });
    const first = s.codes[0]!;
    expect(first).toMatchObject({
      reason: "opened",
      failures: 0,
      expiresAt: T0 + 299,
    });

    // A counted wrong guess.
    await wrongGuess(w);
    await until(() => s.codes.length === 2);
    expect(s.codes[1]).toMatchObject({
      reason: "wrong-code",
      failures: 1,
      expiresAt: T0 + 299,
    });
    expect(s.codes[1]!.code).not.toBe(first.code);

    // This person declined: the guess was refunded, the count stays.
    let offersB: LocalOffer[] = [];
    let joined = dial(w.b, w.net, { code: s.codes[1]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => s.offers.length === 1 && offersB.length === 1);
    await s.offers[0]!.decline();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "declined",
    });
    await until(() => s.codes.length === 3);
    expect(s.codes[2]).toMatchObject({ reason: "declined", failures: 1 });

    // The other device went away at the consent: any other end.
    offersB = [];
    const abort = new AbortController();
    joined = dial(w.b, w.net, { qr: s.codes[2]!.qr }, offersB, {
      signal: abort.signal,
    });
    joined.catch(() => undefined);
    await until(() => s.offers.length === 2 && offersB.length === 1);
    abort.abort();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "cancelled",
    });
    await until(() => s.codes.length === 4);
    expect(s.codes[3]).toMatchObject({ reason: "closed", failures: 1 });

    // The consent ran out.
    offersB = [];
    joined = dial(w.b, w.net, { qr: s.codes[3]!.qr }, offersB);
    joined.catch(() => undefined);
    await until(() => s.offers.length === 3 && offersB.length === 1);
    hold.fire();
    await until(() => s.codes.length === 5);
    expect(s.codes[4]).toMatchObject({ reason: "timeout", failures: 1 });
    expect(s.failed).toEqual(["declined", "closed", "timeout"]);
    await joined.catch(() => undefined);
    // Nothing above ended the window.
    expect(s.ends).toEqual([]);
  });

  it("renew() opens a window that is new in every respect and never reuses a recent nameplate", async () => {
    const w = await world();
    let now = 1000;
    const bytes = [48];
    const s = await show(w.a, w.net, {
      mono: () => now,
      random: scripted(bytes),
    });
    const first = s.codes[0]!;
    expect(first.nameplate).toBe("48");
    const firstAdvert = advertOf(w.net);

    // A wrong guess first: the count is not carried over.
    await wrongGuess(w);
    await until(() => s.codes.length === 2);
    expect(s.codes[1]!.failures).toBe(1);

    // 48 is drawn first and skipped, then 55 is taken.
    bytes.push(48, 55);
    const second = await s.handle.renew();
    expect(bytes).toEqual([]);
    expect(second.nameplate).toBe("55");
    expect(second).toMatchObject({ reason: "opened", failures: 0 });
    expect(s.handle.code()).toBe(second);
    expect(s.handle.open).toBe(true);
    // One advert: the new window's, under another instance.
    expect(qrAdverts(w.net)).toHaveLength(1);
    expect(advertOf(w.net).instance).not.toBe(firstAdvert.instance);
    // The replaced window made no onEnd, and its code is gone with it.
    expect(s.ends).toEqual([]);
    await expect(
      dial(w.b, w.net, { qr: s.codes[0]!.qr }, [], { browseSeconds: 0.05 }),
    ).rejects.toMatchObject({ code: "pairing-not-found" });

    // Both closed windows are held for 300 s.
    bytes.push(48, 55, 12);
    expect((await s.handle.renew()).nameplate).toBe("12");
    // Past 300 s the first is free again.
    now += 301;
    bytes.push(48);
    expect((await s.handle.renew()).nameplate).toBe("48");
    expect(bytes).toEqual([]);
    expect(s.ends).toEqual([]);
    // The new window pairs, and its end is told once.
    await pairUp(w, s, { code: s.handle.code()!.code });
    await until(() => s.ends.length === 1);
    expect(s.ends).toEqual(["stored"]);
  });

  it("renew() works on a closed handle and refuses what pair refuses", async () => {
    const w = await world();
    const s = await show(w.a, w.net);
    await s.handle.stop();
    expect(s.handle.open).toBe(false);
    expect(s.handle.code()).toBeNull();
    expect(s.ends).toEqual(["person"]);
    const c = await s.handle.renew();
    expect(c.reason).toBe("opened");
    expect(s.handle.open).toBe(true);

    // The slot is kept while it renews: another pair() is refused, two renews share one window.
    const one = s.handle.renew();
    const two = s.handle.renew();
    await expect(show(w.a, w.net)).rejects.toMatchObject({
      code: "invalid-argument",
    });
    expect(await one).toBe(await two);
    expect(qrAdverts(w.net)).toHaveLength(1);

    // Another handle's window blocks it.
    await s.handle.stop();
    const other = await show(w.a, w.net);
    await expect(s.handle.renew()).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await other.handle.stop();

    // The cap: 32 links held, nothing is advertised.
    const store = w.a.connect.localStore();
    for (let i = 0; i < 32; i++) await addLink(store, i);
    await expect(s.handle.renew()).rejects.toMatchObject({
      code: "local-links-full",
      cap: "stored",
    });
    expect(qrAdverts(w.net)).toEqual([]);
  });

  it("renew() is refused with the typed N/A while the gate is off", async () => {
    const w = await world();
    const s = await show(w.a, w.net);
    w.worker.localPairing = false;
    await w.a.discover();
    await until(() => !s.handle.open);
    await expect(s.handle.renew()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(s.handle.renew()).rejects.toMatchObject({
      code: "local-pairing-off",
    });
    expect(qrAdverts(w.net)).toEqual([]);
  });

  it("onInterrupted counts connections closed without a guess and starts again with a code or a consent", async () => {
    const w = await world();
    let now = 1000;
    const s = await show(w.a, w.net, { mono: () => now });
    const port = advertOf(w.net).port;
    for (let i = 0; i < 3; i++) {
      await junk(port);
      now += 1;
    }
    await until(() => s.interrupted.length >= 3);
    expect(s.interrupted.slice(0, 3)).toEqual([1, 2, 3]);
    expect(s.codes).toHaveLength(1);
    // A counted guess is not an interruption.
    const seen = s.interrupted.length;
    await wrongGuess(w);
    await until(() => s.codes.length === 2);
    expect(s.interrupted).toHaveLength(seen);

    // The next code starts the count again.
    await junk(port);
    await until(() => s.interrupted.length === seen + 1);
    expect(s.interrupted.at(-1)).toBe(1);

    // A consent does too: the first refusal while it is up is the first one again. (The window
    // admits five first messages a minute: a minute later it takes the next.)
    now += 61;
    const offersB: LocalOffer[] = [];
    const joined = dial(w.b, w.net, { code: s.codes[1]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => s.offers.length === 1 && offersB.length === 1);
    await junk(port);
    await until(() => s.interrupted.length === seen + 2);
    expect(s.interrupted.at(-1)).toBe(1);
    await s.offers[0]!.decline();
    await joined.catch(() => undefined);
  });

  it("onEnd says once why the window ended, after its advert is withdrawn", async () => {
    // expired
    const w = await world();
    const hold = heldTimers((ms) => ms === 299_000);
    let advertsAtEnd = -1;
    const expired = await show(w.a, w.net, {
      seconds: 299,
      timer: hold.timer,
      onEnd: (e: { reason: string }) => {
        advertsAtEnd = qrAdverts(w.net).length;
        expired.ends.push(e.reason);
      },
    });
    hold.fire();
    await until(() => expired.ends.length === 1);
    expect(expired.ends).toEqual(["expired"]);
    expect(advertsAtEnd).toBe(0);
    expect(expired.handle.open).toBe(false);

    // person, and a second stop() says nothing more
    const person = await show(w.a, w.net);
    await person.handle.stop();
    await person.handle.stop();
    expect(person.ends).toEqual(["person"]);

    // too-many-tries: the fifth counted guess (the clock is injected: the renewal floor follows it)
    const tries = await show(w.a, w.net, { mono: () => 1000 });
    for (let i = 0; i < 5; i++) {
      await until(() => tries.codes.length === i + 1 || !tries.handle.open);
      if (!tries.handle.open) break;
      await wrongGuess(w, i + 1);
    }
    await until(() => tries.ends.length === 1);
    expect(tries.ends).toEqual(["too-many-tries"]);
    expect(tries.failed).toEqual(["too-many-tries"]);

    // stored: a link was made
    const stored = await show(w.a, w.net, { mono: () => 2000 });
    await pairUp(w, stored, { code: stored.codes[0]!.code });
    await until(() => stored.ends.length === 1);
    expect(stored.ends).toEqual(["stored"]);

    // off: the product turned pairing off
    const w2 = await world();
    const off = await show(w2.a, w2.net, {
      mono: () => 2000,
      onEnd: (e: { reason: string }) => {
        advertsAtEnd = qrAdverts(w2.net).length;
        off.ends.push(e.reason);
      },
    });
    w2.worker.localPairing = false;
    await w2.a.discover();
    await until(() => off.ends.length === 1);
    expect(off.ends).toEqual(["off"]);
    expect(advertsAtEnd).toBe(0);
  });
});

describe("the shower: stop() against a renewal, the floor, the draw and the interruptions", () => {
  /** An mdns whose advertise waits while `gate.hold` is set, so a window can be caught opening. */
  function slowMdns(net: MemoryMdnsNetwork) {
    const base = net.adapter();
    const gate = {
      hold: null as Promise<void> | null,
      reached: 0,
      release: (): void => undefined,
    };
    return {
      gate,
      mdns: {
        browse: base.browse,
        advertise: async (a: Parameters<typeof base.advertise>[0]) => {
          if (gate.hold !== null) {
            gate.reached++;
            await gate.hold;
          }
          return base.advertise(a);
        },
      },
      holdNext(): void {
        gate.reached = 0;
        gate.hold = new Promise<void>((r) => {
          gate.release = () => {
            gate.hold = null;
            r();
          };
        });
      },
    };
  }

  /** Five counted wrong guesses: the window ends `too-many-tries`. */
  async function exhaust(w: World, s: Shown): Promise<void> {
    for (let i = 1; i <= 5 && s.handle.open; i++) {
      await until(() => s.codes.length === i || !s.handle.open);
      if (s.handle.open) await wrongGuess(w, i);
    }
    await until(() => s.ends.length === 1);
  }

  it("stop() while renew() is opening a window leaves no window, no advert and no code", async () => {
    const w = await world();
    const slow = slowMdns(w.net);
    const s = await show(w.a, w.net, { mdns: slow.mdns });
    slow.holdNext();
    const renewing = s.handle.renew();
    renewing.catch(() => undefined);
    await until(() => slow.gate.reached === 1);
    const stopping = s.handle.stop();
    slow.gate.release();
    await stopping;
    await expect(renewing).rejects.toThrow("The window closed.");
    expect(s.handle.open).toBe(false);
    expect(s.handle.code()).toBeNull();
    expect(qrAdverts(w.net)).toEqual([]);
    // The new window was never shown.
    expect(s.codes).toHaveLength(1);
    expect(s.ends).toEqual(["person"]);
  });

  it("no code is shown for a window that closes off while it opens", async () => {
    const w = await world();
    const slow = slowMdns(w.net);
    const codes: LocalCode[] = [];
    const ends: string[] = [];
    slow.holdNext();
    const pairing = w.a.cloudConnect.localLinks.pair({
      categories: ["notes"],
      mdns: slow.mdns,
      ...LOOP,
      onCode: (c) => void codes.push(c),
      onConfirm: () => undefined,
      onEnd: (e) => void ends.push(e.reason),
    });
    pairing.catch(() => undefined);
    await until(() => slow.gate.reached === 1);
    w.worker.localPairing = false;
    await w.a.discover();
    slow.gate.release();
    await expect(pairing).rejects.toMatchObject({ code: "local-pairing-off" });
    expect(codes).toEqual([]);
    expect(ends).toEqual(["off"]);
    expect(qrAdverts(w.net)).toEqual([]);
  });

  it("after too-many-tries pair() and renew() are refused for 30 s with cooldown", async () => {
    const w = await world();
    let now = 1000;
    const s = await show(w.a, w.net, { mono: () => now });
    await exhaust(w, s);
    expect(s.ends).toEqual(["too-many-tries"]);

    now += 10;
    const refused = { code: "peer-closed", reason: "cooldown" };
    await expect(s.handle.renew()).rejects.toMatchObject(refused);
    await expect(show(w.a, w.net, { mono: () => now })).rejects.toMatchObject(
      refused,
    );
    expect(qrAdverts(w.net)).toEqual([]);
    now += 19;
    await expect(s.handle.renew()).rejects.toMatchObject(refused);
    now += 1;
    expect((await s.handle.renew()).reason).toBe("opened");
  });

  it("the second window that ends after a wrong guess within 10 minutes starts the cooldown; one does not", async () => {
    const w = await world();
    let now = 1000;
    const s = await show(w.a, w.net, { mono: () => now });
    await wrongGuess(w);
    await until(() => s.codes.length === 2);
    // The first such window: the renewal opens.
    now += 100;
    expect((await s.handle.renew()).failures).toBe(0);
    await wrongGuess(w, 8);
    await until(() => s.codes.length === 4);
    now += 100;
    // The second ends: the renewal is refused and the window is gone.
    await expect(s.handle.renew()).rejects.toMatchObject({
      code: "peer-closed",
      reason: "cooldown",
    });
    expect(s.handle.open).toBe(false);
    now += 30;
    expect((await s.handle.renew()).reason).toBe("opened");
  });

  it("a window with no failed guess never starts the cooldown", async () => {
    const w = await world();
    let now = 1000;
    const s = await show(w.a, w.net, { mono: () => now });
    for (let i = 0; i < 4; i++) {
      now += 1;
      await s.handle.renew();
    }
    expect(s.handle.open).toBe(true);
  });

  it("the nameplate draw ignores adverts other windows show", async () => {
    const w = await world();
    const tag = await productTag(PRODUCT, advertEpoch(T0));
    await w.net.adapter().advertise({
      instance: "p1-0123456789abcdef",
      port: 9,
      txt: ["v=1", "m=q", `h=${tag}`, "n=48"],
    });
    const s = await show(w.a, w.net, { random: scripted([48]) });
    expect(s.codes[0]!.nameplate).toBe("48");
  });

  it("onInterrupted is told at most once a second while the count goes on", async () => {
    const clock = { now: 1000 };
    const w = await world();
    const s = await show(w.a, w.net, { mono: () => clock.now });
    const port = advertOf(w.net).port;
    for (let i = 0; i < 4; i++) await junk(port);
    await until(() => s.interrupted.length >= 1);
    // A flood inside one second: the first is told and the rest are counted.
    expect(s.interrupted).toEqual([1]);
    clock.now += 1;
    await junk(port);
    await until(() => s.interrupted.length === 2);
    expect(s.interrupted).toEqual([1, 5]);
  });
});

describe("the joiner: reasons, dialsLeft and cancel", () => {
  /** A made-up advert at a port nothing listens on: a dial of it ends before the answer. */
  async function deadAdvert(
    w: World,
    nameplate: string,
    i: number,
  ): Promise<void> {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const tag = await productTag(PRODUCT, advertEpoch(T0));
    await w.net.adapter().advertise({
      instance: pairingInstance(new Uint8Array(10).fill(i + 1)),
      port,
      txt: ["v=1", "m=q", `h=${tag}`, `n=${nameplate}`],
    });
  }

  it("pairing-code-failed carries why: invalid, other-app, spent, wrong", async () => {
    const w = await world();
    const l = w.b.cloudConnect.localLinks;
    const reasonOf = async (p: Promise<unknown>) => {
      const e: unknown = await p.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LocalPairingError);
      expect(e).toMatchObject({ code: "pairing-code-failed" });
      return (e as LocalPairingError).reason;
    };
    expect(await reasonOf(dial(w.b, w.net, { code: "1234 567" }))).toBe(
      "invalid",
    );
    expect(
      await reasonOf(
        dial(w.b, w.net, {
          qr: makeQr(
            "other",
            pairingInstance(new Uint8Array(10).fill(3)),
            new Uint8Array(16).fill(5),
          ),
        }),
      ),
    ).toBe("other-app");

    const s = await show(w.a, w.net);
    const bad = wrongPassword(s.codes[0]!.code);
    // A dial that ended after the other device answered.
    expect(
      await reasonOf(
        dial(w.b, w.net, { code: bad }, [], { browseSeconds: 0.05 }),
      ),
    ).toBe("wrong");
    await until(() => s.codes.length === 2);
    expect(l.dialsLeft(bad)).toBe(1);
    expect(
      await reasonOf(
        dial(w.b, w.net, { code: wrongPassword(s.codes[1]!.code) }, [], {
          browseSeconds: 0.05,
        }),
      ),
    ).toBe("wrong");
    // Both dials are spent: the next join answers at once.
    expect(l.dialsLeft(bad)).toBe(0);
    expect(await reasonOf(dial(w.b, w.net, { code: bad }))).toBe("spent");
  });

  it("a dial stopped by the budget in the middle of a join is spent; ones that all fail before the answer are not-found", async () => {
    const w = await world();
    const l = w.b.cloudConnect.localLinks;
    await deadAdvert(w, "48", 0);
    // One dial of 48 spent, nothing answered.
    await deadJoin(w);
    expect(l.dialsLeft("48")).toBe(1);

    // Two candidates now: the first dial spends the last one, the second is stopped by the budget.
    await deadAdvert(w, "48", 1);
    await expect(
      dial(w.b, w.net, { code: "4812 3456" }, [], { browseSeconds: 5 }),
    ).rejects.toMatchObject({
      code: "pairing-code-failed",
      reason: "spent",
    });
    expect(l.dialsLeft("48")).toBe(0);
  });

  it("dialsLeft reads two digits, keeps nothing and spends nothing", async () => {
    const w = await world();
    const l = w.b.cloudConnect.localLinks;
    expect(l.dialsLeft("")).toBeNull();
    expect(l.dialsLeft("4")).toBeNull();
    expect(l.dialsLeft("4 -")).toBeNull();
    expect(l.dialsLeft("ab12")).toBeNull();
    expect(l.dialsLeft("４８")).toBeNull();
    expect(l.dialsLeft(undefined as unknown as string)).toBeNull();
    expect(l.dialsLeft("48")).toBe(2);
    expect(l.dialsLeft("4-8 12")).toBe(2);
    expect(l.dialsLeft(" 48 1234 56")).toBe(2);
    for (let i = 0; i < 5; i++) l.dialsLeft("48");
    expect(l.dialsLeft("48")).toBe(2);

    await deadAdvert(w, "48", 0);
    await deadJoin(w);
    // The budget is the nameplate's: it is the same for every text that starts with 48.
    expect(l.dialsLeft("48")).toBe(1);
    expect(l.dialsLeft("4812 3456")).toBe(1);
    expect(l.dialsLeft("49")).toBe(2);
    // Another client of the product meets the same budget.
    expect(w.a.cloudConnect.localLinks.dialsLeft("48")).toBe(1);
  });

  it("cancel: an aborted signal rejects with peer-closed / cancelled, a QR join is not charged, a code join keeps its spent dial", async () => {
    const w = await world();
    const l = w.b.cloudConnect.localLinks;
    const done = new AbortController();
    done.abort();
    await expect(
      dial(w.b, w.net, { code: "4812 3456" }, [], { signal: done.signal }),
    ).rejects.toMatchObject({ code: "peer-closed", reason: "cancelled" });
    expect(l.dialsLeft("48")).toBe(2);

    // While browsing: no advert, a long browse, the abort ends it at once.
    const during = new AbortController();
    const waiting = dial(w.b, w.net, { code: "4812 3456" }, [], {
      signal: during.signal,
    });
    waiting.catch(() => undefined);
    during.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "peer-closed",
      reason: "cancelled",
    });

    // At the consent: the dial was spent, the key material is wiped and nothing is stored.
    const s = await show(w.a, w.net);
    const drawn: Uint8Array[] = [];
    const abort = new AbortController();
    const offersB: LocalOffer[] = [];
    const joined = dial(w.b, w.net, { code: s.codes[0]!.code }, offersB, {
      signal: abort.signal,
      random: (n: number) => {
        const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
        drawn.push(b);
        return b;
      },
    });
    joined.catch(() => undefined);
    await until(() => offersB.length === 1);
    expect(drawn.some((b) => b.length === 32 && b.some((x) => x !== 0))).toBe(
      true,
    );
    abort.abort();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "cancelled",
    });
    await until(() => drawn.every((b) => b.every((x) => x === 0)));
    expect(l.dialsLeft(s.codes[0]!.code)).toBe(1);
    expect(await l.list()).toEqual([]);
  });

  it("a peer-closed carries why: declined by the other device, timeout, closed", async () => {
    const w = await world();
    // The other device declined: its window sent peer_bye before any link.
    const s = await show(w.a, w.net);
    let offersB: LocalOffer[] = [];
    let joined = dial(w.b, w.net, { code: s.codes[0]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => s.offers.length === 1 && offersB.length === 1);
    await s.offers[0]!.decline();
    const e: unknown = await joined.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalPairingError);
    expect(e).toMatchObject({ code: "peer-closed", reason: "declined" });
    await s.handle.stop();

    // This person declined.
    const s2 = await show(w.a, w.net);
    offersB = [];
    joined = dial(w.b, w.net, { code: s2.codes[0]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => offersB.length === 1);
    await offersB[0]!.decline();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "declined",
    });
    await s2.handle.stop();

    // The consent ran out on this side.
    const s3 = await show(w.a, w.net);
    const hold = heldTimers((ms) => ms > 100_000 && ms <= 120_000);
    offersB = [];
    joined = dial(w.b, w.net, { code: s3.codes[0]!.code }, offersB, {
      timer: hold.timer,
    });
    joined.catch(() => undefined);
    await until(() => offersB.length === 1);
    hold.fire();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "timeout",
    });
    await s3.handle.stop();

    // The connection dropped at the consent: through a proxy that cuts it.
    const s4 = await show(w.a, w.net);
    const real = advertOf(w.net);
    const realPort = real.port;
    const cut: Socket[] = [];
    const proxy = createServer((c) => {
      const u = connect(realPort, "127.0.0.1");
      cut.push(c, u);
      sockets.push(c, u);
      c.pipe(u);
      u.pipe(c);
      c.on("error", () => undefined);
      u.on("error", () => undefined);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    real.port = (proxy.address() as { port: number }).port;
    offersB = [];
    joined = dial(w.b, w.net, { code: s4.codes[0]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => offersB.length === 1);
    for (const c of cut) c.destroy();
    await expect(joined).rejects.toMatchObject({
      code: "peer-closed",
      reason: "closed",
    });
  });
});

describe("the list: onChange, the gate, the platform, the cap", () => {
  it("onChange fires after a pairing is stored, rename, setReachable, a sighting and remove, and not after unsubscribing", async () => {
    const w = await world();
    const l = w.a.cloudConnect.localLinks;
    let n = 0;
    const off = l.onChange(() => n++);
    const s = await show(w.a, w.net);
    await pairUp(w, s, { code: s.codes[0]!.code });
    expect(n).toBeGreaterThanOrEqual(1);
    const [row] = await l.list();
    const mark = (): number => (n = 0);

    mark();
    expect(await l.rename(row!.id, "Kitchen")).toBe(true);
    expect(n).toBe(1);
    mark();
    expect(await l.setReachable(row!.id, false)).toBe(true);
    expect(n).toBe(1);
    mark();
    // A sighting writes the hour of the last session, once an hour.
    const [held] = await w.a.connect.localStore().rows();
    const ref = {
      id: held!.id,
      label: null,
      categories: [],
      peerKey: held!.peerKey,
      tag: localTag(base64UrlDecode(held!.secret)),
    };
    await w.a.connect.touchLocal(ref);
    expect(n).toBe(1);
    await w.a.connect.touchLocal(ref);
    expect(n).toBe(1);
    expect((await l.list())[0]!.lastSeen).not.toBeNull();
    // Nothing changed: no event.
    mark();
    expect(await l.rename("nope-nope-nope-no", "x")).toBe(false);
    expect(n).toBe(0);
    expect(await l.remove(row!.id)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await l.list()).toEqual([]);
    mark();
    off();
    await addLink(w.a.connect.localStore(), 1);
    const [other] = await l.list();
    await l.rename(other!.id, "Again");
    expect(n).toBe(0);
  });

  it("the gate is readable and every flip is an event, in both directions", async () => {
    const w = await world();
    const l = w.a.cloudConnect.localLinks;
    const seen: boolean[] = [];
    l.onChange(() => seen.push(l.localPairing()));
    expect(l.localPairing()).toBe(true);
    w.worker.localPairing = false;
    await w.a.discover();
    expect(l.localPairing()).toBe(false);
    expect(seen.at(-1)).toBe(false);
    w.worker.localPairing = true;
    await w.a.discover();
    expect(seen.at(-1)).toBe(true);
    const n = seen.length;
    // A read that changes nothing is no event.
    await w.a.discover();
    expect(seen).toHaveLength(n);
  });

  it("a link keeps the other device's platform, and only a known spelling", async () => {
    const w = await world();
    const s = await show(w.a, w.net);
    await pairUp(w, s, { code: s.codes[0]!.code });
    const [mine] = await w.a.cloudConnect.localLinks.list();
    const [theirs] = await w.b.cloudConnect.localLinks.list();
    expect(PLATFORM_VALUES).toContain(mine!.platform);
    expect(PLATFORM_VALUES).toContain(theirs!.platform);
    // What each side stored is what the consent showed of the other.
    expect(mine!.platform).toBe(s.offers[0]!.platform);

    const store = w.a.connect.localStore();
    await addLink(store, 5, "plan9");
    await addLink(store, 6, "ios");
    const list = await w.a.cloudConnect.localLinks.list();
    expect(list.map((x) => x.platform).sort()).toEqual(
      [mine!.platform, null, "ios"].sort(),
    );
    // A stored member that is not a spelling is read as none; a member this reader does not know is ignored.
    await store.update((rows) =>
      rows.map((r, i) =>
        i === 0
          ? ({ ...r, platform: "toaster", extra: { a: 1 } } as typeof r)
          : r,
      ),
    );
    expect((await w.a.cloudConnect.localLinks.list())[0]!.platform).toBeNull();
  });

  it("local-links-full names the cap: stored at 32, reachable at 8", async () => {
    const w = await world();
    const l = w.a.cloudConnect.localLinks;
    const store = w.a.connect.localStore();
    for (let i = 0; i < 9; i++) await addLink(store, i);
    const ninth = (await l.list()).find((x) => !x.reachable)!;
    const e: unknown = await l
      .setReachable(ninth.id, true)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalPairingError);
    expect(e).toMatchObject({ code: "local-links-full", cap: "reachable" });
    for (let i = 9; i < 32; i++) await addLink(store, i);
    await expect(show(w.a, w.net)).rejects.toMatchObject({
      code: "local-links-full",
      cap: "stored",
    });
    await expect(dial(w.a, w.net, { code: "4812 3456" })).rejects.toMatchObject(
      { code: "local-links-full", cap: "stored" },
    );
  });

  it("list, rename, remove and setReachable are never gated, with the gate off or no cached document", async () => {
    for (const mode of ["off", "no-document"] as const) {
      const w = await world(mode === "off" ? false : true);
      const c =
        mode === "off"
          ? w.a
          : await makeClient(new MultiWorker(), "3", dirs, { noToken: true });
      clients.push(c);
      expect(c.cloudConnect.localLinks.localPairing()).toBe(false);
      const l = c.cloudConnect.localLinks;
      const store = c.connect.localStore();
      await addLink(store, 1);
      await addLink(store, 2);
      const [a, b] = await l.list();
      expect(a).toBeDefined();
      expect(await l.rename(a!.id, "Desk")).toBe(true);
      expect(await l.setReachable(a!.id, false)).toBe(true);
      expect(await l.setReachable(a!.id, true)).toBe(true);
      expect((await l.list()).find((x) => x.id === a!.id)).toMatchObject({
        label: "Desk",
        reachable: true,
      });
      expect(await l.remove(b!.id)).toBe(true);
      expect(await l.list()).toHaveLength(1);
      // The gated calls still say so, and nothing was advertised.
      await expect(
        l.pair({
          categories: [],
          mdns: w.net.adapter(),
          ...LOOP,
          onCode: () => undefined,
          onConfirm: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "local-pairing-off" });
      expect(w.net.adverts.size).toBe(0);
    }
  });
});

describe("the joiner wipes what it makes after a cancel", () => {
  const zero = (v: Uint8Array): boolean => v.every((b) => b === 0);

  async function cancelAt(point: "cpaceGenerator" | "cpacePsk") {
    const w = await world();
    const s = await show(w.a, w.net);
    // Only what the joiner makes from here on.
    spy.made = {};
    spy.isk.clear();
    const ac = new AbortController();
    spy.after[point] = () => {
      spy.after[point] = undefined;
      ac.abort();
    };
    await expect(
      dial(w.b, w.net, { code: s.codes[0]!.code }, [], { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "peer-closed", reason: "cancelled" });
  }

  it("a cancel during the generator", async () => {
    await cancelAt("cpaceGenerator");
    expect(spy.made.cpaceGenerator).toHaveLength(1);
    for (const k of ["cpaceGenerator", "cpaceScalar"])
      for (const v of spy.made[k]!) expect(zero(v), k).toBe(true);
  });

  it("a cancel during the pre-shared key", async () => {
    await cancelAt("cpacePsk");
    expect(spy.made.cpacePsk).toHaveLength(1);
    for (const k of ["cpacePsk", "cpaceIsk"])
      for (const v of spy.made[k]!) expect(zero(v), k).toBe(true);
  });
});
