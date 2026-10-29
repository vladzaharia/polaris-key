// The body of the Node and browser runners for `conformance/corpus/v2/peer-matrix.json`
// (WIRE-CONTRACT-V5 §15.4 to §15.7), shared like `suites.ts` is for corpus v2: `peerMatrix.test.ts`
// (Node, reads the file with node:fs) and `conformance/runners/browser` (Vite JSON import) both
// call `registerPeerMatrixSuites`, so a vector added to the matrix runs in every JS runtime at
// once. Every section runs through the codecs of `peer/` in `@polaris-key/client-core`: adverts,
// prologue and PSK, the SAS with its commit and reveal, framing, records and reassembly, relay
// envelopes and handshake payloads. Nothing here may import a Node builtin: this module runs in a
// browser. The only runtime port is SHA-256 (`node:crypto` in Node, `crypto.subtle` in the
// browser), which is async.
//
// Each registered suite names the matrix sections it covers (`SUITES`). A section the matrix has
// that no suite covers fails the run, so a section added to the file (the LAN-address and mDNS
// sections of the IPv6 slices) cannot go unrun in either runner: it plugs in as one more entry.
// A row an engine cannot run fails; it is never skipped (notes/A7 §5).

import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  isAcceptableEd25519Point,
  isCanonicalB64url,
  isX25519LowOrder,
} from "@polaris-key/jws";
import {
  RecordAssembler,
  accountInstance,
  advertEpoch,
  browseAccountInstance,
  candidateTarget,
  capsIntersection,
  decodeFrames,
  decodeRelay,
  decodeSasValue,
  encodeFrame,
  encodeRelay,
  isInstanceName,
  lanGroupKey,
  lanVerdict,
  normalizeDeviceLabel,
  parseHandshakePayload,
  parseRecord,
  parseSasBody,
  parseStrictObject,
  parseTxt,
  peerPrologue,
  peerPsk,
  productTag,
  sasBody,
  sasCommit,
  sasDisplay,
  sasRevealOk,
  sasValue,
  verifyDeviceProof,
  type PeerMode,
  type RecordMode,
  type RelayMessage,
} from "@polaris-key/client-core";

/** The parsed `peer-matrix.json`. */
export type PeerMatrix = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** SHA-256 of the bytes: `node:crypto` in Node, `crypto.subtle.digest` in the browser. */
export type Sha256 = (bytes: Uint8Array) => Promise<Uint8Array>;

/** SHA-256 as lowercase hex. */
type ShaHex = (bytes: Uint8Array) => Promise<string>;

export interface PeerMatrixPorts {
  sha256: Sha256;
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
/** Hex, or `{fill, count}` (one hex byte repeated). */
const bytes = (b: string | { fill: string; count: number }): Uint8Array =>
  typeof b === "string"
    ? unhex(b)
    : new Uint8Array(b.count).fill(parseInt(b.fill, 16));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function adverts(m: PeerMatrix): void {
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
}

function prologueAndPsk(m: PeerMatrix): void {
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
}

function sas(m: PeerMatrix): void {
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
        const code = await sasValue(
          unhex(r.h),
          unhex(r.nD),
          unhex(r.nM),
          r.mode,
        );
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
}

function frames(m: PeerMatrix, sha: ShaHex): void {
  describe("peer-matrix frames", () => {
    it("encode", () => {
      for (const r of m.frames.encode)
        expect(hex(encodeFrame(unhex(r.noise)))).toBe(r.frame);
    });
    it("limits", async () => {
      for (const r of m.frames.limits) {
        const body = new Uint8Array(r.len).fill(0x5a);
        if (r.want.refused) {
          expect(() => encodeFrame(body), String(r.len)).toThrow();
        } else {
          const f = encodeFrame(body);
          expect(hex(f.slice(0, 2))).toBe(r.want.header);
          expect(await sha(f)).toBe(r.want.frameSha256);
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
}

function records(m: PeerMatrix, sha: ShaHex): void {
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
    it("sessions", async () => {
      for (const s of m.records.sessions) {
        const asm = new RecordAssembler(s.mode as RecordMode);
        const delivered: { type: string; length: number; sha256: string }[] =
          [];
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
              sha256: await sha(r.body),
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
}

function relayEnvelopes(m: PeerMatrix): void {
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
}

function handshakePayloads(m: PeerMatrix): void {
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
}

function lanAddresses(m: PeerMatrix): void {
  describe("peer-matrix lanAddresses", () => {
    const rows = m.lanAddresses.rows;
    const cands = m.lanAddresses.candidates.rows;
    // Exact: a row added or dropped is a deliberate corpus change, never a silent one.
    it("has the rows", () => {
      expect(rows.length).toBe(133);
      expect(cands.length).toBe(73);
      for (const list of [rows, cands])
        expect(new Set(list.map((r: { id: string }) => r.id)).size).toBe(
          list.length,
        );
    });
    it("lanVerdict rows", () => {
      for (const r of rows) {
        expect(lanVerdict(r.remote, r.local, r.allowLoopback), r.id).toEqual({
          dial: r.dial,
          key: r.key,
        });
        expect(lanGroupKey(r.key), r.id).toBe(r.group);
      }
    });
    it("candidate rows", () => {
      for (const r of cands)
        expect(candidateTarget(r.entry, r.interfaces), r.id).toEqual(r.target);
    });
  });
}

/**
 * The mDNS answer rows are run by the SDKs that have their own DNS codec (V5 §15.9); client-core
 * holds none. This suite checks the shape every runner relies on, so a malformed row cannot reach
 * an SDK unseen.
 */
function mdnsAnswers(m: PeerMatrix): void {
  describe("peer-matrix mdnsAnswers (shape)", () => {
    const rows = m.mdnsAnswers.rows;
    it("has well-formed rows", () => {
      expect(rows.length).toBe(21);
      expect(new Set(rows.map((r: { id: string }) => r.id)).size).toBe(
        rows.length,
      );
      for (const r of rows) {
        expect(r.packet, r.id).toMatch(/^(?:[0-9a-f]{2})+$/);
        expect(typeof r.source, r.id).toBe("string");
        expect(r.zone === null || typeof r.zone === "string", r.id).toBe(true);
        for (const l of r.learned) {
          expect(typeof l.name, r.id).toBe("string");
          expect(typeof l.address, r.id).toBe("string");
        }
      }
    });
  });
}

// ── vouch (WIRE-CONTRACT-V5 §15.6.1) ─────────────────────────────────────────
//
// Until CC-15.1 lands `peer/vouch.ts` in client-core, this file holds the one JS implementation
// of the vouch rules the rows pin. It is built from client-core and jws primitives only (the
// strict JSON reader, the label cleaning, the `vouch` device proof) and uses nothing outside
// them, so it runs unchanged in Node and in a browser. When CC-15.1 merges, these four helpers
// are replaced by its exports and the rows stay.

const VOUCH_REQ_MAX = 4096;
const VOUCH_HELD_RECORDS = 16;
const VOUCH_HELD_BYTES = 16384;
const PLATFORM_SHOWN = /^[A-Za-z0-9 ._+-]{1,32}$/;
const P25519 = (1n << 255n) - 19n;
const REQUEST_RE = /^nr_[A-Za-z0-9_-]{22}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{32}$/;

const cleanLabel = (raw: string): string | null =>
  normalizeDeviceLabel(raw.normalize("NFC"));
const cleanPlatform = (raw: string): string =>
  PLATFORM_SHOWN.test(raw) ? raw : "Unknown";

/** A canonical base64url of 32 bytes, decoded, or null. */
function key32(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || v.length !== 43 || !isCanonicalB64url(v))
    return null;
  const b = base64UrlDecode(v);
  return b.length === 32 ? b : null;
}

/** The one X25519 spelling the Worker registers: bit 255 clear and u below p (§15.8). */
function agreeSpelling(k: Uint8Array): boolean {
  if ((k[31]! & 0x80) !== 0) return false;
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(k[i]!);
  return u < P25519;
}

interface VouchShown {
  request: string;
  deviceId: string;
  signKey: string;
  agreeKey: string;
  label: string | null;
  platform: string;
}

/** M's check of a `VOUCH_REQ` body against D's HELLO (§15.6.1 rule 5), or null to refuse. */
async function checkVouchRequest(
  slug: string,
  h: Uint8Array,
  hello: { label?: string; platform: string },
  body: Uint8Array,
): Promise<VouchShown | null> {
  if (body.length > VOUCH_REQ_MAX) return null;
  const o = parseStrictObject(body);
  if (o === null || o.v !== 1) return null;
  const { request, deviceId, signKey, agreeKey, label, platform, sig } = o;
  if (typeof request !== "string" || !REQUEST_RE.test(request)) return null;
  if (typeof deviceId !== "string" || !DEVICE_RE.test(deviceId)) return null;
  const sk = key32(signKey);
  if (sk === null || !isAcceptableEd25519Point(sk)) return null;
  const ak = key32(agreeKey);
  if (ak === null || isX25519LowOrder(ak) || !agreeSpelling(ak)) return null;
  if (label !== undefined && typeof label !== "string") return null;
  if (typeof platform !== "string" || typeof sig !== "string") return null;
  const proven = await verifyDeviceProof({
    purpose: "vouch",
    product: slug,
    deviceId,
    value: `${base64UrlEncodeBytes(h)}.${request}`,
    tokenHash: "-",
    signKey: signKey as string,
    sig,
  });
  if (!proven) return null;
  const shown = label === undefined ? null : cleanLabel(label);
  const helloLabel = hello.label === undefined ? null : cleanLabel(hello.label);
  if (shown !== helloLabel) return null;
  const shownPlatform = cleanPlatform(platform);
  if (shownPlatform !== cleanPlatform(hello.platform)) return null;
  return {
    request,
    deviceId,
    signKey: signKey as string,
    agreeKey: agreeKey as string,
    label: shown,
    platform: shownPlatform,
  };
}

/** D's reading of a `VOUCH_RESULT` body (§15.6.1 rule 6). */
function readVouchResult(
  body: Uint8Array,
): { status: string } | { refuse: "peer_bad_frame" } {
  const o = parseStrictObject(body);
  if (o === null || typeof o.status !== "string")
    return { refuse: "peer_bad_frame" };
  return {
    status:
      o.status === "approved" || o.status === "denied" || o.status === "expired"
        ? o.status
        : "denied",
  };
}

interface FlowStep {
  ev?: string;
  capsD?: string[];
  capsM?: string[];
  dir?: "d2m" | "m2d";
  type?: string;
  status?: string;
  bytes?: number;
}

/** One session's order, direction and gating rules (§15.6.1 rules 1, 4, 7, 8, 12). */
function runVouchFlow(steps: FlowStep[]): {
  close: string | null;
  at: number | null;
  delivered: number[];
} {
  const delivered: number[] = [];
  const held: { at: number; bytes: number }[] = [];
  let heldBytes = 0;
  let picked = false;
  let confirmed = false;
  let requestAt = -1;
  let requestPending = false;
  let resultStatus: string | undefined;
  let resultSeen = false;
  const close = (code: string, at: number) => ({ close: code, at, delivered });
  for (const [i, s] of steps.entries()) {
    if (s.ev !== undefined) {
      if (s.ev === "handshake") {
        if (!capsIntersection(s.capsD!, s.capsM!).includes("vouch/1"))
          return close("peer_not_allowed", i);
      } else if (s.ev === "picked") {
        picked = true;
        if (requestPending) {
          delivered.push(requestAt);
          requestPending = false;
        }
      } else if (s.ev === "wrong-pick" || s.ev === "none-match") {
        return close("peer_bye", i);
      } else if (s.ev === "timeout") {
        return close("peer_timeout", i);
      } else if (s.ev === "confirmed") {
        confirmed = true;
        for (const h of held.splice(0)) delivered.push(h.at);
        heldBytes = 0;
      }
      continue;
    }
    const sync = /^003[0-9a-f]$/.test(s.type!);
    if (s.type === "8010") {
      if (s.dir !== "d2m") return close("peer_not_allowed", i);
      if (requestAt >= 0) return close("peer_bad_frame", i);
      requestAt = i;
      if (picked) delivered.push(i);
      else requestPending = true;
    } else if (s.type === "8011") {
      if (s.dir !== "m2d" || requestAt < 0) return close("peer_not_allowed", i);
      if (resultSeen) return close("peer_bad_frame", i);
      resultSeen = true;
      resultStatus = s.status;
      delivered.push(i);
    } else if (sync) {
      if (s.dir !== "m2d" || resultStatus !== "approved")
        return close("peer_not_allowed", i);
      if (confirmed) {
        delivered.push(i);
      } else {
        const n = s.bytes ?? 0;
        if (
          held.length >= VOUCH_HELD_RECORDS ||
          heldBytes + n > VOUCH_HELD_BYTES
        )
          return close("peer_busy", i);
        held.push({ at: i, bytes: n });
        heldBytes += n;
      }
    } else {
      throw new Error(`unknown record type ${s.type}`);
    }
  }
  return { close: null, at: null, delivered };
}

/** What M does with the answer of `nearby/approve` (§15.6.1 rule 6). */
function vouchFinish(r: {
  keysRetried: boolean;
  http: number | null;
  body: string | null;
  discoveryNearby: boolean;
}): Record<string, unknown> {
  const stop = (stopAdvert = false) => ({ close: true, stopAdvert });
  if (r.http === null) return stop();
  const o = r.body === null ? null : parseStrictObject(utf8(r.body));
  const code = typeof o?.code === "string" ? o.code : null;
  if (r.http === 200) {
    if (o?.status === "approved") return { send: "approved" };
    return o?.status === "choose" ? { wait: "choice" } : stop();
  }
  if (r.http === 204) return { send: "denied" };
  if (r.http === 403)
    return code === "not_nearby" || code === "device_limit"
      ? { send: "denied" }
      : stop();
  if (r.http === 404)
    return r.discoveryNearby ? { send: "expired" } : stop(true);
  if (r.http === 409) {
    if (code === "device_keys_required")
      return r.keysRetried ? stop() : { wait: "keys" };
    return code === "license_choice_required" ? { wait: "choice" } : stop();
  }
  return stop();
}

/** A request row's body bytes: text, hex, or a prefix, a filler and a suffix. */
function vouchBody(r: any): Uint8Array {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (r.bodyHex !== undefined) return unhex(r.bodyHex);
  if (r.bodyPad !== undefined)
    return utf8(
      r.bodyPad.prefix +
        r.bodyPad.fill.repeat(r.bodyPad.count) +
        r.bodyPad.suffix,
    );
  return utf8(r.body);
}

function vouch(m: PeerMatrix): void {
  describe("peer-matrix vouch", () => {
    const v = m.vouch;
    const unique = (rows: { id: string }[]) =>
      new Set(rows.map((r) => r.id)).size === rows.length;
    // Exact: a row added or dropped is a deliberate corpus change, never a silent one.
    it("has the rows", () => {
      expect(v.requests.length).toBe(78);
      expect(v.results.length).toBe(26);
      expect(v.flows.length).toBe(30);
      expect(v.finish.length).toBe(29);
      for (const k of ["requests", "results", "flows", "finish"])
        expect(unique(v[k]), k).toBe(true);
    });
    it("requests", async () => {
      for (const r of v.requests) {
        const body = vouchBody(r);
        if (r.bodyPad !== undefined) expect(body.length, r.id).toBe(r.length);
        const got = await checkVouchRequest(
          r.slug,
          unhex(r.hHex),
          r.hello,
          body,
        );
        if (r.verdict === "ok") expect(got, r.id).toEqual(r.result);
        else {
          expect(got, r.id).toBeNull();
          expect(r.close, r.id).toBe("peer_bad_frame");
        }
      }
    });
    it("results", () => {
      for (const r of v.results) {
        const got = readVouchResult(vouchBody(r));
        expect(got, r.id).toEqual(
          r.refuse !== undefined ? { refuse: r.refuse } : { status: r.status },
        );
      }
    });
    it("flows", () => {
      for (const r of v.flows)
        expect(runVouchFlow(r.steps), r.id).toEqual(r.want);
    });
    it("finish", () => {
      for (const r of v.finish) expect(vouchFinish(r), r.id).toEqual(r.result);
    });
  });
}

/** Keys of the matrix that are not sections. */
const META = new Set(["peerMatrixVersion", "description"]);

/** One suite and the matrix sections it covers. */
const SUITES: {
  sections: readonly string[];
  run: (m: PeerMatrix, sha: ShaHex) => void;
}[] = [
  { sections: ["adverts"], run: adverts },
  { sections: ["prologue", "psk"], run: prologueAndPsk },
  { sections: ["sas"], run: sas },
  { sections: ["frames"], run: frames },
  { sections: ["records"], run: records },
  { sections: ["relayEnvelopes"], run: relayEnvelopes },
  { sections: ["handshakePayloads"], run: handshakePayloads },
  { sections: ["lanAddresses"], run: lanAddresses },
  { sections: ["mdnsAnswers"], run: mdnsAnswers },
  { sections: ["vouch"], run: vouch },
];

/** Register every suite whose sections the matrix has, and fail on a section no suite covers. */
export function registerPeerMatrixSuites(
  m: PeerMatrix,
  { sha256 }: PeerMatrixPorts,
): void {
  const sha = async (b: Uint8Array): Promise<string> => hex(await sha256(b));
  const covered = new Set(SUITES.flatMap((s) => s.sections));
  describe("peer-matrix coverage", () => {
    it("every section of the matrix has a suite", () => {
      const uncovered = Object.keys(m).filter(
        (k) => !META.has(k) && !covered.has(k),
      );
      expect(uncovered, "sections no suite covers").toEqual([]);
    });
    it("every suite's sections exist in the matrix", () => {
      const missing = [...covered].filter((k) => !(k in m));
      expect(missing, "sections the matrix lacks").toEqual([]);
    });
  });
  for (const s of SUITES) s.run(m, sha);
}
