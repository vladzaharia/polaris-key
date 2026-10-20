/**
 * "Sign in to your other account" (PX-15, the join's second proof). The login card normally shows
 * only while signed out, but the second proof is a sign-in made while signed in. The dialog leaves a
 * flag naming the session it started from (that session's CSRF token, which a new sign-in replaces)
 * and goes to `/signin`, which the Worker sends back to `#/account/link`. While the flag still
 * names the live session the portal shows the card in this mode; the first sign-in changes the
 * session, the flag no longer matches and the dialog opens with both accounts. Per tab on purpose:
 * a magic link opened elsewhere is a new tab, which comes back through the flag's absence to the
 * dialog (the flow itself lives on the server).
 */
const KEY = "pk-link-second";

export function beginSecondSignIn(sessionToken: string): void {
  try {
    window.sessionStorage.setItem(KEY, sessionToken);
  } catch {
    // Storage off: the card does not show; the dialog's button stays the way back in.
  }
}

export function secondSignInFrom(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function endSecondSignIn(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
