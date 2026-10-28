// @pkey-feature connect.noise
// The browser conformance runner for `noise-vectors.json` (WIRE-CONTRACT-V5 §15.5): the X25519
// and AES-256-GCM known answers and every handshake byte for byte, through WebCrypto in a real
// engine. WebCrypto X25519 needs Chromium 133 or later, Firefox, or Safari 17; where the engine
// has none the X25519-dependent suites are skipped with that reason (not passed silently).
import { describe, expect, it } from "vitest";
import vectors from "../../corpus/v2/noise-vectors.json";
import {
  NoiseHandshake,
  webCryptoAead,
  webCryptoX25519,
} from "@polaris-key/client-core";

interface Msg {
  index: number;
  from: "i" | "r";
  kind: "handshake" | "transport";
  payload: string;
  ciphertext: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = vectors as any;

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function hasX25519(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}
const x25519 = await hasX25519();
const withX = x25519 ? describe : describe.skip;
if (!x25519)
  console.warn(
    "noiseVectors.browser: skipped, this engine has no WebCrypto X25519 (needs Chromium 133+, Firefox or Safari 17)",
  );

describe("noise vectors in the browser: AES-256-GCM", () => {
  it("known answers", async () => {
    for (const c of V.aesGcm) {
      const sealed = await webCryptoAead.seal(
        bytes(c.key),
        bytes(c.nonce),
        bytes(c.aad),
        bytes(c.plaintext),
      );
      expect(hex(sealed), c.id).toBe(c.ciphertext + c.tag);
    }
  });
});

withX("noise vectors in the browser: X25519 and handshakes", () => {
  it("scalar multiplication", async () => {
    for (const c of V.x25519.scalarMult) {
      const out = await webCryptoX25519.dh(bytes(c.scalar), bytes(c.u));
      expect(out === null ? null : hex(out), c.id).toBe(c.expect);
    }
  });

  for (const h of V.handshakes) {
    it(`${h.id}: every message byte for byte`, async () => {
      const mk = (role: "initiator" | "responder") =>
        new NoiseHandshake({
          role,
          protocol: h.protocol,
          prologue: bytes(h.prologue),
          ...(h.psk !== undefined ? { psk: bytes(h.psk) } : {}),
          staticKey: bytes(role === "initiator" ? h.initStatic : h.respStatic),
          ephemeralKey: bytes(
            role === "initiator" ? h.initEphemeral : h.respEphemeral,
          ),
        });
      const i = mk("initiator");
      const r = mk("responder");
      const msgs: Msg[] = h.messages.filter((m: Msg) => m.kind === "handshake");
      for (const [k, m] of msgs.entries()) {
        const [w, d] = k % 2 === 0 ? [i, r] : [r, i];
        const wire = await w.writeMessage(bytes(m.payload));
        expect(hex(wire), `${h.id} message ${k}`).toBe(m.ciphertext);
        expect(hex(await d.readMessage(wire))).toBe(m.payload);
      }
      expect(hex(i.handshakeHash)).toBe(h.handshakeHash);
      const t = await i.transport();
      const none = new Uint8Array(0);
      for (const m of h.messages.filter((x: Msg) => x.kind === "transport")) {
        if (m.from !== "i") break;
        expect(hex(await t.send.encrypt(none, bytes(m.payload)))).toBe(
          m.ciphertext,
        );
        break;
      }
    });
  }
});
