// Local links (V5 §15.12): behaviour the corpus rows do not pin. The known answers are
// `conformance/corpus/v2/peer-matrix.json` `local`, run by the conformance runners.

import { describe, expect, it } from "vitest";
import {
  LocalPairingGate,
  DialBudget,
  PairingWindow,
  displayCode,
  drawNameplate,
  drawPassword,
  localPairingOf,
  makeQr,
  pairingInstance,
  parseCode,
  parseQr,
  randomByteSource,
} from "../src/index.js";

describe("local codes", () => {
  it("a drawn code reads back through the typed form", () => {
    for (let i = 0; i < 50; i++) {
      const n = drawNameplate(randomByteSource)!;
      const p = drawPassword(randomByteSource)!;
      expect(n).toMatch(/^[0-9]{2}$/);
      expect(p).toMatch(/^[0-9]{6}$/);
      const back = parseCode(displayCode(n, p));
      expect(back).toEqual({ ok: true, nameplate: n, password: p });
    }
  });

  it("a QR made for a window reads back as the app's own", () => {
    const sid = globalThis.crypto.getRandomValues(new Uint8Array(10));
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const qr = makeQr("demo", pairingInstance(sid), secret);
    const got = parseQr(qr, "demo");
    expect(got).toMatchObject({ result: "ok", instance: pairingInstance(sid) });
    if (got.result === "ok") expect(got.secret).toEqual(secret);
    expect(parseQr(qr, "other").result).toBe("other-app");
  });
});

describe("the pairing window", () => {
  it("asks for a rotation after each failed guess but the closing one, and holds until rotated", () => {
    const w = new PairingWindow();
    w.open(0);
    const rotates: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const c = w.c1(i * 10, true);
      expect(w.beginGuess(c.id!, i * 10 + 1)).toBe(true);
      rotates.push(w.guessFailed(c.id!, i * 10 + 1).rotate);
      if (i < 4) {
        expect(w.c1(i * 10 + 2, true).result).toBe("busy");
        w.rotated(i * 10 + 2);
      }
    }
    expect(rotates).toEqual([true, true, true, true, false]);
    expect(w.state.open).toBe(false);
  });

  it("counts a guess before its verdict and gives the permit once, to the holder only", () => {
    const w = new PairingWindow();
    w.open(0);
    const a = w.c1(1, true).id!;
    expect(w.beginGuess(a + 1, 2)).toBe(false);
    expect(w.beginGuess(a, 2)).toBe(true);
    expect(w.state.failures).toBe(1);
    expect(w.beginGuess(a, 3)).toBe(false);
    expect(w.guessOpened(a, 3).result).toBe("transport");
    expect(w.state.failures).toBe(0);
  });

  it("refuses a permit to an attempt that ran out its 30 s", () => {
    const w = new PairingWindow();
    w.open(0);
    const a = w.c1(1, true).id!;
    expect(w.beginGuess(a, 31)).toBe(false);
    expect(w.state.failures).toBe(0);
  });
});

describe("the dial budget", () => {
  it("spends two dials per nameplate in 300 s across joins", () => {
    const b = new DialBudget();
    expect(b.check("48", 0).allowed).toBe(true);
    b.spend("48", 0, 1);
    b.spend("48", 5, 1);
    expect(b.check("48", 10).allowed).toBe(false);
    expect(b.check("49", 10).allowed).toBe(true);
    expect(b.check("48", 301).allowed).toBe(true);
  });
});

describe("the gate", () => {
  it("is on only for the boolean true", () => {
    const body = (v: unknown): unknown => ({
      services: { connect: { enabled: true, localPairing: v } },
    });
    expect(localPairingOf(body(true))).toBe(true);
    for (const v of [false, 1, "true", null, undefined, {}])
      expect(localPairingOf(body(v))).toBe(false);
  });

  it("a successful read that turns it off withdraws; a failed read changes nothing", () => {
    const g = new LocalPairingGate("on");
    expect(g.readError()).toEqual([]);
    expect(g.allowed).toBe(true);
    expect(g.readOk({})).toHaveLength(3);
    expect(g.check()).toBe("local-pairing-off");
  });
});
