// The mode-v vouch codecs (WIRE-CONTRACT-V5 §15.6.1): VOUCH_REQ built by a real device key store
// and verified, VOUCH_RESULT, the approve-answer table, the decoys and their positions, the
// advert instance, the failure budget and the order guard. The shared vectors run in
// `conformance/runners` (peer-matrix `vouch`); these are the behaviours rows cannot show.
import { beforeAll, describe, expect, it } from "vitest";
import {
  RECORD,
  VOUCH_HELD_BYTES,
  VOUCH_HELD_RECORDS,
  VouchFailureBudget,
  VouchFlow,
  approverInstance,
  buildVouchRequest,
  buildVouchResult,
  createWebDeviceKeyStore,
  decoyCodes,
  finishMap,
  memoryDeviceKeyStorage,
  parseVouchResult,
  verifyVouchRequest,
  type DeviceKeyPort,
  type VouchRecord,
  type VouchStatus,
} from "../src/index.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const SLUG = "demo";
const DEVICE = "yLOTkYomb4xKmDRpnlnvrvB4_ktxXwrS";
const REQUEST = "nr_0IvbE7YHMGPBP0VAfZDQhg";
const H = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_H = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const HELLO = { label: "Ana's Switch", platform: "linux" };

let port: DeviceKeyPort;
let body: Uint8Array;

beforeAll(async () => {
  port = createWebDeviceKeyStore({ storage: memoryDeviceKeyStorage() });
  body = await buildVouchRequest({
    port,
    slug: SLUG,
    h: H,
    request: REQUEST,
    deviceId: DEVICE,
    hello: HELLO,
  });
});

const edit = (f: (o: Record<string, unknown>) => void): Uint8Array => {
  const o = JSON.parse(text(body)) as Record<string, unknown>;
  f(o);
  return utf8(JSON.stringify(o));
};
const verify = (b: Uint8Array, h = H, hello: typeof HELLO | object = HELLO) =>
  verifyVouchRequest({
    slug: SLUG,
    h,
    hello: hello as typeof HELLO,
    body: b,
  });

describe("VOUCH_REQ", () => {
  it("a built request verifies and shows what D's HELLO showed", async () => {
    const keys = await port.ensure();
    expect(await verify(body)).toEqual({
      request: REQUEST,
      deviceId: DEVICE,
      signKey: keys.signKey,
      agreeKey: keys.agreeKey,
      label: HELLO.label,
      platform: "linux",
    });
    const o = JSON.parse(text(body)) as Record<string, unknown>;
    expect(Object.keys(o)).toEqual([
      "v",
      "request",
      "deviceId",
      "signKey",
      "agreeKey",
      "label",
      "platform",
      "sig",
    ]);
  });

  it("omits label when HELLO had none, and then a label is refused", async () => {
    const b = await buildVouchRequest({
      port,
      slug: SLUG,
      h: H,
      request: REQUEST,
      deviceId: DEVICE,
      hello: { platform: "linux" },
    });
    expect(JSON.parse(text(b))).not.toHaveProperty("label");
    expect((await verify(b, H, { platform: "linux" }))?.label).toBeNull();
    expect(await verify(b, H, HELLO)).toBeNull();
    expect(await verify(body, H, { platform: "linux" })).toBeNull();
  });

  it("is bound to one session: another h refuses it", async () => {
    expect(await verify(body, OTHER_H)).toBeNull();
  });

  it("refuses a changed field, each of which the proof or the checks cover", async () => {
    expect(
      await verify(edit((o) => (o.request = "nr_AAAAAAAAAAAAAAAAAAAAAA"))),
    ).toBeNull();
    expect(
      await verify(edit((o) => (o.deviceId = DEVICE.replace("y", "z")))),
    ).toBeNull();
    expect(await verify(edit((o) => (o.label = "Someone else")))).toBeNull();
    expect(await verify(edit((o) => (o.platform = "windows")))).toBeNull();
    expect(await verify(edit((o) => delete o.sig))).toBeNull();
    expect(await verify(edit((o) => (o.v = 2)))).toBeNull();
    const other = createWebDeviceKeyStore({
      storage: memoryDeviceKeyStorage(),
    });
    const otherKeys = await other.ensure();
    expect(
      await verify(edit((o) => (o.signKey = otherKeys.signKey))),
    ).toBeNull();
  });

  it("ignores unknown members and refuses a body over 4 KiB", async () => {
    expect(await verify(edit((o) => (o.extra = [1, 2])))).not.toBeNull();
    expect(await verify(edit((o) => (o.extra = "x".repeat(4096))))).toBeNull();
  });

  it("refuses a bad input when building, and never names a value", async () => {
    const base = {
      port,
      slug: SLUG,
      h: H,
      request: REQUEST,
      deviceId: DEVICE,
      hello: HELLO,
    };
    await expect(
      buildVouchRequest({ ...base, h: H.slice(1) }),
    ).rejects.toThrow();
    await expect(
      buildVouchRequest({ ...base, request: "nr_short" }),
    ).rejects.toThrow("vouch request: bad input");
    await expect(
      buildVouchRequest({ ...base, deviceId: "short" }),
    ).rejects.toThrow();
    await expect(
      buildVouchRequest({
        ...base,
        hello: { platform: "p", label: "x".repeat(5000) },
      }),
    ).rejects.toThrow("vouch request: too large");
  });
});

describe("VOUCH_RESULT", () => {
  it("round-trips the three statuses and reads an unknown one as denied", () => {
    for (const s of ["approved", "denied", "expired"] as const)
      expect(parseVouchResult(buildVouchResult(s))).toEqual({ status: s });
    expect(parseVouchResult(utf8('{"status":"not_nearby"}'))).toEqual({
      status: "denied",
    });
    expect(parseVouchResult(utf8("[]"))).toEqual({ refuse: "peer_bad_frame" });
  });
});

describe("finishMap", () => {
  const ans = (http: number | null, b: string | null = null, o = {}) =>
    finishMap({
      http,
      body: b,
      discoveryNearby: true,
      keysRetried: false,
      ...o,
    });
  it("maps the table", () => {
    expect(ans(200, '{"status":"approved"}')).toEqual({ send: "approved" });
    expect(ans(204)).toEqual({ send: "denied" });
    expect(ans(403, '{"code":"not_nearby"}')).toEqual({ send: "denied" });
    expect(ans(403, '{"code":"device_limit"}')).toEqual({ send: "denied" });
    expect(ans(404)).toEqual({ send: "expired" });
    expect(ans(200, '{"status":"choose"}')).toEqual({ wait: "choice" });
    expect(ans(409, '{"code":"device_keys_required"}')).toEqual({
      wait: "keys",
    });
    expect(ans(409, '{"code":"license_choice_required"}')).toEqual({
      wait: "choice",
    });
  });
  it("closes on everything else; the keys retry happens once", () => {
    const stop = { close: true, stopAdvert: false };
    for (const [h, b] of [
      [null, null],
      [400, null],
      [403, '{"code":"account_required"}'],
      [409, '{"code":"conflict"}'],
      [429, null],
      [503, null],
      [200, null],
      [201, '{"status":"approved"}'],
    ] as const)
      expect(ans(h, b), `${h}`).toEqual(stop);
    expect(
      ans(409, '{"code":"device_keys_required"}', { keysRetried: true }),
    ).toEqual(stop);
  });
  it("a 404 after discovery lost nearby closes and stops the advert", () => {
    expect(ans(404, null, { discoveryNearby: false })).toEqual({
      close: true,
      stopAdvert: true,
    });
  });
});

/** A source that hands out the given 32-bit draws, then bytes of a counter. */
const draws = (...n: number[]) => {
  let i = 0;
  return (len: number): Uint8Array => {
    expect(len).toBe(4);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n[i++] ?? 0xffff_fff0 - i);
    return out;
  };
};

describe("decoyCodes", () => {
  it("gives three distinct codes in range with the real one at index", () => {
    for (let i = 0; i < 200; i++) {
      const real = Math.floor(Math.random() * 1_000_000);
      const { codes, index } = decoyCodes(real);
      expect(new Set(codes).size).toBe(3);
      for (const c of codes)
        expect(Number.isInteger(c) && c >= 0 && c < 1_000_000).toBe(true);
      expect(codes[index]).toBe(real);
    }
  });

  it("rejects a draw in the biased tail and a draw equal to a code already held", () => {
    // 2^32 = 4294 * 10^6 + 967296, so 4_294_000_000 and above is the biased tail.
    const limit = 4_294_000_000;
    const src = draws(
      limit, // rejected: tail
      0xffff_ffff, // rejected: tail
      7, // = real 7: rejected as a duplicate
      123_456, // decoy 1
      123_456, // duplicate of decoy 1: rejected
      999_999, // decoy 2
      0, // shuffle: position for slot 2
      0, // shuffle: position for slot 1
    );
    const { codes } = decoyCodes(7, src);
    expect(new Set(codes)).toEqual(new Set([7, 123_456, 999_999]));
  });

  it("a source that cannot produce a value is given up on, not looped on", () => {
    expect(() =>
      decoyCodes(5, () => new Uint8Array([0xff, 0xff, 0xff, 0xff])),
    ).toThrow("vouch: random source");
    expect(() => decoyCodes(5, () => new Uint8Array(4))).toThrow(
      "vouch: random source",
    );
  });

  it("refuses a real code outside [0, 10^6)", () => {
    for (const bad of [-1, 1_000_000, 1.5, Number.NaN])
      expect(() => decoyCodes(bad)).toThrow();
  });

  it("puts the real code at each position about equally often", () => {
    const seen = [0, 0, 0];
    for (let i = 0; i < 3000; i++) seen[decoyCodes(42).index]!++;
    for (const n of seen) expect(n).toBeGreaterThan(800);
    for (const n of seen) expect(n).toBeLessThan(1200);
  });

  it("the shuffle is a Fisher-Yates over three slots, every order reachable", () => {
    const orders = new Set<string>();
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 2; b++) {
        // real=1; decoys 2 and 3 by draws 2 and 3, then the shuffle's two draws.
        const { codes } = decoyCodes(1, draws(2, 3, a, b));
        orders.add(codes.join());
      }
    expect(orders.size).toBe(6);
  });
});

describe("approverInstance", () => {
  it("is p1- and 16 base32 characters of 10 random bytes", () => {
    const i = approverInstance();
    expect(i).toMatch(/^p1-[a-z2-7]{16}$/);
    expect(approverInstance()).not.toBe(i);
    let asked = 0;
    approverInstance((n) => {
      asked = n;
      return new Uint8Array(n);
    });
    expect(asked).toBe(10);
    expect(approverInstance(() => new Uint8Array(10))).toBe(
      "p1-" + "a".repeat(16),
    );
  });
});

describe("VouchFailureBudget", () => {
  it("stops the advert at the second failure within 10 minutes, until reopened", () => {
    let t = 0;
    const b = new VouchFailureBudget(() => t);
    expect(b.fail()).toBe(false);
    t = 599;
    expect(b.fail()).toBe(true);
    expect(b.stopped).toBe(true);
    b.reopen();
    expect(b.stopped).toBe(false);
    expect(b.fail()).toBe(false);
  });
  it("a failure older than the window does not count", () => {
    let t = 0;
    const b = new VouchFailureBudget(() => t);
    b.fail();
    t = 600;
    expect(b.fail()).toBe(false);
    expect(b.stopped).toBe(false);
  });
});

const rec = (type: number, b: Uint8Array = new Uint8Array(0)): VouchRecord => ({
  type,
  body: b,
});
const result = (s: VouchStatus) =>
  rec(RECORD.VOUCH_RESULT, buildVouchResult(s));
const CAPS = ["app/1", "vouch/1"];

/** M and D, negotiated and showing their codes. */
function pair() {
  const d = new VouchFlow("requester");
  const m = new VouchFlow("approver");
  expect(d.negotiate(CAPS, CAPS).ok).toBe(true);
  expect(m.negotiate(CAPS, CAPS).ok).toBe(true);
  d.codeShown();
  m.codeShown();
  return { d, m };
}

describe("VouchFlow", () => {
  it("negotiation fails closed: nothing passes before it, and vouch/1 is needed", () => {
    const m = new VouchFlow("approver");
    expect(m.receive(rec(RECORD.VOUCH_REQ))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
    const d = new VouchFlow("requester");
    expect(d.negotiate(["vouch/2"], ["vouch/2"])).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
    expect(d.send(rec(RECORD.VOUCH_REQ))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
  });

  it("M gets the request only after the right pick, and may finish only then", () => {
    const { m } = pair();
    const req = rec(RECORD.VOUCH_REQ, utf8("{}"));
    expect(m.receive(req)).toEqual({ ok: true, deliver: [] });
    expect(m.mayFinish).toBe(false);
    expect(m.picked()).toEqual({ ok: true, deliver: [req] });
    expect(m.mayFinish).toBe(false); // verified is the host's next step
    m.verified();
    expect(m.mayFinish).toBe(true);
    expect(m.send(result("approved")).ok).toBe(true);
    expect(m.mayFinish).toBe(false); // one result
  });

  it("M cannot send a result before the request verified", () => {
    const { m } = pair();
    m.receive(rec(RECORD.VOUCH_REQ));
    m.picked();
    expect(m.send(result("approved"))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
  });

  it("a wrong pick, none-match and stop close peer_bye; a timeout peer_timeout; none delivers", () => {
    for (const [why, code] of [
      ["wrong-pick", "peer_bye"],
      ["none-match", "peer_bye"],
      ["stop", "peer_bye"],
      ["timeout", "peer_timeout"],
    ] as const) {
      const { m } = pair();
      m.receive(rec(RECORD.VOUCH_REQ));
      expect(m.abandon(why)).toEqual({ ok: false, close: code });
      expect(m.picked()).toEqual({ ok: false, close: code }); // dead, same code
      expect(m.mayFinish).toBe(false);
    }
  });

  it("a pick before the codes were shown, and on D, is refused", () => {
    const m = new VouchFlow("approver");
    m.negotiate(CAPS, CAPS);
    expect(m.picked()).toEqual({ ok: false, close: "peer_not_allowed" });
    const { d } = pair();
    expect(d.picked()).toEqual({ ok: false, close: "peer_not_allowed" });
  });

  it("D sends its request once, only after the code", () => {
    const d = new VouchFlow("requester");
    d.negotiate(CAPS, CAPS);
    expect(d.send(rec(RECORD.VOUCH_REQ)).ok).toBe(false);
    const { d: d2 } = pair();
    expect(d2.send(rec(RECORD.VOUCH_REQ)).ok).toBe(true);
    expect(d2.send(rec(RECORD.VOUCH_REQ))).toEqual({
      ok: false,
      close: "peer_bad_frame",
    });
  });

  it("D reads a result only after its request, once, with a good body", () => {
    const { d } = pair();
    expect(d.receive(result("approved"))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
    const e = pair().d;
    e.send(rec(RECORD.VOUCH_REQ));
    expect(e.receive(rec(RECORD.VOUCH_RESULT, utf8("[]")))).toEqual({
      ok: false,
      close: "peer_bad_frame",
    });
    const f = pair().d;
    f.send(rec(RECORD.VOUCH_REQ));
    const r = result("denied");
    expect(f.receive(r)).toEqual({ ok: true, deliver: [r] });
    expect(f.receive(result("denied"))).toEqual({
      ok: false,
      close: "peer_bad_frame",
    });
  });

  it("directions: D refuses a request, M refuses a result and any 0x003x from D", () => {
    const { d, m } = pair();
    expect(d.receive(rec(RECORD.VOUCH_REQ)).ok).toBe(false);
    expect(m.receive(result("approved"))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
    const m2 = pair().m;
    expect(m2.receive(rec(RECORD.KEYRING_WRAP))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
    expect(m2.send(result("approved")).ok).toBe(false);
    expect(m2.send(rec(RECORD.KEYRING_WRAP))).toEqual({
      ok: false,
      close: "peer_not_allowed",
    });
  });

  /** D after an approved result. */
  function approved() {
    const d = pair().d;
    d.send(rec(RECORD.VOUCH_REQ));
    d.receive(result("approved"));
    return d;
  }

  it("D holds sync records until its person confirms the account (rule 12)", () => {
    const d = approved();
    const a = rec(0x0030, new Uint8Array(10));
    const b = rec(0x003f, new Uint8Array(10));
    expect(d.receive(a)).toEqual({ ok: true, deliver: [] });
    expect(d.receive(b)).toEqual({ ok: true, deliver: [] });
    expect(d.confirmAccount()).toEqual({ ok: true, deliver: [a, b] });
    const c = rec(0x0031, new Uint8Array(10));
    expect(d.receive(c)).toEqual({ ok: true, deliver: [c] });
  });

  it("D keeps 16 records and 16 KiB, then closes peer_busy", () => {
    const d = approved();
    for (let i = 0; i < VOUCH_HELD_RECORDS; i++)
      expect(d.receive(rec(0x0030)).ok).toBe(true);
    expect(d.receive(rec(0x0030))).toEqual({ ok: false, close: "peer_busy" });
    const e = approved();
    expect(e.receive(rec(0x0030, new Uint8Array(VOUCH_HELD_BYTES))).ok).toBe(
      true,
    );
    expect(e.receive(rec(0x0030, new Uint8Array(1)))).toEqual({
      ok: false,
      close: "peer_busy",
    });
  });

  it("a decline drops every held record and the flow stays closed", () => {
    const d = approved();
    d.receive(rec(0x0030, new Uint8Array(5)));
    expect(d.declineAccount()).toEqual({ ok: false, close: "peer_bye" });
    expect(d.confirmAccount()).toEqual({ ok: false, close: "peer_bye" });
    expect(d.receive(rec(0x0031))).toEqual({ ok: false, close: "peer_bye" });
  });

  it("a denied or expired result lets no record through", () => {
    for (const s of ["denied", "expired"] as const) {
      const d = pair().d;
      d.send(rec(RECORD.VOUCH_REQ));
      d.receive(result(s));
      expect(d.receive(rec(0x0030))).toEqual({
        ok: false,
        close: "peer_not_allowed",
      });
    }
  });

  it("records outside the vouch set pass through untouched", () => {
    const { m } = pair();
    const ping = rec(RECORD.PING, new Uint8Array(8));
    expect(m.receive(ping)).toEqual({ ok: true, deliver: [ping] });
  });
});
