// Reference: local links, account-free pairing (WIRE-CONTRACT-V5 §15.12; plans/CC-23L.md).
//
// The code and its nameplate, the QR, the pairing and local-link adverts (instance, TXT, browse),
// the `LOCAL_LINK` body, the link secret, the handshake payloads of modes `q` and `l`, and the
// machines of the pairing exchange, the pin, the listener's trial order, the pairing window, the
// gate and the record rules. Written from the specification over `node:crypto` alone (the strict
// JSON parser, the label cleaning and the hash helpers are the other references'), so it shares
// nothing with client-core. `peer-matrix.json` `local` is recomputed through it.

import {
  byteCompare,
  refBodyCats,
  refBodyLabel,
  refBodyObject,
  refContactCategories,
  refTrialAccount,
  refTrialList,
} from "./contact.js";
import { bytesHex, hmac, refHkdf } from "./noise.js";
import {
  cat,
  refAdvertEpoch,
  refBase32Lower,
  refCapsIntersection,
  refHandshakePayload,
  refInstanceShape,
  refParseTxt,
  utf8,
} from "./peerMatrix.js";

export const REF_LOCAL_PAIR_SECONDS = 300;
export const REF_LOCAL_CODE_DIGITS = 8;
export const REF_LOCAL_PAIR_FAILURES = 5;
export const REF_LOCAL_QR_SECRET_BYTES = 16;
export const REF_LOCAL_JOIN_CANDIDATES = 2;
export const REF_LOCAL_JOIN_BROWSE_SECONDS = 15;
export const REF_MAX_LOCAL_LINKS = 32;
export const REF_MAX_LIVE_LOCAL_ADVERTS = 8;
export const REF_MAX_CONTACT_SECRETS = 72;
export const REF_MAX_LINK_SECRETS =
  REF_MAX_CONTACT_SECRETS + REF_MAX_LOCAL_LINKS;
export const REF_LOCAL_BODY_MAX = 4096;
export const REF_LOCAL_MAX_CATS = 8;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

// ── The code (§15.12, "The code") ────────────────────────────────────────────

export interface RefDraw {
  /** The value, or null when the stream ran out first. */
  value: number | null;
  /** How many bytes the draw read. */
  consumed: number;
}

/**
 * The nameplate: one byte at a time, drawn again at 200 or more, then mod 100; a nameplate in
 * use by a live pairing advert of the product is drawn again, unless all 100 are in use, when
 * any is taken. `inUse` holds nameplates as numbers 0 to 99.
 */
export function refNameplate(
  stream: Uint8Array,
  inUse: readonly number[],
): RefDraw {
  const taken = new Set(inUse);
  const all = taken.size >= 100;
  for (let i = 0; i < stream.length; i++) {
    if (stream[i]! >= 200) continue;
    const n = stream[i]! % 100;
    if (!all && taken.has(n)) continue;
    return { value: n, consumed: i + 1 };
  }
  return { value: null, consumed: stream.length };
}

/** The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6. */
export function refPassword(stream: Uint8Array): RefDraw {
  for (let i = 0; i + 4 <= stream.length; i += 4) {
    const n = new DataView(stream.buffer, stream.byteOffset + i, 4).getUint32(
      0,
    );
    if (n >= 4_294_000_000) continue;
    return { value: n % 1_000_000, consumed: i + 4 };
  }
  return { value: null, consumed: stream.length - (stream.length % 4) };
}

export const refNameplateText = (n: number): string =>
  String(n).padStart(2, "0");
export const refPasswordText = (n: number): string =>
  String(n).padStart(6, "0");

/** Two groups of four digits, one space between. */
export const refCodeDisplay = (nameplate: string, password: string): string => {
  const d = nameplate + password;
  return `${d.slice(0, 4)} ${d.slice(4)}`;
};

export type CodeVerdict =
  | { ok: true; nameplate: string; password: string }
  | { ok: false };

/** A typed code: ASCII spaces and hyphens removed; what is left is exactly 8 ASCII digits. */
export function refCodeParse(text: string): CodeVerdict {
  const d = text.replace(/[ -]/g, "");
  if (!/^[0-9]{8}$/.test(d)) return { ok: false };
  return { ok: true, nameplate: d.slice(0, 2), password: d.slice(2) };
}

// ── The QR (§15.12, "The QR") ────────────────────────────────────────────────

/** `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case: the instance's 16 base32 characters and the
 *  secret's 26 (RFC 4648, no padding, the two unused low bits zero). */
export function refQrText(
  slug: string,
  instance: string,
  secret: Uint8Array,
): string {
  if (secret.length !== REF_LOCAL_QR_SECRET_BYTES)
    throw new Error("local: QR secret length");
  if (!refInstanceShape(instance)) throw new Error("local: QR instance");
  return `PKP1:${slug}:${instance.slice(3)}:${refBase32Lower(secret)}`.toUpperCase();
}

export type QrVerdict =
  | { result: "ok"; slug: string; instance: string; secret: string }
  | { result: "other-app" }
  | { result: "invalid" };

/** Read a scanned QR: fold ASCII case; four fields split at `:`; the secret's last character
 *  keeps its two unused low bits zero. `own` is the app's slug. */
export function refQrParse(text: string, own: string): QrVerdict {
  const t = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const f = t.split(":");
  if (f.length !== 4 || f[0] !== "pkp1") return { result: "invalid" };
  const [, slug, instance, secret] = f as [string, string, string, string];
  if (!SLUG_RE.test(slug)) return { result: "invalid" };
  if (!/^[a-z2-7]{16}$/.test(instance)) return { result: "invalid" };
  if (!/^[a-z2-7]{26}$/.test(secret)) return { result: "invalid" };
  if ("abcdefghijklmnopqrstuvwxyz234567".indexOf(secret[25]!) % 4 !== 0)
    return { result: "invalid" };
  if (slug !== own) return { result: "other-app" };
  return { result: "ok", slug, instance: `p1-${instance}`, secret };
}

// ── Adverts (§15.4, §15.12) ──────────────────────────────────────────────────

/** The pairing advert's instance: `p1-` + the 16 base32 characters of the window's 10 bytes. */
export const refPairInstance = (sid: Uint8Array): string => {
  if (sid.length !== 10) throw new Error("local: sid length");
  return `p1-${refBase32Lower(sid)}`;
};

/** `p1-` + base32lower(HMAC-SHA256(secret, "pkey-peer/1 ldisc" ‖ 0x00 ‖ u64be(epoch) ‖ ownLinkKey))[0..16]. */
export const refLocalInstance = (
  secret: Uint8Array,
  ownLinkKey: Uint8Array,
  epoch: number,
): string =>
  `p1-${refBase32Lower(
    hmac(
      secret,
      cat(
        utf8("pkey-peer/1 ldisc"),
        Uint8Array.of(0),
        u64be(epoch),
        ownLinkKey,
      ),
    ),
  ).slice(0, 16)}`;

export type TxtVerdict =
  | { ok: true; mode: "a" | "v" | "p" | "q" | "l"; h?: string; n?: string }
  | {
      ok: false;
      reason: "duplicate" | "version" | "mode" | "tag" | "nameplate";
    };

function refKv(
  entries: string[],
): Map<string, string> | { ok: false; reason: "duplicate" } {
  const kv = new Map<string, string>();
  for (const e of entries) {
    const m = /^([^=]+)=([^]*)$/.exec(e);
    if (m === null) continue;
    if (kv.has(m[1]!)) return { ok: false, reason: "duplicate" };
    kv.set(m[1]!, m[2]!);
  }
  return kv;
}

/** `parseTxt` with mode `q` (§15.4, §15.12): `v` must be 1; `m` must be a, v, p or q; `h` is read
 *  for v, p and q (16 lower-case hex characters); `n` is read for q only and is two ASCII digits.
 *  Mode `l` (and `c`) is an unknown mode here. */
export function refParseTxtQ(entries: string[]): TxtVerdict {
  const kv = refKv(entries);
  if (!(kv instanceof Map)) return kv;
  if (kv.get("m") !== "q") return refParseTxt(entries);
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  const h = kv.get("h");
  if (h === undefined || !/^[0-9a-f]{16}$/.test(h))
    return { ok: false, reason: "tag" };
  const n = kv.get("n");
  if (n === undefined || !/^[0-9]{2}$/.test(n))
    return { ok: false, reason: "nameplate" };
  return { ok: true, mode: "q", h, n };
}

/** `parseLocalTxt`: `v=1` and `m=l`; it reads no `h` and no `n`. */
export function refParseLocalTxt(entries: string[]): TxtVerdict {
  const kv = refKv(entries);
  if (!(kv instanceof Map)) return kv;
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  if (kv.get("m") !== "l") return { ok: false, reason: "mode" };
  return { ok: true, mode: "l" };
}

export interface RefLink {
  secret: Uint8Array;
  /** The peer's link public key, 32 raw bytes. */
  peerKey: Uint8Array;
}

export interface LinkHit {
  /** Index into the links as held. */
  link: number;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
}

/** Which link an instance belongs to: the first of the first 32 links in held order that
 *  matches, in the current or the previous epoch; at most 64 HMACs. */
export function refLocalBrowse(
  instance: string,
  links: readonly RefLink[],
  now: number,
): LinkHit | null {
  if (!refInstanceShape(instance)) return null;
  const epoch = refAdvertEpoch(now);
  for (let i = 0; i < links.length && i < REF_MAX_LOCAL_LINKS; i++)
    for (const epochBack of [0, 1] as const)
      if (
        refLocalInstance(
          links[i]!.secret,
          links[i]!.peerKey,
          epoch - epochBack,
        ) === instance
      )
        return { link: i, epochBack };
  return null;
}

// ── The LOCAL_LINK body (§15.12) ─────────────────────────────────────────────

export type LinkBodyVerdict =
  | { ok: true; label?: string; cats: string[] }
  | { ok: false };

/** Judge one `LOCAL_LINK` body: strict JSON, at most 4 KiB, `v` = 1, an optional label cleaned as
 *  a `HELLO` label, `cats` an array of at most 8 distinct strings of `^[a-z0-9-]{1,32}$`. Unknown
 *  members are ignored. */
export function refLinkBody(bytes: Uint8Array): LinkBodyVerdict {
  const o = refBodyObject(bytes, REF_LOCAL_BODY_MAX);
  if (o === null || o.v !== 1) return { ok: false };
  const cats = refBodyCats(o.cats, REF_LOCAL_MAX_CATS);
  const label = refBodyLabel(o.label);
  if (cats === null || label === null) return { ok: false };
  return { ok: true, ...(label !== undefined ? { label } : {}), cats };
}

/** A link's categories: the entries both sides listed, once each, in byte order. */
const refLinkCategories = refContactCategories;

// ── The link secret (§15.12) ─────────────────────────────────────────────────

/**
 * `HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" ‖ 0x00 ‖ lo ‖ hi)`, 32 bytes:
 * `h` is the mode-q handshake hash, `lo` and `hi` the two link public keys by unsigned byte order.
 */
export function refLinkSecret(
  h: Uint8Array,
  isk: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): Uint8Array {
  const [lo, hi] = byteCompare(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  return refHkdf(
    h,
    isk,
    cat(utf8("pkey-peer/1 local"), Uint8Array.of(0), lo, hi),
    32,
  );
}

// ── Handshake payloads (§15.5, §15.12) ───────────────────────────────────────

export type LocalMode = "q" | "l";

/** Judge one handshake payload of mode `q` or `l`: as a non-account mode (no `cert`, no `ring`). */
export const refLocalPayload = (
  message: 1 | 2 | 3,
  bytes: Uint8Array,
): ReturnType<typeof refHandshakePayload> =>
  refHandshakePayload("p", message, bytes);

export type NegotiateVerdict = { caps: string[]; close?: "peer_not_allowed" };

/** The session's capabilities; in mode `q` a side whose capabilities lack `local/1` closes
 *  `peer_not_allowed` after `HELLO`, before any consent prompt. */
export function refLocalNegotiate(
  mode: LocalMode,
  local: string[],
  remote: string[],
): NegotiateVerdict {
  const caps = refCapsIntersection(local, remote);
  if (mode === "q" && !caps.includes("local/1"))
    return { caps, close: "peer_not_allowed" };
  return { caps };
}

// ── The pairing exchange (§15.12, "Consent and LOCAL_LINK", "Order of checks") ───────────────

export type ExchangeEvent =
  | { event: "own-confirm" }
  | { event: "own-decline" }
  | { event: "peer-confirm" }
  | { event: "peer-link"; body: Uint8Array }
  /** The 120 s from the first byte have run out. */
  | { event: "timeout-confirm" }
  /** The 30 s after both CONFIRMs have run out. */
  | { event: "timeout-exchange" };

export interface ExchangeStepResult {
  sends: ("CONFIRM" | "LOCAL_LINK")[];
  close?: "peer_bad_frame" | "peer_timeout" | "peer_not_allowed" | "peer_bye";
  stored?: { label?: string; cats: string[] };
}

/**
 * Feed the events of one side in order: what each sends, and where it closes or stores. `held` is
 * the number of local links the device holds for the product and `cats` this side's approved
 * categories. A side stores the link when it reads the peer's valid `LOCAL_LINK`, then closes
 * `peer_bye`.
 */
export function refLocalExchange(
  events: ExchangeEvent[],
  held: number,
  cats: readonly string[],
): ExchangeStepResult[] {
  const st = { own: false, peer: false, sent: false, got: false, over: false };
  return events.map((e): ExchangeStepResult => {
    const r: ExchangeStepResult = { sends: [] };
    if (st.over) return r;
    const end = (code: NonNullable<ExchangeStepResult["close"]>): void => {
      r.close = code;
      st.over = true;
    };
    const link = (): void => {
      if (st.own && st.peer && !st.sent) {
        st.sent = true;
        r.sends.push("LOCAL_LINK");
      }
    };
    if (e.event === "own-confirm" && !st.own) {
      // The person confirms once; a second confirmation is not an event of the wire.
      st.own = true;
      r.sends.push("CONFIRM");
      link();
    } else if (e.event === "own-decline" && !st.own) end("peer_bye");
    else if (e.event === "peer-confirm") {
      if (st.peer) end("peer_bad_frame");
      else {
        st.peer = true;
        link();
      }
    } else if (e.event === "peer-link") {
      const v = refLinkBody(e.body);
      if (!st.own || !st.peer || st.got || !v.ok) end("peer_bad_frame");
      else if (held >= REF_MAX_LOCAL_LINKS) end("peer_not_allowed");
      else {
        st.got = true;
        r.stored = {
          ...(v.label !== undefined ? { label: v.label } : {}),
          cats: refLinkCategories(cats, v.cats),
        };
        end("peer_bye");
      }
    } else if (e.event === "timeout-confirm" && !(st.own && st.peer))
      end("peer_timeout");
    else if (e.event === "timeout-exchange" && st.own && st.peer && !st.got)
      end("peer_timeout");
    return r;
  });
}

// ── The pin (§15.12, "Mode l" and "Link keys") ───────────────────────────────

export type PinVerdict =
  | { ok: true }
  | { ok: false; close: "peer_revoked"; sends: 0 }
  | { ok: false; close: "silent"; sends: 0 };

/** Mode l: the remote static key must equal the stored peer link key of the link whose secret
 *  opened the session. Mode q: a remote static key equal to this side's own link key ends the
 *  handshake silently. */
export function refLocalPin(
  mode: LocalMode,
  held: Uint8Array,
  remote: Uint8Array,
  own?: Uint8Array,
): PinVerdict {
  if (mode === "q")
    return own !== undefined && byteCompare(remote, own) === 0
      ? { ok: false, close: "silent", sends: 0 }
      : { ok: true };
  return byteCompare(held, remote) === 0 && held.length === remote.length
    ? { ok: true }
    : { ok: false, close: "peer_revoked", sends: 0 };
}

// ── The shared listener's trial order (§15.5, §15.12) ────────────────────────

export interface TrialIn {
  /** The discKeys (current, previous; null = none) or null for a host without an account. */
  account: (string | null)[] | null;
  /** The contact secrets in `contactTrialOrder` (at most 72 are tried). */
  contacts: string[];
  /** The local-link secrets in held order (at most 32 are tried). */
  locals: string[];
  /** Which key opens message 1, if any. */
  opens:
    | { mode: "a"; key: number }
    | { mode: "c"; contact: number }
    | { mode: "l"; link: number }
    | null;
  /** What the contact limiter says to a contact or local-link trial. */
  limiter: "admit" | "refuse";
}

export interface TrialOut {
  /** Every key a tag was tried under, in order: `a:<i>`, `c:<i>` or `l:<i>`. */
  tried: string[];
  hit: string | null;
  /** A limiter slot is held until message 3 (a contact or local-link hit only). */
  slot: boolean;
  close: "handshake_failed" | "peer_busy" | null;
}

export function refLocalTrial(i: TrialIn): TrialOut {
  const tried: string[] = [];
  const opens = i.opens;
  const a = refTrialAccount(
    i.account,
    opens?.mode === "a" ? opens.key : null,
    tried,
  );
  if (a !== null) return { tried, hit: a, slot: false, close: null };
  if (i.contacts.length + i.locals.length === 0)
    return { tried, hit: null, slot: false, close: "handshake_failed" };
  if (i.limiter === "refuse")
    return { tried, hit: null, slot: false, close: "peer_busy" };
  const hit =
    refTrialList(
      "c",
      i.contacts.length,
      REF_MAX_CONTACT_SECRETS,
      opens?.mode === "c" ? opens.contact : null,
      tried,
    ) ??
    refTrialList(
      "l",
      i.locals.length,
      REF_MAX_LOCAL_LINKS,
      opens?.mode === "l" ? opens.link : null,
      tried,
    );
  return hit !== null
    ? { tried, hit, slot: true, close: null }
    : { tried, hit: null, slot: false, close: "handshake_failed" };
}

// ── The pairing window (§15.12, "The pairing window") ────────────────────────

export type WindowEvent =
  | { event: "open"; t: number }
  | { event: "c1"; t: number; valid: boolean }
  /** Message 1 of the attempt that holds the window: whether its tag opens under the PSK. */
  | { event: "msg1"; t: number; opens: boolean }
  /** The attempt closed or timed out before message 1 (or its connection dropped). */
  | { event: "abandon"; t: number }
  /** The session that reached the transport ended; `stored` when a link was stored. */
  | { event: "session-end"; t: number; stored: boolean }
  | { event: "tick"; t: number }
  | { event: "close"; t: number };

export type WindowResult =
  | "opened"
  | "already-open"
  | "closed"
  | "busy"
  | "limited"
  | "refused"
  | "attempt"
  | "transport"
  | "failed"
  | "too-many-tries";

export interface WindowStep {
  /** What the event did, when it asks for a decision. */
  result?: WindowResult;
  open: boolean;
  holder: "attempt" | "session" | null;
  /** Failed guesses so far in this window. */
  failures: number;
  /** Rotations of the password and the QR secret so far in this window. */
  rotations: number;
  /** Why the window is closed: null while open or never opened. */
  closed: "expired" | "too-many-tries" | "stored" | "person" | null;
  /** The code the host's person hears when the window closes on failures. */
  host?: "pairing-code-failed";
}

/** The window's machine: one window per device per product, at most 300 s, one attempt at a time,
 *  at most 5 admitted C1s in any 60 s, an attempt's 30 s to the transport, five failed guesses. */
export function refLocalWindow(events: readonly WindowEvent[]): WindowStep[] {
  let open = false;
  let openedAt = 0;
  let holder: "attempt" | "session" | null = null;
  let attemptAt = 0;
  let failures = 0;
  let rotations = 0;
  let closed: WindowStep["closed"] = null;
  const admitted: number[] = [];
  const out: WindowStep[] = [];
  const settle = (t: number): void => {
    if (open && t - openedAt >= REF_LOCAL_PAIR_SECONDS) {
      open = false;
      closed = "expired";
      // A connection that has not reached the transport is closed; a session runs on.
      if (holder === "attempt") holder = null;
    }
    if (holder === "attempt" && t - attemptAt >= 30) holder = null;
  };
  for (const e of events) {
    settle(e.t);
    let result: WindowResult | undefined;
    let host: WindowStep["host"];
    switch (e.event) {
      case "open":
        if (open || holder === "session") result = "already-open";
        else {
          open = true;
          openedAt = e.t;
          holder = null;
          failures = 0;
          rotations = 0;
          closed = null;
          admitted.length = 0;
          result = "opened";
        }
        break;
      case "c1": {
        if (!open) result = "closed";
        else if (holder !== null) result = "busy";
        else {
          const recent = admitted.filter((a) => e.t - a < 60);
          admitted.length = 0;
          admitted.push(...recent);
          if (recent.length >= 5) result = "limited";
          else {
            admitted.push(e.t);
            if (!e.valid) result = "refused";
            else {
              holder = "attempt";
              attemptAt = e.t;
              result = "attempt";
            }
          }
        }
        break;
      }
      case "msg1":
        if (holder === "attempt") {
          if (e.opens) {
            holder = "session";
            result = "transport";
          } else {
            holder = null;
            failures++;
            if (failures >= REF_LOCAL_PAIR_FAILURES) {
              open = false;
              closed = "too-many-tries";
              host = "pairing-code-failed";
              result = "too-many-tries";
            } else {
              rotations++;
              result = "failed";
            }
          }
        }
        break;
      case "abandon":
        if (holder === "attempt") holder = null;
        break;
      case "session-end":
        if (holder === "session") {
          holder = null;
          if (e.stored) {
            open = false;
            closed = "stored";
          } else if (open) rotations++;
        }
        break;
      case "tick":
        break;
      case "close":
        if (open) {
          open = false;
          closed = "person";
          if (holder === "attempt") holder = null;
        }
        break;
    }
    out.push({
      ...(result !== undefined ? { result } : {}),
      open,
      holder,
      failures,
      rotations,
      closed,
      ...(host !== undefined ? { host } : {}),
    });
  }
  return out;
}

// ── The joiner (§15.12, "The joiner") ────────────────────────────────────────

export interface JoinAdvert {
  instance: string;
  /** The product tag against the joiner's epochs: current, previous or neither. */
  h: "current" | "previous" | "other";
  n: string;
}

export interface JoinIn {
  /** The typed code or the scanned QR: what the reader said. */
  input:
    | { kind: "code"; nameplate: string }
    | { kind: "qr"; instance: string }
    | { kind: "invalid" };
  /** The `m=q` adverts seen in 15 s, in first-seen order. */
  adverts: JoinAdvert[];
  /** How each dial ends, in the order the joiner dials. */
  dials: ("transport" | "before-c2" | "after-c2")[];
}

export interface JoinOut {
  /** Whether anything is browsed or dialled. */
  browsed: boolean;
  /** The instances kept (matching, at most 8) and the ones dialled (at most 2). */
  kept: string[];
  dialled: string[];
  result: "transport" | "pairing-code-failed" | "pairing-not-found";
}

export function refLocalJoin(i: JoinIn): JoinOut {
  if (i.input.kind === "invalid")
    return {
      browsed: false,
      kept: [],
      dialled: [],
      result: "pairing-code-failed",
    };
  const input = i.input;
  const kept: string[] = [];
  for (const a of i.adverts) {
    if (a.h === "other") continue;
    if (
      input.kind === "code"
        ? a.n !== input.nameplate
        : a.instance !== input.instance
    )
      continue;
    if (kept.length < 8 && !kept.includes(a.instance)) kept.push(a.instance);
  }
  const dialled: string[] = [];
  let afterC2 = false;
  for (const inst of kept.slice(0, REF_LOCAL_JOIN_CANDIDATES)) {
    const end = i.dials[dialled.length] ?? "before-c2";
    dialled.push(inst);
    if (end === "transport")
      return { browsed: true, kept, dialled, result: "transport" };
    if (end === "after-c2") afterC2 = true;
  }
  return {
    browsed: true,
    kept,
    dialled,
    result: afterC2 ? "pairing-code-failed" : "pairing-not-found",
  };
}

// ── The gate (§15.12, "Gates") ───────────────────────────────────────────────

export type GateRead =
  | { read: "ok"; body: unknown }
  | { read: "not-found" }
  | { read: "error" };

export type GateOp =
  | "pair"
  | "join"
  | "advertise-q"
  | "advertise-l"
  | "browse-q"
  | "browse-l"
  | "dial-l"
  | "answer-l"
  | "list"
  | "rename"
  | "remove"
  | "set-reachable";

export type GateEvent = GateRead | { call: GateOp };

export interface GateStep {
  /** The cached answer after the event: `on` (cached true), `off` (a document without true) or
   *  `none` (no cached document). */
  cached: "on" | "off" | "none";
  /** Of a call: `ok` or the typed N/A. */
  call?: "ok" | "local-pairing-off";
  /** Of a read that cleared a cached true. */
  effects?: ("close-windows" | "withdraw-adverts" | "end-sessions")[];
}

const GATED: GateOp[] = [
  "pair",
  "join",
  "advertise-q",
  "advertise-l",
  "browse-q",
  "browse-l",
  "dial-l",
  "answer-l",
];

/** `services.connect.localPairing` of a discovery body: true only for the boolean `true`. */
export function refGateMember(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const svc = (body as Record<string, unknown>).services;
  if (svc === null || typeof svc !== "object") return false;
  const c = (svc as Record<string, unknown>).connect;
  if (c === null || typeof c !== "object") return false;
  return (c as Record<string, unknown>).localPairing === true;
}

export function refLocalGate(
  start: "on" | "off" | "none",
  events: readonly GateEvent[],
): GateStep[] {
  let cached = start;
  const out: GateStep[] = [];
  for (const e of events) {
    const step: GateStep = { cached };
    if ("call" in e) {
      step.call =
        !GATED.includes(e.call) || cached === "on" ? "ok" : "local-pairing-off";
    } else if (e.read === "ok") {
      const was = cached;
      cached = refGateMember(e.body) ? "on" : "off";
      if (was === "on" && cached !== "on")
        step.effects = ["close-windows", "withdraw-adverts", "end-sessions"];
    } else if (e.read === "not-found") {
      const was = cached;
      cached = "none";
      if (was === "on")
        step.effects = ["close-windows", "withdraw-adverts", "end-sessions"];
    }
    step.cached = cached;
    out.push(step);
  }
  return out;
}

// ── Records (§15.6, §15.12) ──────────────────────────────────────────────────

export type RecordMode = "a" | "v" | "p" | "c" | "q" | "l";

interface RecordRow {
  from: number;
  to: number;
  name: string;
  modes: RecordMode[];
  /** The capability a side needs for the type. */
  needs?: string;
}

const ALL_MODES: RecordMode[] = ["a", "v", "p", "c", "q", "l"];

/** The record table of §15.6 with the new rows: CONFIRM `p` and `q`, LOCAL_LINK `q`, APP and
 *  Direct Transfer `a`, `c` and `l`. */
export const REF_RECORD_ROWS: RecordRow[] = [
  { from: 0x8001, to: 0x8001, name: "HELLO", modes: ALL_MODES },
  { from: 0x0002, to: 0x0002, name: "RING", modes: ["a"] },
  { from: 0x0003, to: 0x0003, name: "TRUST", modes: ["a"] },
  { from: 0x0004, to: 0x0004, name: "PING", modes: ALL_MODES },
  { from: 0x0005, to: 0x0005, name: "PONG", modes: ALL_MODES },
  { from: 0x0006, to: 0x0006, name: "CANDIDATES", modes: ["a"] },
  { from: 0x8010, to: 0x8010, name: "VOUCH_REQ", modes: ["v"] },
  { from: 0x8011, to: 0x8011, name: "VOUCH_RESULT", modes: ["v"] },
  { from: 0x8012, to: 0x8012, name: "CONFIRM", modes: ["p", "q"] },
  { from: 0x0013, to: 0x0013, name: "CONTACT", modes: ["p"] },
  {
    from: 0x0014,
    to: 0x0014,
    name: "LOCAL_LINK",
    modes: ["q"],
    needs: "local/1",
  },
  ...(["SAS_COMMIT", "SAS_NONCE", "SAS_REVEAL"] as const).map(
    (name, n): RecordRow => ({
      from: 0x8014 + n,
      to: 0x8014 + n,
      name,
      modes: ["v", "p"],
    }),
  ),
  {
    from: 0x0020,
    to: 0x0025,
    name: "XFER",
    modes: ["a", "c", "l"],
    needs: "xfer/1",
  },
  { from: 0x0030, to: 0x003f, name: "SYNC", modes: ["v"] },
  {
    from: 0x0100,
    to: 0x7fff,
    name: "APP",
    modes: ["a", "c", "l"],
    needs: "app/1",
  },
  {
    from: 0x8100,
    to: 0xfffd,
    name: "APP_CRITICAL",
    modes: ["a", "c", "l"],
    needs: "app/1",
  },
  { from: 0x80fe, to: 0x80fe, name: "REKEY", modes: ALL_MODES },
  { from: 0x80ff, to: 0x80ff, name: "CLOSE", modes: ALL_MODES },
];

export type RecordVerdict =
  | { allowed: true; name: string; needs?: string }
  | { allowed: false; close: "peer_not_allowed" | "peer_unknown_critical" }
  | { ignored: true };

/** One record's type in one mode: a known type in a mode that does not allow it closes
 *  `peer_not_allowed`; an unknown type closes `peer_unknown_critical` when its high bit is set and
 *  is otherwise ignored. */
export function refLocalRecord(mode: RecordMode, type: number): RecordVerdict {
  const row = REF_RECORD_ROWS.find((r) => type >= r.from && type <= r.to);
  if (row === undefined)
    return (type & 0x8000) !== 0
      ? { allowed: false, close: "peer_unknown_critical" }
      : { ignored: true };
  if (!row.modes.includes(mode))
    return { allowed: false, close: "peer_not_allowed" };
  return {
    allowed: true,
    name: row.name,
    ...(row.needs !== undefined ? { needs: row.needs } : {}),
  };
}
