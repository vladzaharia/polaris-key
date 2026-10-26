// @pkey-feature connect.noise
// The Node conformance runner for `conformance/corpus/v2/noise-vectors.json` (WIRE-CONTRACT-V5
// §15.5, §15.6). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
//
// Every row runs through the Noise engine of `peer/noise.ts` on its WebCrypto ports: the X25519
// and AES-256-GCM known answers, the low-order points (`isX25519LowOrder` from shared-jws, and
// the engine's refusal of the all-zero DH), the three handshake modes byte for byte with rekey,
// the 15 failure rows, and the external anchors.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NoiseError,
  NoiseHandshake,
  peerNoiseProtocol,
  peerPrologue,
  peerPsk,
  webCryptoAead,
  webCryptoNoisePorts,
  webCryptoX25519,
  type NoisePorts,
  type NoiseTransport,
  type PeerMode,
} from "@polaris-key/client-core";
import { isX25519LowOrder } from "@polaris-key/jws";

interface Message {
  index: number;
  from: "i" | "r";
  kind: "handshake" | "transport";
  payload: string;
  ciphertext: string;
  rekeyAfter?: boolean;
}

interface Handshake {
  id: string;
  mode: PeerMode;
  protocol: string;
  slug: string;
  prologue: string;
  psk?: string;
  initStatic: string;
  initStaticPublic: string;
  initEphemeral: string;
  initEphemeralPublic: string;
  respStatic: string;
  respStaticPublic: string;
  respEphemeral: string;
  respEphemeralPublic: string;
  handshakeHash: string;
  messages: Message[];
}

interface Failure {
  id: string;
  mode: PeerMode;
  protocol: string;
  prologue: string;
  responderPrologue?: string;
  psk?: string;
  responderPsk?: string;
  initStatic: string;
  initEphemeral: string;
  initEphemeralPublic?: string;
  respStatic: string;
  respEphemeral: string;
  payloads: string[];
  failedAt: number;
  reason: "decrypt" | "dh_zero";
}

interface Anchor {
  source: string;
  vector: {
    protocol_name: string;
    init_prologue: string;
    init_psks?: string[];
    init_static?: string;
    init_ephemeral: string;
    resp_prologue: string;
    resp_psks?: string[];
    resp_static?: string;
    resp_ephemeral: string;
    handshake_hash?: string;
    messages: { payload: string; ciphertext: string }[];
  };
}

interface NoiseVectors {
  noiseVectorsVersion: number;
  x25519: {
    scalarMult: { id: string; scalar: string; u: string; expect: string }[];
    agreement: {
      id: string;
      alicePrivate: string;
      alicePublic: string;
      bobPrivate: string;
      bobPublic: string;
      shared: string;
    }[];
  };
  lowOrder: {
    scalar: string;
    rows: {
      id: string;
      u: string;
      lowOrder: boolean;
      output: string;
      allZero: boolean;
    }[];
  };
  aesGcm: {
    id: string;
    key: string;
    nonce: string;
    aad: string;
    plaintext: string;
    ciphertext: string;
    tag: string;
  }[];
  handshakes: Handshake[];
  failures: Failure[];
  anchors: { vectors: Anchor[] };
}

const here = dirname(fileURLToPath(import.meta.url));
const V: NoiseVectors = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "noise-vectors.json"),
    "utf8",
  ),
);

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const swapPublicKey = (privHex: string, pub: Uint8Array): NoisePorts => ({
  ...webCryptoNoisePorts,
  x25519: {
    ...webCryptoX25519,
    publicKey: async (priv) =>
      hex(priv) === privHex ? pub : webCryptoX25519.publicKey(priv),
  },
});

interface Side {
  prologue: string;
  psk?: string;
  staticKey?: string;
  ephemeral: string;
}

/** Run the handshake messages through both roles. Returns the messages and, on a refusal, where
 *  and why; the failing step is the writer's or the reader's, as the reference reports it. */
async function runHandshake(
  protocol: string,
  init: Side,
  resp: Side,
  payloads: Uint8Array[],
  replaceFirstEphemeral?: Uint8Array,
): Promise<{
  wire: Uint8Array[];
  failure: { at: number; reason: string } | null;
  i: NoiseHandshake;
  r: NoiseHandshake;
}> {
  const mk = (role: "initiator" | "responder", s: Side) =>
    new NoiseHandshake({
      role,
      protocol,
      prologue: bytes(s.prologue),
      ...(s.psk !== undefined ? { psk: bytes(s.psk) } : {}),
      staticKey: bytes(s.staticKey ?? "00".repeat(32)),
      ephemeralKey: bytes(s.ephemeral),
      // The reference swaps the initiator's message-1 public key before it mixes it; so does this.
      ...(role === "initiator" && replaceFirstEphemeral !== undefined
        ? { ports: swapPublicKey(s.ephemeral, replaceFirstEphemeral) }
        : {}),
    });
  const i = mk("initiator", init);
  const r = mk("responder", resp);
  const wire: Uint8Array[] = [];
  for (let idx = 0; idx < payloads.length; idx++) {
    const [w, d] = idx % 2 === 0 ? [i, r] : [r, i];
    try {
      const msg = await w.writeMessage(payloads[idx]!);
      wire.push(msg);
      const got = await d.readMessage(msg);
      expect(hex(got)).toBe(hex(payloads[idx]!));
    } catch (err) {
      if (!(err instanceof NoiseError)) throw err;
      return { wire, failure: { at: idx, reason: err.code }, i, r };
    }
  }
  return { wire, failure: null, i, r };
}

const runVector = (h: Handshake, msgs: Message[]) => {
  const side = (own: "init" | "resp"): Side => ({
    prologue: h.prologue,
    ...(h.psk !== undefined ? { psk: h.psk } : {}),
    staticKey: own === "init" ? h.initStatic : h.respStatic,
    ephemeral: own === "init" ? h.initEphemeral : h.respEphemeral,
  });
  return runHandshake(
    h.protocol,
    side("init"),
    side("resp"),
    msgs.map((m) => bytes(m.payload)),
  );
};

async function transportOf(
  i: NoiseHandshake,
  r: NoiseHandshake,
): Promise<{ i: NoiseTransport; r: NoiseTransport }> {
  return { i: await i.transport(), r: await r.transport() };
}

describe("noise vectors: version and primitives", () => {
  it("is noise-vectors version 1", () => {
    expect(V.noiseVectorsVersion).toBe(1);
  });

  it("X25519 scalar multiplication (RFC 7748 §5.2)", async () => {
    for (const c of V.x25519.scalarMult) {
      const out = await webCryptoX25519.dh(bytes(c.scalar), bytes(c.u));
      expect(out === null ? null : hex(out), c.id).toBe(c.expect);
    }
  });

  it("X25519 agreement and public keys (RFC 7748 §6.1)", async () => {
    for (const c of V.x25519.agreement) {
      const a = bytes(c.alicePrivate);
      const b = bytes(c.bobPrivate);
      expect(hex(await webCryptoX25519.publicKey(a)), c.id).toBe(c.alicePublic);
      expect(hex(await webCryptoX25519.publicKey(b)), c.id).toBe(c.bobPublic);
      const ab = await webCryptoX25519.dh(a, bytes(c.bobPublic));
      const ba = await webCryptoX25519.dh(b, bytes(c.alicePublic));
      expect(hex(ab!), c.id).toBe(c.shared);
      expect(hex(ba!), c.id).toBe(c.shared);
    }
  });

  it("low-order points: classified by isX25519LowOrder, refused as a DH", async () => {
    for (const r of V.lowOrder.rows) {
      const u = bytes(r.u);
      expect(isX25519LowOrder(u), r.id).toBe(r.lowOrder);
      const out = await webCryptoX25519.dh(bytes(V.lowOrder.scalar), u);
      if (r.allZero) {
        // The backend refuses (null) or answers zeros; either way the engine aborts on it.
        expect(out === null || out.every((x) => x === 0), r.id).toBe(true);
      } else {
        expect(hex(out!), r.id).toBe(r.output);
      }
    }
  });

  it("AES-256-GCM known answers, and a flipped bit fails the tag", async () => {
    for (const c of V.aesGcm) {
      const sealed = await webCryptoAead.seal(
        bytes(c.key),
        bytes(c.nonce),
        bytes(c.aad),
        bytes(c.plaintext),
      );
      expect(hex(sealed), c.id).toBe(c.ciphertext + c.tag);
      const opened = await webCryptoAead.open(
        bytes(c.key),
        bytes(c.nonce),
        bytes(c.aad),
        sealed,
      );
      expect(opened === null ? null : hex(opened), c.id).toBe(c.plaintext);
      const bad = Uint8Array.from(sealed);
      bad[bad.length - 1]! ^= 1;
      expect(
        await webCryptoAead.open(
          bytes(c.key),
          bytes(c.nonce),
          bytes(c.aad),
          bad,
        ),
        c.id,
      ).toBeNull();
    }
  });
});

describe("noise vectors: handshakes", () => {
  for (const h of V.handshakes) {
    it(`${h.id}: derivations, every message byte for byte, rekey`, async () => {
      expect(peerNoiseProtocol(h.mode)).toBe(h.protocol);
      expect(hex(peerPrologue(h.slug, h.mode))).toBe(h.prologue);
      if (h.psk !== undefined) {
        // The mode-a PSK is HKDF(salt empty, ikm discovery key, info), V5 §15.5. The vector's
        // discovery key is SHA-256 of a label.
        const kDisc = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode("pkey-peer/1 noise vector k_disc"),
          ),
        );
        expect(hex(await peerPsk(kDisc, h.slug))).toBe(h.psk);
      }
      const handshakeMsgs = h.messages.filter((m) => m.kind === "handshake");
      const run = await runVector(h, handshakeMsgs);
      expect(run.failure).toBeNull();
      run.wire.forEach((w, k) =>
        expect(hex(w), `${h.id} message ${k}`).toBe(
          handshakeMsgs[k]!.ciphertext,
        ),
      );
      expect(hex(run.i.handshakeHash)).toBe(h.handshakeHash);
      expect(hex(run.r.handshakeHash)).toBe(h.handshakeHash);
      expect(hex(run.i.remoteStatic!)).toBe(h.respStaticPublic);
      expect(hex(run.r.remoteStatic!)).toBe(h.initStaticPublic);

      const t = await transportOf(run.i, run.r);
      const none = new Uint8Array(0);
      for (const m of h.messages.filter((x) => x.kind === "transport")) {
        const [from, to] = m.from === "i" ? [t.i, t.r] : [t.r, t.i];
        const ct = await from.send.encrypt(none, bytes(m.payload));
        expect(hex(ct), `${h.id} record ${m.index}`).toBe(m.ciphertext);
        expect(hex(await to.receive.decrypt(none, ct))).toBe(m.payload);
        if (m.rekeyAfter) {
          await from.send.rekey();
          await to.receive.rekey();
        }
      }
    });

    it(`${h.id}: a tampered or replayed record fails and does not advance`, async () => {
      const handshakeMsgs = h.messages.filter((m) => m.kind === "handshake");
      const run = await runVector(h, handshakeMsgs);
      const t = await transportOf(run.i, run.r);
      const none = new Uint8Array(0);
      const ct = await t.i.send.encrypt(none, bytes("0102"));
      const bad = Uint8Array.from(ct);
      bad[0]! ^= 1;
      await expect(t.r.receive.decrypt(none, bad)).rejects.toMatchObject({
        code: "decrypt",
      });
      expect(hex(await t.r.receive.decrypt(none, ct))).toBe("0102");
      await expect(t.r.receive.decrypt(none, ct)).rejects.toMatchObject({
        code: "decrypt",
      });
    });
  }

  it("the three modes cover a, v and p", () => {
    expect(V.handshakes.map((h) => h.mode).sort()).toEqual(["a", "p", "v"]);
  });
});

describe("noise vectors: failures", () => {
  for (const f of V.failures) {
    it(`${f.id}: fails at message ${f.failedAt} (${f.reason})`, async () => {
      const run = await runHandshake(
        f.protocol,
        {
          prologue: f.prologue,
          ...(f.psk !== undefined ? { psk: f.psk } : {}),
          staticKey: f.initStatic,
          ephemeral: f.initEphemeral,
        },
        {
          prologue: f.responderPrologue ?? f.prologue,
          ...((f.responderPsk ?? f.psk) !== undefined
            ? { psk: (f.responderPsk ?? f.psk)! }
            : {}),
          staticKey: f.respStatic,
          ephemeral: f.respEphemeral,
        },
        f.payloads.map(bytes),
        f.initEphemeralPublic !== undefined
          ? bytes(f.initEphemeralPublic)
          : undefined,
      );
      expect(run.failure).toEqual({ at: f.failedAt, reason: f.reason });
      // A dead handshake refuses further use.
      await expect(
        run.i.writeMessage(new Uint8Array(0)),
      ).rejects.toBeInstanceOf(NoiseError);
    });
  }

  it("covers the 15 failure rows", () => {
    expect(V.failures).toHaveLength(15);
  });
});

describe("noise vectors: external anchors", () => {
  for (const a of V.anchors.vectors) {
    const v = a.vector;
    const isXx = v.protocol_name === "Noise_XX_25519_AESGCM_SHA256";
    (isXx ? it : it.skip)(
      `${a.source}: ${v.protocol_name} (the engine implements XX only; NNpsk0 anchors the reference)`,
      async () => {
        const side = (own: "init" | "resp"): Side => ({
          prologue: own === "init" ? v.init_prologue : v.resp_prologue,
          staticKey: own === "init" ? v.init_static! : v.resp_static!,
          ephemeral: own === "init" ? v.init_ephemeral : v.resp_ephemeral,
        });
        const run = await runHandshake(
          v.protocol_name,
          side("init"),
          side("resp"),
          v.messages.slice(0, 3).map((m) => bytes(m.payload)),
        );
        expect(run.failure).toBeNull();
        run.wire.forEach((w, k) =>
          expect(hex(w), `message ${k}`).toBe(v.messages[k]!.ciphertext),
        );
        if (v.handshake_hash !== undefined)
          expect(hex(run.i.handshakeHash)).toBe(v.handshake_hash);
        const t = await transportOf(run.i, run.r);
        const none = new Uint8Array(0);
        for (let k = 3; k < v.messages.length; k++) {
          const [from, to] = k % 2 === 0 ? [t.i, t.r] : [t.r, t.i];
          const ct = await from.send.encrypt(
            none,
            bytes(v.messages[k]!.payload),
          );
          expect(hex(ct), `message ${k}`).toBe(v.messages[k]!.ciphertext);
          expect(hex(await to.receive.decrypt(none, ct))).toBe(
            v.messages[k]!.payload,
          );
        }
      },
    );
  }
});
