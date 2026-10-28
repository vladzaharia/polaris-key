import { decodeRelay, encodeRelay } from "@polaris-key/client-core/peer";
import { describe, expect, it } from "vitest";
import {
  RELAY_CLOSE,
  RELAY_LIMIT,
  RATE_STRIKES_MAX,
  RelayEngine,
  type RelayOutput,
  type RelayTicket,
} from "../../../src/services/connect/relay/engine.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const T0 = 1_800_000_000_000;
const dev = (n: number): Uint8Array => new Uint8Array(24).fill(n);
const A = dev(1);
const B = dev(2);
const C = dev(3);
const STRANGER = dev(9);

const ticket = (
  device: Uint8Array,
  over: Partial<RelayTicket> = {},
): RelayTicket => ({
  device,
  members: [A, B, C],
  dayBytes: 256 * MiB,
  paused: false,
  productOver: false,
  expiresAt: T0 + 60_000,
  ...over,
});
const send = (to: Uint8Array, noise = [7, 7, 7], session = 5): Uint8Array =>
  encodeRelay({ op: "send", to, session, noise: Uint8Array.from(noise) });

function room(opts: Partial<RelayTicket> = {}) {
  const e = new RelayEngine();
  let now = T0;
  const go = (i: Parameters<RelayEngine["step"]>[0]): RelayOutput[] =>
    e.step(i);
  const join = (socket: string, d: Uint8Array, o: Partial<RelayTicket> = {}) =>
    go({ kind: "connect", socket, ticket: ticket(d, { ...opts, ...o }), now });
  const frame = (socket: string, data: Uint8Array | string) =>
    go({ kind: "frame", socket, data, now });
  return {
    e,
    join,
    frame,
    go,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
const spend = (r: ReturnType<typeof room>, n: number): void => {
  const list = encodeRelay({ op: "list" });
  for (let i = 0; i < n; i++) r.frame("a1", list);
};
const closes = (o: RelayOutput[]) =>
  o.flatMap((x) => (x.kind === "close" ? [[x.socket, x.code] as const] : []));
const sent = (o: RelayOutput[], socket: string) =>
  o.flatMap((x) =>
    x.kind === "send" && x.socket === socket
      ? [decodeRelay("toClient", x.data)!]
      : [],
  );
const meters = (o: RelayOutput[]) =>
  o.flatMap((x) => (x.kind === "meter" ? [x.bytes] : []));

describe("relay engine: admission", () => {
  it.each([
    ["a device outside the roster", ticket(STRANGER), RELAY_CLOSE.notMember],
    ["an expired ticket", ticket(A, { expiresAt: T0 }), RELAY_CLOSE.badTicket],
    ["a short device id", ticket(new Uint8Array(23)), RELAY_CLOSE.badTicket],
    [
      "a short member id",
      ticket(A, { members: [A, new Uint8Array(5)] }),
      RELAY_CLOSE.badTicket,
    ],
  ])("closes %s", (_n, t, code) => {
    const e = new RelayEngine();
    expect(
      closes(e.step({ kind: "connect", socket: "s", ticket: t, now: T0 })),
    ).toEqual([["s", code]]);
  });

  it("admits a member and tells it who is online; others hear the arrival", () => {
    const r = room();
    const first = r.join("a1", A);
    expect(sent(first, "a1")).toEqual([{ op: "members", devices: [A] }]);
    const second = r.join("b1", B);
    expect(sent(second, "b1")).toEqual([{ op: "members", devices: [A, B] }]);
    expect(sent(second, "a1")).toEqual([{ op: "members", devices: [A, B] }]);
  });

  it("a second socket of an online device announces nothing", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.join("a2", A);
    expect(sent(out, "b1")).toEqual([]);
  });

  it("closes a duplicate socket id", () => {
    const r = room();
    r.join("a1", A);
    expect(closes(r.join("a1", A))).toEqual([["a1", RELAY_CLOSE.badTicket]]);
  });

  it("a paused admission gets LIMIT 4 and 4008", () => {
    const r = room({ paused: true });
    const out = r.join("a1", A);
    expect(sent(out, "a1")).toEqual([
      { op: "limit", reason: RELAY_LIMIT.paused },
    ]);
    expect(closes(out)).toEqual([["a1", RELAY_CLOSE.limit]]);
  });

  it("a fresh roster without a device closes that device's sockets and announces GONE", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.join("c1", C, { members: [A, C] });
    expect(closes(out)).toEqual([["b1", RELAY_CLOSE.notMember]]);
    expect(sent(out, "a1")).toContainEqual({ op: "gone", device: B });
  });
});

describe("relay engine: socket caps", () => {
  it("a third socket of a device replaces the oldest (4009), with no GONE", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    r.join("a2", A);
    const out = r.join("a3", A);
    expect(closes(out)).toEqual([["a1", RELAY_CLOSE.replaced]]);
    expect(sent(out, "b1").some((m) => m.op === "gone")).toBe(false);
    // the replaced socket is gone: it no longer receives
    const hop = r.frame("b1", send(A));
    expect(hop.filter((x) => x.kind === "send" && x.socket === "a1")).toEqual(
      [],
    );
    expect(sent(hop, "a2").length).toBe(1);
    expect(sent(hop, "a3").length).toBe(1);
  });

  it("the 33rd socket in a room is refused 4008", () => {
    const r = room();
    const members = Array.from({ length: 17 }, (_, i) => dev(i + 1));
    for (let i = 0; i < 16; i++) {
      r.join(`d${i}a`, members[i]!, { members });
      r.join(`d${i}b`, members[i]!, { members });
    }
    expect(closes(r.join("x", members[16]!, { members }))).toEqual([
      ["x", RELAY_CLOSE.limit],
    ]);
    // a device already at two sockets still replaces rather than fails
    expect(closes(r.join("d0c", members[0]!, { members }))).toEqual([
      ["d0a", RELAY_CLOSE.replaced],
    ]);
  });
});

describe("relay engine: SEND", () => {
  it("delivers to every socket of the target with the admitted device as from", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    r.join("b2", B);
    const out = r.frame("a1", send(B, [1, 2, 3], 42));
    const want = {
      op: "recv",
      from: A,
      session: 42,
      noise: Uint8Array.of(1, 2, 3),
    };
    expect(sent(out, "b1")).toEqual([want]);
    expect(sent(out, "b2")).toEqual([want]);
    expect(meters(out)).toEqual([1 + 24 + 4 + 3]);
  });

  it("cannot forge from: a client RECV frame (or any toClient op) is refused 1008", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const forged = encodeRelay({
      op: "recv",
      from: C,
      session: 1,
      noise: Uint8Array.of(1),
    });
    const out = r.frame("a1", forged);
    expect(closes(out)).toEqual([["a1", RELAY_CLOSE.refused]]);
    expect(sent(out, "b1").every((m) => m.op === "gone")).toBe(true);
  });

  it("a forged from bytes inside noise never reaches the stamp", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.frame("a1", send(B, [...C]));
    const m = sent(out, "b1")[0]!;
    expect(m.op === "recv" && Buffer.from(m.from)).toEqual(Buffer.from(A));
  });

  it("a send to a device outside the person's roster closes 4003 and delivers nothing", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.frame("a1", send(STRANGER));
    expect(closes(out)).toEqual([["a1", RELAY_CLOSE.notMember]]);
    expect(meters(out)).toEqual([]);
    expect(sent(out, "b1").filter((m) => m.op === "recv")).toEqual([]);
  });

  it("drops a send to an offline member and to oneself, unmetered", () => {
    const r = room();
    r.join("a1", A);
    expect(r.frame("a1", send(C))).toEqual([]);
    expect(r.frame("a1", send(A))).toEqual([]);
  });

  it("answers PING with PONG echoing the 8 bytes, and LIST with MEMBERS", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const data = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    expect(
      sent(r.frame("a1", encodeRelay({ op: "ping", data })), "a1"),
    ).toEqual([{ op: "pong", data }]);
    expect(sent(r.frame("a1", encodeRelay({ op: "list" })), "a1")).toEqual([
      { op: "members", devices: [A, B] },
    ]);
  });

  it.each([
    ["a text frame", "hello"],
    ["an empty message", new Uint8Array(0)],
    ["a short SEND", Uint8Array.of(0x01, 1, 2, 3)],
    ["an unknown op", Uint8Array.of(0x55, 1)],
    ["a PING of 7 bytes", Uint8Array.of(0x03, 1, 2, 3, 4, 5, 6, 7)],
    ["an oversize message", new Uint8Array(65565).fill(1, 0, 1)],
  ])("%s closes 1008 and is never answered", (_n, data) => {
    const r = room();
    r.join("a1", A);
    const out = r.frame("a1", data);
    expect(sent(out, "a1")).toEqual([]);
    expect(closes(out)).toEqual([["a1", RELAY_CLOSE.refused]]);
    // frames after the close are lost
    expect(r.frame("a1", encodeRelay({ op: "list" }))).toEqual([]);
  });
});

describe("relay engine: token bucket", () => {
  it("allows the burst of 400, then LIMIT 1; refills at 200 a second", () => {
    const r = room();
    r.join("a1", A);
    const list = encodeRelay({ op: "list" });
    for (let i = 0; i < 400; i++)
      expect(sent(r.frame("a1", list), "a1")[0]?.op).toBe("members");
    expect(sent(r.frame("a1", list), "a1")).toEqual([
      { op: "limit", reason: RELAY_LIMIT.rate },
    ]);
    r.advance(1000); // 200 tokens
    for (let i = 0; i < 200; i++)
      expect(sent(r.frame("a1", list), "a1")[0]?.op).toBe("members");
    expect(sent(r.frame("a1", list), "a1")[0]).toEqual({
      op: "limit",
      reason: 1,
    });
  });

  it("a 1,000-a-second flood still reaches the strike close: accepted frames between strikes do not reset it", () => {
    const r = room();
    r.join("a1", A);
    const list = encodeRelay({ op: "list" });
    spend(r, 400); // the burst
    let closed = false;
    // 1,000 a second: one frame per millisecond; the refill wins a token every fifth.
    for (let i = 0; i < 5000 && !closed; i++) {
      r.advance(1);
      closed = closes(r.frame("a1", list)).some(
        ([, c]) => c === RELAY_CLOSE.limit,
      );
    }
    expect(closed).toBe(true);
  });

  it("strikes decay after a second without one", () => {
    const r = room();
    r.join("a1", A);
    const list = encodeRelay({ op: "list" });
    spend(r, 400);
    for (let i = 0; i < RATE_STRIKES_MAX - 1; i++) r.frame("a1", list);
    r.advance(1500); // quiet: the strikes decay on the next accepted frame
    expect(sent(r.frame("a1", list), "a1")[0]?.op).toBe("members");
    spend(r, 400);
    const out = r.frame("a1", list);
    expect(closes(out)).toEqual([]);
  });

  it("a members update closes the sockets of devices that left (4003) and announces them gone", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.go({ kind: "members", members: [A, C] });
    expect(closes(out)).toEqual([["b1", RELAY_CLOSE.notMember]]);
    expect(sent(out, "a1").map((m) => m.op)).toEqual(["gone"]);
  });

  it("is per socket", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const list = encodeRelay({ op: "list" });
    spend(r, 401);
    expect(sent(r.frame("b1", list), "b1")[0]?.op).toBe("members");
  });

  it("garbage spends tokens too: a flood of bad frames cannot dodge the bucket", () => {
    const r = room();
    r.join("a1", A);
    spend(r, 400);
    const out = r.frame("a1", Uint8Array.of(0x55));
    expect(closes(out)).toEqual([]);
    expect(sent(out, "a1")).toEqual([{ op: "limit", reason: 1 }]);
  });

  it(`closes 4008 after ${RATE_STRIKES_MAX} consecutive limited messages`, () => {
    const r = room();
    r.join("a1", A);
    const list = encodeRelay({ op: "list" });
    spend(r, 400);
    let last: RelayOutput[] = [];
    for (let i = 0; i < RATE_STRIKES_MAX; i++) last = r.frame("a1", list);
    expect(closes(last)).toEqual([["a1", RELAY_CLOSE.limit]]);
  });
});

describe("relay engine: bytes and LIMIT", () => {
  const sendLen = 1 + 24 + 4 + 100;
  const big = (): Uint8Array =>
    send(
      B,
      Array.from({ length: 100 }, () => 1),
    );

  it("refuses a send that would pass the day's bytes: LIMIT 2, no delivery, no meter", () => {
    const r = room({ dayBytes: sendLen * 2 });
    r.join("a1", A);
    r.join("b1", B);
    expect(meters(r.frame("a1", big()))).toEqual([sendLen]);
    expect(meters(r.frame("a1", big()))).toEqual([sendLen]);
    const out = r.frame("a1", big());
    expect(sent(out, "a1")).toEqual([
      { op: "limit", reason: RELAY_LIMIT.person },
    ]);
    expect(sent(out, "b1")).toEqual([]);
    expect(meters(out)).toEqual([]);
    expect(closes(out)).toEqual([]);
  });

  it("the day rolls over at UTC midnight", () => {
    const r = room({ dayBytes: sendLen });
    r.join("a1", A);
    r.join("b1", B);
    r.frame("a1", big());
    expect(sent(r.frame("a1", big()), "a1")[0]).toEqual({
      op: "limit",
      reason: 2,
    });
    r.advance(86_400_000);
    expect(meters(r.frame("a1", big()))).toEqual([sendLen]);
  });

  it("the quota is shared by every device of the person", () => {
    const r = room({ dayBytes: sendLen });
    r.join("a1", A);
    r.join("b1", B);
    r.join("c1", C);
    r.frame("a1", big());
    expect(sent(r.frame("b1", send(C, Array(100).fill(1))), "b1")[0]).toEqual({
      op: "limit",
      reason: 2,
    });
  });

  it("clamps a quota to 4 GiB and a bad quota to the unlicensed 16 MiB", () => {
    const hi = room({ dayBytes: 100 * GiB });
    hi.join("a1", A);
    expect(hi.e.snapshot().dayBytesQuota).toBe(4 * GiB);
    for (const bad of [NaN, -1, Infinity]) {
      const r = room({ dayBytes: bad });
      r.join("a1", A);
      expect(r.e.snapshot().dayBytesQuota).toBe(16 * MiB);
    }
  });

  it("LIMIT 3 when the product's month is spent; LIMIT 4 on a pause, announced once", () => {
    const r = room({ productOver: true });
    r.join("a1", A);
    r.join("b1", B);
    expect(sent(r.frame("a1", big()), "a1")).toEqual([
      { op: "limit", reason: 3 },
    ]);
    const paused = r.go({ kind: "tick", now: r.now(), paused: true });
    expect(sent(paused, "a1")).toEqual([{ op: "limit", reason: 4 }]);
    expect(sent(paused, "b1")).toEqual([{ op: "limit", reason: 4 }]);
    expect(r.go({ kind: "tick", now: r.now(), paused: true })).toEqual([]);
    expect(sent(r.frame("a1", big()), "a1")).toEqual([
      { op: "limit", reason: 4 },
    ]);
    r.go({ kind: "tick", now: r.now(), paused: false, productOver: false });
    expect(meters(r.frame("a1", big()))).toEqual([sendLen]);
  });
});

describe("relay engine: GONE, RING, restore", () => {
  it("GONE fans out to every other socket when a device's last socket closes", () => {
    const r = room();
    r.join("a1", A);
    r.join("a2", A);
    r.join("b1", B);
    r.join("c1", C);
    expect(
      sent(r.go({ kind: "close", socket: "a1", now: r.now() }), "b1"),
    ).toEqual([]);
    const out = r.go({ kind: "close", socket: "a2", now: r.now() });
    for (const s of ["b1", "c1"])
      expect(sent(out, s)).toEqual([{ op: "gone", device: A }]);
    expect(sent(out, "a2")).toEqual([]);
  });

  it("a refused envelope also announces GONE for a last socket", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    expect(sent(r.frame("a1", "x"), "b1")).toContainEqual({
      op: "gone",
      device: A,
    });
  });

  it("closing an unknown socket does nothing", () => {
    expect(room().go({ kind: "close", socket: "zz", now: T0 })).toEqual([]);
  });

  it("RING reaches every socket", () => {
    const r = room();
    r.join("a1", A);
    r.join("b1", B);
    const out = r.go({ kind: "ring", epoch: 9 });
    expect(sent(out, "a1")).toEqual([{ op: "ring", epoch: 9 }]);
    expect(sent(out, "b1")).toEqual([{ op: "ring", epoch: 9 }]);
  });

  it("restore rebuilds sockets, roster, quota and the day's bytes", () => {
    const r = room({ dayBytes: 200 });
    r.join("a1", A);
    r.join("b1", B);
    r.frame("a1", send(B, [1]));
    const snap = r.e.snapshot();
    const e = new RelayEngine();
    e.restore(snap, T0);
    const out = e.step({
      kind: "frame",
      socket: "a1",
      data: send(B, [1]),
      now: T0,
    });
    expect(sent(out, "b1")[0]?.op).toBe("recv");
    expect(e.snapshot().dayUsed).toBe(2 * (1 + 24 + 4 + 1));
  });
});
