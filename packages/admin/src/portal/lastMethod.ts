/**
 * "You usually sign in with ..." (SIGN-IN.md §3.4 HintStep; THREAT-MODEL, the returning-person
 * hint): a first-party cookie holds only the method's kind and a salted hash of the address, so it
 * names no one and a stolen copy proves nothing. The hint is never read from a server lookup (a
 * lookup would say which addresses have accounts): the card only compares the typed address's
 * hash with the one this browser wrote itself after a sign-in. The salt and the first name for
 * "Welcome back" stay in this browser's storage and are never sent. Polaris Locker and the console
 * each make one store from `createLastMethodStore` with their own names; the cookie's shape and the
 * hash are the same, and the console card's inline script computes the same hash
 * (`worker/src/console/signinScript.ts`; one shared test vector pins them).
 */
import { createLastMethodStore, type LastKind } from "../lib/lastMethod.js";

export type { LastMethod } from "../lib/lastMethod.js";

export const { hashAddress, rememberVia, commitLastMethod, readLastMethod } =
  createLastMethodStore<LastKind>({
    kinds: ["email", "passkey", "apple", "google", "steam"],
    cookie: "pk_last_method",
    via: "pk-signin-via",
    salt: "pk-hint-salt",
    name: "pk-hint-name:",
    cookieAttrs: "Path=/; Max-Age=31536000; SameSite=Lax; Secure",
  });

const NUDGE = "pk-signin-nudge";
/** A nudge the sign-in left before the account was known goes stale after this long. */
const NUDGE_CLAIM_MS = 10 * 60 * 1000;

/**
 * The Worker's `nudge: true` ("add another way to sign in", after a first sign-in). It is kept in
 * localStorage, not sessionStorage: a magic link opens the portal in a new tab, which has no
 * sessionStorage of the tab that asked. The sign-in does not know the account yet, so it leaves a
 * timestamp; the first signed-in page claims it for the account (`claimNudge`), and from then on it
 * is the account's own (`nudge:<id>`) until the person dismisses it.
 */
export function rememberNudge(): void {
  try {
    window.localStorage.setItem(NUDGE, String(Date.now()));
  } catch {
    // Storage off: the nudge waits for the next sign-in the Worker offers it on.
  }
}

/** Whether the nudge is waiting for this account; claims a fresh sign-in's flag first. */
export function nudgePending(accountId: string): boolean {
  try {
    const own = `${NUDGE}:${accountId}`;
    const left = Number(window.localStorage.getItem(NUDGE));
    if (left) {
      window.localStorage.removeItem(NUDGE);
      if (Date.now() - left < NUDGE_CLAIM_MS)
        window.localStorage.setItem(own, "1");
    }
    return window.localStorage.getItem(own) === "1";
  } catch {
    return false;
  }
}

/** The person answered it (dismissed it, or went to add a method). */
export function clearNudge(accountId: string): void {
  try {
    window.localStorage.removeItem(`${NUDGE}:${accountId}`);
  } catch {
    // Nothing to clear.
  }
}
