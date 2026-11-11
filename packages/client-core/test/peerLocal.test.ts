// Local links (V5 §15.12): behaviour the corpus rows do not pin. The known answers are
// `conformance/corpus/v2/peer-matrix.json` `local`, run by the conformance runners.

import { describe, expect, it } from "vitest";
import {
  LocalPairingGate,
  DialBudget,
  JoinPlan,
  NameplateMemory,
  RenewFloor,
  dialsLeft,
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

describe("dialsLeft", () => {
  it("is null until two digits are typed, ignoring spaces and hyphens", () => {
    const b = new DialBudget();
    for (const s of ["", "4", " 4 ", "a4812", "-", "4a", "\u0664\u0668"])
      expect(dialsLeft(b, s, 0), JSON.stringify(s)).toBeNull();
    for (const s of ["48", "4 8", "4-8", " 48 12", "4812 3456"])
      expect(dialsLeft(b, s, 0), JSON.stringify(s)).toBe(2);
  });

  it("is two less the dials spent, per nameplate, and frees after 300 s", () => {
    const b = new DialBudget();
    b.spend("48", 0, 1);
    expect(dialsLeft(b, "48", 1)).toBe(1);
    expect(dialsLeft(b, "49", 1)).toBe(2);
    b.spend("48", 10, 1);
    expect(dialsLeft(b, "4812", 11)).toBe(0);
    expect(dialsLeft(b, "48", 300)).toBe(1);
    expect(dialsLeft(b, "48", 310)).toBe(2);
  });

  it("spends and keeps nothing", () => {
    const b = new DialBudget();
    dialsLeft(b, "48 12", 0);
    expect(b.check("48", 0)).toEqual({ allowed: true, used: 0 });
  });
});

describe("NameplateMemory", () => {
  it("keeps a nameplate until 300 s after its window closed, and the latest close wins", () => {
    const m = new NameplateMemory();
    m.shown("48", 100);
    m.shown("48", 50);
    expect(m.recent(399)).toEqual(["48"]);
    expect(m.recent(400)).toEqual([]);
    m.shown("48", 500);
    expect(m.recent(700)).toEqual(["48"]);
  });
});

describe("NameplateMemory.draw", () => {
  const stream =
    (...b: number[]) =>
    (n: number) =>
      b.length >= n ? Uint8Array.from(b.splice(0, n)) : null;
  const two = (n: number): string => String(n).padStart(2, "0");

  it("draws among the nameplates it does not hold", () => {
    const m = new NameplateMemory();
    m.shown("48", 0);
    expect(m.draw(stream(48, 55), 10)).toBe("55");
  });

  it("holding all 100 takes the oldest close, the lowest on a tie, and reads no byte", () => {
    const m = new NameplateMemory();
    for (let i = 0; i < 100; i++) m.shown(two(i), i < 50 ? 20 : 10);
    const s = stream(1, 2);
    expect(m.draw(s, 30)).toBe("50");
    expect(s(2)).not.toBeNull();
  });
});

describe("RenewFloor", () => {
  it("one wrong-code end is free, the second within 600 s starts 30 s, and too-many-tries starts 30 s at once", () => {
    const f = new RenewFloor();
    f.ended("wrong-code", 0);
    expect(f.check(1).allowed).toBe(true);
    f.ended("wrong-code", 599);
    expect(f.check(600)).toEqual({ allowed: false, retryIn: 29 });
    expect(f.check(629).allowed).toBe(true);
    const g = new RenewFloor();
    g.ended("too-many-tries", 5);
    expect(g.check(34)).toEqual({ allowed: false, retryIn: 1 });
    expect(g.check(35).allowed).toBe(true);
  });
});

describe("JoinPlan reasons", () => {
  const code = { kind: "code", nameplate: "48" } as const;
  const seen = (p: JoinPlan): JoinPlan => {
    p.see("p1-a", true, "48");
    p.see("p1-b", true, "48");
    return p;
  };

  it("a budget stop is spent unless a dial ended after C2", () => {
    const p = seen(new JoinPlan(code));
    p.ended("before-c2");
    p.ended("budget");
    expect([p.result(), p.reason()]).toEqual(["pairing-code-failed", "spent"]);
  });

  it("a result that is not pairing-code-failed has no reason", () => {
    const p = seen(new JoinPlan(code));
    p.ended("before-c2");
    p.ended("before-c2");
    expect([p.result(), p.reason()]).toEqual(["pairing-not-found", null]);
  });

  it("a code spent at the start browses nothing", () => {
    const p = new JoinPlan(code);
    p.startSpent();
    expect(p.browses).toBe(false);
    expect([p.result(), p.reason()]).toEqual(["pairing-code-failed", "spent"]);
  });
});
