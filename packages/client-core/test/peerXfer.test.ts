// @pkey-feature connect.transfer
// Direct Transfer (§15.11) past what `peer-matrix.json` `xfer` can express: the machines over two
// real sessions in memory, a resume across sessions, the session's ownership of the xfer record
// types and the endpoint's ordering.
import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import {
  PeerChannel,
  XFER,
  XFER_DELIVERED_SECONDS,
  XFER_MAX_DELIVERED_PER_PEER,
  XferDeliveredMemory,
  XferEndpoint,
  XferHasher,
  XferMachine,
  encodeRecord,
  webCryptoNoisePorts,
  webCryptoX25519,
  xferChunkBody,
  xferOfferBody,
  xferPartialPath,
  type SessionEvent,
  type XferAsk,
  type XferPartial,
  type XferPartialEffect,
  type XferResult,
} from "../src/peer/index.js";

const KID = "peer-test-2026";
const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const NOW = 1_700_001_000;
const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);

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
  return { priv, pub, certJws, id };
}

interface Side {
  s: PeerChannel;
  events: SessionEvent[];
  out: Uint8Array[];
}

const content = (from: number, to: number): Uint8Array =>
  Uint8Array.from(
    { length: to - from },
    (_, k) => ((from + k) * 7 + 13) & 0xff,
  );
const shaHex = async (b: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");

async function pair(caps: [string[], string[]]) {
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
  const mk = (
    role: "initiator" | "responder",
    me: typeof A,
    c: string[],
  ): Side => {
    const events: SessionEvent[] = [];
    const out: Uint8Array[] = [];
    const s = new PeerChannel({
      mode: "a",
      role,
      slug: "djdl",
      staticKey: me.priv,
      account: acct(me),
      caps: c,
      hello: { platform: "test", app: "demo" },
      send: (n) => out.push(n),
      onEvent: (e) => events.push(e),
      now: () => NOW,
    });
    return { s, events, out };
  };
  const a = mk("initiator", A, caps[0]);
  const b = mk("responder", B, caps[1]);
  await a.s.start();
  await settle(a, b);
  return { a, b, A, B };
}

async function settle(a: Side, b: Side): Promise<void> {
  for (let i = 0; i < 400 && (a.out.length > 0 || b.out.length > 0); i++) {
    for (const m of a.out.splice(0)) await b.s.receive(m);
    for (const m of b.out.splice(0)) await a.s.receive(m);
  }
}

/** An in-memory store of partial files and a source of the (7 i + 13) content. */
function memStore() {
  const files = new Map<string, Uint8Array>();
  const log: string[] = [];
  return {
    files,
    log,
    apply: async (e: XferPartialEffect): Promise<void> => {
      if ("create" in e) files.set(e.create, new Uint8Array(0));
      else if ("truncate" in e)
        files.set(e.truncate, files.get(e.truncate)!.slice(0, e.to));
      else if ("discard" in e) files.delete(e.discard);
      else if ("evict" in e) files.delete(e.evict);
      else if ("delete" in e) files.delete(e.delete);
      else if ("write" in e) {
        const cur = files.get(e.write)!;
        const next = new Uint8Array(
          Math.max(cur.length, e.offset + e.data.length),
        );
        next.set(cur);
        next.set(e.data, e.offset);
        files.set(e.write, next);
      }
      log.push(Object.keys(e)[0]!);
    },
  };
}

function ends(overrides: { asks?: XferAsk[]; results?: XferResult[] } = {}) {
  const asks = overrides.asks ?? [];
  const results = overrides.results ?? [];
  return {
    asks,
    results,
    events: {
      ask: (a: XferAsk) => asks.push(a),
      withdraw: () => undefined,
      result: (r: XferResult) => results.push(r),
      refused: () => undefined,
      error: (e: unknown) => {
        throw e;
      },
    },
  };
}

describe("Direct Transfer over two sessions", () => {
  it("sends a file across, hash checked before it is finalized", async () => {
    const { a, b, A } = await pair([
      ["app/1", "xfer/1"].map((x) => x),
      ["app/1", "xfer/1"],
    ]);
    const size = 5 * 4096 + 123;
    const sha = await shaHex(content(0, size));
    const store = memStore();
    const rx = ends();
    const tx = ends();
    const recv = XferEndpoint.attach(b.s, {
      machine: {
        mode: "a",
        caps: ["app/1", "xfer/1"],
        maxMessage: 1_048_576,
        handler: () => "accept",
        peerKey: A.pub,
      },
      read: async () => {
        throw new Error("a receiver reads nothing");
      },
      apply: store.apply,
      events: rx.events,
    });
    const send = XferEndpoint.attach(a.s, {
      machine: {
        mode: "a",
        caps: ["app/1", "xfer/1"],
        maxMessage: 1_048_576,
        handler: null,
        peerKey: A.pub,
      },
      read: async (_id, off, len) => content(off, off + len),
      apply: async () => undefined,
      events: tx.events,
    });
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    send.offer({ id, size, chunk: 4096, sha256: sha, name: "../x/a.bin" });
    for (let i = 0; i < 30; i++) {
      await send.idle();
      await recv.idle();
      await settle(a, b);
    }
    expect(rx.asks).toEqual([]);
    expect(rx.results).toEqual([{ id, outcome: "delivered" }]);
    expect(tx.results).toEqual([{ id, outcome: "delivered" }]);
    expect(recv.machine.live).toBe(0);
    // The file is named by the key, the id and the hash alone.
    const path = xferPartialPath(A.pub, id, sha);
    expect(store.files.get(path)).toEqual(content(0, size));
    expect(store.log.at(-1)).toBe("finalize");
    expect(store.log.lastIndexOf("write")).toBeLessThan(store.log.length - 1);
  });

  it("holds a partial across sessions and resumes at the verified offset", async () => {
    const size = 10 * 1000;
    const sha = await shaHex(content(0, size));
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    const key = rnd();
    const store = memStore();
    const path = xferPartialPath(key, id, sha);
    // A first session wrote 4 chunks and ended.
    store.files.set(path, content(0, 4000));
    const kept: XferPartial = {
      ref: path,
      id,
      sha256: sha,
      size,
      chunk: 1000,
      bytes: 4000,
      writtenAt: 0,
    };
    const m = new XferMachine({
      mode: "a",
      caps: ["xfer/1"],
      maxMessage: 1_048_576,
      handler: () => "accept",
      peerKey: key,
      partials: [{ ...kept, reread: 3500 }],
      rehash: (ref, off) =>
        new XferHasher().update(store.files.get(ref)!.slice(0, off)),
    });
    const o = m.receive(
      10,
      XFER.OFFER,
      xferOfferBody({ id, size, sha256: sha, chunk: 1000 }),
    );
    // 3500 bytes were re-read: the verified offset is the multiple of the chunk below.
    expect(o.send).toEqual([{ t: "ACCEPT", id, offset: 3000 }]);
    expect(o.partial).toEqual([{ truncate: path, to: 3000 }]);
    let at = 11;
    let out;
    for (let off = 3000; off < size; off += 1000) {
      out = m.receive(
        at++,
        XFER.CHUNK,
        xferChunkBody(id, off, content(off, off + 1000)),
      );
    }
    expect(out!.send).toEqual([{ t: "ACK", id, offset: size }]);
    const done = m.receive(
      at,
      XFER.DONE,
      new TextEncoder().encode(JSON.stringify({ id, sha256: sha })),
    );
    expect(done.results).toEqual([{ id, outcome: "delivered" }]);
    expect(done.partial).toEqual([{ finalize: path }]);
  });
});

describe("the session owns the xfer record types", () => {
  const rec = (type: number, flags = 0): Uint8Array =>
    encodeRecord({ type, flags, body: new Uint8Array(4) });

  it("closes peer_not_allowed on an xfer record without the capability", async () => {
    const { a, b } = await pair([["app/1"], ["app/1", "xfer/1"]]);
    // A mode-a pair's `sendRecord` carries host records; the xfer types are refused locally.
    await expect(
      a.s.sendRecord(XFER.OFFER, new Uint8Array(1)),
    ).rejects.toThrow();
    expect(() => a.s.attachXfer(() => undefined)).toThrow();
    expect(() => b.s.attachXfer(() => undefined)).toThrow();
    expect(a.s.closed).toBe(false);
    // A peer that sends one anyway is closed on.
    const chan = a.s as unknown as {
      tp: {
        send: { encrypt(ad: Uint8Array, p: Uint8Array): Promise<Uint8Array> };
      };
      o: { send(n: Uint8Array): void };
    };
    chan.o.send(await chan.tp.send.encrypt(new Uint8Array(0), rec(XFER.ACK)));
    await settle(a, b);
    expect(b.events.filter((e) => e.type === "closed")).toEqual([
      { type: "closed", code: "peer_not_allowed", byPeer: false },
    ]);
  });

  it("refuses sendRecord for the six types and hands them to the port when attached", async () => {
    const { a, b } = await pair([
      ["app/1", "xfer/1"],
      ["app/1", "xfer/1"],
    ]);
    const got: [number, number][] = [];
    const sendB = b.s.attachXfer((t, body) => got.push([t, body.length]));
    for (const t of Object.values(XFER))
      await expect(a.s.sendRecord(t, new Uint8Array(1))).rejects.toThrow();
    const sendA = a.s.attachXfer(() => undefined);
    await sendA(XFER.ACK, new Uint8Array(7));
    await settle(a, b);
    expect(got).toEqual([[XFER.ACK, 7]]);
    await expect(sendB(0x0100, new Uint8Array(1))).rejects.toThrow();
    expect(() => a.s.attachXfer(() => undefined)).toThrow();
  });

  it("closes peer_bad_frame on an xfer record with MORE set", async () => {
    const { a, b } = await pair([
      ["app/1", "xfer/1"],
      ["app/1", "xfer/1"],
    ]);
    b.s.attachXfer(() => undefined);
    // Bypass the writer: encrypt a MORE record through the initiator's own transport.
    const sendA = a.s.attachXfer(() => undefined);
    void sendA;
    const bad = rec(XFER.CHUNK, 1);
    const chan = a.s as unknown as {
      tp: {
        send: { encrypt(ad: Uint8Array, p: Uint8Array): Promise<Uint8Array> };
      };
      o: { send(n: Uint8Array): void };
    };
    chan.o.send(await chan.tp.send.encrypt(new Uint8Array(0), bad));
    await settle(a, b);
    expect(b.events.filter((e) => e.type === "closed")).toEqual([
      { type: "closed", code: "peer_bad_frame", byPeer: false },
    ]);
  });
});

describe("the machine's edges", () => {
  const key = new Uint8Array(32).fill(7);
  const sha =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const mk = (
    extra: Partial<ConstructorParameters<typeof XferMachine>[0]> = {},
  ) =>
    new XferMachine({
      mode: "a",
      caps: ["xfer/1"],
      maxMessage: 1_048_576,
      handler: () => "ask",
      peerKey: key,
      ...extra,
    });
  const idOf = (n: number): string =>
    base64UrlEncodeBytes(new Uint8Array(16).fill(n));

  it("reports nextDeadline per wait: none while consent is open on an idle session", () => {
    const m = mk();
    expect(m.nextDeadline()).toBeNull();
    m.receive(
      5,
      XFER.OFFER,
      xferOfferBody({ id: idOf(1), size: 0, sha256: sha, chunk: 1 }),
    );
    expect(m.nextDeadline()).toBe(125);
    // Consent never idles at 60 s; at 125 s it times out with a withdrawal.
    const t = m.tick(125);
    expect(t.withdraw).toEqual([idOf(1)]);
    expect(t.send).toEqual([{ t: "CANCEL", id: idOf(1), reason: "timeout" }]);
    expect(t.results).toEqual([]);
    expect(m.nextDeadline()).toBeNull();
  });

  it("refuses a duplicate or a fifth offer locally and rejects bad host arguments", () => {
    const m = mk();
    for (let i = 1; i <= 4; i++)
      m.offer(0, { id: idOf(i), size: 10, chunk: 4, sha256: sha });
    expect(
      m.offer(0, { id: idOf(5), size: 10, chunk: 4, sha256: sha }).refused,
    ).toBe("busy");
    expect(() =>
      m.offer(0, { id: idOf(1), size: 10, chunk: 4, sha256: sha }),
    ).toThrow();
    expect(() =>
      m.offer(0, { id: "short", size: 10, chunk: 4, sha256: sha }),
    ).toThrow();
    expect(() =>
      m.offer(0, { id: idOf(9), size: 10, chunk: 70000, sha256: sha }),
    ).toThrow();
  });

  it("keeps its partial and reports closed when the session ends after a fault", () => {
    const m = mk({ handler: () => "accept" });
    const id = idOf(2);
    const sha10 =
      "eafc237cd91eef92735a0b3397e59b03c54c01fc9da4cc788bd85bc9562e467c";
    const o = m.receive(
      0,
      XFER.OFFER,
      xferOfferBody({ id, size: 10, sha256: sha10, chunk: 4 }),
    );
    expect(o.partial).toHaveLength(1);
    const ref = (o.partial[0] as { create: string }).create;
    expect(ref).toBe(xferPartialPath(key, id, sha10));
    const bad = m.receive(1, XFER.CHUNK, xferChunkBody(id, 4, content(4, 8)));
    expect(bad.close).toBe("peer_bad_frame");
    // The host's own close is a no-op after a fault; the endpoint's abandon cleans up.
    expect(m.close(2)).toEqual({
      send: [],
      withdraw: [],
      results: [],
      partial: [],
    });
    const gone = m.abandon(3);
    expect(gone.results).toEqual([{ id, outcome: "closed" }]);
    expect(gone.partial).toEqual([{ keep: ref }]);
    expect(m.abandon(4).results).toEqual([]);
    expect(m.partials().map((p) => p.ref)).toEqual([ref]);
  });

  it("a resume whose re-read fails starts afresh at 0 instead of throwing", () => {
    const p: XferPartial = {
      ref: "p",
      id: idOf(4),
      sha256: sha,
      size: 4,
      chunk: 2,
      bytes: 2,
      writtenAt: 0,
    };
    const m = mk({
      partials: [p],
      rehash: () => {
        throw new Error("gone");
      },
    });
    m.receive(
      1,
      XFER.OFFER,
      xferOfferBody({ id: idOf(4), size: 4, sha256: sha, chunk: 2 }),
    );
    const out = m.consent(2, idOf(4), "accept");
    expect(out.send).toEqual([{ t: "ACCEPT", id: idOf(4), offset: 0 }]);
    expect(out.partial.map((e) => Object.keys(e)[0])).toEqual([
      "discard",
      "create",
    ]);
  });

  it("starts a new session with the partials, none held", () => {
    const p: XferPartial = {
      ref: "p",
      id: idOf(3),
      sha256: sha,
      size: 4,
      chunk: 2,
      bytes: 2,
      writtenAt: 0,
      held: true,
      reread: 2,
    };
    const m = mk({ partials: [p] });
    m.newSession(1);
    const { reread: _r, ...rest } = p;
    expect(m.partials()).toEqual([{ ...rest, held: false }]);
  });

  it("a source that fails ends the transfer without sending its DONE", async () => {
    const { a, b, A } = await pair([
      ["app/1", "xfer/1"],
      ["app/1", "xfer/1"],
    ]);
    const rx = ends();
    const tx = ends();
    const store = memStore();
    const recv = XferEndpoint.attach(b.s, {
      machine: {
        mode: "a",
        caps: ["xfer/1"],
        maxMessage: 1_048_576,
        handler: () => "accept",
        peerKey: A.pub,
      },
      read: async () => new Uint8Array(0),
      apply: store.apply,
      events: rx.events,
    });
    const send = XferEndpoint.attach(a.s, {
      machine: {
        mode: "a",
        caps: ["xfer/1"],
        maxMessage: 1_048_576,
        handler: null,
        peerKey: A.pub,
      },
      read: async () => {
        throw new Error("disk gone");
      },
      apply: async () => undefined,
      events: tx.events,
    });
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    send.offer({
      id,
      size: 100,
      chunk: 50,
      sha256: await shaHex(content(0, 100)),
    });
    for (let i = 0; i < 20; i++) {
      await send.idle();
      await recv.idle();
      await settle(a, b);
    }
    console.log(
      tx.results,
      rx.results,
      a.events.map((e) => e.type),
      b.events.map((e) => e.type),
    );
    expect(tx.results).toEqual([
      { id, outcome: "cancelled", reason: "cancelled" },
    ]);
    expect(rx.results).toEqual([
      { id, outcome: "cancelled", reason: "cancelled" },
    ]);
    expect(a.s.closed).toBe(false);
  });
});

describe("a re-offer of delivered content (CC-20.F)", () => {
  const dec = new TextEncoder();
  const doneBody = (id: string, sha?: string): Uint8Array =>
    dec.encode(
      JSON.stringify(sha === undefined ? { id } : { id, sha256: sha }),
    );
  const rx = (mem: XferDeliveredMemory | null, key: Uint8Array) =>
    new XferMachine({
      mode: "a",
      caps: ["xfer/1"],
      maxMessage: 1_048_576,
      handler: () => "accept",
      peerKey: key,
      ...(mem ? { delivered: mem.forPeer(key) } : {}),
    });
  const receive = async (
    m: XferMachine,
    id: string,
    size: number,
    chunk: number,
    at: number,
  ) => {
    const sha = await shaHex(content(0, size));
    const o = m.receive(
      at,
      XFER.OFFER,
      xferOfferBody({ id, size, sha256: sha, chunk }),
    );
    return { sha, o };
  };

  it("answers a delivered tuple at the last chunk boundary, reads the tail and reports nothing", async () => {
    const mem = new XferDeliveredMemory();
    const key = rnd();
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    const m1 = rx(mem, key);
    const { sha, o } = await receive(m1, id, 2500, 1000, 1);
    expect(o.send).toEqual([{ t: "ACCEPT", id, offset: 0 }]);
    for (let off = 0; off < 2500; off += 1000)
      m1.receive(
        2,
        XFER.CHUNK,
        xferChunkBody(id, off, content(off, Math.min(2500, off + 1000))),
      );
    const d = m1.receive(3, XFER.DONE, doneBody(id, sha));
    expect(d.results).toEqual([{ id, outcome: "delivered" }]);
    // A new session (the sender never saw the final DONE) offers the same transfer again.
    const m2 = rx(mem, key);
    const r = m2.receive(
      10,
      XFER.OFFER,
      xferOfferBody({ id, size: 2500, sha256: sha, chunk: 1000 }),
    );
    expect(r.send).toEqual([{ t: "ACCEPT", id, offset: 2000 }]);
    expect(r.ask).toBeUndefined();
    expect(r.partial).toEqual([]);
    const c = m2.receive(
      11,
      XFER.CHUNK,
      xferChunkBody(id, 2000, content(2000, 2500)),
    );
    expect(c.send).toEqual([{ t: "ACK", id, offset: 2500 }]);
    expect(c.partial).toEqual([]);
    const f = m2.receive(12, XFER.DONE, doneBody(id, sha));
    expect(f.send).toEqual([{ t: "DONE", id }]);
    expect(f.results).toEqual([{ id, outcome: "delivered", again: true }]);
    expect(f.partial).toEqual([]);
  });

  it("accepts at size when the size is a whole number of chunks, and refuses a wrong hash", async () => {
    const mem = new XferDeliveredMemory();
    const key = rnd();
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    const m1 = rx(mem, key);
    const { sha } = await receive(m1, id, 2000, 1000, 1);
    for (let off = 0; off < 2000; off += 1000)
      m1.receive(
        2,
        XFER.CHUNK,
        xferChunkBody(id, off, content(off, off + 1000)),
      );
    m1.receive(3, XFER.DONE, doneBody(id, sha));
    const m2 = rx(mem, key);
    const r = m2.receive(
      10,
      XFER.OFFER,
      xferOfferBody({ id, size: 2000, sha256: sha, chunk: 1000 }),
    );
    expect(r.send).toEqual([{ t: "ACCEPT", id, offset: 2000 }]);
    const bad = m2.receive(11, XFER.DONE, doneBody(id, "0".repeat(64)));
    expect(bad.send).toEqual([{ t: "CANCEL", id, reason: "hash" }]);
    expect(bad.results).toEqual([]);
  });

  it("receives again for another peer, another hash or size, no memory, or after expiry", async () => {
    const mem = new XferDeliveredMemory();
    const key = rnd();
    const id = base64UrlEncodeBytes(rnd().slice(0, 16));
    const m1 = rx(mem, key);
    const { sha } = await receive(m1, id, 1000, 1000, 1);
    m1.receive(2, XFER.CHUNK, xferChunkBody(id, 0, content(0, 1000)));
    m1.receive(3, XFER.DONE, doneBody(id, sha));
    const offer = (m: XferMachine, at: number, size = 1000, h = sha) =>
      m.receive(
        at,
        XFER.OFFER,
        xferOfferBody({ id, size, sha256: h, chunk: 1000 }),
      ).send;
    expect(offer(rx(mem, rnd()), 10)).toEqual([{ t: "ACCEPT", id, offset: 0 }]);
    expect(offer(rx(mem, key), 10, 2000)).toEqual([
      { t: "ACCEPT", id, offset: 0 },
    ]);
    expect(offer(rx(mem, key), 10, 1000, "1".repeat(64))).toEqual([
      { t: "ACCEPT", id, offset: 0 },
    ]);
    expect(offer(rx(null, key), 10)).toEqual([{ t: "ACCEPT", id, offset: 0 }]);
    expect(offer(rx(mem, key), 3 + XFER_DELIVERED_SECONDS + 1)).toEqual([
      { t: "ACCEPT", id, offset: 0 },
    ]);
    // Forgetting a peer (a deleted link) forgets its entries.
    mem.forget(key);
    expect(offer(rx(mem, key), 10)).toEqual([{ t: "ACCEPT", id, offset: 0 }]);
  });

  it("keeps at most XFER_MAX_DELIVERED_PER_PEER entries per peer, oldest first", () => {
    const mem = new XferDeliveredMemory();
    const v = mem.forPeer(new Uint8Array(32).fill(1));
    for (let i = 0; i <= XFER_MAX_DELIVERED_PER_PEER; i++)
      v.add(`id${i}`, "a".repeat(64), 1, i);
    expect(v.has("id0", "a".repeat(64), 1, 70)).toBe(false);
    expect(v.has("id1", "a".repeat(64), 1, 70)).toBe(true);
  });
});
