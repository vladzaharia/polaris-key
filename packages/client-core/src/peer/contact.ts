// WIRE-CONTRACT-V5 §15.10: inter-account links. Pure functions, no I/O: the contact secret, the
// `CONTACT` body, a link's categories, the order of the pairing exchange, the contact advert (name,
// TXT, browse) and the contact room (room id, alias, ticket body). The vectors are
// `peer-matrix.json` `contact`; the session (`session.ts`) runs the exchange and mode `c`.
//
// The secret and the keys are key material: nothing here logs or returns one inside an error.

import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  isCanonicalB64url,
  isX25519LowOrder,
} from "@polaris-key/jws";
import {
  advertEpoch,
  deviceIdBytes,
  isInstanceName,
  base32Lower,
} from "./advert.js";
import { cleanLabel } from "./display.js";
import { hkdfSha256, hmac, sha256 } from "./noise.js";
import { parseStrictObject } from "./payload.js";
import type { PeerCloseCode } from "./record.js";

/** Contacts one device holds for one product. */
export const MAX_CONTACTS = 64;
export const MAX_CONTACT_CATS = 8;
/**
 * Pairings with a peer the host already holds wait here as pending contacts (§15.10). At most
 * this many at once; the oldest is dropped for a newer one.
 */
export const MAX_PENDING_CONTACTS = 8;
/** A pending contact that no handshake has promoted is dropped this long after it was stored. */
export const PENDING_CONTACT_SECONDS = 86_400;
/** The secrets a responder tries and a browser tests: the held contacts and the pending ones. */
export const MAX_CONTACT_SECRETS = MAX_CONTACTS + MAX_PENDING_CONTACTS;
/** Contact adverts a host keeps live at once. */
export const MAX_LIVE_CONTACT_ADVERTS = 8;
export const CONTACT_BODY_MAX = 4096;
export const CONTACT_TICKET_BODY_MAX = 256;
/** The relay leases bytes to a contact room in steps of this many (§15.7). */
export const CONTACT_LEASE_BYTES = 1_048_576;
/** A contact room with no socket for this long erases itself (§15.7). */
export const CONTACT_ROOM_IDLE_SECONDS = 2_592_000;
/** From this side's `CONFIRM` to the peer's `CONTACT`. */
export const CONTACT_EXCHANGE_SECONDS = 30;

const CAT_RE = /^[a-z0-9-]{1,32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const RID_RE = /^[A-Za-z0-9_-]{22}$/;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));
const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

/** A canonical base64url of 32 bytes, decoded, or null. */
function key32(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !KEY_RE.test(v) || !isCanonicalB64url(v))
    return null;
  const b = base64UrlDecode(v);
  return b.length === 32 ? b : null;
}

/** Unsigned byte order of two equal-length byte strings. */
function byteCompare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

// ── The contact secret ───────────────────────────────────────────────────────────────────────

/**
 * `HKDF-SHA256(salt = h, ikm = nD ‖ nM, info = "pkey-peer/1 contact" ‖ 0x00 ‖ lo ‖ hi)`, 32
 * bytes: `h` is the mode-`p` handshake hash, `nD` and `nM` the two SAS nonces and `lo`, `hi` the
 * two devices' agreeKeys (32 raw bytes each) by unsigned byte order.
 */
export async function contactSecret(
  h: Uint8Array,
  nD: Uint8Array,
  nM: Uint8Array,
  agreeKeyA: Uint8Array,
  agreeKeyB: Uint8Array,
): Promise<Uint8Array> {
  if (agreeKeyA.length !== 32 || agreeKeyB.length !== 32)
    throw new RangeError("agreeKey");
  const [lo, hi] =
    byteCompare(agreeKeyA, agreeKeyB) <= 0
      ? [agreeKeyA, agreeKeyB]
      : [agreeKeyB, agreeKeyA];
  return hkdfSha256(
    h,
    cat(nD, nM),
    cat(utf8("pkey-peer/1 contact"), Uint8Array.of(0), lo, hi),
    32,
  );
}

// ── The CONTACT body ─────────────────────────────────────────────────────────────────────────

export interface ContactBody {
  /** The sender's device agreeKey, 43 canonical base64url characters. */
  agreeKey: string;
  label?: string;
  /** The categories the sender's person approved. */
  cats: string[];
}

export type ContactVerdict = ({ ok: true } & ContactBody) | { ok: false };

const validCats = (cats: readonly unknown[]): cats is string[] =>
  cats.length <= MAX_CONTACT_CATS &&
  cats.every((c) => typeof c === "string" && CAT_RE.test(c)) &&
  new Set(cats).size === cats.length;

/** The bytes of a `CONTACT` body. Throws `RangeError` for a body the peer would refuse. */
export function buildContact(o: {
  agreeKey: string;
  label?: string;
  cats: readonly string[];
}): Uint8Array {
  const key = key32(o.agreeKey);
  if (key === null || isX25519LowOrder(key)) throw new RangeError("agreeKey");
  if (!validCats(o.cats)) throw new RangeError("cats");
  const body: Record<string, unknown> = { v: 1, agreeKey: o.agreeKey };
  if (o.label !== undefined) {
    const label = cleanLabel(o.label);
    if (label !== null) body.label = label;
  }
  body.cats = [...o.cats];
  const bytes = utf8(JSON.stringify(body));
  if (bytes.length > CONTACT_BODY_MAX) throw new RangeError("size");
  return bytes;
}

/**
 * Judge one `CONTACT` body. `own` is the reader's own agreeKey: a body that carries it is no
 * contact. The label is cleaned as a `HELLO` label (§15.6) and dropped when nothing is left.
 */
export function parseContact(body: Uint8Array, own?: string): ContactVerdict {
  const no: ContactVerdict = { ok: false };
  if (body.length > CONTACT_BODY_MAX) return no;
  const o = parseStrictObject(body);
  if (o === null || o.v !== 1) return no;
  const key = key32(o.agreeKey);
  if (key === null || isX25519LowOrder(key)) return no;
  if (own !== undefined && o.agreeKey === own) return no;
  const cats = o.cats;
  if (!Array.isArray(cats) || !validCats(cats)) return no;
  let label: string | undefined;
  if (o.label !== undefined) {
    if (typeof o.label !== "string") return no;
    const l = cleanLabel(o.label);
    if (l !== null) label = l;
  }
  return {
    ok: true,
    agreeKey: o.agreeKey as string,
    ...(label !== undefined ? { label } : {}),
    cats: [...cats],
  };
}

/** A link's categories: the entries both sides list, once each, in byte order. */
export const contactCategories = (
  a: readonly string[],
  b: readonly string[],
): string[] => [...new Set(a.filter((c) => b.includes(c)))].sort();

// ── The pairing exchange ─────────────────────────────────────────────────────────────────────

export type ExchangeEvent =
  | { event: "own-confirm" }
  | { event: "peer-confirm" }
  | { event: "peer-contact"; body: Uint8Array }
  /** `CONTACT_EXCHANGE_SECONDS` after this side's `CONFIRM`. */
  | { event: "timeout" };

export interface ExchangeStep {
  /** The records this step makes the side send. */
  sends: ("CONFIRM" | "CONTACT")[];
  close?: Extract<
    PeerCloseCode,
    "peer_bad_frame" | "peer_timeout" | "peer_not_allowed"
  >;
  /**
   * The peer's `CONTACT`, valid, read in order: the host stores it. `pending` is true when the
   * host already holds that `agreeKey`: the new contact then waits (`storeContact`) and replaces
   * the held one only after a handshake under its secret passes the pin (§15.10).
   */
  stored?: ContactBody & { pending: boolean };
}

/**
 * One side's order guard over the records of the exchange (§15.10, "Order of checks"). A
 * `CONTACT` goes out once this side has sent its `CONFIRM` and read the peer's; the peer's
 * arrives only after both. After a close nothing happens.
 */
export class ContactExchange {
  private ownConfirmed = false;
  private peerConfirmed = false;
  private contactSent = false;
  private peerContact = false;
  private dead = false;

  /**
   * `own` is this device's agreeKey. `held` is the agreeKey of every active contact the host
   * holds for the product: a peer in it is a re-pair, accepted at any count; a peer not in it is
   * refused (`peer_not_allowed`, nothing stored) when the host already holds `MAX_CONTACTS`.
   */
  constructor(
    private readonly own?: string,
    private readonly held: readonly string[] = [],
  ) {}

  /** This side's `CONFIRM` is out and the peer's `CONTACT` is still wanted. */
  get waiting(): boolean {
    return !this.dead && this.ownConfirmed && !this.peerContact;
  }

  step(e: ExchangeEvent): ExchangeStep {
    const r: ExchangeStep = { sends: [] };
    if (this.dead) return r;
    const bad = (): ExchangeStep => {
      this.dead = true;
      r.close = "peer_bad_frame";
      return r;
    };
    const maybeContact = (): void => {
      if (this.ownConfirmed && this.peerConfirmed && !this.contactSent) {
        this.contactSent = true;
        r.sends.push("CONTACT");
      }
    };
    switch (e.event) {
      case "own-confirm":
        this.ownConfirmed = true;
        r.sends.push("CONFIRM");
        maybeContact();
        return r;
      case "peer-confirm":
        if (this.peerConfirmed) return bad();
        this.peerConfirmed = true;
        maybeContact();
        return r;
      case "peer-contact": {
        if (!this.ownConfirmed || !this.peerConfirmed || this.peerContact)
          return bad();
        const v = parseContact(e.body, this.own);
        if (!v.ok) return bad();
        const pending = this.held.includes(v.agreeKey);
        if (!pending && this.held.length >= MAX_CONTACTS) {
          this.dead = true;
          r.close = "peer_not_allowed";
          return r;
        }
        this.peerContact = true;
        r.stored = {
          agreeKey: v.agreeKey,
          ...(v.label !== undefined ? { label: v.label } : {}),
          cats: v.cats,
          pending,
        };
        return r;
      }
      case "timeout":
        if (this.ownConfirmed && !this.peerContact) {
          this.dead = true;
          r.close = "peer_timeout";
        }
        return r;
    }
  }
}

// ── The contact list ─────────────────────────────────────────────────────────────────────────

/** A contact the host holds. `pendingSince` (unix seconds) marks a pending one. */
export interface StoredContact {
  agreeKey: string;
  secret: Uint8Array;
  label?: string;
  cats: readonly string[];
  pendingSince?: number;
}

export type StoreVerdict =
  | { ok: true; contacts: StoredContact[]; pending: boolean }
  | { ok: false; reason: "full" };

const activeOf = (list: readonly StoredContact[]): StoredContact[] =>
  list.filter((c) => c.pendingSince === undefined);

/**
 * Store a contact the exchange produced (§15.10). A peer whose `agreeKey` the host does not hold
 * is added as an active contact, or refused (`full`) at `MAX_CONTACTS`. A peer it does hold is
 * stored pending: the held contact stays as it is, one pending contact per key (a newer one
 * replaces an older), at most `MAX_PENDING_CONTACTS` (the oldest goes first). Pure: the list in,
 * the list out.
 */
export function storeContact(
  list: readonly StoredContact[],
  incoming: Omit<StoredContact, "pendingSince">,
  nowSeconds: number,
): StoreVerdict {
  const held = activeOf(list).some((c) => c.agreeKey === incoming.agreeKey);
  if (!held) {
    if (activeOf(list).length >= MAX_CONTACTS)
      return { ok: false, reason: "full" };
    return { ok: true, contacts: [...list, { ...incoming }], pending: false };
  }
  const next = list.filter(
    (c) => !(c.pendingSince !== undefined && c.agreeKey === incoming.agreeKey),
  );
  next.push({ ...incoming, pendingSince: nowSeconds });
  for (;;) {
    const pend = next.filter((c) => c.pendingSince !== undefined);
    if (pend.length <= MAX_PENDING_CONTACTS) break;
    // Oldest first; of equal age, the one stored earlier (lower in the list).
    let oldest = pend[0]!;
    for (const c of pend)
      if (c.pendingSince! < oldest.pendingSince!) oldest = c;
    next.splice(next.indexOf(oldest), 1);
  }
  return { ok: true, contacts: next, pending: true };
}

/**
 * A handshake under a pending contact's secret passed the pin: it replaces the held contact of
 * that key, in the held one's place. A key with no pending contact leaves the list as it is.
 */
export function promoteContact(
  list: readonly StoredContact[],
  agreeKey: string,
): StoredContact[] {
  const p = list.find(
    (c) => c.pendingSince !== undefined && c.agreeKey === agreeKey,
  );
  if (p === undefined) return [...list];
  const fresh: StoredContact = {
    agreeKey: p.agreeKey,
    secret: p.secret,
    ...(p.label !== undefined ? { label: p.label } : {}),
    cats: p.cats,
  };
  const out: StoredContact[] = [];
  for (const c of list) {
    if (c === p) continue;
    out.push(
      c.pendingSince === undefined && c.agreeKey === agreeKey ? fresh : c,
    );
  }
  return out;
}

/** Drop the pending contacts stored `PENDING_CONTACT_SECONDS` ago or earlier. */
export function dropStalePending(
  list: readonly StoredContact[],
  nowSeconds: number,
): StoredContact[] {
  return list.filter(
    (c) =>
      c.pendingSince === undefined ||
      nowSeconds - c.pendingSince < PENDING_CONTACT_SECONDS,
  );
}

/**
 * The order a responder tries secrets and a browser tests contacts in: the active contacts in
 * held order, then the pending ones in the order they were stored, at most `MAX_CONTACT_SECRETS`.
 */
export function contactTrialOrder(
  list: readonly StoredContact[],
): StoredContact[] {
  return [
    ...list.filter((c) => c.pendingSince === undefined),
    ...list.filter((c) => c.pendingSince !== undefined),
  ].slice(0, MAX_CONTACT_SECRETS);
}

// ── The pin ──────────────────────────────────────────────────────────────────────────────────

/**
 * Mode c (§15.10): the remote static key must be the agreeKey of the contact whose secret opened
 * the session. The initiator asks after message 2, the responder after message 3; a `false`
 * ends the session as `peer_revoked` with nothing sent.
 */
export function contactPin(held: string, remoteStatic: Uint8Array): boolean {
  return base64UrlEncodeBytes(remoteStatic) === held;
}

// ── The LAN advert ───────────────────────────────────────────────────────────────────────────

/** A contact the device holds: its secret and the peer's agreeKey (32 raw bytes). */
export interface ContactKey {
  secret: Uint8Array;
  agreeKey: Uint8Array;
}

/**
 * The contact instance name for an advertiser in one epoch: `p1-` and the first 16 characters of
 * the lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 cdisc" ‖ 0x00 ‖ u64be(epoch) ‖
 * agreeKey)`, with the advertiser's own agreeKey so the two devices of a link differ.
 */
export async function contactInstance(
  secret: Uint8Array,
  advertiserAgreeKey: Uint8Array,
  epoch: number,
): Promise<string> {
  const mac = await hmac(
    secret,
    cat(
      utf8("pkey-peer/1 cdisc"),
      Uint8Array.of(0),
      u64be(epoch),
      advertiserAgreeKey,
    ),
  );
  return `p1-${base32Lower(mac).slice(0, 16)}`;
}

export type ContactTxtResult =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "version" | "mode" };

/** `v=1` and `m=c`. An entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated key refuses; `h` is not read. */
export function parseContactTxt(entries: readonly string[]): ContactTxtResult {
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

export interface ContactHit {
  /** Index into the contacts as held. */
  contact: number;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
}

/**
 * Which contact an instance belongs to: the first of the first `MAX_CONTACT_SECRETS`, in the
 * order of `contactTrialOrder`, that matches in the current or the previous epoch. At most 144
 * HMACs.
 */
export async function browseContactInstance(
  instance: string,
  contacts: readonly ContactKey[],
  nowSeconds: number,
): Promise<ContactHit | null> {
  if (!isInstanceName(instance)) return null;
  const epoch = advertEpoch(nowSeconds);
  for (let i = 0; i < contacts.length && i < MAX_CONTACT_SECRETS; i++)
    for (const epochBack of [0, 1] as const)
      if (
        (await contactInstance(
          contacts[i]!.secret,
          contacts[i]!.agreeKey,
          epoch - epochBack,
        )) === instance
      )
        return { contact: i, epochBack };
  return null;
}

// ── The contact room ─────────────────────────────────────────────────────────────────────────

/** The room id: base64url of `HKDF-SHA256(salt = empty, ikm = secret, info = "pkey-peer/1 room")[0..16]`, 22 characters. */
export async function contactRid(secret: Uint8Array): Promise<string> {
  const okm = await hkdfSha256(
    new Uint8Array(0),
    secret,
    utf8("pkey-peer/1 room"),
    32,
  );
  return base64UrlEncodeBytes(okm.slice(0, 16));
}

/** The alias a room uses for a device: `SHA-256(rid ‖ deviceId)[0..24]` over the 16 decoded rid bytes and the 24 decoded device-id bytes. */
export async function contactAlias(
  rid: string,
  deviceId: string,
): Promise<Uint8Array> {
  if (!RID_RE.test(rid) || !isCanonicalB64url(rid)) throw new RangeError("rid");
  return (await sha256(base64UrlDecode(rid), deviceIdBytes(deviceId))).slice(
    0,
    24,
  );
}

/** The ticket-request body for a contact room. */
export function contactTicketBody(rid: string): string {
  if (!RID_RE.test(rid) || !isCanonicalB64url(rid)) throw new RangeError("rid");
  return JSON.stringify({ room: "c", rid });
}

export type ContactTicketBody = { ok: true; rid: string } | { ok: false };

/** Read a ticket-request body: strict JSON of at most 256 bytes with exactly `room` = "c" and a canonical `rid`. */
export function parseContactTicketBody(bytes: Uint8Array): ContactTicketBody {
  const no: ContactTicketBody = { ok: false };
  if (bytes.length > CONTACT_TICKET_BODY_MAX) return no;
  const o = parseStrictObject(bytes);
  if (o === null) return no;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !("room" in o) || !("rid" in o)) return no;
  if (o.room !== "c") return no;
  const rid = o.rid;
  if (typeof rid !== "string" || !RID_RE.test(rid) || !isCanonicalB64url(rid))
    return no;
  if (base64UrlDecode(rid).length !== 16) return no;
  return { ok: true, rid };
}
