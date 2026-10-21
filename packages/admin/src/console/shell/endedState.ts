/**
 * "Your session ended", in place (SIGN-IN.md §3.12). When the console API answers 401 with
 * `X-PKey-Session: expired` while a page is open, the page is NOT left: the overlay
 * (`SessionEnded.tsx`) covers it, whatever the person had typed stays in the DOM, and signing in
 * again happens in a second tab that tells this one when it is done.
 *
 * One module-level flag with subscribers, because the 401 is seen by `api.ts`, which knows no tree.
 *
 * The request that met the 401 is HELD, not failed: `api.ts` waits here, and when the session is
 * back it sends the same request again with the fresh CSRF token (the 401 means the server refused
 * it before doing anything, so replaying it cannot double an effect). The page that asked never
 * sees an error, so it keeps its form state and its place. If the person chooses "Not now", the
 * held requests fail with the 401 as they would have, and the page shows what it shows for that.
 */
import * as React from "react";

/** The channel the sign-in tab uses to tell the page it came from that the session is back. */
export const SESSION_CHANNEL = "pkey-console-session";
/** Where the second tab lands after sign-in: the console's "signed in again" card. */
export const SIGNED_IN_HASH = "#/signed-in";

let ended = false;
const listeners = new Set<() => void>();
const waiters = new Set<(back: boolean) => void>();
const emit = (): void => listeners.forEach((l) => l());

/** The session ended under an open page. */
export function markSessionEnded(): void {
  if (ended) return;
  ended = true;
  emit();
}

/**
 * The overlay is over: `back` when a `/me` read succeeded again (held requests are sent again),
 * `dismissed` when the person chose "Not now" (held requests fail with their 401).
 */
export function clearSessionEnded(
  outcome: "back" | "dismissed" = "back",
): void {
  if (!ended) return;
  ended = false;
  const held = [...waiters];
  waiters.clear();
  emit();
  for (const release of held) release(outcome === "back");
}

/** Held until the overlay is over: `true` when the session is back, `false` when dismissed. */
export function waitForSessionBack(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ended) return resolve(true);
    waiters.add(resolve);
  });
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
