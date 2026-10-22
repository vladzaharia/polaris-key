/**
 * The step-up sign-in: a gated write the Worker refused for a stale step-up sends the operator to
 * the console's sign-in and back to this page. Lives in `lib/` (no `api.ts` import) so the
 * shared ConfirmDialog can start it without reaching the console's API client.
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
