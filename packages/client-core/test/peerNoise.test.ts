// The Noise engine beyond the vectors: random keys end to end, order and reuse refusals, and
// concurrent sends. The known answers are the Node conformance runner's `noiseVectors.test.ts`.
import { describe, expect, it } from "vitest";
import {
  NoiseHandshake,
  peerNoiseProtocol,
  peerPrologue,
  webCryptoNoisePorts,
} from "../src/peer/index.js";

const rnd = (): Uint8Array => webCryptoNoisePorts.random(32);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function pair() {
  const prologue = peerPrologue("demo", "v");
  const mk = (role: "initiator" | "responder") =>
    new NoiseHandshake({
      role,
      protocol: peerNoiseProtocol("v"),
      prologue,
      staticKey: rnd(),
    });
  const i = mk("initiator");
  const r = mk("responder");
  await r.readMessage(await i.writeMessage(utf8("one")));
  await i.readMessage(await r.writeMessage(utf8("two")));
  await r.readMessage(await i.writeMessage(utf8("three")));
  return { i, r };
}

describe("peer noise engine", () => {
  it("round-trips with random keys and agrees on the hash and statics", async () => {
    const { i, r } = await pair();
    expect(i.finished && r.finished).toBe(true);
    expect(i.handshakeHash).toEqual(r.handshakeHash);
    const ti = await i.transport();
    const tr = await r.transport();
    const none = new Uint8Array(0);
    const ct = await ti.send.encrypt(none, utf8("hello"));
    expect(new TextDecoder().decode(await tr.receive.decrypt(none, ct))).toBe(
      "hello",
    );
  });

  it("refuses out-of-turn calls and use after a failure", async () => {
    const h = new NoiseHandshake({
      role: "responder",
      protocol: peerNoiseProtocol("v"),
      prologue: peerPrologue("demo", "v"),
      staticKey: rnd(),
    });
    await expect(h.writeMessage(utf8("x"))).rejects.toMatchObject({
      code: "state",
    });
    await expect(h.readMessage(new Uint8Array(3))).rejects.toMatchObject({
      code: "malformed",
    });
    await expect(h.readMessage(rnd())).rejects.toMatchObject({ code: "state" });
  });

  it("needs the PSK exactly for XXpsk0", () => {
    expect(
      () =>
        new NoiseHandshake({
          role: "initiator",
          protocol: peerNoiseProtocol("a"),
          prologue: peerPrologue("demo", "a"),
          staticKey: rnd(),
        }),
    ).toThrow();
  });

  it("never reuses a nonce across concurrent sends", async () => {
    const { i, r } = await pair();
    const ti = await i.transport();
    const tr = await r.transport();
    const none = new Uint8Array(0);
    const cts = await Promise.all(
      [1, 2, 3, 4].map((n) => ti.send.encrypt(none, Uint8Array.of(n))),
    );
    for (let k = 0; k < cts.length; k++)
      expect(await tr.receive.decrypt(none, cts[k]!)).toEqual(
        Uint8Array.of(k + 1),
      );
  });
});
