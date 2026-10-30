// Reference: inter-account links (WIRE-CONTRACT-V5 §15.10, §15.7 contact rooms, §15.4 the contact
// advert; plans/CC-16-CC-19-CC-20-slices.md D-2 to D-7).
//
// The contact secret, the `CONTACT` body, the categories, the contact advert (name, TXT, browse),
// the room id and alias, the ticket body and the pairing exchange order. Written from the
// specification over `node:crypto` alone (the hash, HMAC and HKDF helpers are the Noise
// reference's), so it shares nothing with client-core.

import { refCanonicalB64url } from "./b64url.js";
import { refParseStrict, type Json } from "./config.js";
import { bytesHex, hmac, refHkdf, sha256 } from "./noise.js";
import { refX25519LowOrder } from "./peer.js";
import {
  cat,
  refAdvertEpoch,
  refBase32Lower,
  refDeviceIdBytes,
  refInstanceShape,
  refVouchLabel,
  utf8,
} from "./peerMatrix.js";

export const REF_MAX_CONTACTS = 64;
export const REF_MAX_CONTACT_CATS = 8;
export const REF_CONTACT_BODY_MAX = 4096;
export const REF_TICKET_BODY_MAX = 256;
const CAT_RE = /^[a-z0-9-]{1,32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const RID_RE = /^[A-Za-z0-9_-]{22}$/;

const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from(s, "base64url"));

/** A key spelling: 43 canonical base64url characters of 32 bytes; null otherwise. */
function refKey32(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !KEY_RE.test(v) || !refCanonicalB64url(v))
    return null;
  const b = unb64u(v);
  return b.length === 32 ? b : null;
}

/** Unsigned byte order of two equal-length byte strings: negative, zero or positive. */
const byteCompare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

// ── The contact secret (§15.10) ──────────────────────────────────────────────

/**
 * `HKDF-SHA256(salt = h, ikm = nD ‖ nM, info = "pkey-peer/1 contact" ‖ 0x00 ‖ lo ‖ hi)`, 32 bytes:
 * `lo` and `hi` are the two agreeKeys (32 raw bytes each) by unsigned byte order.
 */
export function refContactSecret(
  h: Uint8Array,
  nD: Uint8Array,
  nM: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): Uint8Array {
  const [lo, hi] = byteCompare(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  return refHkdf(
    h,
    cat(nD, nM),
    cat(utf8("pkey-peer/1 contact"), Uint8Array.of(0), lo, hi),
    32,
  );
}

// ── The CONTACT body (§15.10) ────────────────────────────────────────────────

export type ContactVerdict =
  | { ok: true; agreeKey: string; label?: string; cats: string[] }
  | { ok: false };

/** Judge one `CONTACT` body. `own` is the reader's own agreeKey (43 characters), when known. */
export function refContactBody(
  bytes: Uint8Array,
  own?: string,
): ContactVerdict {
  const no: ContactVerdict = { ok: false };
  if (bytes.length > REF_CONTACT_BODY_MAX) return no;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return no;
  }
  if (text.startsWith("\ufeff")) return no;
  const parsed = refParseStrict(text);
  if (!parsed.ok) return no;
  const o = parsed.value;
  if (o === null || typeof o !== "object" || Array.isArray(o)) return no;
  if (o.v !== 1) return no;
  const key = refKey32(o.agreeKey);
  if (key === null || refX25519LowOrder(key)) return no;
  if (own !== undefined && o.agreeKey === own) return no;
  const cats = o.cats;
  if (
    !Array.isArray(cats) ||
    cats.length > REF_MAX_CONTACT_CATS ||
    !cats.every((c) => typeof c === "string" && CAT_RE.test(c)) ||
    new Set(cats as string[]).size !== cats.length
  )
    return no;
  let label: string | undefined;
  if (o.label !== undefined) {
    if (typeof o.label !== "string") return no;
    const l = refVouchLabel(o.label);
    if (l !== null) label = l;
  }
  return {
    ok: true,
    agreeKey: o.agreeKey as string,
    ...(label !== undefined ? { label } : {}),
    cats: cats as string[],
  };
}

/** A link's categories: the entries both sides list, once each, in byte order. */
export const refContactCategories = (
  a: readonly string[],
  b: readonly string[],
): string[] => [...new Set(a.filter((c) => b.includes(c)))].sort();

// ── The pairing exchange (§15.10, "Order of checks") ─────────────────────────

export type ExchangeEvent =
  | { event: "own-confirm" }
  | { event: "peer-confirm" }
  | { event: "peer-contact"; body: Uint8Array }
  | { event: "timeout" };

export interface ExchangeStepResult {
  sends: ("CONFIRM" | "CONTACT")[];
  close?: "peer_bad_frame" | "peer_timeout";
  stored?: { agreeKey: string; label?: string; cats: string[] };
}

/** Feed the events of one side in order: what each sends, and where it closes or stores. */
export function refContactExchange(
  events: ExchangeEvent[],
  own?: string,
): ExchangeStepResult[] {
  let ownConfirmed = false;
  let peerConfirmed = false;
  let contactSent = false;
  let peerContact = false;
  let dead = false;
  const out: ExchangeStepResult[] = [];
  for (const e of events) {
    const r: ExchangeStepResult = { sends: [] };
    const bad = (): void => {
      r.close = "peer_bad_frame";
      dead = true;
    };
    const maybeContact = (): void => {
      if (ownConfirmed && peerConfirmed && !contactSent) {
        contactSent = true;
        r.sends.push("CONTACT");
      }
    };
    if (dead) {
      out.push(r);
      continue;
    }
    switch (e.event) {
      case "own-confirm":
        ownConfirmed = true;
        r.sends.push("CONFIRM");
        maybeContact();
        break;
      case "peer-confirm":
        if (peerConfirmed) bad();
        else {
          peerConfirmed = true;
          maybeContact();
        }
        break;
      case "peer-contact": {
        if (!ownConfirmed || !peerConfirmed || peerContact) {
          bad();
          break;
        }
        const v = refContactBody(e.body, own);
        if (!v.ok) {
          bad();
          break;
        }
        peerContact = true;
        r.stored = {
          agreeKey: v.agreeKey,
          ...(v.label !== undefined ? { label: v.label } : {}),
          cats: v.cats,
        };
        break;
      }
      case "timeout":
        if (ownConfirmed && !peerContact) {
          r.close = "peer_timeout";
          dead = true;
        }
        break;
    }
    out.push(r);
  }
  return out;
}

// ── The LAN advert (§15.4, §15.10) ───────────────────────────────────────────

/** `p1-` + base32lower(HMAC-SHA256(secret, "pkey-peer/1 cdisc" ‖ 0x00 ‖ u64be(epoch) ‖ agreeKey))[0..16]. */
export const refContactInstance = (
  secret: Uint8Array,
  agreeKey: Uint8Array,
  epoch: number,
): string =>
  `p1-${refBase32Lower(
    hmac(
      secret,
      cat(utf8("pkey-peer/1 cdisc"), Uint8Array.of(0), u64be(epoch), agreeKey),
    ),
  ).slice(0, 16)}`;

export type ContactTxtVerdict = { ok: true } | { ok: false; reason: string };

/** `v=1` and `m=c`; an entry splits at its first `=`; one without `=` or with an empty key is
 *  ignored; a repeated key refuses; `h` is not read. */
export function refContactTxt(entries: string[]): ContactTxtVerdict {
  const kv = new Map<string, string>();
  for (const e of entries) {
    const at = e.indexOf("=");
    if (at < 1) continue;
    const k = e.slice(0, at);
    if (kv.has(k)) return { ok: false, reason: "duplicate" };
    kv.set(k, e.slice(at + 1));
  }
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  if (kv.get("m") !== "c") return { ok: false, reason: "mode" };
  return { ok: true };
}

export interface RefContact {
  secret: Uint8Array;
  /** The peer's agreeKey, 32 raw bytes. */
  agreeKey: Uint8Array;
}

export interface ContactHit {
  /** Index into the contacts as held. */
  contact: number;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
}

/** Which contact an instance belongs to: the first of the first 64 contacts, in held order,
 *  that matches in the current or the previous epoch. At most 128 HMACs. */
export function refContactBrowse(
  instance: string,
  contacts: readonly RefContact[],
  now: number,
): ContactHit | null {
  if (!refInstanceShape(instance)) return null;
  const epoch = refAdvertEpoch(now);
  for (let i = 0; i < contacts.length && i < REF_MAX_CONTACTS; i++)
    for (const epochBack of [0, 1] as const)
      if (
        refContactInstance(
          contacts[i]!.secret,
          contacts[i]!.agreeKey,
          epoch - epochBack,
        ) === instance
      )
        return { contact: i, epochBack };
  return null;
}

// ── The contact room (§15.7) ─────────────────────────────────────────────────

/** `base64url(HKDF-SHA256(salt = empty, ikm = secret, info = "pkey-peer/1 room")[0..16])`. */
export const refContactRid = (secret: Uint8Array): string =>
  b64u(
    refHkdf(new Uint8Array(0), secret, utf8("pkey-peer/1 room"), 32).slice(
      0,
      16,
    ),
  );

/** `SHA-256(rid ‖ deviceId)[0..24]` over the 16 decoded rid bytes and the 24 decoded device-id
 *  bytes, as 48 hex characters. */
export const refContactAlias = (rid: string, deviceId: string): string =>
  bytesHex(sha256(unb64u(rid), refDeviceIdBytes(deviceId)).slice(0, 24));

export type TicketBodyVerdict = { ok: true; rid: string } | { ok: false };

/** The optional ticket-request body `{"room":"c","rid":"<22>"}`: strict JSON, at most 256 bytes,
 *  exactly those two members. */
export function refContactTicketBody(bytes: Uint8Array): TicketBodyVerdict {
  const no: TicketBodyVerdict = { ok: false };
  if (bytes.length > REF_TICKET_BODY_MAX) return no;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return no;
  }
  if (text.startsWith("\ufeff")) return no;
  const parsed = refParseStrict(text);
  if (!parsed.ok) return no;
  const o: Json = parsed.value;
  if (o === null || typeof o !== "object" || Array.isArray(o)) return no;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes("room") || !keys.includes("rid"))
    return no;
  if (o.room !== "c") return no;
  const rid = o.rid;
  if (typeof rid !== "string" || !RID_RE.test(rid)) return no;
  if (!refCanonicalB64url(rid) || unb64u(rid).length !== 16) return no;
  return { ok: true, rid };
}
