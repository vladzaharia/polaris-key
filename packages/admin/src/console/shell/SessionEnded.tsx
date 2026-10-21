/**
 * The session-ended overlay and the card its second tab lands on (SIGN-IN.md §3.12, frame 14).
 *
 * The overlay is the console's modal `Dialog` (focus trap, inert page, Escape, focus returned to
 * where it was), not a navigation, so a form half-filled when the session ended is still there when
 * the person comes back. "Sign in again" opens the Worker's sign-in card in a second tab (a link,
 * so a popup blocker cannot stop it); that tab ends on `SignedInAgain`, which tells this one.
 * "Not now" (and Escape) leaves the page as it is, to copy something out: the requests that were
 * waiting fail as they would have, and the next one that meets the 401 brings the overlay back.
 * When the session comes back the waiting requests are sent again (`endedState.ts`).
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../ui/Button.js";
import { toast } from "../../ui/toast.js";
import { Dialog, DialogFooter } from "../../ui/Dialog.js";
import { AuthCard, AuthTitle } from "../../ui/auth/index.js";
import { ConsoleBrand } from "./ConsoleSignIn.js";
import { qk } from "../data/queries.js";
import {
  SESSION_CHANNEL,
  clearSessionEnded,
  onAccountChanged,
  signInAgainHref,
  useSessionEnded,
} from "./endedState.js";

export function SessionEnded(): React.ReactElement | null {
  const ended = useSessionEnded();
  const qc = useQueryClient();
  const [opened, setOpened] = React.useState(false);

  // A different person signed in: what was waiting was dropped. Say so, and load their data.
  React.useEffect(
    () =>
      onAccountChanged((name) => {
        toast.warning(
          `Signed in as ${name}. Your unsaved change was not sent.`,
        );
        void qc.invalidateQueries();
      }),
    [qc],
  );

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

  // The dialog gives focus back to where it was. When that element is gone (the page changed under
  // it while the request waited), the page heading takes it, never <body>.
  const wasEnded = React.useRef(false);
  React.useEffect(() => {
    if (wasEnded.current && !ended) {
      let frames = 0;
      // The dialog's own return runs first. If its target goes (a held request just failed and
      // the page is rebuilding), the heading takes focus instead; watched for about 0.6 s.
      const settle = (): void => {
        const active = document.activeElement;
        if (!active || active === document.body) {
          const h1 = document.querySelector<HTMLElement>("h1[data-page-title]");
          if (h1 && frames >= 2) return h1.focus({ preventScroll: true });
        }
        if (++frames < 40) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    }
    wasEnded.current = ended;
  }, [ended]);

  return (
    <Dialog
      open={ended}
      onOpenChange={(open) => {
        if (!open) clearSessionEnded("dismissed");
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
        <Button
          variant="outline"
          onClick={() => clearSessionEnded("dismissed")}
        >
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
