import { describe, expect, it } from "vitest";
import {
  RELAY_BURST,
  RELAY_RATE,
  RelayOutbox,
  RelayPacer,
} from "../src/peer/index.js";

/** A clock and a timer the test moves by hand. */
function rig(maxBytes?: number) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const wrote: number[] = [];
  const pacer = new RelayPacer(RELAY_RATE, RELAY_BURST, () => now);
  const out = new RelayOutbox((d) => wrote.push(d.length), {
    pacer,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    timer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t) >>> 0, 1);
    },
  });
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const t = timers[0];
      if (t === undefined || t.at > end) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
    }
    now = end;
  };
  return { out, pacer, wrote, advance, timers };
}
const env = (n = 10) => new Uint8Array(n);

describe("RelayPacer and RelayOutbox (D-9)", () => {
  it("lets a burst of 360 straight through and holds the 361st", () => {
    const { out, wrote } = rig();
    for (let i = 0; i < 400; i++) out.push(env());
    expect(wrote).toHaveLength(360);
    expect(out.length).toBe(40);
  });

  it("then sends 180 a second", () => {
    const { out, wrote, advance } = rig();
    for (let i = 0; i < 1000; i++) out.push(env());
    expect(wrote).toHaveLength(360);
    advance(1000);
    expect(wrote.length).toBeGreaterThanOrEqual(539);
    expect(wrote.length).toBeLessThanOrEqual(541);
    advance(1000);
    expect(wrote.length).toBeGreaterThanOrEqual(719);
    expect(wrote.length).toBeLessThanOrEqual(721);
  });

  it("LIMIT 1 halves the rate for 10 s", () => {
    const { out, pacer, wrote, advance } = rig();
    for (let i = 0; i < 360; i++) out.push(env());
    out.halve();
    expect(pacer.rate).toBe(90);
    for (let i = 0; i < 2000; i++) out.push(env());
    const before = wrote.length;
    advance(1000);
    const got = wrote.length - before;
    expect(got).toBeGreaterThanOrEqual(89);
    expect(got).toBeLessThanOrEqual(91);
    advance(9_000);
    expect(pacer.rate).toBe(180);
  });

  it("refuses a message past 8 MiB, takes forced envelopes, and frees room as it sends", () => {
    const { out, advance } = rig();
    // Spend the burst so nothing leaves.
    while (out.pacer.tryTake() === 0);
    const mib = 1024 * 1024;
    for (let i = 0; i < 8; i++) expect(out.push(env(mib))).toBe(true);
    expect(out.queued).toBe(8 * mib);
    expect(out.push(env(1))).toBe(false);
    expect(out.push(env(1), true)).toBe(true);
    advance(1000);
    expect(out.push(env(1))).toBe(true);
  });

  it("flush writes everything past the pacer, clear drops it", () => {
    const a = rig();
    while (a.out.pacer.tryTake() === 0);
    a.out.push(env());
    a.out.push(env());
    expect(a.wrote).toHaveLength(0);
    a.out.flush();
    expect(a.wrote).toHaveLength(2);
    a.out.push(env());
    a.out.clear();
    a.advance(5000);
    expect(a.wrote).toHaveLength(2);
    expect(a.out.queued).toBe(0);
  });
});
