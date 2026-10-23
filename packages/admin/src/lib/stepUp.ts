/**
 * The step-up sign-in: a gated write the Worker refused for a stale step-up sends the operator to
 * the console's sign-in and back to this page. Lives in `lib/` (no `api.ts` import) so the
 * shared ConfirmDialog can start it without reaching the console's API client. It also holds the
 * saved dialog state a step-up sign-in leaves behind (`stashStepUp`, `readStash`), which a dialog reads
 * back when it reopens.
 */

const redirectDefault = (): void => {
  const back = `/manage/${window.location.hash}`;
  window.location.href = `/manage/login?stepUp=1&returnTo=${encodeURIComponent(back)}`;
};

let redirectToStepUp = redirectDefault;

/** Override the step-up redirect (tests pass a spy; call with no arg to restore the default). */
export function setStepUpRedirectForTests(fn?: () => void): void {
  redirectToStepUp = fn ?? redirectDefault;
}

/** Send the operator to the step-up sign-in, back to this page (a write that needs a fresh one). */
export function startStepUp(): void {
  redirectToStepUp();
}

const STEP_UP_TTL_MS = 15 * 60 * 1000;
const stepUpStorageKey = (key: string): string => `pkey:step-up:${key}`;

export interface Stash {
  typed: string;
  fields: Record<string, string>;
}

export function stashStepUp(
  key: string | undefined,
  typed: string,
  fields: Record<string, string> = {},
): void {
  if (!key) return;
  try {
    sessionStorage.setItem(
      stepUpStorageKey(key),
      JSON.stringify({
        typed,
        fields,
        page: window.location.hash,
        at: Date.now(),
      }),
    );
  } catch {
    // No storage: the word is typed again.
  }
}

export function readStash(
  key: string | undefined,
  remove: boolean,
): Stash | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(stepUpStorageKey(key));
    if (raw === null) return null;
    if (remove) sessionStorage.removeItem(stepUpStorageKey(key));
    const v = JSON.parse(raw) as {
      typed?: unknown;
      fields?: unknown;
      page?: unknown;
      at?: unknown;
    };
    if (
      typeof v.at !== "number" ||
      Date.now() - v.at >= STEP_UP_TTL_MS ||
      (typeof v.page === "string" && v.page !== window.location.hash)
    )
      return null;
    const fields: Record<string, string> = {};
    if (v.fields && typeof v.fields === "object")
      for (const [k, x] of Object.entries(v.fields))
        if (typeof x === "string") fields[k] = x;
    return { typed: typeof v.typed === "string" ? v.typed : "", fields };
  } catch {
    return null;
  }
}

/** Whether a step-up sign-in left a saved dialog for `key` on this page (it reopens). */
export function hasSavedStepUp(key: string): boolean {
  return readStash(key, false) !== null;
}
