// The local-links reference's own checks (CC-29.2, CC-29.3; WIRE-CONTRACT-V5 §15.12): the
// machines behave as the contract says on the rows that matter most, so a generated row is not
// vacuous. The committed rows are checked against client-core by the runners (CC-29.5).

import { describe, expect, it } from "vitest";
import {
  type WindowEvent,
  refCodeParse,
  refLinkBody,
  refLocalExchange,
  refLocalGate,
  refLocalJoin,
  refLocalRecord,
  refLocalTrial,
  refLocalWindow,
  refQrParse,
} from "./corpus/reference/local.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const body = utf8('{"v":1,"cats":["docs"]}');

describe("local reference", () => {
  it("reads a typed code and a QR", () => {
    expect(refCodeParse("4812-3456")).toEqual({
      ok: true,
      nameplate: "48",
      password: "123456",
    });
    expect(refCodeParse("4812 345")).toEqual({ ok: false });
    expect(
      refQrParse(
        "pkp1:demo:aaaaaaaaaaaaaaaa:aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "demo",
      ).result,
    ).toBe("ok");
    expect(
      refQrParse(
        "PKP1:OTHER:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAA",
        "demo",
      ).result,
    ).toBe("other-app");
  });

  it("refuses a LOCAL_LINK that carries no categories list", () => {
    expect(refLinkBody(utf8('{"v":1}'))).toEqual({ ok: false });
    expect(refLinkBody(body)).toEqual({ ok: true, cats: ["docs"] });
  });

  it("sends LOCAL_LINK only after both CONFIRMs, and stores on the peer's", () => {
    const r = refLocalExchange(
      [
        { event: "peer-confirm" },
        { event: "own-confirm" },
        { event: "peer-link", body },
      ],
      0,
      ["docs", "music"],
    );
    expect(r[0]!.sends).toEqual([]);
    expect(r[1]!.sends).toEqual(["CONFIRM", "LOCAL_LINK"]);
    expect(r[2]!.stored).toEqual({ cats: ["docs"] });
    expect(r[2]!.close).toBe("peer_bye");
    expect(
      refLocalExchange([{ event: "peer-link", body }], 0, [])[0]!.close,
    ).toBe("peer_bad_frame");
    expect(
      refLocalExchange(
        [
          { event: "own-confirm" },
          { event: "peer-confirm" },
          { event: "peer-link", body },
        ],
        32,
        [],
      )[2]!.close,
    ).toBe("peer_not_allowed");
  });

  it("tries accounts, then contacts, then local links, at most 104", () => {
    const n = (c: string, k: number): string[] =>
      Array.from({ length: k }, () => c);
    const out = refLocalTrial({
      account: ["k", "k"],
      contacts: n("c", 80),
      locals: n("l", 40),
      opens: null,
      limiter: "admit",
    });
    expect(out.tried).toHaveLength(2 + 72 + 32);
    expect(out.tried[2]).toBe("c:0");
    expect(out.tried[74]).toBe("l:0");
    expect(
      refLocalTrial({
        account: null,
        contacts: [],
        locals: ["l"],
        opens: { mode: "l", link: 0 },
        limiter: "refuse",
      }).close,
    ).toBe("peer_busy");
  });

  it("closes the window on the fifth failed guess and rotates on the first four", () => {
    const ev: WindowEvent[] = [{ event: "open", t: 0 }];
    for (let i = 0; i < 5; i++) {
      ev.push(
        { event: "c1", t: 1 + i * 13, valid: true },
        { event: "msg1", t: 2 + i * 13, opens: false },
      );
      // A failed guess holds the window until the rotation is done.
      if (i < 4) ev.push({ event: "rotated", t: 3 + i * 13 });
    }
    const out = refLocalWindow(ev);
    const last = out[out.length - 1]!;
    expect(last.closed).toBe("too-many-tries");
    expect(last.host).toBe("pairing-code-failed");
    expect(last.failures).toBe(5);
    expect(last.rotations).toBe(4);
  });

  it("limits the sixth C1 in a minute and frees the window after 300 s", () => {
    const ev: WindowEvent[] = [{ event: "open", t: 0 }];
    for (let i = 0; i < 6; i++)
      ev.push({ event: "c1", t: 1 + i, valid: false });
    ev.push({ event: "c1", t: 300, valid: true });
    const out = refLocalWindow(ev);
    expect(out[6]!.result).toBe("limited");
    expect(out[7]!.result).toBe("closed");
  });

  it("answers pairing-code-failed only when an attempt failed after C2", () => {
    const ad = {
      instance: "p1-aaaaaaaaaaaaaaaa",
      h: "current" as const,
      n: "48",
    };
    const input = { kind: "code" as const, nameplate: "48" };
    expect(
      refLocalJoin({ input, adverts: [ad], dials: ["before-c2"] }).result,
    ).toBe("pairing-not-found");
    expect(
      refLocalJoin({ input, adverts: [ad], dials: ["after-c2"] }).result,
    ).toBe("pairing-code-failed");
  });

  it("gates on a cached boolean true and withdraws when it clears", () => {
    const on = {
      services: { connect: { enabled: true, localPairing: true } },
    };
    const off = {
      services: { connect: { enabled: true, localPairing: false } },
    };
    const out = refLocalGate("none", [
      { call: "pair" },
      { read: "ok", body: on },
      { call: "pair" },
      { read: "error" },
      { call: "pair" },
      { read: "ok", body: off },
    ]);
    expect(out.map((s) => s.call)).toEqual([
      "local-pairing-off",
      undefined,
      "ok",
      undefined,
      "ok",
      undefined,
    ]);
    expect(out[5]!.effects).toEqual([
      "close-windows",
      "withdraw-adverts",
      "end-sessions",
    ]);
  });

  it("allows LOCAL_LINK in mode q only and APP in mode l", () => {
    expect(refLocalRecord("q", 0x0014)).toMatchObject({ allowed: true });
    expect(refLocalRecord("l", 0x0014)).toEqual({
      allowed: false,
      close: "peer_not_allowed",
    });
    expect(refLocalRecord("l", 0x0100)).toMatchObject({
      allowed: true,
      needs: "app/1",
    });
    expect(refLocalRecord("q", 0x0100)).toEqual({
      allowed: false,
      close: "peer_not_allowed",
    });
    expect(refLocalRecord("q", 0x0006)).toEqual({
      allowed: false,
      close: "peer_not_allowed",
    });
    expect(refLocalRecord("l", 0x8020)).toEqual({
      allowed: false,
      close: "peer_unknown_critical",
    });
  });
});
