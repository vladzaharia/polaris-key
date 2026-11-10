// The `cpace` section of `noise-vectors.json` (WIRE-CONTRACT-V5 §15.12, "The mode-q handshake"),
// as suites over `@polaris-key/client-core`'s `peer/cpace.ts` and the Noise engine. Shared by the
// Node runner and the browser runner, which hand over the parsed section; nothing here reads a file.
// The X25519-dependent suites take `x25519` so a browser engine without WebCrypto X25519 skips them
// with a stated reason (the caller's choice), never passes them silently.

import { describe, expect, it } from "vitest";
import {
  NoiseError,
  NoiseHandshake,
  checkShare,
  cpaceGenerator,
  cpaceIsk,
  cpacePrsCode,
  cpacePrsQr,
  cpacePsk,
  cpaceShare,
  elligator2,
  encodeC1,
  encodeC2,
  generatorString,
  lvCat,
  parseC1,
  parseC2,
  peerNoiseProtocol,
  peerPrologue,
  prependLen,
  transcriptIr,
  webCryptoNoisePorts,
  webCryptoX25519,
  type NoisePorts,
  type PeerMode,
} from "@polaris-key/client-core";

const bytes = (text: string): Uint8Array =>
  new Uint8Array((text.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha512 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-512",
      b as Uint8Array<ArrayBuffer>,
    ),
  );

interface Verdict {
  ok: boolean;
  kind?: string;
  reason?: string;
  share?: string;
}
interface Attempt {
  id: string;
  kind: "code" | "qr";
  joinerSecret: string;
  showerSecret: string;
  joinerSlug: string;
  showerSlug: string;
  joinerSid: string;
  showerSid: string;
  ya: string;
  yb: string;
  reflect?: boolean;
  joinerG: string;
  showerG: string;
  Ya: string;
  Yb: string;
  c1: string;
  c2: string;
  joinerK: string;
  showerK: string;
  joinerIsk: string;
  showerIsk: string;
  joinerPsk: string;
  showerPsk: string;
  agree: boolean;
}
interface Handshake {
  id: string;
  mode: PeerMode;
  protocol: string;
  slug: string;
  prologue: string;
  psk: string;
  initStatic: string;
  initEphemeral: string;
  respStatic: string;
  respEphemeral: string;
  handshakeHash: string;
  attempt?: string;
  isk?: string;
  messages: {
    kind: "handshake" | "transport";
    payload: string;
    ciphertext: string;
  }[];
}
interface Failure {
  id: string;
  mode: PeerMode;
  protocol: string;
  prologue: string;
  responderPrologue?: string;
  psk: string;
  responderPsk?: string;
  initStatic: string;
  initEphemeral: string;
  initEphemeralPublic?: string;
  respStatic: string;
  respEphemeral: string;
  payloads: string[];
  failedAt: number;
  reason: string;
}
interface AnchorCase {
  in: string | string[];
  out: string;
}
export interface CpaceSection {
  suite: string;
  dsi: string;
  dsiIsk: string;
  sInBytes: number;
  anchors: {
    vectors: {
      id: string;
      vector: Record<string, unknown> & { cases?: AnchorCase[] };
    }[];
  };
  elligator: {
    id: string;
    input: string;
    r: string;
    onCurve: boolean;
    u: string;
  }[];
  generators: {
    id: string;
    kind: "code" | "qr";
    secret: string;
    slug: string;
    prs: string;
    ci: string;
    sid: string;
    generatorString: string;
    hash: string;
    decoded: string;
    g: string;
  }[];
  shares: { id: string; share: string; want: Verdict }[];
  frames: {
    c1: { id: string; frame: string; want: Verdict }[];
    c2: { id: string; frame: string; want: Verdict }[];
  };
  attempts: Attempt[];
  abort: {
    scalar: string;
    rows: {
      id: string;
      u: string;
      k: string;
      kAllZero: boolean;
      shareRefused: boolean;
    }[];
  };
  handshakes: Handshake[];
  failures: Failure[];
}

/** A frame verdict in the corpus's shape. */
function verdictOf(v: ReturnType<typeof parseC1>): Verdict {
  if (!v.ok) return { ok: false, reason: v.reason };
  const out: Verdict = { ok: true, share: hex(v.share) };
  if (v.kind !== undefined) out.kind = v.kind;
  return out;
}

/** The handshake messages in turn, `first` writing first; each is read by the other side. */
async function relay(
  first: NoiseHandshake,
  second: NoiseHandshake,
  payloads: string[],
): Promise<Uint8Array[]> {
  const wires: Uint8Array[] = [];
  let [from, to] = [first, second];
  for (const payload of payloads) {
    const wire = await from.writeMessage(bytes(payload));
    wires.push(wire);
    expect(hex(await to.readMessage(wire))).toBe(payload);
    [from, to] = [to, from];
  }
  return wires;
}

const prsOf = (kind: "code" | "qr", secret: string): Uint8Array =>
  kind === "code" ? cpacePrsCode(secret) : cpacePrsQr(bytes(secret));

async function sideOf(a: Attempt, side: "joiner" | "shower") {
  const slug = side === "joiner" ? a.joinerSlug : a.showerSlug;
  const secret = side === "joiner" ? a.joinerSecret : a.showerSecret;
  const sid = bytes(side === "joiner" ? a.joinerSid : a.showerSid);
  const g = await cpaceGenerator(
    prsOf(a.kind, secret),
    peerPrologue(slug, "q"),
    sid,
  );
  return { slug, sid, g };
}

export function registerCpaceSuites(
  c: CpaceSection,
  { x25519 }: { x25519: boolean },
): void {
  const withX = x25519 ? describe : describe.skip;

  describe("noise vectors cpace: the suite and the string functions", () => {
    it("pins the suite", () => {
      expect(c.suite).toBe("CPACE-X25519-SHA512");
      expect(c.dsi).toBe("CPace255");
      expect(c.dsiIsk).toBe("CPace255_ISK");
      expect(c.sInBytes).toBe(128);
    });

    it("prepend_len, lv_cat and transcript_ir: the draft's appendix A vectors", () => {
      for (const a of c.anchors.vectors) {
        const cases = a.vector.cases;
        if (cases === undefined) continue;
        const fn = a.vector.fn;
        for (const k of cases) {
          if (fn === "prepend_len")
            expect(hex(prependLen(bytes(k.in as string))), a.id).toBe(k.out);
          else if (fn === "lv_cat")
            expect(hex(lvCat(...(k.in as string[]).map(bytes))), a.id).toBe(
              k.out,
            );
          else if (fn === "transcript_ir") {
            const [ya, ada, yb, adb] = (k.in as string[]).map(bytes);
            expect(hex(transcriptIr(ya!, ada!, yb!, adb!)), a.id).toBe(k.out);
          }
        }
      }
    });

    it("the draft's B.1.1 generator, B.1.2 to B.1.5 transcript and ISK", async () => {
      const b11 = c.anchors.vectors.find((a) => a.id === "B.1.1")!
        .vector as Record<string, string>;
      const gs = generatorString(
        bytes(b11.DSI!),
        bytes(b11.PRS!),
        bytes(b11.CI!),
        bytes(b11.sid!),
        c.sInBytes,
      );
      expect(hex(gs)).toBe(b11.generatorString);
      const hash = (await sha512(gs)).slice(0, 32);
      expect(hex(hash)).toBe(b11.hashGeneratorString);
      expect(hex(elligator2(hash).u)).toBe(b11.g);
      expect(
        hex(
          await cpaceGenerator(
            bytes(b11.PRS!),
            bytes(b11.CI!),
            bytes(b11.sid!),
          ),
        ),
      ).toBe(b11.g);
      const b12 = c.anchors.vectors.find((a) => a.id === "B.1.2-B.1.5")!
        .vector as Record<string, string>;
      const ir = transcriptIr(
        bytes(b12.Ya!),
        bytes(b12.ADa!),
        bytes(b12.Yb!),
        bytes(b12.ADb!),
      );
      expect(hex(ir)).toBe(b12.transcriptIr);
      const input = new Uint8Array([
        ...lvCat(bytes(b12.dsiIsk!), bytes(b11.sid!), bytes(b12.K!)),
        ...ir,
      ]);
      expect(hex(input)).toBe(b12.iskInput);
      expect(hex(await sha512(input))).toBe(b12.isk);
    });
  });

  describe("noise vectors cpace: Elligator 2 and the generators", () => {
    it("map_to_curve_elligator2 rows", () => {
      for (const r of c.elligator) {
        const out = elligator2(bytes(r.input));
        expect(hex(out.r), r.id).toBe(r.r);
        expect(out.onCurve, r.id).toBe(r.onCurve);
        expect(hex(out.u), r.id).toBe(r.u);
      }
    });

    it("generator rows: PRS, generator string, hash, decoded element and g", async () => {
      for (const r of c.generators) {
        const prs = prsOf(r.kind, r.secret);
        expect(hex(prs), r.id).toBe(r.prs);
        expect(hex(peerPrologue(r.slug, "q")), r.id).toBe(r.ci);
        const gs = generatorString(
          utf8(c.dsi),
          prs,
          bytes(r.ci),
          bytes(r.sid),
          c.sInBytes,
        );
        expect(hex(gs), r.id).toBe(r.generatorString);
        const hash = (await sha512(gs)).slice(0, 32);
        expect(hex(hash), r.id).toBe(r.hash);
        expect(
          hex(await cpaceGenerator(prs, bytes(r.ci), bytes(r.sid))),
          r.id,
        ).toBe(r.g);
      }
    });
  });

  describe("noise vectors cpace: shares and frames", () => {
    it("share check: length, canonical, then low order", () => {
      for (const r of c.shares) {
        const v = checkShare(bytes(r.share));
        expect(v.ok, r.id).toBe(r.want.ok);
        if (!v.ok) expect(v.reason, r.id).toBe(r.want.reason);
      }
    });

    it("C1 as the shower judges it, C2 as the joiner judges it", () => {
      for (const r of c.frames.c1)
        expect(verdictOf(parseC1(bytes(r.frame))), r.id).toEqual(r.want);
      for (const r of c.frames.c2)
        expect(verdictOf(parseC2(bytes(r.frame))), r.id).toEqual(r.want);
    });
  });

  withX("noise vectors cpace: attempts, aborts and handshakes", () => {
    it("whole attempts: shares, frames, K, ISK and the Noise PSK", async () => {
      for (const a of c.attempts) {
        const j = await sideOf(a, "joiner");
        const s = await sideOf(a, "shower");
        expect(hex(j.g), a.id).toBe(a.joinerG);
        expect(hex(s.g), a.id).toBe(a.showerG);
        const Ya = (await cpaceShare(bytes(a.ya), j.g))!;
        const Yb =
          a.reflect === true ? Ya : (await cpaceShare(bytes(a.yb), s.g))!;
        expect(hex(Ya), a.id).toBe(a.Ya);
        expect(hex(Yb), a.id).toBe(a.Yb);
        expect(hex(encodeC1(a.kind, Ya)), a.id).toBe(a.c1);
        expect(hex(encodeC2(Yb)), a.id).toBe(a.c2);
        const kj = await webCryptoX25519.dh(bytes(a.ya), Yb);
        const ks = await webCryptoX25519.dh(bytes(a.yb), Ya);
        expect(hex(kj!), a.id).toBe(a.joinerK);
        expect(hex(ks!), a.id).toBe(a.showerK);
        const iskJ = (await cpaceIsk({
          sid: j.sid,
          scalar: bytes(a.ya),
          ya: Ya,
          yb: Yb,
          role: "initiator",
        }))!;
        const iskS = (await cpaceIsk({
          sid: s.sid,
          scalar: bytes(a.yb),
          ya: Ya,
          yb: Yb,
          role: "responder",
        }))!;
        expect(hex(iskJ), a.id).toBe(a.joinerIsk);
        expect(hex(iskS), a.id).toBe(a.showerIsk);
        expect(hex(await cpacePsk(iskJ, j.slug)), a.id).toBe(a.joinerPsk);
        expect(hex(await cpacePsk(iskS, s.slug)), a.id).toBe(a.showerPsk);
        expect(hex(iskJ) === hex(iskS), a.id).toBe(a.agree);
      }
    });

    it("a scalar is overwritten once the ISK is made", async () => {
      const a = c.attempts[0]!;
      const j = await sideOf(a, "joiner");
      const scalar = bytes(a.ya);
      await cpaceIsk({
        sid: j.sid,
        scalar,
        ya: bytes(a.Ya),
        yb: bytes(a.Yb),
        role: "initiator",
      });
      expect(scalar.every((b) => b === 0)).toBe(true);
    });

    it("abort: a low-order u gives a zero K, which refuses; its share is refused first", async () => {
      for (const r of c.abort.rows) {
        const out = await webCryptoX25519.dh(bytes(c.abort.scalar), bytes(r.u));
        const zero = out === null || out.every((b) => b === 0);
        if (r.kAllZero) expect(zero, r.id).toBe(true);
        else expect(hex(out!), r.id).toBe(r.k);
        expect(!checkShare(bytes(r.u)).ok, r.id).toBe(r.shareRefused);
        const isk = await cpaceIsk({
          sid: new Uint8Array(10),
          scalar: bytes(c.abort.scalar),
          ya: new Uint8Array(32),
          yb: bytes(r.u),
          role: "initiator",
        });
        expect(isk === null, r.id).toBe(r.kAllZero);
      }
    });

    for (const h of c.handshakes) {
      it(`${h.id}: derivations and every message byte for byte`, async () => {
        expect(peerNoiseProtocol(h.mode)).toBe(h.protocol);
        expect(hex(peerPrologue(h.slug, h.mode))).toBe(h.prologue);
        if (h.attempt !== undefined) {
          const a = c.attempts.find((x) => x.id === h.attempt)!;
          expect(a.joinerPsk).toBe(h.psk);
          expect(a.joinerIsk).toBe(h.isk);
        }
        const keys = {
          initiator: { s: h.initStatic, e: h.initEphemeral },
          responder: { s: h.respStatic, e: h.respEphemeral },
        };
        const mk = (role: "initiator" | "responder") =>
          new NoiseHandshake({
            role,
            protocol: h.protocol,
            prologue: bytes(h.prologue),
            psk: bytes(h.psk),
            staticKey: bytes(keys[role].s),
            ephemeralKey: bytes(keys[role].e),
          });
        const i = mk("initiator");
        const r = mk("responder");
        const msgs = h.messages.filter((m) => m.kind === "handshake");
        const wires = await relay(
          i,
          r,
          msgs.map((m) => m.payload),
        );
        wires.forEach((w, k) =>
          expect(hex(w), `${h.id} message ${k}`).toBe(msgs[k]!.ciphertext),
        );
        expect(hex(i.handshakeHash)).toBe(h.handshakeHash);
        expect(hex(r.handshakeHash)).toBe(h.handshakeHash);
        const ti = await i.transport();
        const tr = await r.transport();
        const none = new Uint8Array(0);
        for (const m of h.messages.filter((x) => x.kind === "transport")) {
          const ct = await ti.send.encrypt(none, bytes(m.payload));
          expect(hex(ct), `${h.id} record`).toBe(m.ciphertext);
          expect(hex(await tr.receive.decrypt(none, ct))).toBe(m.payload);
          break;
        }
      });
    }

    for (const f of c.failures) {
      it(`${f.id}: fails at message ${f.failedAt} (${f.reason})`, async () => {
        const mk = (
          role: "initiator" | "responder",
          prologue: string,
          psk: string,
          staticKey: string,
          eph: string,
        ) =>
          new NoiseHandshake({
            role,
            protocol: f.protocol,
            prologue: bytes(prologue),
            psk: bytes(psk),
            staticKey: bytes(staticKey),
            ephemeralKey: bytes(eph),
            // The reference swaps the initiator's message-1 public key before it mixes it.
            ...(role === "initiator" && f.initEphemeralPublic !== undefined
              ? { ports: swapPublicKey(eph, bytes(f.initEphemeralPublic)) }
              : {}),
          });
        const i = mk(
          "initiator",
          f.prologue,
          f.psk,
          f.initStatic,
          f.initEphemeral,
        );
        const r = mk(
          "responder",
          f.responderPrologue ?? f.prologue,
          f.responderPsk ?? f.psk,
          f.respStatic,
          f.respEphemeral,
        );
        let failure: { at: number; reason: string } | null = null;
        for (const [idx, p] of f.payloads.entries()) {
          const [w, d] = idx % 2 === 0 ? [i, r] : [r, i];
          try {
            const msg = await w.writeMessage(bytes(p));
            const got = await d.readMessage(msg);
            expect(hex(got)).toBe(p);
          } catch (err) {
            if (!(err instanceof NoiseError)) throw err;
            failure = { at: idx, reason: err.code };
            break;
          }
        }
        expect(failure).toEqual({ at: f.failedAt, reason: f.reason });
      });
    }
  });
}

function swapPublicKey(privHex: string, pub: Uint8Array): NoisePorts {
  return {
    ...webCryptoNoisePorts,
    x25519: {
      ...webCryptoX25519,
      publicKey: async (priv) =>
        hex(priv) === privHex ? pub : webCryptoX25519.publicKey(priv),
    },
  };
}
