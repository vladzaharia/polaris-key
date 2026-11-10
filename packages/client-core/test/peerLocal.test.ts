// Local links (V5 §15.12): behaviour the corpus rows do not pin. The known answers are
// `conformance/corpus/v2/peer-matrix.json` `local`, run by the conformance runners.

import { describe, expect, it } from "vitest";
import {
  LocalPairingGate,
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
  it("asks for a rotation after each failed guess but the closing one", () => {
    const w = new PairingWindow();
    w.open(0);
    const rotates: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      w.c1(i * 10, true);
      rotates.push(w.msg1(i * 10 + 1, false).rotate);
    }
    expect(rotates).toEqual([true, true, true, true, false]);
    expect(w.state.open).toBe(false);
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
