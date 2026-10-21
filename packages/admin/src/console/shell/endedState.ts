/**
 * "Your session ended", in place (SIGN-IN.md §3.12). When the console API answers 401 with
 * `X-PKey-Session: expired` while a page is open, the page is NOT left: the overlay
 * (`SessionEnded.tsx`) covers it, whatever the person had typed stays in the DOM, and signing in
 * again happens in a second tab that tells this one when it is done.
 *
 * One module-level flag with subscribers, because the 401 is seen by `api.ts`, which knows no tree.
 */
import * as React from "react";

/** The channel the sign-in tab uses to tell the page it came from that the session is back. */
export const SESSION_CHANNEL = "pkey-console-session";
/** Where the second tab lands after sign-in: the console's "signed in again" card. */
export const SIGNED_IN_HASH = "#/signed-in";

let ended = false;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

/** The session ended under an open page. */
export function markSessionEnded(): void {
  if (ended) return;
  ended = true;
  emit();
}

/** The session is back (a `/me` read succeeded again), or the person chose to stay. */
export function clearSessionEnded(): void {
  if (!ended) return;
  ended = false;
  emit();
}

export function isSessionEnded(): boolean {
  return ended;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSessionEnded(): boolean {
  return React.useSyncExternalStore(subscribe, isSessionEnded, () => false);
}

/** The sign-in link for the second tab: the plain "session ended" card, back to the signed-in card. */
export function signInAgainHref(): string {
  return `/manage/login?ended=1&returnTo=${encodeURIComponent(`/manage/${SIGNED_IN_HASH}`)}`;
}
