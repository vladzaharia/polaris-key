// `identity.signIn.start(opts)`: the one way to sign in (I-10a.10), the React half of Node's
// `client.identity.signIn`. `channel: "device-code"` is RFC 8628 (a TV, a kiosk, a desktop
// renderer behind the bridge); `channel: "redirect"` is the web redirect with PKCE (client-core's
// `identityRedirect.ts`, one implementation for Node and React), whose verifier and `state` wait in
// `sessionStorage` across the navigation, keyed by `state`, until `signIn.complete(callbackUrl)`.
//
// This file holds what both transports share: the option and session shapes, the discovery
// reading, and the stash. The transports are `bearer/signInSessions.ts` and the desktop adapter.

import type { AuthorizePurpose } from "@polaris-key/protocol/identity";
import type { RedirectPending } from "@polaris-key/client-core";
import { isSecureTransportUrl } from "./types.js";

export type { AuthorizePurpose };

/** Hints that prefill the sign-in page. They verify nothing (WIRE-CONTRACT-V4 §12.4). */
export interface SignInHints {
  loginHint?: string;
  nameHint?: string;
  purpose?: AuthorizePurpose;
}

/** `signIn.start({channel: "device-code"})`. */
export interface DeviceCodeSignInOptions extends SignInHints {
  channel: "device-code";
  /** The device label the sign-in page shows (§12.7.1), else the client's. */
  deviceName?: string;
  scope?: string | readonly string[];
  /** `"app"`: the app shows the licence choice itself (a hint; the card chooses otherwise). */
  licenseChoice?: "app";
}

/** `signIn.start({channel: "redirect", redirectUri})`. */
export interface RedirectSignInOptions extends SignInHints {
  channel: "redirect";
  /** The `https:` URI the product registered; the browser lands there with the code. */
  redirectUri: string;
  /** Default `profile email`. */
  scope?: string | readonly string[];
  /** `"app"`: the app shows the licence choice itself. Honoured only when discovery has the
   *  `choice*` endpoints; otherwise the card chooses. */
  licenseChoice?: "app";
  deviceName?: string;
}

export type SignInOptions = DeviceCodeSignInOptions | RedirectSignInOptions;

/** How a sign-in session ended, or (`wait({once: true})`) has not yet. A person's refusal throws
 *  `sign-in-denied`; a failure after approval throws `sign-in-failed`. */
export type SignInOutcome =
  /** Not finished. `interval` is the seconds before the next poll; `slowDown` says the Worker
   *  asked for a longer one. Only `wait({once: true})` answers this. */
  | { kind: "pending"; interval: number; slowDown?: true }
  /** `license_choice=app` and a choice is due. No token was stored. */
  | {
      kind: "choose";
      grant: string;
      expiresIn: number;
      choices: Record<string, unknown>;
    }
  | {
      kind: "signedIn";
      /** The pairwise account subject (`ps_…`), or null when the product serves none. */
      subject: string | null;
      /** The granted scope (redirect only). */
      scope?: string;
      /** The activation the sign-in produced: the device now holds the identity's token. */
      activation: { licenseId: string | null };
      /** Who signed in, when the server named them (device code). */
      identity?: { name?: string; email?: string };
    }
  | { kind: "cancelled" }
  | { kind: "expired" };

/** A device-code sign-in in progress. The poll credential never leaves the adapter. */
export interface DeviceCodeSignInSession {
  readonly channel: "device-code";
  /** What the person types on the verification page, e.g. `WDJB-MJHT`. */
  readonly userCode: string;
  /** The page to open and type the code into. */
  readonly verificationUri: string;
  /** The same page with the code pre-filled: the QR payload and the "Open" link. */
  readonly verificationUriComplete: string;
  /** Seconds the code lives for. */
  readonly expiresIn: number;
  /** The minimum seconds between polls; a `slow_down` lengthens it. */
  readonly interval: number;
  /** When the code expires on this client's clock (epoch seconds). */
  readonly expiresAt: number;
  /** The label the sign-in page shows, or null. */
  readonly deviceName: string | null;
  /** Open `verificationUriComplete` in a new tab; false when no opener ran. */
  reopen(): Promise<boolean>;
  /** Stop. A running `wait` answers `cancelled`. */
  cancel(): void;
  /** Poll until the sign-in settles (`signedIn | expired | cancelled`). `{once: true}` polls
   *  exactly once and may answer `pending`. Rejects with the signal's reason when it aborts. */
  wait(opts?: { signal?: AbortSignal; once?: boolean }): Promise<SignInOutcome>;
}

/** A redirect sign-in in progress. Single use: `complete` and `cancel` drop the PKCE verifier. */
export interface RedirectSignInSession {
  readonly channel: "redirect";
  /** Navigate to this. It carries the challenge and `state`, never the verifier. */
  readonly authorizeUrl: string;
  /** Forget the pending request. `complete` then refuses. */
  cancel(): void;
  /** Redeem the callback the browser was sent back to: `signedIn`, `choose` or `cancelled`. */
  complete(callbackUrl: string): Promise<SignInOutcome>;
}

export type SignInSession = DeviceCodeSignInSession | RedirectSignInSession;

/** `adapter.signIn` (`usePolarisAuth().signIn`). */
export interface SignInNamespace {
  start(opts: DeviceCodeSignInOptions): Promise<DeviceCodeSignInSession>;
  start(opts: RedirectSignInOptions): Promise<RedirectSignInSession>;
  /** After the navigation back: finish the redirect sign-in whose `state` the callback carries,
   *  from the verifier kept in `sessionStorage`. */
  complete(callbackUrl: string): Promise<SignInOutcome>;
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────

/** What a redirect sign-in reads off discovery's identity fragment. */
export interface RedirectEndpoints {
  authorizeEndpoint: string;
  tokenEndpoint: string;
  issuer: string;
  /** All four `choice*` endpoints are served. */
  choiceAvailable: boolean;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** The redirect endpoints and issuer from a discovery document, or `null` when the product
 *  serves no redirect sign-in. An endpoint is used only when discovery names it, never built. */
export function redirectEndpointsOf(
  discovery: Record<string, unknown> | null | undefined,
): RedirectEndpoints | null {
  const services = discovery?.services as
    | Record<string, Record<string, unknown> | undefined>
    | undefined;
  const identity = services?.identity;
  if (identity?.enabled !== true) return null;
  const endpoints = (identity.endpoints ?? {}) as Record<string, unknown>;
  const authorizeEndpoint = str(endpoints.authorize);
  const tokenEndpoint = str(endpoints.token);
  const issuer = str(identity.issuer);
  if (!authorizeEndpoint || !tokenEndpoint || !issuer) return null;
  return {
    authorizeEndpoint,
    tokenEndpoint,
    issuer,
    choiceAvailable: [
      "choiceLicenses",
      "choiceDevices",
      "choiceComplete",
      "choiceCancel",
    ].every((k) => str(endpoints[k]) !== undefined),
  };
}

// ── The stash: a pending redirect across the navigation ───────────────────────────────────────

/** What waits in `sessionStorage` between the navigation and the callback. The verifier is a
 *  secret that never leaves this tab's session storage. */
export interface StashedRedirect extends RedirectPending {
  deviceName: string | null;
  /** Epoch seconds the sign-in started. */
  at: number;
}

/** Where a pending redirect waits. `take` reads AND removes: one use. */
export interface RedirectStash {
  save(p: StashedRedirect): void;
  take(state: string): StashedRedirect | null;
  drop(state: string): void;
}

/** A pending sign-in older than this is not resumed. */
export const REDIRECT_STASH_TTL_SECONDS = 3600;

const KEY_PREFIX = "pkey.signin.redirect:";

/** The stash over `sessionStorage`, keyed `<product>:<state>`; `null` where there is none (a
 *  redirect cannot survive its navigation without one). A stale entry is purged on each save. */
export function sessionStorageStash(
  product: string,
  now: () => number,
  storage: Storage | undefined = typeof sessionStorage === "undefined"
    ? undefined
    : sessionStorage,
): RedirectStash | null {
  if (!storage) return null;
  const prefix = `${KEY_PREFIX}${product}:`;
  const parse = (raw: string | null): StashedRedirect | null => {
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as Partial<StashedRedirect>;
      return typeof v.state === "string" &&
        typeof v.codeVerifier === "string" &&
        typeof v.redirectUri === "string" &&
        typeof v.clientId === "string" &&
        typeof v.issuer === "string" &&
        typeof v.tokenEndpoint === "string" &&
        typeof v.authorizeUrl === "string" &&
        typeof v.at === "number"
        ? (v as StashedRedirect)
        : null;
    } catch {
      return null;
    }
  };
  return {
    save(p) {
      for (let i = storage.length - 1; i >= 0; i -= 1) {
        const k = storage.key(i);
        if (k?.startsWith(prefix) !== true) continue;
        const old = parse(storage.getItem(k));
        if (old === null || now() - old.at > REDIRECT_STASH_TTL_SECONDS)
          storage.removeItem(k);
      }
      storage.setItem(`${prefix}${p.state}`, JSON.stringify(p));
    },
    take(state) {
      const key = `${prefix}${state}`;
      const p = parse(storage.getItem(key));
      storage.removeItem(key);
      return p !== null && now() - p.at <= REDIRECT_STASH_TTL_SECONDS
        ? p
        : null;
    },
    drop(state) {
      storage.removeItem(`${prefix}${state}`);
    },
  };
}

/** The `state` a callback URL carries, or null. */
export function callbackState(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).searchParams.get("state");
  } catch {
    return null;
  }
}

/** Open a link in a new tab. Only an https link (or loopback http) opens; true when it did. */
export function openUrl(url: string): Promise<boolean> {
  if (!isSecureTransportUrl(url)) return Promise.resolve(false);
  if (typeof window === "undefined" || typeof window.open !== "function")
    return Promise.resolve(false);
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve(true);
}
