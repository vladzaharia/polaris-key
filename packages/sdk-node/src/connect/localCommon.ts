// Pairing with a code, with no account: the types and the pieces the shower and the joiner share
// (CC-29.7; WIRE-CONTRACT-V5 §15.12). The window is `localShower.ts`, the dialling side is
// `localJoiner.ts`, and `localLinks.ts` is the `client.cloudConnect.localLinks` facade.
//
// A password, a QR secret and a link secret are key material: nothing here logs one, prints one or
// puts one in an error.

import type { Socket } from "node:net";
import { PolarisError, UnsupportedError } from "@polaris-key/client-core";
import {
  MAX_CONTACT_CATS,
  type PeerHello,
  type SessionEvent,
} from "@polaris-key/client-core/peer";
import { ErrorCode, Feature } from "../constants.generated.js";
import { defaultTimer } from "./channel.js";
import type { LocalLinkStore } from "./localState.js";
import { MulticastDnsAdapter, type MdnsAdapter } from "./mdns.js";
import {
  LanError,
  guarded,
  type SessionClosed,
  type SocketLink,
} from "./session.js";

const CAT = /^[a-z0-9-]{1,32}$/;
const LABEL_MAX = 64;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export const systemRandom = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * The 10 bytes behind a `p1-` instance name, which are the window's CPace `sid`; null for a name
 * that is not 16 base32 characters.
 */
export function sidOf(instance: string): Uint8Array | null {
  if (!/^p1-[a-z2-7]{16}$/.test(instance)) return null;
  let n = 0n;
  for (const c of instance.slice(3)) n = (n << 5n) | BigInt(B32.indexOf(c));
  return Uint8Array.from({ length: 10 }, (_, i) =>
    Number((n >> BigInt(8 * (9 - i))) & 0xffn),
  );
}

/** What local pairing reads of the client. */
export interface LocalSource {
  slug: string;
  /** Seconds since the epoch. */
  now(): number;
  /** The cached discovery answer `localPairing` is true (§15.12 "Gates"). */
  allowed(): boolean;
  store: LocalLinkStore;
  /** The links changed (renamed, re-marked, forgotten): the listener and the adverts follow. */
  notify(): void;
  /** Called by `notify()` and when the gate moves. Returns the unsubscribe. */
  onChange(fn: () => void): () => void;
}

/** The code a shower shows now. It changes after every failed guess. */
export interface LocalCode {
  /** The 8 digits as two groups of four, like `4812 3456`. */
  readonly code: string;
  /** The text of the QR, `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case. */
  readonly qr: string;
  /** The public two digits of the code, the advert's `n`. */
  readonly nameplate: string;
}

/** The common options of `pair` and `join`. */
export interface LocalOptions {
  /**
   * The data categories this app asks both people to approve (at most 8, each `^[a-z0-9-]{1,32}$`,
   * no repeat). Show them next to the consent. A link keeps the ones both sides listed.
   */
  categories: readonly string[];
  /** This device's label, sent in `HELLO` and in `LOCAL_LINK` and stored on the other device. */
  label?: string;
  /** Called when a device reaches the consent: show it, then call `confirm()` or `decline()`. */
  onConfirm: (offer: LocalOffer) => void;
  mdns?: MdnsAdapter;
  /** Where the shower listens. Default `::`, or 0.0.0.0. */
  host?: string;
  /** Accept and dial loopback peers. For tests and same-host use only. */
  allowLoopback?: boolean;
  handshakeMs?: number;
  timer?: (fn: () => void, ms: number) => () => void;
  mono?: () => number;
  random?: (n: number) => Uint8Array;
}

export interface LocalPairOptions extends LocalOptions {
  /** Called with the code when the window opens, and with the new one after every failed guess. */
  onCode: (c: LocalCode) => void;
  /** Called once with the link made. */
  onLinked?: (link: LocalPaired) => void;
  /** Called when a session that reached consent ends without a link, and at the fifth failed guess. */
  onFailed?: (f: LocalPairFailure) => void;
  /** Seconds the window stays open (default and most 300). */
  seconds?: number;
}

export interface LocalJoinOptions extends LocalOptions {
  /** The code the other device shows, typed (spaces and hyphens are ignored). */
  code?: string;
  /** The text of the QR the other device shows. Give exactly one of `code` and `qr`. */
  qr?: string;
  /** Seconds to browse for the other device (default and most 15). */
  browseSeconds?: number;
}

/** The other device, at the consent step. */
export interface LocalOffer {
  /** Agree to the pairing. The link exists once the other person agrees too. */
  confirm(): Promise<void>;
  /** Say no: the session closes and this side stores nothing. */
  decline(): Promise<void>;
  /** Subscribe to the end of the session; returns the unsubscribe. */
  onClose(fn: (c: SessionClosed) => void): () => void;
  /**
   * The label the other device sent. It proved the code, but nothing else about it is
   * authenticated: show it as "reported by the device".
   */
  readonly label: string | null;
  readonly platform: string;
  /** The categories this app asked for: list them before the person agrees. */
  readonly categories: readonly string[];
}

/** What `pair` and `join` report once a link is stored. */
export interface LocalPaired {
  /** Names the link on this device; `list()` has the rest. */
  id: string;
  label: string | null;
  /** The categories both people approved. */
  categories: readonly string[];
}

export interface LocalPairFailure {
  /** `declined` here, `timeout` a deadline ran out, `full` at the cap, `too-many-tries` the fifth failed guess, `closed` otherwise. */
  reason: "declined" | "timeout" | "full" | "too-many-tries" | "closed";
  close?: SessionClosed;
}

export interface LocalPairHandle {
  /** Close the window: the advert, the listener and every session. */
  stop(): Promise<void>;
  /** The window is still open. */
  readonly open: boolean;
  /** The code on show now; null once the window has closed. */
  code(): LocalCode | null;
}

export const off = (detail: string): UnsupportedError =>
  new UnsupportedError(
    {
      supported: false,
      feature: Feature.connectLocal,
      reason: "product",
      detail,
    },
    ErrorCode.localPairingOff,
  );

export const full = (): PolarisError =>
  new PolarisError(
    ErrorCode.localLinksFull,
    "This device holds the most local links it can for this app.",
  );

/** Eight links are reachable already: turn one off before another is advertised (§15.12). */
export const reachableFull = (): PolarisError =>
  new PolarisError(
    ErrorCode.localLinksFull,
    "Eight local links are already reachable on this network; turn one off first.",
  );

const catsOk = (c: unknown): boolean =>
  Array.isArray(c) &&
  c.length <= MAX_CONTACT_CATS &&
  new Set(c).size === c.length &&
  c.every((x) => typeof x === "string" && CAT.test(x));

/** Throws `LanError` `bad_input` for options of `pair` or `join` that break a rule. */
export function checkOptions(o: LocalOptions): void {
  const refuse = (m: string): LanError => new LanError("bad_input", m);
  if (typeof o.onConfirm !== "function") throw refuse("onConfirm is required.");
  if (!catsOk(o.categories))
    throw refuse(
      "categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).",
    );
  if (
    o.label !== undefined &&
    (typeof o.label !== "string" || o.label.length > LABEL_MAX)
  )
    throw refuse("The label is not valid.");
}

/** The clock, the timer, the random source and the mDNS adapter of one pairing. */
export interface Env {
  random: (n: number) => Uint8Array;
  timer: (fn: () => void, ms: number) => () => void;
  mono: () => number;
  mdns: MdnsAdapter;
}

export const envOf = (o: LocalOptions): Env => ({
  random: o.random ?? systemRandom,
  timer: o.timer ?? defaultTimer,
  mono: o.mono ?? ((): number => performance.now() / 1000),
  mdns: o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback }),
});

/** The connection of one attempt, on either side. */
export class Attempt {
  id: number | null = null;
  socket: Socket | null = null;
  link: SocketLink | null = null;
  hello: PeerHello | null = null;
  phase: "c1" | "session" | "done" = "c1";
  shown = false;
  linked = false;
  declined = false;
  local = false;
  failure: LocalPairFailure["reason"] | null = null;
  closed: SessionClosed | null = null;
  storing: Promise<unknown> | null = null;
  /** This attempt's link private key: kept only when the attempt stores a link. */
  linkKey: Uint8Array = new Uint8Array(0);
  readonly closers = new Set<(c: SessionClosed) => void>();
}

/** The consent handle the host gets for an attempt that proved the code. */
export function offerOf(
  a: Attempt,
  cats: readonly string[],
  hello: PeerHello,
): LocalOffer {
  return {
    label: hello.label ?? null,
    platform: hello.platform,
    categories: [...cats],
    confirm: async () => {
      if (a.link === null || a.local) return;
      await a.link.channel.confirmPairing();
    },
    decline: async () => {
      if (a.link === null) return;
      a.declined = true;
      a.failure = "declined";
      await a.link.channel.declinePairing().catch(() => undefined);
    },
    onClose: (fn) => {
      a.closers.add(fn);
      if (a.closed !== null) guarded(() => fn(a.closed!));
      return () => a.closers.delete(fn);
    },
  };
}

/**
 * Store the link a session produced. Null at the cap (the attempt's `failure` says `full`); throws
 * what the store throws. The secret is wiped either way.
 */
export async function storeLink(
  src: LocalSource,
  a: Attempt,
  e: Extract<SessionEvent, { type: "local-link" }>,
): Promise<LocalPaired | null> {
  try {
    const r = await src.store.add({
      ownKey: a.linkKey,
      ownPublic: e.ownKey,
      peerKey: e.peerKey,
      secret: e.secret,
      ...(e.label !== undefined ? { label: e.label } : {}),
      cats: e.cats,
      now: src.now(),
      // The gate is read again inside the store call: a pairing already storing when it clears writes nothing.
      allowed: () => src.allowed(),
    });
    if (!r.stored) {
      a.failure = r.off ? "closed" : "full";
      return null;
    }
    a.linked = true;
    // The listener starts (a device that held no link) and the new link is advertised.
    src.notify();
    return { id: r.id, label: e.label ?? null, categories: [...e.cats] };
  } finally {
    e.secret.fill(0);
  }
}
