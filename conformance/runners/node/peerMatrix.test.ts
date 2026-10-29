// @pkey-feature connect.protocol
// The Node conformance runner for `conformance/corpus/v2/peer-matrix.json` (WIRE-CONTRACT-V5
// §15.4 to §15.7). It covers React too, since both JS SDKs share `@polaris-key/client-core`.
// Every section runs through the codecs of `peer/`: adverts, prologue and PSK, the SAS with its
// commit and reveal, framing, records and reassembly, relay envelopes, handshake payloads and the
// LAN address rule (§15.4.1).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RecordAssembler,
  accountInstance,
  advertEpoch,
  browseAccountInstance,
  capsIntersection,
  decodeFrames,
  decodeRelay,
  decodeSasValue,
  encodeFrame,
  encodeRelay,
  isInstanceName,
  lanVerdict,
  parseHandshakePayload,
  parseRecord,
  parseSasBody,
  parseTxt,
  peerPrologue,
  peerPsk,
  productTag,
  sasBody,
  sasCommit,
  sasDisplay,
  sasRevealOk,
  sasValue,
  type PeerMode,
  type RecordMode,
  type RelayMessage,
} from "@polaris-key/client-core";

const here = dirname(fileURLToPath(import.meta.url));
const m = JSON.parse(
  readFileSync(join(here, "../../corpus/v2/peer-matrix.json"), "utf8"),
) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
/** Hex, or `{fill, count}` (one hex byte repeated). */
const bytes = (b: string | { fill: string; count: number }): Uint8Array =>
  typeof b === "string"
    ? unhex(b)
    : new Uint8Array(b.count).fill(parseInt(b.fill, 16));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("peer-matrix adverts", () => {
  it("epochs", () => {
    for (const r of m.adverts.epochs)
      expect(advertEpoch(r.now), String(r.now)).toBe(r.epoch);
    expect(m.adverts.epochSeconds).toBe(900);
  });
  it("names", async () => {
    for (const r of m.adverts.names)
      expect(
        await accountInstance(unhex(r.kDisc), r.epoch, r.deviceId),
        r.id,
      ).toBe(r.instance);
  });
  it("tags", async () => {
    for (const r of m.adverts.tags)
      expect(await productTag(r.slug, r.epoch)).toBe(r.h);
  });
  it("txt", () => {
    for (const r of m.adverts.txt)
      expect(parseTxt(r.entries), r.id).toEqual(r.want);
  });
  it("instance shapes", () => {
    for (const r of m.adverts.instances)
      expect(isInstanceName(r.name), r.name).toBe(r.want);
  });
  it("browse", async () => {
    for (const r of m.adverts.browse)
      expect(
        await browseAccountInstance(
          r.instance,
          r.kDiscs.map(unhex),
          r.now,
          r.roster,
        ),
        r.id,
      ).toEqual(r.want);
  });
});

describe("peer-matrix prologue and psk", () => {
  it("prologue", () => {
    for (const r of m.prologue)
      expect(hex(peerPrologue(r.slug, r.mode as PeerMode))).toBe(r.prologue);
  });
  it("psk", async () => {
    for (const r of m.psk)
      expect(hex(await peerPsk(unhex(r.kDisc), r.slug))).toBe(r.psk);
  });
});

describe("peer-matrix sas", () => {
  it("commits and bodies", async () => {
    for (const r of m.sas.commits) {
      expect(hex(await sasCommit(unhex(r.nD)))).toBe(r.c);
      expect(new TextDecoder().decode(sasBody("c", unhex(r.c)))).toBe(
        r.commitBody,
      );
      expect(new TextDecoder().decode(sasBody("nD", unhex(r.nD)))).toBe(
        r.revealBody,
      );
      expect(hex(parseSasBody("c", utf8(r.commitBody))!)).toBe(r.c);
      expect(hex(parseSasBody("nD", utf8(r.revealBody))!)).toBe(r.nD);
    }
  });
  it("codes", async () => {
    for (const r of m.sas.codes) {
      const code = await sasValue(unhex(r.h), unhex(r.nD), unhex(r.nM), r.mode);
      expect(code, r.id).toBe(r.code);
      expect(sasDisplay(code), r.id).toBe(r.display);
    }
  });
  it("reveals", async () => {
    for (const r of m.sas.reveals)
      expect(await sasRevealOk(r.c, r.nD), r.id).toBe(r.want);
  });
  it("nonces", () => {
    for (const r of m.sas.nonces) {
      const got = decodeSasValue(r.text);
      expect(got === null ? null : hex(got), r.id).toBe(r.want);
    }
  });
});

describe("peer-matrix frames", () => {
  it("encode", () => {
    for (const r of m.frames.encode)
      expect(hex(encodeFrame(unhex(r.noise)))).toBe(r.frame);
  });
  it("limits", () => {
    for (const r of m.frames.limits) {
      const body = new Uint8Array(r.len).fill(0x5a);
      if (r.want.refused) {
        expect(() => encodeFrame(body), String(r.len)).toThrow();
      } else {
        const f = encodeFrame(body);
        expect(hex(f.slice(0, 2))).toBe(r.want.header);
        expect(sha(f)).toBe(r.want.frameSha256);
      }
    }
  });
  it("decode", () => {
    for (const r of m.frames.decode) {
      const got = decodeFrames(unhex(r.stream));
      if ("error" in r.want) expect(got, r.id).toEqual(r.want);
      else {
        if ("error" in got) throw new Error(r.id);
        expect(got.frames.map(hex), r.id).toEqual(r.want.frames);
        expect(hex(got.rest), r.id).toBe(r.want.rest);
      }
    }
  });
});

describe("peer-matrix records", () => {
  it("parse", () => {
    for (const r of m.records.parse) {
      const got = parseRecord(unhex(r.plaintext));
      if (r.want.error) expect(got, r.plaintext).toBeNull();
      else {
        expect(got).not.toBeNull();
        expect(got!.type.toString(16).padStart(4, "0")).toBe(r.want.type);
        expect((got!.flags & 1) !== 0).toBe(r.want.more);
        expect(hex(got!.body)).toBe(r.want.body);
      }
    }
  });
  it("sessions", () => {
    for (const s of m.records.sessions) {
      const asm = new RecordAssembler(s.mode as RecordMode);
      const delivered: { type: string; length: number; sha256: string }[] = [];
      let close: { close: string; at: number } | null = null;
      for (let i = 0; i < s.records.length && close === null; i++) {
        const rec = s.records[i];
        const r = asm.push({
          type: parseInt(rec.type, 16),
          flags: rec.flags ?? 0,
          body: bytes(rec.body),
        });
        if (r.kind === "close") close = { close: r.code, at: i };
        else if (r.kind === "message")
          delivered.push({
            type: r.type.toString(16).padStart(4, "0"),
            length: r.body.length,
            sha256: sha(r.body),
          });
      }
      if (s.want.close) expect(close, s.id).toEqual(s.want);
      else {
        expect(close, s.id).toBeNull();
        expect({ delivered }, s.id).toEqual(s.want);
      }
    }
  });
});

describe("peer-matrix relay envelopes", () => {
  const toMsg = (x: any): RelayMessage => {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    const o: any = { ...x }; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const k of ["to", "from", "noise", "data", "device"])
      if (typeof o[k] === "string") o[k] = unhex(o[k]);
    if (o.devices) o.devices = o.devices.map(unhex);
    return o as RelayMessage;
  };
  it("messages round-trip both ways", () => {
    for (const r of m.relayEnvelopes.messages) {
      const msg = toMsg(r.message);
      expect(hex(encodeRelay(msg)), r.id).toBe(r.bytes);
      expect(decodeRelay(r.dir, unhex(r.bytes)), r.id).toEqual(msg);
    }
  });
  it("refused", () => {
    for (const r of m.relayEnvelopes.refused)
      expect(decodeRelay(r.dir, unhex(r.bytes)), r.id).toBeNull();
  });
  it("sizes", () => {
    for (const r of m.relayEnvelopes.sizes) {
      const prefix = unhex(r.bytes.prefix);
      const b = new Uint8Array(r.total).fill(parseInt(r.bytes.fill, 16));
      b.set(prefix);
      const got = decodeRelay(r.dir, b);
      if (r.want.refused) expect(got, r.id).toBeNull();
      else expect(got, r.id).not.toBeNull();
    }
  });
});

describe("peer-matrix handshake payloads", () => {
  it("payloads", () => {
    for (const r of m.handshakePayloads.payloads) {
      const b =
        r.payloadHex !== undefined
          ? unhex(r.payloadHex)
          : r.payloadPad !== undefined
            ? utf8(
                r.payloadPad.prefix +
                  r.payloadPad.fill.repeat(r.payloadPad.count) +
                  r.payloadPad.suffix,
              )
            : utf8(r.payload);
      expect(b.length, r.id).toBe(r.length);
      const v = parseHandshakePayload(r.mode, r.message, b);
      expect(v.ok, r.id).toBe(r.want.ok);
      if (r.want.ok && r.want.caps !== undefined && v.ok)
        expect(v.caps, r.id).toEqual(r.want.caps);
      if (r.want.cert !== undefined && v.ok) {
        expect(v.cert).toBe(r.want.cert);
        expect(v.ring).toBe(r.want.ring);
      }
    }
  });
  it("intersection", () => {
    for (const r of m.handshakePayloads.intersection)
      expect(capsIntersection(r.local, r.remote), r.id).toEqual(r.want);
  });
});

describe("peer-matrix lanAddresses", () => {
  it("rows", () => {
    expect(m.lanAddresses.rows.length).toBeGreaterThanOrEqual(35);
    for (const r of m.lanAddresses.rows)
      expect(lanVerdict(r.remote, r.local, r.allowLoopback), r.id).toEqual({
        dial: r.dial,
        key: r.key,
      });
  });
});
