// CPace (V5 §15.12): behaviour the corpus rows do not pin. The known answers are
// `conformance/corpus/v2/noise-vectors.json` `cpace`, run by the conformance runners.

import { describe, expect, it } from "vitest";
import {
  checkShare,
  cpaceGenerator,
  cpaceIsk,
  cpacePrsCode,
  cpacePrsQr,
  cpacePsk,
  cpaceScalar,
  cpaceShare,
  elligator2,
  encodeC1,
  encodeC2,
  parseC1,
  parseC2,
  peerNoiseProtocol,
  peerPrologue,
} from "../src/index.js";

const sid = new Uint8Array(10).fill(7);
const ci = peerPrologue("demo", "q");

describe("cpace", () => {
  it("both sides derive one ISK and one PSK from the same code", async () => {
    const prs = cpacePrsCode("004217");
    const g = await cpaceGenerator(prs, ci, sid);
    const ya = cpaceScalar();
    const yb = cpaceScalar();
    const Ya = (await cpaceShare(ya, g))!;
    const Yb = (await cpaceShare(yb, g))!;
    expect(parseC1(encodeC1("code", Ya))).toMatchObject({
      ok: true,
      kind: "code",
    });
    expect(parseC2(encodeC2(Yb)).ok).toBe(true);
    const a = await cpaceIsk({
      sid,
      scalar: ya,
      ya: Ya,
      yb: Yb,
      role: "initiator",
    });
    const b = await cpaceIsk({
      sid,
      scalar: yb,
      ya: Ya,
      yb: Yb,
      role: "responder",
    });
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    expect(await cpacePsk(a!, "demo")).toEqual(await cpacePsk(b!, "demo"));
    expect(await cpacePsk(a!, "demo")).not.toEqual(await cpacePsk(a!, "other"));
    expect(ya.every((x) => x === 0)).toBe(true);
  });

  it("a different password gives another generator and another ISK", async () => {
    const g1 = await cpaceGenerator(cpacePrsCode("000001"), ci, sid);
    const g2 = await cpaceGenerator(cpacePrsCode("000002"), ci, sid);
    expect(g1).not.toEqual(g2);
    const y = cpaceScalar();
    const Y1 = (await cpaceShare(y, g1))!;
    const Y2 = (await cpaceShare(y, g2))!;
    expect(Y1).not.toEqual(Y2);
  });

  it("refuses malformed passwords, QR secrets and map inputs", () => {
    expect(() => cpacePrsCode("12345")).toThrow(RangeError);
    expect(() => cpacePrsCode("12345a")).toThrow(RangeError);
    expect(() => cpacePrsQr(new Uint8Array(15))).toThrow(RangeError);
    expect(() => elligator2(new Uint8Array(31))).toThrow(RangeError);
  });

  it("refuses the all-zero share and a low-order peer share", async () => {
    expect(checkShare(new Uint8Array(32)).ok).toBe(false);
    const isk = await cpaceIsk({
      sid,
      scalar: cpaceScalar(),
      ya: new Uint8Array(32),
      yb: new Uint8Array(32),
      role: "initiator",
    });
    expect(isk).toBeNull();
  });

  it("the local-link modes use the XXpsk0 protocol", () => {
    expect(peerNoiseProtocol("q")).toBe("Noise_XXpsk0_25519_AESGCM_SHA256");
    expect(peerNoiseProtocol("l")).toBe("Noise_XXpsk0_25519_AESGCM_SHA256");
  });
});
