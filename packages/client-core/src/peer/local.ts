// WIRE-CONTRACT-V5 §15.12: local links (account-free pairing). Pure functions and small machines,
// no I/O: the code and its nameplate, the QR, the adverts, the `LOCAL_LINK` body, the link secret,
// the handshake capabilities, the joiner, the pairing window, the exchange guard, the pin, the
// trial order and the gate. The vectors are `peer-matrix.json` `local`; the session (`session.ts`)
// runs modes `q` and `l` over them, and CPace itself is `cpace.ts`.
//
// A password, a QR secret and a link secret are key material: nothing here logs one or returns one
// inside an error. Time comes in as arguments (a monotonic clock, in seconds, for the window), so a
// machine never reads a clock of its own.

import {
  advertEpoch,
  base32Lower,
  cat,
  isInstanceName,
  txtEntries,
  u64be,
  utf8,
} from "./advert.js";
import { MAX_CONTACT_SECRETS, byteCompare, validCats } from "./contact.js";
import { cleanLabel } from "./display.js";
import { hkdfSha256, hmac } from "./noise.js";
import { capsIntersection, parseStrictObjectScanned } from "./payload.js";
import type { PeerCloseCode } from "./record.js";

// ── Constants (§15.12) ───────────────────────────────────────────────────────────────────────

/** A pairing window stays open at most this long. */
export const LOCAL_PAIR_SECONDS = 300;
/** A code is 8 digits: a 2-digit nameplate and a 6-digit password. */
export const LOCAL_CODE_DIGITS = 8;
/** The fifth failed guess closes the window. */
export const LOCAL_PAIR_FAILURES = 5;
export const LOCAL_QR_SECRET_BYTES = 16;
export const LOCAL_JOIN_CANDIDATES = 2;
export const LOCAL_JOIN_BROWSE_SECONDS = 15;
/** Local links one device holds for one product. */
export const MAX_LOCAL_LINKS = 32;
export const MAX_LIVE_LOCAL_ADVERTS = 8;
/** `MAX_CONTACT_SECRETS` (72) plus `MAX_LOCAL_LINKS`. */
export const MAX_LINK_SECRETS = 104;
/** The pairing window admits at most this many C1s in any `LOCAL_C1_WINDOW_SECONDS`. */
export const LOCAL_C1_PER_WINDOW = 5;
export const LOCAL_C1_WINDOW_SECONDS = 60;
/** From the first byte (C1 included) to the transport. */
export const LOCAL_ATTEMPT_SECONDS = 30;
/** The joiner keeps at most this many matching `m=q` names while it joins. */
export const LOCAL_JOIN_KEPT = 8;
export const LOCAL_LINK_BODY_MAX = 4096;
/** The mandatory capability of mode `q`. */
export const LOCAL_CAP = "local/1";

// ── The code (§15.12, "The code") ────────────────────────────────────────────────────────────

/**
 * A source of random bytes that answers null when it cannot supply `n` of them (a stream of fixed
 * bytes in a vector, or `getRandomValues`, which never runs out).
 */
export type DrawSource = (n: number) => Uint8Array | null;

/** `crypto.getRandomValues` as a `DrawSource`. */
export const randomByteSource: DrawSource = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * The nameplate: one byte at a time, 200 or more drawn again, then mod 100, and a nameplate in
 * `inUse` drawn again unless all 100 are in use (then any is taken). Rejection sampling, so every
 * nameplate is equally likely. Null when the source runs out.
 */
export function drawNameplate(
  source: DrawSource,
  inUse: readonly string[] = [],
): string | null {
  const used = new Set(inUse);
  const all =
    used.size >= 100 && [...Array(100).keys()].every((i) => used.has(two(i)));
  for (;;) {
    const b = source(1);
    if (b === null) return null;
    if (b[0]! >= 200) continue;
    const n = two(b[0]! % 100);
    if (!all && used.has(n)) continue;
    return n;
  }
}

/**
 * The nameplates this device showed for one product in windows that closed less than
 * `LOCAL_DIAL_BUDGET_SECONDS` (300) ago (§15.12, "The code"), in memory. The shower's draw skips
 * them, so a renewed window never reuses the nameplate of the window just closed, whose dials a
 * joiner may have spent. Hold one per product for the life of the process, like `DialBudget`.
 */
export class NameplateMemory {
  private readonly closed = new Map<string, number>();

  /** The window that showed `nameplate` closed at the monotonic time `t` (seconds). */
  shown(nameplate: string, t: number): void {
    this.closed.set(nameplate, Math.max(t, this.closed.get(nameplate) ?? t));
  }

  /** The nameplates of windows that closed less than 300 s before `t`. */
  recent(t: number): string[] {
    for (const [n, at] of this.closed)
      if (t - at >= LOCAL_DIAL_BUDGET_SECONDS) this.closed.delete(n);
    return [...this.closed.keys()];
  }

  /**
   * The shower's draw, in two tiers. First among the nameplates this memory does not hold: the
   * adverts of other windows are not authenticated, so they never steer it. Only when it holds all
   * 100, the one that closed longest ago (the lowest on a tie), with no byte read. Null when the
   * source runs out.
   */
  draw(source: DrawSource, t: number): string | null {
    const held = this.recent(t);
    if (held.length < 100) return drawNameplate(source, held);
    let best = "";
    let at = Infinity;
    for (const [n, c] of [...this.closed].sort(([a], [b]) => (a < b ? -1 : 1)))
      if (c < at) [best, at] = [n, c];
    return best;
  }
}

/** The SDK's renewal floor (§15.12, "The code"): refuse a new window for this long after a hard end. */
export const LOCAL_RENEW_COOLDOWN_SECONDS = 30;
/** Two windows that ended after a wrong guess within this many seconds start the cooldown. */
export const LOCAL_RENEW_WRONG_SECONDS = 600;
/** How many such windows start the cooldown. */
export const LOCAL_RENEW_WRONG_LIMIT = 2;

/**
 * How a window ended, for `RenewFloor`: `too-many-tries` (the fifth failed guess) or `wrong-code`
 * (any other end of a window that had counted a failed guess, a `renew()` replacement included).
 */
export type RenewEnd = "too-many-tries" | "wrong-code";

/**
 * The renewal floor, one per product for the life of the process, beside `DialBudget`. After a
 * `too-many-tries` end, or the second `wrong-code` end within 600 s, no window opens for 30 s, so
 * a host that renews from `onEnd` with no person cannot give a guesser windows at machine speed.
 * Times are monotonic seconds. In memory only.
 */
export class RenewFloor {
  private until = -Infinity;
  private wrong: number[] = [];

  /** A window ended at `t`. */
  ended(end: RenewEnd, t: number): void {
    if (end === "wrong-code") {
      this.wrong = this.wrong.filter((w) => t - w < LOCAL_RENEW_WRONG_SECONDS);
      this.wrong.push(t);
      if (this.wrong.length < LOCAL_RENEW_WRONG_LIMIT) return;
    }
    this.until = Math.max(this.until, t + LOCAL_RENEW_COOLDOWN_SECONDS);
  }

  /** Whether a window may open at `t`, and else the whole seconds until it may. */
  check(t: number): { allowed: boolean; retryIn: number } {
    return t >= this.until
      ? { allowed: true, retryIn: 0 }
      : { allowed: false, retryIn: Math.ceil(this.until - t) };
  }
}

/**
 * The password: a u32be of 4 bytes, drawn again at 4 294 000 000 or more, then mod 10^6, written
 * with leading zeros. Null when the source runs out.
 */
export function drawPassword(source: DrawSource): string | null {
  for (;;) {
    const b = source(4);
    if (b === null) return null;
    const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
    if (n >= 4_294_000_000) continue;
    return String(n % 1_000_000).padStart(6, "0");
  }
}

/** `4812 3456`: two groups of four, one space. */
export function displayCode(nameplate: string, password: string): string {
  const digits = nameplate + password;
  if (!/^[0-9]{8}$/.test(digits)) throw new RangeError("code");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

export type CodeVerdict =
  | { ok: true; nameplate: string; password: string }
  | { ok: false };

/** A typed code: ASCII spaces and hyphens removed, then exactly 8 ASCII digits. */
export function parseCode(text: string): CodeVerdict {
  const digits = text.replace(/[ -]/g, "");
  return /^[0-9]{8}$/.test(digits)
    ? { ok: true, nameplate: digits.slice(0, 2), password: digits.slice(2) }
    : { ok: false };
}

// ── The QR (§15.12, "The QR") ────────────────────────────────────────────────────────────────

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const asciiFold = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The base32 characters of an instance after `p1-` (16) and of the QR secret (26). */
const INSTANCE_BODY_RE = /^[a-z2-7]{16}$/;
const SECRET_RE = /^[a-z2-7]{26}$/;

/** `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. */
export function makeQr(
  slug: string,
  instance: string,
  secret: Uint8Array,
): string {
  if (!SLUG_RE.test(slug)) throw new RangeError("slug");
  if (!isInstanceName(instance)) throw new RangeError("instance");
  if (secret.length !== LOCAL_QR_SECRET_BYTES) throw new RangeError("secret");
  return `PKP1:${slug}:${instance.slice(3)}:${base32Lower(secret)}`.toUpperCase();
}

export type QrVerdict =
  | { result: "ok"; slug: string; instance: string; secret: Uint8Array }
  | { result: "other-app" }
  | { result: "invalid" };

/** The 16 bytes of 26 canonical base32 characters; null when the two unused low bits are set. */
function decodeSecret(chars: string): Uint8Array | null {
  const out = new Uint8Array(16);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of chars) {
    acc = (acc << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out[at++] = (acc >> (bits - 8)) & 0xff;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}

/**
 * Read a scanned QR. ASCII case is folded and the text needs four fields split at `:`: `PKP1`, a
 * slug, 16 base32 characters and 26 canonical ones. A well-formed slug that is not `own` answers
 * `other-app`; everything else wrong is `invalid`, and the slug is judged last.
 */
export function parseQr(text: string, own: string): QrVerdict {
  const f = asciiFold(text).split(":");
  if (f.length !== 4 || f[0] !== "pkp1") return { result: "invalid" };
  const [, slug, instance, secret] = f as [string, string, string, string];
  if (!SLUG_RE.test(slug) || !INSTANCE_BODY_RE.test(instance))
    return { result: "invalid" };
  if (!SECRET_RE.test(secret)) return { result: "invalid" };
  const bytes = decodeSecret(secret);
  if (bytes === null) return { result: "invalid" };
  if (slug !== own) return { result: "other-app" };
  return { result: "ok", slug, instance: `p1-${instance}`, secret: bytes };
}

// ── The adverts (§15.12, "The pairing window" and "Mode l") ──────────────────────────────────

/** The `m=q` instance: `p1-` and the 16 base32 characters of the window's 10 random bytes. */
export function pairingInstance(sid: Uint8Array): string {
  if (sid.length !== 10) throw new RangeError("sid");
  return `p1-${base32Lower(sid)}`;
}

/**
 * The `m=l` instance of an advertiser in one epoch: `p1-` and the first 16 characters of the
 * lower-case base32 of `HMAC-SHA256(secret, "pkey-peer/1 ldisc" ‖ 0x00 ‖ u64be(epoch) ‖ key)`,
 * with the advertiser's own link key so the two devices of a link differ.
 */
export async function localInstance(
  secret: Uint8Array,
  advertiserLinkKey: Uint8Array,
  epoch: number,
): Promise<string> {
  const mac = await hmac(
    secret,
    cat(
      utf8("pkey-peer/1 ldisc"),
      Uint8Array.of(0),
      u64be(epoch),
      advertiserLinkKey,
    ),
  );
  return `p1-${base32Lower(mac).slice(0, 16)}`;
}

/** A link the device holds, as a browser tests it: its secret and the peer's link key. */
export interface LocalLinkKey {
  secret: Uint8Array;
  peerKey: Uint8Array;
}

export interface LocalHit {
  /** Index into the links as held. */
  link: number;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
}

/**
 * Which held link an instance belongs to: the first of the first `MAX_LOCAL_LINKS`, in held order,
 * that matches in the current or the previous epoch. At most 64 HMACs.
 */
export async function browseLocalInstance(
  instance: string,
  links: readonly LocalLinkKey[],
  nowSeconds: number,
): Promise<LocalHit | null> {
  if (!isInstanceName(instance)) return null;
  const epoch = advertEpoch(nowSeconds);
  for (let i = 0; i < links.length && i < MAX_LOCAL_LINKS; i++)
    for (const epochBack of [0, 1] as const) {
      if (epoch - epochBack < 0) continue;
      if (
        (await localInstance(
          links[i]!.secret,
          links[i]!.peerKey,
          epoch - epochBack,
        )) === instance
      )
        return { link: i, epochBack };
    }
  return null;
}

export type LocalTxtResult =
  | { ok: true; mode: "l" }
  | { ok: false; reason: "duplicate" | "version" | "mode" };

/** `v=1` and `m=l`. Entries split as `parseTxt` splits them; `h` and `n` are not read. */
export function parseLocalTxt(entries: readonly string[]): LocalTxtResult {
  const kv = txtEntries(entries);
  if (kv === null) return { ok: false, reason: "duplicate" };
  const refused =
    kv.get("v") !== "1" ? "version" : kv.get("m") !== "l" ? "mode" : null;
  return refused === null
    ? { ok: true, mode: "l" }
    : { ok: false, reason: refused };
}

// ── The LOCAL_LINK body (§15.12, "The LOCAL_LINK body") ──────────────────────────────────────

export interface LocalLinkBody {
  label?: string;
  /** The categories the sender's person approved. */
  cats: string[];
}

export type LocalLinkVerdict = ({ ok: true } & LocalLinkBody) | { ok: false };

/** The bytes of a `LOCAL_LINK` body. Throws `RangeError` for a body the peer would refuse. */
export function buildLocalLink(o: {
  label?: string;
  cats: readonly string[];
}): Uint8Array {
  if (!validCats(o.cats)) throw new RangeError("cats");
  const label = o.label === undefined ? null : cleanLabel(o.label);
  const bytes = utf8(
    JSON.stringify({
      v: 1,
      ...(label !== null ? { label } : {}),
      cats: [...o.cats],
    }),
  );
  if (bytes.length > LOCAL_LINK_BODY_MAX) throw new RangeError("size");
  return bytes;
}

/**
 * Judge one `LOCAL_LINK` body: strict JSON of at most 4 KiB, `v` the integer 1, an optional label
 * cleaned as a `HELLO` label (dropped when nothing is left), `cats` required. Unknown members are
 * ignored; a key, id or certificate in the body is never read.
 */
export function parseLocalLink(body: Uint8Array): LocalLinkVerdict {
  const scanned =
    body.length > LOCAL_LINK_BODY_MAX ? null : parseStrictObjectScanned(body);
  if (scanned === null) return { ok: false };
  const { cats, label, v } = scanned.o;
  const labelOk = label === undefined || typeof label === "string";
  if (
    v !== 1 ||
    scanned.nonWireIntegers.has("/v") ||
    !labelOk ||
    !Array.isArray(cats) ||
    !validCats(cats)
  )
    return { ok: false };
  const clean = typeof label === "string" ? cleanLabel(label) : null;
  return {
    ok: true,
    ...(clean !== null ? { label: clean } : {}),
    cats: [...cats],
  };
}

// ── The link secret (§15.12, "The link secret") ──────────────────────────────────────────────

/**
 * `HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local" ‖ 0x00 ‖ lo ‖ hi)`, 32 bytes: `h` is
 * the mode-`q` handshake hash, `isk` the CPace ISK (64 bytes) and `lo`, `hi` the two link public
 * keys by unsigned byte order.
 */
export async function localLinkSecret(
  h: Uint8Array,
  isk: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): Promise<Uint8Array> {
  if (keyA.length !== 32 || keyB.length !== 32) throw new RangeError("key");
  const [lo, hi] = byteCompare(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  return hkdfSha256(
    h,
    isk,
    cat(utf8("pkey-peer/1 local"), Uint8Array.of(0), lo, hi),
    32,
  );
}

/** A link's categories: the entries both sides listed, once each, in byte order. */
export const localCategories = capsIntersection;

// ── Handshake capabilities (§15.12 step 4) ───────────────────────────────────────────────────

export interface LocalCaps {
  caps: string[];
  /** Mode `q` without `local/1` in the session's capabilities: close, before any consent. */
  close?: "peer_not_allowed";
}

/** The session's capabilities of a mode-`q` or mode-`l` handshake. */
export function negotiateLocalCaps(
  mode: "q" | "l",
  local: readonly string[],
  remote: readonly string[],
): LocalCaps {
  const caps = capsIntersection(local, remote);
  return mode === "q" && !caps.includes(LOCAL_CAP)
    ? { caps, close: "peer_not_allowed" }
    : { caps };
}

// ── The joiner (§15.12, "The joiner") ────────────────────────────────────────────────────────

export type JoinInput =
  | { kind: "code"; nameplate: string }
  | { kind: "qr"; instance: string }
  | { kind: "invalid" }
  | { kind: "other-app" };

/**
 * How one dial ended. `budget` is a dial the joiner's budget stopped in the middle of a join
 * (nothing was dialled).
 */
export type DialOutcome = "transport" | "before-c2" | "after-c2" | "budget";

export type JoinResult =
  | "transport"
  | "pairing-code-failed"
  | "pairing-not-found";

/**
 * Why a joiner answered `pairing-code-failed` (§15.12, "Errors"). Display only. The first that
 * applies wins: `invalid` or `other-app` (the parse), `spent` (refused at the start), `wrong` (a
 * dial ended after C2), `spent` (the budget stopped a dial in the middle of the join).
 */
export type PairingCodeFailedReason =
  | "invalid"
  | "other-app"
  | "spent"
  | "wrong";

/** Why a showing device's code is the code it is (`LocalCode.reason`). Display only. */
export type LocalCodeReason =
  | "opened"
  | "wrong-code"
  | "declined"
  | "timeout"
  | "closed";

/** Why a window ended: the `WindowClosed` reasons, and `off` when the gate went off. */
export type LocalWindowEnd = WindowClosed | "off";

/** Why a pairing ended without a link (`onFailed`, and the reason of a joiner's `peer-closed`). */
export type LocalPairFailureReason =
  | "declined"
  | "timeout"
  | "full"
  | "too-many-tries"
  | "closed"
  | "cancelled"
  | "cooldown";

/** Which limit `local-links-full` hit. */
export type LocalLinksCap = "stored" | "reachable";

/**
 * The joiner's choices over one browse. A code or QR that did not parse browses nothing and
 * answers `pairing-code-failed`. Matching `m=q` adverts are kept once each in first-seen order, at
 * most `LOCAL_JOIN_KEPT`, and the first `LOCAL_JOIN_CANDIDATES` are dialled, never redialled. The
 * first session that reaches the transport ends the dial.
 */
export class JoinPlan {
  private readonly keptNames: string[] = [];
  private dials = 0;
  private transport = false;
  private afterC2 = false;
  private budgetStopped = false;
  private spentAtStart = false;

  constructor(private readonly input: JoinInput) {}

  /** Whether anything is browsed at all. */
  get browses(): boolean {
    return (
      this.input.kind !== "invalid" &&
      this.input.kind !== "other-app" &&
      !this.spentAtStart
    );
  }

  /** The nameplate's dials were spent before the join began: nothing is browsed or dialled. */
  startSpent(): void {
    this.spentAtStart = true;
  }

  get kept(): readonly string[] {
    return this.keptNames;
  }

  /**
   * One `m=q` advert seen. `tagMatches` is whether its `h` is this product's tag of the current or
   * previous epoch; `n` its nameplate. Returns whether it was kept.
   */
  see(instance: string, tagMatches: boolean, n: string): boolean {
    if (!this.browses || !tagMatches) return false;
    const match =
      this.input.kind === "code"
        ? n === this.input.nameplate
        : instance === (this.input as { instance: string }).instance;
    if (
      !match ||
      this.keptNames.includes(instance) ||
      this.keptNames.length >= LOCAL_JOIN_KEPT
    )
      return false;
    this.keptNames.push(instance);
    return true;
  }

  /** The next advert to dial, or null when the dial has ended. */
  next(): string | null {
    if (this.transport || this.dials >= LOCAL_JOIN_CANDIDATES) return null;
    return this.keptNames[this.dials] ?? null;
  }

  /** The dial of `next()` ended this way. */
  ended(outcome: DialOutcome): void {
    this.dials++;
    if (outcome === "transport") this.transport = true;
    else if (outcome === "after-c2") this.afterC2 = true;
    else if (outcome === "budget") this.budgetStopped = true;
  }

  /** The answer once no dial is left (or the browse ran out). */
  result(): JoinResult {
    if (!this.browses) return "pairing-code-failed";
    if (this.transport) return "transport";
    return this.afterC2 || this.budgetStopped
      ? "pairing-code-failed"
      : "pairing-not-found";
  }

  /** Of a `pairing-code-failed` result, why; null for any other result. */
  reason(): PairingCodeFailedReason | null {
    if (this.result() !== "pairing-code-failed") return null;
    if (this.input.kind === "invalid") return "invalid";
    if (this.input.kind === "other-app") return "other-app";
    if (this.spentAtStart) return "spent";
    return this.afterC2 ? "wrong" : "spent";
  }
}

/** At most this many dials per nameplate in any `LOCAL_DIAL_BUDGET_SECONDS`, across joins. */
export const LOCAL_DIAL_BUDGET = 2;
export const LOCAL_DIAL_BUDGET_SECONDS = 300;

/**
 * The joiner's dials per typed nameplate across joins, in memory, per product (§15.12). A person
 * who retypes a code meets the same budget as one join: a fake advert that answers a dial gets one
 * guess, so retries must not multiply the dials. A QR names its instance and is never limited.
 */
export class DialBudget {
  private readonly dialled = new Map<string, number[]>();

  private recent(nameplate: string, t: number): number[] {
    const kept = (this.dialled.get(nameplate) ?? []).filter(
      (d) => t - d < LOCAL_DIAL_BUDGET_SECONDS,
    );
    this.dialled.set(nameplate, kept);
    return kept;
  }

  /** Whether a join of this nameplate may browse and dial now, and the dials already spent. */
  check(nameplate: string, t: number): { allowed: boolean; used: number } {
    const used = this.recent(nameplate, t).length;
    return { allowed: used < LOCAL_DIAL_BUDGET, used };
  }

  /** The join made `dials` dials. */
  spend(nameplate: string, t: number, dials: number): void {
    this.recent(nameplate, t).push(...Array<number>(dials).fill(t));
  }

  /** The dials a join of this nameplate may still make now: 2 less the dials spent. */
  left(nameplate: string, t: number): 0 | 1 | 2 {
    return (LOCAL_DIAL_BUDGET - this.check(nameplate, t).used) as 0 | 1 | 2;
  }
}

/**
 * The dials left for the nameplate a person has typed so far (`localLinks.dialsLeft`): null unless
 * the text, with ASCII spaces and hyphens removed, starts with two ASCII digits. It reads those two
 * digits only, keeps nothing and spends nothing.
 */
export function dialsLeft(
  budget: DialBudget,
  text: string,
  t: number,
): 0 | 1 | 2 | null {
  const m = /^[0-9]{2}/.exec(text.replace(/[ -]/g, ""));
  return m === null ? null : budget.left(m[0], t);
}

// ── The pairing window (§15.12, "The pairing window") ────────────────────────────────────────

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

export type WindowClosed = "expired" | "too-many-tries" | "stored" | "person";

export interface WindowOutcome {
  result?: WindowResult;
  /** The id of the attempt a C1 admitted. */
  id?: number;
  /** The error the host hears: the fifth failed guess. */
  host?: "pairing-code-failed";
  /**
   * The password and the QR secret rotate now. The window is `rotating` (busy, uncounted) until
   * the host has made the new code and QR secret and computed both generators, and calls `rotated`.
   */
  rotate: boolean;
}

export interface WindowState {
  open: boolean;
  holder: "attempt" | "session" | "rotating" | null;
  /** Guesses counted: counted when permitted, refunded when one opens. */
  failures: number;
  rotations: number;
  closed: WindowClosed | null;
}

/**
 * The shower's window over events with a monotonic time in seconds. A C1 that is admitted hands out
 * an attempt id; one attempt holds the window from its C1 until its guess or `LOCAL_ATTEMPT_SECONDS`.
 *
 * A guess is counted before its tag is tried. The session asks `beginGuess(id, t)`, a synchronous
 * permit given once, to the holder's own attempt only, while the window is open; it counts the
 * failure now (the fifth closes the window once its verdict is in), and an attempt that was not
 * permitted, a stale, expired or closed one, answers false and its tag is never tried. A guess that
 * opens is refunded (`guessOpened`) and the attempt becomes the session; one that does not, and a
 * permitted attempt whose connection ends (`abandon`) or runs out its 30 s, is a failed guess
 * (`guessFailed`): the password and the QR secret rotate. The window is `rotating` until
 * `rotated`, which the host calls once the new secrets and both generators are ready (§15.12,
 * step 6), so a C1 never meets the old password or a generator that is still being made.
 *
 * A refused C1 and an attempt that never reached its guess count nothing; a session that ends
 * without a link also rotates and holds the window until `rotated`. At most 5 C1s a minute are
 * admitted, counted when admitted; a busy C1 is never counted. The window expires
 * `LOCAL_PAIR_SECONDS` after it opened, which closes a connection that has not reached the
 * transport (the host closes it) and leaves a session running. Attempt ids never repeat, so a
 * connection of a closed window cannot touch the next one.
 */
export class PairingWindow {
  private isOpen = false;
  private openedAt = 0;
  private holder: WindowState["holder"] = null;
  private attempt: { id: number; at: number; guessed: boolean } | null = null;
  private nextId = 1;
  private failures = 0;
  private rotations = 0;
  private closedFor: WindowClosed | null = null;
  private admits: number[] = [];

  get state(): WindowState {
    return {
      open: this.isOpen,
      holder: this.holder,
      failures: this.failures,
      rotations: this.rotations,
      closed: this.closedFor,
    };
  }

  /** Apply the clocks: the window's expiry and an attempt's deadline. */
  tick(t: number): WindowOutcome {
    let out: WindowOutcome = { rotate: false };
    if (this.isOpen && t - this.openedAt >= LOCAL_PAIR_SECONDS) {
      this.isOpen = false;
      this.closedFor = "expired";
      // A counted guess stays counted; there is no window left to rotate.
      if (this.holder === "attempt") this.drop();
      if (this.holder === "rotating") this.holder = null;
    }
    const a = this.attempt;
    if (
      this.holder === "attempt" &&
      a !== null &&
      t - a.at >= LOCAL_ATTEMPT_SECONDS
    ) {
      if (a.guessed) out = this.failed();
      else this.drop();
    }
    return out;
  }

  private drop(): void {
    this.attempt = null;
    this.holder = null;
  }

  private isHolder(id: number): boolean {
    return (
      this.isOpen &&
      this.holder === "attempt" &&
      this.attempt !== null &&
      this.attempt.id === id
    );
  }

  /** One window per device per product: an open window, or a session still running, answers `already-open`. */
  open(t: number): WindowOutcome {
    this.tick(t);
    if (this.isOpen || this.holder === "session")
      return { result: "already-open", rotate: false };
    this.isOpen = true;
    this.openedAt = t;
    this.holder = null;
    this.attempt = null;
    this.failures = 0;
    this.rotations = 0;
    this.closedFor = null;
    this.admits = [];
    return { result: "opened", rotate: false };
  }

  /** A C1 arrived; `valid` is whether it passed the frame and share checks. */
  c1(t: number, valid: boolean): WindowOutcome {
    this.tick(t);
    if (!this.isOpen) return { result: "closed", rotate: false };
    if (this.holder !== null) return { result: "busy", rotate: false };
    this.admits = this.admits.filter((a) => t - a < LOCAL_C1_WINDOW_SECONDS);
    if (this.admits.length >= LOCAL_C1_PER_WINDOW)
      return { result: "limited", rotate: false };
    this.admits.push(t);
    if (!valid) return { result: "refused", rotate: false };
    const id = this.nextId++;
    this.holder = "attempt";
    this.attempt = { id, at: t, guessed: false };
    return { result: "attempt", id, rotate: false };
  }

  /**
   * The permit to try message 1's tag. True once, for the holder's own attempt, while the window is
   * open and the attempt's 30 s have not run out; the guess is counted now. False otherwise: the
   * session must not try the tag.
   */
  beginGuess(id: number, t: number): boolean {
    this.tick(t);
    if (!this.isHolder(id) || this.attempt!.guessed) return false;
    this.attempt!.guessed = true;
    this.failures++;
    return true;
  }

  /** The permitted guess opened: the count is refunded and the attempt is the session. */
  guessOpened(id: number, t: number): WindowOutcome {
    this.tick(t);
    if (!this.isHolder(id) || !this.attempt!.guessed) return { rotate: false };
    this.failures--;
    this.attempt = null;
    this.holder = "session";
    return { result: "transport", rotate: false };
  }

  /** The permitted guess did not open. */
  guessFailed(id: number, t: number): WindowOutcome {
    this.tick(t);
    if (!this.isHolder(id) || !this.attempt!.guessed) return { rotate: false };
    return this.failed();
  }

  private failed(): WindowOutcome {
    this.attempt = null;
    if (this.failures >= LOCAL_PAIR_FAILURES) {
      this.isOpen = false;
      this.closedFor = "too-many-tries";
      this.holder = null;
      return {
        result: "too-many-tries",
        host: "pairing-code-failed",
        rotate: false,
      };
    }
    this.rotations++;
    this.holder = "rotating";
    return { result: "failed", rotate: true };
  }

  /** Message 1 of `id`: the permit, then the verdict. Not permitted: nothing is tried, nothing changes. */
  msg1(id: number, t: number, opens: boolean): WindowOutcome | null {
    if (!this.beginGuess(id, t)) return null;
    return opens ? this.guessOpened(id, t) : this.guessFailed(id, t);
  }

  /** The attempt's connection closed or timed out. A permitted guess with no verdict is failed. */
  abandon(id: number, t: number): WindowOutcome {
    this.tick(t);
    if (!this.isHolder(id)) return { rotate: false };
    if (this.attempt!.guessed) return this.failed();
    this.drop();
    return { rotate: false };
  }

  /** The new code, QR secret and both generators are ready: the window takes the next C1. */
  rotated(t: number): void {
    this.tick(t);
    if (this.holder === "rotating") this.holder = null;
  }

  /**
   * The held session ended. A stored link closes the window; any other end rotates and holds the
   * window until `rotated`.
   */
  sessionEnd(t: number, stored: boolean): WindowOutcome {
    this.tick(t);
    if (this.holder !== "session") return { rotate: false };
    this.holder = null;
    if (stored) {
      this.isOpen = false;
      this.closedFor = "stored";
      return { rotate: false };
    }
    if (!this.isOpen) return { rotate: false };
    this.rotations++;
    this.holder = "rotating";
    return { rotate: true };
  }

  /** The person closed the window. */
  close(t: number): WindowOutcome {
    this.tick(t);
    if (this.isOpen) {
      this.isOpen = false;
      this.closedFor = "person";
      if (this.holder === "attempt" || this.holder === "rotating") this.drop();
    }
    return { rotate: false };
  }
}

// ── The gate (§15.12, "Gates") ───────────────────────────────────────────────────────────────

/** The cached discovery answer for local pairing. */
export type GateState = "on" | "off" | "none";
/** What a read that left a cached `true` behind makes the host do. */
export type GateEffect = "close-windows" | "withdraw-adverts" | "end-sessions";
export const GATE_EFFECTS: readonly GateEffect[] = [
  "close-windows",
  "withdraw-adverts",
  "end-sessions",
];

/** The calls the gate holds back; managing links (`list`, `rename`, `remove`, `set-reachable`) is never gated. */
export const GATED_CALLS = [
  "pair",
  "join",
  "advertise-q",
  "advertise-l",
  "browse-q",
  "browse-l",
  "dial-l",
  "answer-l",
] as const;
export type GatedCall = (typeof GATED_CALLS)[number];

/**
 * `services.connect.localPairing` of a discovery body: true only as the boolean `true` while
 * `services.connect.enabled` is the boolean `true`. A body of any other shape, a disabled service
 * and an absent member all read as false.
 */
export function localPairingOf(body: unknown): boolean {
  const member = (o: unknown, key: string): unknown =>
    o !== null && typeof o === "object"
      ? (o as Record<string, unknown>)[key]
      : undefined;
  const connect = member(member(body, "services"), "connect");
  return (
    member(connect, "enabled") === true &&
    member(connect, "localPairing") === true
  );
}

/**
 * The SDK's enforcement of the operator gate from the discovery document it cached. No cached
 * document is off, and offline a cached `true` keeps working. A successful read replaces the
 * answer, a not-found clears it, an error changes nothing; a read that leaves a cached `true`
 * behind returns the effects the host must carry out.
 */
export class LocalPairingGate {
  constructor(private cached: GateState = "none") {}

  get state(): GateState {
    return this.cached;
  }

  get allowed(): boolean {
    return this.cached === "on";
  }

  /** A successful discovery read. */
  readOk(body: unknown): GateEffect[] {
    return this.set(localPairingOf(body) ? "on" : "off");
  }

  /** A not-found discovery read: the cached answer is cleared. */
  readNotFound(): GateEffect[] {
    return this.set("none");
  }

  /** A failed read (offline, an error status): nothing changes. */
  readError(): GateEffect[] {
    return [];
  }

  private set(next: GateState): GateEffect[] {
    const was = this.cached;
    this.cached = next;
    return was === "on" && next !== "on" ? [...GATE_EFFECTS] : [];
  }

  /** `local-pairing-off` for a gated call while the gate is not on. */
  check(): "ok" | "local-pairing-off" {
    return this.allowed ? "ok" : "local-pairing-off";
  }
}

// ── The pairing exchange (§15.12, "Consent and LOCAL_LINK") ──────────────────────────────────

export type LocalExchangeEvent =
  | { event: "own-confirm" }
  | { event: "own-decline" }
  | { event: "peer-confirm" }
  | { event: "peer-link"; body: Uint8Array }
  /** 120 s from the first byte ran out. */
  | { event: "timeout-confirm" }
  /** `CONTACT_EXCHANGE_SECONDS` after both `CONFIRM`s ran out. */
  | { event: "timeout-exchange" };

export interface LocalExchangeStep {
  /** The records this step makes the side send. */
  sends: ("CONFIRM" | "LOCAL_LINK")[];
  close?: Extract<
    PeerCloseCode,
    "peer_bye" | "peer_bad_frame" | "peer_timeout" | "peer_not_allowed"
  >;
  /** The peer's `LOCAL_LINK`, valid, read in order: the host stores the link. */
  stored?: { label?: string; cats: string[] };
}

/**
 * One side's order guard over the records of the pairing (§15.12, "Order of checks"). A
 * `LOCAL_LINK` goes out once this side has sent its `CONFIRM` and read the peer's; the peer's
 * arrives only after both. The first valid `LOCAL_LINK` is stored and the side closes `peer_bye`;
 * after any close nothing happens, so a second `LOCAL_LINK` is never answered.
 */
export class LocalExchange {
  private ownConfirmed = false;
  private peerConfirmed = false;
  private linkSent = false;
  private dead = false;

  /** `held` is the number of local links the device holds; `cats` are this side's approved ones. */
  constructor(
    private readonly held: number,
    private readonly cats: readonly string[],
  ) {}

  /** Both `CONFIRM`s are done (this side's sent, the peer's read), and no link has closed the session. */
  get bothConfirmed(): boolean {
    return !this.dead && this.ownConfirmed && this.peerConfirmed;
  }

  step(e: LocalExchangeEvent): LocalExchangeStep {
    const r: LocalExchangeStep = { sends: [] };
    if (this.dead) return r;
    const end = (close: NonNullable<LocalExchangeStep["close"]>) => {
      this.dead = true;
      r.close = close;
      return r;
    };
    const maybeLink = (): void => {
      if (this.ownConfirmed && this.peerConfirmed && !this.linkSent) {
        this.linkSent = true;
        r.sends.push("LOCAL_LINK");
      }
    };
    switch (e.event) {
      case "own-confirm":
        if (this.ownConfirmed) return r;
        this.ownConfirmed = true;
        r.sends.push("CONFIRM");
        maybeLink();
        return r;
      case "own-decline":
        // A decline after this side's CONFIRM is not an event: the person already agreed.
        return this.ownConfirmed ? r : end("peer_bye");
      case "peer-confirm":
        if (this.peerConfirmed) return end("peer_bad_frame");
        this.peerConfirmed = true;
        maybeLink();
        return r;
      case "peer-link": {
        if (!this.ownConfirmed || !this.peerConfirmed)
          return end("peer_bad_frame");
        const v = parseLocalLink(e.body);
        if (!v.ok) return end("peer_bad_frame");
        if (this.held >= MAX_LOCAL_LINKS) return end("peer_not_allowed");
        r.stored = {
          ...(v.label !== undefined ? { label: v.label } : {}),
          cats: localCategories(this.cats, v.cats),
        };
        return end("peer_bye");
      }
      case "timeout-confirm":
        return this.ownConfirmed && this.peerConfirmed
          ? r
          : end("peer_timeout");
      case "timeout-exchange":
        return this.ownConfirmed && this.peerConfirmed
          ? end("peer_timeout")
          : r;
    }
  }
}

// ── The pin (§15.12, "Mode l" and "Link keys") ───────────────────────────────────────────────

const sameKey = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && byteCompare(a, b) === 0;

/**
 * Mode l: the remote static key must be the peer link key of the link whose secret opened the
 * session. The initiator asks after message 2, the responder after message 3; a `false` ends the
 * session as `peer_revoked` with nothing sent.
 */
export const localPin = (held: Uint8Array, remoteStatic: Uint8Array): boolean =>
  sameKey(held, remoteStatic);

/**
 * Mode q: a remote static key equal to this side's own link key ends the handshake silently,
 * before the transport (a reflected handshake). `true` means the key is another's.
 */
export const pairingRemoteOk = (
  own: Uint8Array,
  remoteStatic: Uint8Array,
): boolean => !sameKey(own, remoteStatic);

// ── The listener's trial order (§15.5 "One listener, one order") ─────────────────────────────

/** The trials a full miss costs: two account keys, 72 contact secrets and 32 local-link secrets. */
export const TRIAL_TOTAL = 2 + MAX_CONTACT_SECRETS + MAX_LOCAL_LINKS;

/** Dummy trials after a miss behind the limiter, so a silent close costs `TRIAL_TOTAL` trials. */
export const trialPadding = (tried: number): number =>
  Math.max(0, TRIAL_TOTAL - tried);

export interface TrialEntry {
  /** `a` an account discovery key, `c` a contact secret, `l` a local-link secret. */
  kind: "a" | "c" | "l";
  /** Index in the list as held (an absent account key keeps its slot). */
  index: number;
}

/**
 * The order a shared listener tries message 1 in: the account's keys (an absent one is skipped),
 * then the contact secrets (at most `MAX_CONTACT_SECRETS`), then the local-link secrets in held
 * order (at most `MAX_LOCAL_LINKS`): at most `MAX_LINK_SECRETS` secrets after the account keys.
 * The contact and local-link trials sit behind the contact limiter; the account keys do not.
 */
export function listenerTrialOrder(
  account: readonly (unknown | null)[] | null,
  contacts: number,
  locals: number,
): TrialEntry[] {
  const out: TrialEntry[] = [];
  (account ?? []).slice(0, 2).forEach((k, index) => {
    if (k !== null) out.push({ kind: "a", index });
  });
  for (let i = 0; i < Math.min(contacts, MAX_CONTACT_SECRETS); i++)
    out.push({ kind: "c", index: i });
  for (let i = 0; i < Math.min(locals, MAX_LOCAL_LINKS); i++)
    out.push({ kind: "l", index: i });
  return out;
}
