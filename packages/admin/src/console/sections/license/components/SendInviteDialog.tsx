/**
 * LX-27c.5: **Resend invitation** (S-24 §8.8, plans/LX-27-slices.md L7): emails the sign-in link
 * again to a waiting license's address. Mints nothing, so there is no key to show and nothing to
 * keep; a failed send says why. One mail per license per 10 minutes, shared with Send a new key
 * (the wait shows, and Send waits with it). The refusal wording is in `inviteCopy.ts`.
 */

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HttpError } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { toast } from "../../../../ui/toast.js";
import {
  canRetryInvite,
  inviteFailureCopy,
  inviteRefusal,
} from "./inviteCopy.js";

const minutesText = (seconds: number): string =>
  `${Math.max(1, Math.ceil(seconds / 60))} min`;

export function SendInviteDialog({
  slug,
  licenseId,
  email,
  open,
  onOpenChange,
  context,
  first = false,
}: {
  slug: string;
  licenseId: string;
  email: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: "assigned";
  /** No invitation has gone out yet: it says Send, not Resend. */
  first?: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [failed, setFailed] = React.useState<{
    reason?: Parameters<typeof inviteFailureCopy>[0];
  } | null>(null);
  const [until, setUntil] = React.useState(0);
  const [clock, setClock] = React.useState(Date.now());

  React.useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
      setFailed(null);
      setUntil(0);
    }
  }, [open]);
  React.useEffect(() => {
    if (!open || until <= Date.now()) return;
    const t = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [open, until]);

  const waitSeconds = Math.max(0, Math.ceil((until - clock) / 1000));
  // When the wait ends the refusal goes with it: Send is live again and nothing says to wait.
  React.useEffect(() => {
    if (!open || until <= Date.now()) return;
    const t = setTimeout(
      () => {
        setError(null);
        setUntil(0);
      },
      until - Date.now() + 50,
    );
    return () => clearTimeout(t);
  }, [open, until]);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      const res = await mutate("sendLicenseInvite", slug, licenseId, context);
      if (res.delivered.invite === "sent") {
        toast.success(`Invitation sent to ${email}.`);
        onOpenChange(false);
      } else {
        // A failed send frees the window on the Worker, so Try again is open at once.
        setFailed({ reason: res.delivered.reason });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        setUntil(Date.now() + (err.retryAfter ?? 600) * 1000);
        setClock(Date.now());
      }
      // They already have it: the record still says Waiting until it is read again.
      if (err instanceof HttpError && err.reason === "in_account")
        void queryClient.invalidateQueries({
          queryKey: qk.license(slug, licenseId),
        });
      setError(err);
    } finally {
      setBusy(false);
      // Keep the operator on the button they pressed.
      window.setTimeout(
        () => document.getElementById("send-invite-submit")?.focus(),
        0,
      );
    }
  };

  const refusal = error
    ? inviteRefusal(error, email, waitSeconds || 600)
    : null;
  const done = refusal?.kind === "in_account";
  return (
    <Dialog
      open={open}
      title={first ? "Send invitation" : "Resend invitation"}
      description={`Emails ${email} a link to sign in. No key is sent.`}
      dismissible={!busy}
      onOpenChange={onOpenChange}
    >
      <form
        noValidate
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <DialogBody className="space-y-4">
          {failed ? (
            <Callout tone="warning" title="The invitation wasn't sent" live>
              {inviteFailureCopy(failed.reason, email)}
            </Callout>
          ) : null}
          {refusal ? (
            <Callout tone={refusal.tone} title={refusal.title} live>
              {refusal.description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                id="send-invite-submit"
                type="submit"
                loading={busy}
                disabledReason={
                  refusal?.permanent
                    ? refusal.description
                    : waitSeconds > 0
                      ? `Try again in ${minutesText(waitSeconds)}`
                      : failed && !canRetryInvite(failed.reason)
                        ? inviteFailureCopy(failed.reason, email)
                        : undefined
                }
              >
                {failed ? "Try again" : "Send invitation"}
              </Button>
            </>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
