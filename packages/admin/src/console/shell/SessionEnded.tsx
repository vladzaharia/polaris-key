/**
 * The session-ended overlay and the card its second tab lands on (SIGN-IN.md §3.12, frame 14).
 *
 * The overlay is the console's modal `Dialog` (focus trap, inert page, Escape, focus returned to
 * where it was), not a navigation, so a form half-filled when the session ended is still there when
 * the person comes back. "Sign in again" opens the Worker's sign-in card in a second tab (a link,
 * so a popup blocker cannot stop it); that tab ends on `SignedInAgain`, which tells this one.
 * "Not now" (and Escape) leaves the page as it is, to copy something out; the next request that
 * fails brings the overlay back.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../ui/Button.js";
import { Dialog, DialogFooter } from "../../ui/Dialog.js";
import { AuthCard, AuthTitle } from "../../ui/auth/index.js";
import { ConsoleBrand } from "./ConsoleSignIn.js";
import { qk } from "../data/queries.js";
import {
  SESSION_CHANNEL,
  clearSessionEnded,
  signInAgainHref,
  useSessionEnded,
} from "./endedState.js";

export function SessionEnded(): React.ReactElement | null {
  const ended = useSessionEnded();
  const qc = useQueryClient();
  const [opened, setOpened] = React.useState(false);

  // The sign-in tab says it is done: read the session again (which re-arms the CSRF token) and
  // retry what failed. A query that is fine is left alone, so no form is rebuilt under the person.
  React.useEffect(() => {
    if (!ended || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = () => {
      void qc.refetchQueries({ queryKey: qk.me() }).then(() =>
        qc.invalidateQueries({
          predicate: (q) => q.state.status === "error",
        }),
      );
    };
    return () => channel.close();
  }, [ended, qc]);

  // Coming back to the tab without the message (a browser that blocks the channel): ask.
  React.useEffect(() => {
    if (!ended) return;
    const probe = (): void => {
      if (document.visibilityState === "visible")
        void qc.refetchQueries({ queryKey: qk.me() });
    };
    document.addEventListener("visibilitychange", probe);
    return () => document.removeEventListener("visibilitychange", probe);
  }, [ended, qc]);

  React.useEffect(() => {
    if (!ended) setOpened(false);
  }, [ended]);

  return (
    <Dialog
      open={ended}
      onOpenChange={(open) => {
        if (!open) clearSessionEnded();
      }}
      size="sm"
      role="alertdialog"
      title="Your session ended"
      description="Sign in again to carry on. Changes you haven’t saved stay on this page."
    >
      <div
        aria-live="polite"
        className="px-6 text-sm text-fg-muted empty:hidden"
      >
        {opened
          ? "Sign in in the new tab. This page carries on when you’re done."
          : ""}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={clearSessionEnded}>
          Not now
        </Button>
        <Button asChild variant="neutral">
          <a
            href={signInAgainHref()}
            target="_blank"
            rel="noopener"
            onClick={() => setOpened(true)}
          >
            Sign in again
          </a>
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Where the sign-in tab lands (`#/signed-in`): it tells the page it came from, then offers to
 * close or to carry on here. A tab the browser lets a script close closes itself.
 */
export function SignedInAgain(): React.ReactElement {
  React.useEffect(() => {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SESSION_CHANNEL);
      channel.postMessage("signed-in");
      channel.close();
    }
    window.close();
  }, []);
  return (
    <AuthCard brand={<ConsoleBrand />} stepKey="signed-in" focusKey={1}>
      <AuthTitle>You’re signed in again</AuthTitle>
      <p className="text-sm text-fg-muted">
        Close this tab to go back to your page. Your changes are still there.
      </p>
      <Button
        asChild
        variant="outline"
        size="lg"
        className="h-auto min-h-12 w-full py-2 text-base font-semibold"
      >
        <a href="/manage/">Open the console here</a>
      </Button>
    </AuthCard>
  );
}
