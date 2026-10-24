/**
 * The console's transport: the CSRF token, the 401 sign-in, and the one HTTP client
 * every `console/api/*` module calls through. Importable only by `api.ts` and its siblings.
 */
import { markSessionEnded, waitForSessionBack } from "../shell/endedState.js";
import { createHttpClient, HttpError } from "../../lib/http.js";
import { startStepUp } from "../../lib/stepUp.js";

export { HttpError };

// ── transport ─────────────────────────────────────────────────────────────────
const CSRF_HEADER = "X-PKey-CSRF";

let csrf = "";
export function setCsrf(token: string): void {
  csrf = token;
}
/**
 * The 401 sign-in. The Worker marks a session that existed and no longer holds
 * (`X-PKey-Session: expired`). With a page open (the session loaded in this tab) the page is NOT
 * left: the "Your session ended" overlay covers it (`console/shell/endedState.ts`) and unsaved
 * input survives. Before the session ever loaded in this tab (a bookmark opened after the session
 * lapsed) there is nothing to keep, and the card says "Your session ended" and brings the person
 * back. Without the marker (a first visit) it is the plain sign-in card. `returnTo` brings the
 * person back to the page either way.
 */
function loginHref(expired: boolean): string {
  const back = `/manage/${window.location.hash}`;
  return `/manage/login?${expired ? "ended=1&" : ""}returnTo=${encodeURIComponent(back)}`;
}
let redirectToLogin = (expired = false): void => {
  window.location.href = loginHref(expired);
};
/** Override the 401 redirect (tests pass a spy; call with no arg to restore the default). */
export function setLoginRedirectForTests(
  fn?: (expired?: boolean) => void,
): void {
  redirectToLogin =
    fn ??
    ((expired = false) => {
      window.location.href = loginHref(expired);
    });
}

export interface ConsoleOptions {
  stepUpRedirect?: boolean;
  hold?: boolean;
}

const http = createHttpClient<ConsoleOptions>({
  csrfHeader: CSRF_HEADER,
  csrf: () => csrf,
  // The 401 sign-in. A page that had a session stays where it is under the overlay (`csrf` is set
  // once `/me` loaded), and the request waits for the sign-in and goes again, once. `/me` itself
  // is the probe that learns the session is back, so it never waits on itself (`hold: false`).
  onUnauthorized: async (res, retry, opts) => {
    const expired = res.headers.get("X-PKey-Session") === "expired";
    if (expired && csrf !== "") {
      markSessionEnded();
      if (opts.hold !== false && (await waitForSessionBack())) {
        try {
          return await retry();
        } catch (e) {
          // Refused again after the sign-in: the session is gone once more.
          if (e instanceof HttpError && e.status === 401) markSessionEnded();
          throw e;
        }
      }
    } else {
      redirectToLogin(expired);
    }
  },
  onRefusal: (error, opts) => {
    if (
      error.status === 403 &&
      error.code === "step_up_required" &&
      opts.stepUpRedirect
    )
      startStepUp();
  },
});

export const call = http.call;

export const enc = encodeURIComponent;
/** Build a per-product API base. */
export const p = (slug: string): string => `/manage/api/products/${enc(slug)}`;
