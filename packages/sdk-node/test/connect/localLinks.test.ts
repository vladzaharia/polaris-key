// @pkey-feature connect.local
// Pairing with a code, with no account, end to end in one process (CC-29.7; WIRE-CONTRACT-V5
// §15.12): two clients with no credential on 127.0.0.1 over an in-process mDNS network run the
// whole path: the window and its advert, CPace, mode `q`, the permit, the guess accounting and the
// rotation, both people's consent, and the stored link. The codecs, the window machine and the
// gate are the `peer-matrix.json` `local` rows (conformance/runners/node); this file covers what
// the Node SDK does with them: the typed N/A, the dial budget across joins, the cap and the store.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedError } from "@polaris-key/client-core";
import { makeQr } from "@polaris-key/client-core/peer";
import type { PolarisKeyClient } from "../../src/client.js";
import type {
  LocalCode,
  LocalOffer,
  LocalPairHandle,
  LocalPaired,
} from "../../src/connect/index.js";
import {
  Attempt,
  storeLink,
  type LocalSource,
} from "../../src/connect/localCommon.js";
import { resetLocalBudgets } from "../../src/connect/localLinks.js";
import {
  LOCAL_STATE_FILE,
  LocalLinkStore,
  localStorage,
} from "../../src/connect/localState.js";
import { tmpDir } from "../lanFixtures.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  PRODUCT,
  T0,
  makeClient,
  until,
} from "../lanFixtures.js";

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

let dirs: string[] = [];
let clients: PolarisKeyClient[] = [];
let handles: LocalPairHandle[] = [];

/** Only `Date` is frozen: the sockets and the pairing's own clocks run for real. */
function freezeDate(): void {
  resetLocalBudgets();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
}

async function teardown(): Promise<void> {
  for (const h of handles.splice(0)) await h.stop().catch(() => undefined);
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

beforeEach(freezeDate);
afterEach(teardown);

/** Two devices with no credential, and a discovery that says pairing with a code is on. */
async function world(localPairing = true) {
  const worker = new MultiWorker();
  worker.localPairing = localPairing;
  const a = await makeClient(worker, "1", dirs, { noToken: true });
  const b = await makeClient(worker, "2", dirs, { noToken: true });
  clients.push(a, b);
  await a.discover();
  await b.discover();
  return { worker, a, b, net: new MemoryMdnsNetwork() };
}
type World = Awaited<ReturnType<typeof world>>;

interface Shower {
  codes: LocalCode[];
  offers: LocalOffer[];
  linked: LocalPaired[];
  failed: string[];
  handle: LocalPairHandle;
}

async function show(
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  cats: string[],
  label = "Ana",
): Promise<Shower> {
  const s: Shower = {
    codes: [],
    offers: [],
    linked: [],
    failed: [],
    handle: undefined as unknown as LocalPairHandle,
  };
  s.handle = await c.cloudConnect.localLinks.pair({
    categories: cats,
    label,
    mdns: net.adapter(),
    ...LOOP,
    onCode: (code) => s.codes.push(code),
    onConfirm: (o) => s.offers.push(o),
    onLinked: (l) => s.linked.push(l),
    onFailed: (f) => s.failed.push(f.reason),
  });
  handles.push(s.handle);
  return s;
}

const dial = (
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  how: { code: string } | { qr: string },
  offers: LocalOffer[] = [],
  cats = ["notes", "docs"],
  extra: Record<string, unknown> = {},
) =>
  c.cloudConnect.localLinks.join({
    categories: cats,
    label: "Bo",
    mdns: net.adapter(),
    ...LOOP,
    onConfirm: (o) => offers.push(o),
    ...how,
    ...extra,
  });

/** Add the `i`th made-up link to a store. */
const addLink = (st: LocalLinkStore, i: number) =>
  st.add({
    ownKey: new Uint8Array(32).fill(1),
    ownPublic: new Uint8Array(32).fill(2),
    peerKey: Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i : 9)),
    secret: new Uint8Array(32).fill(4),
    cats: [],
    now: T0,
  });

/** Two wrong-password joins against a shower, each after the code it rotated to. */
async function spendDials(w: World, s: Shower, bad: string, extra = {}) {
  for (let i = 0; i < 2; i++) {
    await until(() => s.codes.length === i + 1);
    await expect(
      dial(w.b, w.net, { code: bad }, [], ["notes"], {
        browseSeconds: 0.05,
        ...extra,
      }),
    ).rejects.toMatchObject({ code: "pairing-code-failed" });
  }
}

/** One pairing to the end: the joiner dials, both people agree, both sides store the link. */
async function pairUp(
  w: World,
  s: Shower,
  how: { code: string } | { qr: string },
): Promise<LocalPaired> {
  const offersB: LocalOffer[] = [];
  const joined = dial(w.b, w.net, how, offersB);
  await until(() => s.offers.length === 1 && offersB.length === 1);
  await Promise.all([s.offers[0]!.confirm(), offersB[0]!.confirm()]);
  const mine = await joined;
  await until(() => s.linked.length === 1);
  return mine;
}

/** The code of a shower with its last digit changed: right nameplate, wrong password. */
const wrongPassword = (code: string): string => {
  const digits = code.replace(" ", "");
  const last = digits.endsWith("0") ? "1" : "0";
  return digits.slice(0, -1) + last;
};

describe("pairing with a code, with no account", () => {
  it("pairs by a typed code: both confirm, both store the link, the window closes", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["photos", "notes"]);
    expect(s.codes).toHaveLength(1);
    expect(s.codes[0]!.code).toMatch(/^\d{4} \d{4}$/);
    const advert = [...w.net.adverts.values()].find((a) =>
      a.txt.includes("m=q"),
    )!;
    expect(advert.txt).toContain(`n=${s.codes[0]!.nameplate}`);

    const offersB: LocalOffer[] = [];
    const joined = dial(w.b, w.net, { code: s.codes[0]!.code }, offersB);
    await until(() => s.offers.length === 1 && offersB.length === 1);
    // HELLO is shown at consent, after the code was proven.
    expect(s.offers[0]!.label).toBe("Bo");
    expect(offersB[0]!.label).toBe("Ana");
    expect(s.offers[0]!.categories).toEqual(["photos", "notes"]);
    await Promise.all([s.offers[0]!.confirm(), offersB[0]!.confirm()]);
    const lb = await joined;
    await until(() => s.linked.length === 1);

    expect(lb.label).toBe("Ana");
    expect(lb.categories).toEqual(["notes"]);
    expect(s.linked[0]!.label).toBe("Bo");
    expect(s.linked[0]!.categories).toEqual(["notes"]);
    // The window closed on the stored link: the advert is withdrawn.
    await until(() => !s.handle.open);
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=q")),
    ).toEqual([]);

    // Each side holds the other's link key and one secret both derived.
    const [ra] = await w.a.connect.localStore().rows();
    const [rb] = await w.b.connect.localStore().rows();
    expect(ra!.secret).toBe(rb!.secret);
    expect(ra!.peerKey).toBe(rb!.ownPublic);
    expect(rb!.peerKey).toBe(ra!.ownPublic);
    expect(ra!.ownKey).not.toBe(rb!.ownKey);

    // The listing carries no key and no secret.
    const list = await w.a.cloudConnect.localLinks.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(ra!.secret);
    expect(JSON.stringify(list)).not.toContain(ra!.ownKey);
    // No Cloud Connect identity was ever made: this is not account data.
    expect(await w.a.connect.contactRows()).toEqual([]);
  });

  it("pairs by a QR, and the QR of another app is refused with that reason", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    await pairUp(w, s, { qr: s.codes[0]!.qr.toLowerCase() });

    const other = s.codes[0]!.qr.replace(
      `PKP1:${PRODUCT.toUpperCase()}`,
      "PKP1:OTHER",
    );
    await expect(dial(w.b, w.net, { qr: other })).rejects.toMatchObject({
      code: "pairing-code-failed",
      message: "This code is for another app.",
    });
  });

  it("a wrong guess rotates the code; the new code pairs; five wrong guesses close the window", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    const first = s.codes[0]!;
    // A wrong QR secret is a wrong guess with no dial budget: the joiner answers code-failed.
    const bad = makeQr(
      PRODUCT,
      w.net.adverts.values().next().value!.instance as string,
      new Uint8Array(16).fill(7),
    );
    await expect(dial(w.b, w.net, { qr: bad })).rejects.toMatchObject({
      code: "pairing-code-failed",
    });
    // The failed guess rotated the password and the QR secret together; the nameplate stays.
    await until(() => s.codes.length === 2);
    expect(s.codes[1]!.code).not.toBe(first.code);
    expect(s.codes[1]!.qr).not.toBe(first.qr);
    expect(s.codes[1]!.nameplate).toBe(first.nameplate);

    // The new code works: the rotation finished before the window took this attempt.
    await pairUp(w, s, { code: s.codes[1]!.code });
  });

  it("the fifth failed guess closes the window and its host hears too-many-tries", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    const instance = [...w.net.adverts.values()].find((a) =>
      a.txt.includes("m=q"),
    )!.instance;
    for (let i = 0; i < 5; i++) {
      // Wait for the rotation of the last failure: until then the window is busy and counts nothing.
      await until(() => s.codes.length === i + 1 || !s.handle.open);
      if (!s.handle.open) break;
      const bad = makeQr(PRODUCT, instance, new Uint8Array(16).fill(i + 1));
      await expect(dial(w.b, w.net, { qr: bad })).rejects.toMatchObject({
        code: "pairing-code-failed",
      });
    }
    await until(() => !s.handle.open);
    expect(s.failed).toEqual(["too-many-tries"]);
    expect(s.handle.code()).toBeNull();
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=q")),
    ).toEqual([]);
    expect(await w.a.cloudConnect.localLinks.list()).toEqual([]);
  });

  it("a typed code's dials are counted across joins: the third join browses nothing", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    const bad = wrongPassword(s.codes[0]!.code);
    let browses = 0;
    const counting = (): ReturnType<MemoryMdnsNetwork["adapter"]> => {
      const inner = w.net.adapter();
      return {
        advertise: inner.advertise,
        browse: (...args) => {
          browses++;
          return inner.browse(...args);
        },
      };
    };
    await spendDials(w, s, bad, { mdns: counting() });
    expect(browses).toBe(2);
    // Two dials spent on this nameplate in 300 s: the third join answers at once.
    await expect(
      dial(w.b, w.net, { code: bad }, [], ["notes"], { mdns: counting() }),
    ).rejects.toMatchObject({ code: "pairing-code-failed" });
    expect(browses).toBe(2);
    // A QR is not limited.
    await until(() => s.codes.length === 3);
    await pairUp(w, s, { qr: s.codes[2]!.qr });
  });

  it("a code that does not parse browses nothing; no advert in 15 s is pairing-not-found", async () => {
    const w = await world();
    let browses = 0;
    const inner = w.net.adapter();
    const counting = {
      advertise: inner.advertise,
      browse: ((...a: Parameters<typeof inner.browse>) => {
        browses++;
        return inner.browse(...a);
      }) as typeof inner.browse,
    };
    await expect(
      dial(w.b, w.net, { code: "1234 567" }, [], ["notes"], { mdns: counting }),
    ).rejects.toMatchObject({ code: "pairing-code-failed" });
    expect(browses).toBe(0);
    // The browse runs out at once.
    await expect(
      dial(w.b, w.net, { code: "1234 5678" }, [], ["notes"], {
        mdns: counting,
        browseSeconds: 0.01,
      }),
    ).rejects.toMatchObject({ code: "pairing-not-found" });
    expect(browses).toBe(1);
  });

  it("a decline stores nothing on either side and the window stays for another try", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    const offersB: LocalOffer[] = [];
    const joined = dial(w.b, w.net, { code: s.codes[0]!.code }, offersB);
    joined.catch(() => undefined);
    await until(() => s.offers.length === 1 && offersB.length === 1);
    await s.offers[0]!.decline();
    await expect(joined).rejects.toMatchObject({ code: "peer-closed" });
    await until(() => s.failed.length === 1);
    expect(s.failed).toEqual(["declined"]);
    expect(await w.a.cloudConnect.localLinks.list()).toEqual([]);
    expect(await w.b.cloudConnect.localLinks.list()).toEqual([]);
    // The session reached the transport and ended with no link: no failure counted, the code rotated.
    await until(() => s.codes.length === 2);
    expect(s.handle.open).toBe(true);
  });
});

describe("the gate and the cap", () => {
  it("is off with no cached document, and while discovery says false: the typed N/A, nothing advertised", async () => {
    const w = await world(false);
    const call = (c: PolarisKeyClient) =>
      c.cloudConnect.localLinks.pair({
        categories: [],
        mdns: w.net.adapter(),
        ...LOOP,
        onCode: () => undefined,
        onConfirm: () => undefined,
      });
    await expect(call(w.a)).rejects.toBeInstanceOf(UnsupportedError);
    await expect(call(w.a)).rejects.toMatchObject({
      code: "local-pairing-off",
    });
    await expect(dial(w.b, w.net, { code: "1234 5678" })).rejects.toMatchObject(
      { code: "local-pairing-off" },
    );
    expect(w.net.adverts.size).toBe(0);
    // A client that never discovered has no cached document: off.
    const w2 = await world(true);
    const fresh = await makeClient(new MultiWorker(), "3", dirs, {
      noToken: true,
    });
    clients.push(fresh);
    expect(fresh.cloudConnect.localLinks.localPairing()).toBe(false);
    await expect(
      fresh.cloudConnect.localLinks.join({
        categories: [],
        code: "1234 5678",
        onConfirm: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "local-pairing-off" });
    expect(w2.a.cloudConnect.localLinks.localPairing()).toBe(true);
  });

  it("a read that clears the answer closes the open window; an error read changes nothing", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    // An unreachable read leaves a cached true alone (local links serve LANs with no internet).
    w.worker.discoveryStatus = 503;
    await w.a.discover();
    expect(s.handle.open).toBe(true);
    expect(w.a.cloudConnect.localLinks.localPairing()).toBe(true);
    // The product turned it off: the window closes and the advert is withdrawn.
    w.worker.discoveryStatus = 200;
    w.worker.localPairing = false;
    await w.a.discover();
    await until(() => !s.handle.open);
    expect(w.a.cloudConnect.localLinks.localPairing()).toBe(false);
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=q")),
    ).toEqual([]);
  });

  it("a device that holds 32 links answers local-links-full before anything is advertised", async () => {
    const w = await world();
    const store = w.a.connect.localStore();
    for (let i = 0; i < 32; i++) await addLink(store, i);
    await expect(
      w.a.cloudConnect.localLinks.pair({
        categories: [],
        mdns: w.net.adapter(),
        ...LOOP,
        onCode: () => undefined,
        onConfirm: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "local-links-full" });
    expect(w.net.adverts.size).toBe(0);
    await expect(dial(w.a, w.net, { code: "1234 5678" })).rejects.toMatchObject(
      {
        code: "local-links-full",
      },
    );
  });

  it("one window per device and product; options that break a rule are refused", async () => {
    const w = await world();
    await show(w.a, w.net, ["notes"]);
    await expect(show(w.a, w.net, ["notes"])).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(
      w.b.cloudConnect.localLinks.pair({
        categories: ["Bad Cat"],
        mdns: w.net.adapter(),
        ...LOOP,
        onCode: () => undefined,
        onConfirm: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(
      dial(w.b, w.net, { code: "12345678", qr: "x" } as never),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("the store", () => {
  it("is its own file, outlives the Connect record, and names the schema", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    await pairUp(w, s, { code: s.codes[0]!.code });
    const state = (w.a as unknown as { core: { dirs: { state: string } } }).core
      .dirs.state;
    const rec = JSON.parse(readFileSync(join(state, LOCAL_STATE_FILE), "utf8"));
    expect(rec.schema).toBe("pkey.connect.local.v1");
    expect(rec.product).toBe(PRODUCT);
    expect(rec.links).toHaveLength(1);
  });

  it("a pairing already storing when the gate clears writes nothing", async () => {
    const w = await world();
    const store = w.a.connect.localStore();
    let on = true;
    const src = {
      slug: PRODUCT,
      now: () => T0,
      allowed: () => on,
      store,
      notify: () => undefined,
      onChange: () => () => undefined,
    } as LocalSource;
    const a = new Attempt();
    // The gate is judged inside the store call: it clears between the pairing's last check and the write.
    on = false;
    const paired = await storeLink(src, a, {
      type: "local-link",
      ownKey: new Uint8Array(32).fill(2),
      peerKey: new Uint8Array(32).fill(9),
      secret: new Uint8Array(32).fill(4),
      cats: [],
    } as never);
    expect(paired).toBeNull();
    expect(a.failure).toBe("closed");
    expect(await store.rows()).toHaveLength(0);
  });

  it("a record with two rows of one id is unusable and is not replaced", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    await pairUp(w, s, { code: s.codes[0]!.code });
    const state = (w.a as unknown as { core: { dirs: { state: string } } }).core
      .dirs.state;
    const file = join(state, LOCAL_STATE_FILE);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.links = [...rec.links, ...rec.links];
    const raw = JSON.stringify(rec);
    writeFileSync(file, raw);
    await expect(w.a.cloudConnect.localLinks.list()).rejects.toMatchObject({
      code: "store-failed",
    });
    expect(readFileSync(file, "utf8")).toBe(raw);
  });
});

describe("the review fixes", () => {
  const links = (c: PolarisKeyClient) => c.cloudConnect.localLinks;

  it("a read that said nothing is tried again, and a later off closes the window", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0 * 1000);
    w.worker.discoveryStatus = 503;
    await w.a.discover();
    // "An error changes nothing": still on.
    expect(links(w.a).localPairing()).toBe(true);
    w.worker.discoveryStatus = 200;
    w.worker.localPairing = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    vi.useRealTimers();
    freezeDate();
    await until(() => !links(w.a).localPairing() && !s.handle.open);
  });

  it("the gate is applied even when a store of the read throws", async () => {
    const w = await world();
    w.worker.localPairing = false;
    (
      w.a as unknown as { presentationStore: { accept: () => Promise<void> } }
    ).presentationStore.accept = async () => {
      throw new Error("store");
    };
    await w.a.discover().catch(() => undefined);
    expect(links(w.a).localPairing()).toBe(false);
  });

  it("two concurrent pair() calls open one window; a gate-off during the start closes it", async () => {
    const w = await world();
    const open = () =>
      links(w.a).pair({
        categories: [],
        mdns: w.net.adapter(),
        ...LOOP,
        onCode: () => undefined,
        onConfirm: () => undefined,
      });
    const both = await Promise.allSettled([open(), open()]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const ok = both.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<LocalPairHandle>;
    handles.push(ok.value);
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=q")),
    ).toHaveLength(1);
    await ok.value.stop();

    const starting = open();
    starting.catch(() => undefined);
    await links(w.a).closeAll();
    await expect(starting).rejects.toMatchObject({ code: "local-pairing-off" });
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=q")),
    ).toEqual([]);
  });

  it("the dial budget is shared by every client of a product, and says what to do", async () => {
    const w = await world();
    const s = await show(w.a, w.net, ["notes"]);
    const bad = wrongPassword(s.codes[0]!.code);
    await spendDials(w, s, bad);
    // Another client of the same product meets the spent budget.
    await expect(dial(w.a, w.net, { code: bad })).rejects.toMatchObject({
      code: "pairing-code-failed",
      message: expect.stringContaining("Wait"),
    });
  });

  it("two stores on one directory cannot pass the cap together", async () => {
    const dir = tmpDir(dirs);
    const mk = () =>
      new LocalLinkStore(PRODUCT, async () => localStorage(dir, "durable"));
    const [x, y] = [mk(), mk()];
    const res = await Promise.all(
      Array.from({ length: 40 }, (_, i) => addLink(i % 2 === 0 ? x : y, i)),
    );
    expect(res.filter((r) => r.stored)).toHaveLength(32);
    expect(await mk().count()).toBe(32);
  });
});
