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
export const REF_MAX_PENDING = 8;
export const REF_PENDING_SECONDS = 86_400;
/** The secrets a responder tries and a browser tests: held contacts and pending ones. */
export const REF_MAX_SECRETS = REF_MAX_CONTACTS + REF_MAX_PENDING;
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
export const byteCompare = (a: Uint8Array, b: Uint8Array): number => {
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

/** A body as a strict-JSON object: at most `max` bytes of UTF-8 with no BOM, an object; else null. */
export function refBodyObject(
  bytes: Uint8Array,
  max: number,
): Record<string, Json> | null {
  if (bytes.length > max) return null;
  // Valid UTF-8 round-trips; a BOM is a first character U+FEFF and refuses.
  const text = Buffer.from(bytes).toString("utf8");
  if (Buffer.compare(Buffer.from(text, "utf8"), bytes) !== 0) return null;
  if (text.charCodeAt(0) === 0xfeff) return null;
  const parsed = refParseStrict(text);
  if (!parsed.ok) return null;
  const o = parsed.value;
  return o === null || typeof o !== "object" || Array.isArray(o) ? null : o;
}

/** `cats`: at most `max` distinct strings of `^[a-z0-9-]{1,32}$`; null when the rule is broken. */
export function refBodyCats(v: Json | undefined, max: number): string[] | null {
  if (
    !Array.isArray(v) ||
    v.length > max ||
    !v.every((c) => typeof c === "string" && CAT_RE.test(c)) ||
    new Set(v as string[]).size !== v.length
  )
    return null;
  return v as string[];
}

/** An optional `label`: undefined when absent or cleaned to nothing, the cleaned text, or null
 *  when it is not a string. */
export function refBodyLabel(v: Json | undefined): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return null;
  return refVouchLabel(v) ?? undefined;
}

export type ContactVerdict =
  | { ok: true; agreeKey: string; label?: string; cats: string[] }
  | { ok: false };

/** Judge one `CONTACT` body. `own` is the reader's own agreeKey (43 characters), when known. */
export function refContactBody(
  bytes: Uint8Array,
  own?: string,
): ContactVerdict {
  const no: ContactVerdict = { ok: false };
  const o = refBodyObject(bytes, REF_CONTACT_BODY_MAX);
  if (o === null || o.v !== 1) return no;
  const key = refKey32(o.agreeKey);
  if (key === null || refX25519LowOrder(key)) return no;
  if (own !== undefined && o.agreeKey === own) return no;
  const cats = refBodyCats(o.cats, REF_MAX_CONTACT_CATS);
  if (cats === null) return no;
  const label = refBodyLabel(o.label);
  if (label === null) return no;
  return {
    ok: true,
    agreeKey: o.agreeKey as string,
    ...(label !== undefined ? { label } : {}),
    cats,
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
  close?: "peer_bad_frame" | "peer_timeout" | "peer_not_allowed";
  stored?: {
    agreeKey: string;
    label?: string;
    cats: string[];
    pending: boolean;
  };
}

/** Feed the events of one side in order: what each sends, and where it closes or stores. */
export function refContactExchange(
  events: ExchangeEvent[],
  own?: string,
  held: readonly string[] = [],
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
        // A peer already held is a re-pair, at any count; a new one needs room.
        const isHeld = held.includes(v.agreeKey);
        if (!isHeld && held.length >= REF_MAX_CONTACTS) {
          r.close = "peer_not_allowed";
          dead = true;
          break;
        }
        peerContact = true;
        r.stored = {
          agreeKey: v.agreeKey,
          ...(v.label !== undefined ? { label: v.label } : {}),
          cats: v.cats,
          pending: isHeld,
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

/** Which contact an instance belongs to: the first of the first 72 secrets (held contacts, then
 *  pending ones), in that order, that matches in the current or the previous epoch. At most 144
 *  HMACs. */
export function refContactBrowse(
  instance: string,
  contacts: readonly RefContact[],
  now: number,
): ContactHit | null {
  if (!refInstanceShape(instance)) return null;
  const epoch = refAdvertEpoch(now);
  for (let i = 0; i < contacts.length && i < REF_MAX_SECRETS; i++)
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

// ── The contact list (§15.10, "pending contacts") ────────────────────────────

export interface RefStored {
  agreeKey: string;
  secret: string;
  label?: string;
  /** Unix seconds a pending contact was stored. */
  since?: number;
}

export interface RefStore {
  /** The held contacts, in held order. */
  active: RefStored[];
  /** The pending contacts, in the order they were stored (at most one per key). */
  pending: RefStored[];
}

export type StoreOp =
  | {
      op: "pair";
      agreeKey: string;
      secret: string;
      label?: string;
      now: number;
    }
  | { op: "promote"; agreeKey: string }
  | { op: "drop"; now: number };

export interface StoreStepResult {
  /** Of a `pair`: where the contact went. */
  result?: "active" | "pending" | "full";
  active: string[];
  pending: string[];
  /** The order secrets are tried and browsed in: held, then pending. */
  order: string[];
}

/** Apply `ops` in order to `start`; the state after each op, as secret ids. */
export function refContactStore(
  start: RefStore,
  ops: readonly StoreOp[],
): StoreStepResult[] {
  const active = start.active.map((c) => ({ ...c }));
  let pending = start.pending.map((c) => ({ ...c }));
  const out: StoreStepResult[] = [];
  for (const o of ops) {
    let result: StoreStepResult["result"];
    if (o.op === "pair") {
      const c: RefStored = {
        agreeKey: o.agreeKey,
        secret: o.secret,
        ...(o.label !== undefined ? { label: o.label } : {}),
      };
      if (active.some((a) => a.agreeKey === o.agreeKey)) {
        // The same peer again: held stays; one pending per key; the oldest of 8 goes.
        pending = pending.filter((p) => p.agreeKey !== o.agreeKey);
        pending.push({ ...c, since: o.now });
        while (pending.length > REF_MAX_PENDING) {
          let at = 0;
          for (let i = 1; i < pending.length; i++)
            if (pending[i]!.since! < pending[at]!.since!) at = i;
          pending.splice(at, 1);
        }
        result = "pending";
      } else if (active.length >= REF_MAX_CONTACTS) result = "full";
      else {
        active.push(c);
        result = "active";
      }
    } else if (o.op === "promote") {
      const at = pending.findIndex((p) => p.agreeKey === o.agreeKey);
      if (at >= 0) {
        const p = pending.splice(at, 1)[0]!;
        const slot = active.findIndex((a) => a.agreeKey === o.agreeKey);
        const { since: _s, ...fresh } = p;
        void _s;
        if (slot >= 0) active[slot] = fresh;
        else active.push(fresh);
      }
    } else {
      pending = pending.filter((p) => o.now - p.since! < REF_PENDING_SECONDS);
    }
    const ids = (l: RefStored[]): string[] => l.map((c) => c.secret);
    out.push({
      ...(result !== undefined ? { result } : {}),
      active: ids(active),
      pending: ids(pending),
      order: [...ids(active), ...ids(pending)].slice(0, REF_MAX_SECRETS),
    });
  }
  return out;
}

// ── The shared listener (§15.5 responder rules, §15.10) ──────────────────────

export interface ListenerIn {
  /** The device has an account: its discKeys (current, previous; null = none) are tried. */
  account: (string | null)[] | null;
  /** The contact secrets, in `order` (at most 72). */
  contacts: string[];
  /** Which key opens message 1, if any. */
  opens: { mode: "a"; key: number } | { mode: "c"; contact: number } | null;
  /** What the limiter says to a contact trial. */
  limiter: "admit" | "refuse";
}

export interface ListenerOut {
  /** Every key a tag was tried under, in order: `a:<i>` or `c:<i>`. */
  tried: string[];
  /** The mode and index that decided, or null. */
  hit: string | null;
  /** A limiter slot is held while the connection waits for message 3 (a contact hit only). */
  slot: boolean;
  /** Silent in every case: nothing is sent. */
  close: "handshake_failed" | "peer_busy" | null;
}

/** The account's discKeys tried in order (only the first two); the hit, if any. */
export function refTrialAccount(
  account: (string | null)[] | null,
  key: number | null,
  tried: string[],
): string | null {
  for (let k = 0; account !== null && k < Math.min(2, account.length); k++) {
    if (account[k] === null) continue;
    tried.push(`a:${k}`);
    if (key === k) return `a:${k}`;
  }
  return null;
}

/** `count` secrets of one kind tried in order, at most `cap`; the hit, if any. */
export function refTrialList(
  kind: string,
  count: number,
  cap: number,
  opens: number | null,
  tried: string[],
): string | null {
  for (let k = 0; k < Math.min(cap, count); k++) {
    tried.push(`${kind}:${k}`);
    if (opens === k) return `${kind}:${k}`;
  }
  return null;
}

export function refListener(i: ListenerIn): ListenerOut {
  const tried: string[] = [];
  const a = refTrialAccount(
    i.account,
    i.opens?.mode === "a" ? i.opens.key : null,
    tried,
  );
  if (a !== null) return { tried, hit: a, slot: false, close: null };
  if (i.contacts.length === 0)
    return { tried, hit: null, slot: false, close: "handshake_failed" };
  if (i.limiter === "refuse")
    return { tried, hit: null, slot: false, close: "peer_busy" };
  const c = refTrialList(
    "c",
    i.contacts.length,
    REF_MAX_SECRETS,
    i.opens?.mode === "c" ? i.opens.contact : null,
    tried,
  );
  return c !== null
    ? { tried, hit: c, slot: true, close: null }
    : { tried, hit: null, slot: false, close: "handshake_failed" };
}

// ── The pin (§15.10) ─────────────────────────────────────────────────────────

/** The remote static key must equal the agreeKey of the contact that opened the session. */
export function refPin(held: string, remoteStatic: Uint8Array): boolean {
  return Buffer.from(remoteStatic).toString("base64url") === held;
}
