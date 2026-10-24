/**
 * LX-27 (S-24 §8.4, D12): **Send a new key…**, its refusal wording and the one-time result.
 * Split from the Keys tab to stay under the page budget.
 */

import * as React from "react";
import { HttpError, type KeyEmailFailure } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { OneTimeSecretPanel } from "../../../../ui/OneTimeSecretPanel.js";
import { toast } from "../../../../ui/toast.js";

/** What a send-key left behind when the email did not go out: the key (valid) and why. */
export interface UnsentKey {
  key: string;
  reason?: KeyEmailFailure;
}

/** Whether another try could help: only a provider hiccup can clear on its own. */
export const canRetryKeyEmail = (reason?: KeyEmailFailure): boolean =>
  reason === undefined || reason === "provider_refused";

/** One line for why the email did not go out, in the operator's terms. */
export function keyEmailFailureCopy(
  reason: KeyEmailFailure | undefined,
  email: string,
): string {
  if (reason === "no_mail_binding")
    return "Email isn't set up on this Polaris Key server. Copy the key and send it yourself.";
  if (reason === "address_unusable")
    return `${email} isn't an address we can email. Copy the key and send it yourself.`;
  if (reason === "suppressed")
    return `${email} can't receive email from us. Copy the key and send it yourself.`;
  if (reason === "daily_cap")
    return "This product has reached today's email limit. Copy the key and send it yourself.";
  return "The email provider didn't accept it. Copy the key and send it yourself, or try again.";
}

const minutesText = (seconds: number): string => {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} min`;
};

/** A refused send-key (no key minted), worded for the callout and the Assign toast. */
export interface SendKeyRefusal {
  title: string;
  description: string;
  tone: "danger" | "warning";
  /** True when the Worker minted no key (a 409 or 429), so "No key was made" is known. */
  noKey: boolean;
  /** A 409 that no retry changes: Send key stays off and Mint key is offered. */
  permanent: boolean;
  details?: Record<string, unknown>;
}

const PERMANENT_REASONS = [
  "no_mail_binding",
  "address_unusable",
  "suppressed",
  "daily_cap",
];

/**
 * What a refused send-key says: the 409 reasons, the 429 with its wait, else errorCopy's own
 * title and description. Only a 409 or 429 knows no key was made.
 */
export function sendKeyRefusal(
  error: unknown,
  email: string,
  waitSeconds: number,
): SendKeyRefusal {
  if (error instanceof HttpError && error.status === 409) {
    const base = {
      tone: "danger",
      noKey: true,
      title: "No key was made",
    } as const;
    if (error.reason === "license_not_active")
      return {
        ...base,
        permanent: false,
        description: "Enable the license first, then send a key.",
      };
    if (error.reason === "license_expired")
      return {
        ...base,
        permanent: false,
        description:
          "This license has expired. Extend it first, then send a key.",
      };
    if (error.reason && PERMANENT_REASONS.includes(error.reason))
      return {
        ...base,
        permanent: true,
        description: keyEmailFailureCopy(
          error.reason as KeyEmailFailure,
          email,
        ).replace(
          "Copy the key and send it yourself.",
          "Mint a key and send it yourself.",
        ),
      };
  }
  if (error instanceof HttpError && error.status === 429)
    return {
      tone: "warning",
      noKey: true,
      permanent: false,
      title: "Sent a moment ago",
      description: `You can send another in ${minutesText(waitSeconds)}.`,
    };
  const copy = errorCopy(error, { thing: "License" });
  return {
    tone: "danger",
    noKey: false,
    permanent: false,
    title: copy.title,
    description: copy.description,
    ...(copy.action === "copy-details" ? { details: copy.details } : {}),
  };
}

/**
 * **Send a new key…** (LX-27; notes/S-24 §8.4, D12): mints a key labelled "Sent by email" and
 * mails it to the license's address; the old keys keep working unless **Also revoke its other
 * keys** is ticked. One send per license per 10 minutes (the wait shows, and Send waits with it).
 * When the email does not go out the new key is already valid, so it is shown once here (closing
 * early asks first), with the reason; **Try again** (only when a retry can help, and only after
 * "I've stored it") emails another new key and leaves this one working. `initial` opens straight
 * on that result, for the Assign… dialog's failed send.
 */
export function SendKeyDialog({
  slug,
  licenseId,
  email,
  open,
  onOpenChange,
  initial = null,
  context,
  onMint,
}: {
  slug: string;
  licenseId: string;
  email: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: UnsentKey | null;
  context?: "assigned";
  /** Opens the Mint key dialog (the refusal's way out when mail cannot work). */
  onMint?: () => void;
}): React.ReactElement {
  const [revokeOthers, setRevokeOthers] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [unsent, setUnsent] = React.useState<UnsentKey | null>(null);
  const [ack, setAck] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [until, setUntil] = React.useState(0);
  const [clock, setClock] = React.useState(Date.now());
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    if (open) {
      setRevokeOthers(false);
      setBusy(false);
      setError(null);
      setUnsent(initial);
      setAck(false);
      setAsking(false);
      setUntil(0);
    }
  }, [open, initial]);
  React.useEffect(() => {
    if (!open || until <= Date.now()) return;
    const t = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [open, until]);

  const waitSeconds = Math.max(0, Math.ceil((until - clock) / 1000));

  const send = async (retry: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // A retry never revokes: the key on screen may already be copied.
      const res = await mutate(
        "sendLicenseKey",
        slug,
        licenseId,
        retry ? false : revokeOthers,
        context,
      );
      if (res.delivered.email === "sent") {
        toast.success(
          `Key sent to ${email}.` +
            (res.revoked > 0
              ? ` ${res.revoked} other key${res.revoked === 1 ? "" : "s"} revoked.`
              : ""),
        );
        onOpenChange(false);
      } else {
        setUnsent({ key: res.key, reason: res.delivered.reason });
        setAck(false);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        const wait = err.retryAfter ?? 600;
        setUntil(Date.now() + wait * 1000);
        setClock(Date.now());
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const refusal = error
    ? sendKeyRefusal(error, email, waitSeconds || 600)
    : null;
  const errorCallout = refusal ? (
    <Callout
      tone={refusal.tone}
      title={refusal.title}
      live
      action={
        refusal.permanent && onMint ? (
          <Button variant="outline" size="sm" onClick={onMint}>
            Mint key…
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col items-start gap-2">
        <span>{refusal.description}</span>
        {refusal.details ? (
          <CopyButton
            value={JSON.stringify(refusal.details, null, 2)}
            label="Copy details"
            showLabel
          />
        ) : null}
      </div>
    </Callout>
  ) : null;

  const guardedClose = (next: boolean): void => {
    if (next) return onOpenChange(true);
    if (unsent && !ack) return setAsking(true);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      title={unsent ? "Key not emailed" : "Send a new key"}
      description={
        unsent ? "The new key works." : `Emails a new key to ${email}.`
      }
      dismissible={!busy}
      titleRef={titleRef}
      initialFocusRef={titleRef}
      onOpenChange={guardedClose}
    >
      {unsent ? (
        <OneTimeSecretPanel
          label="License key"
          value={unsent.key}
          acknowledged={ack}
          onAcknowledgedChange={(v) => {
            setAck(v);
            if (v) setAsking(false);
          }}
          closeRequested={asking}
          onCancelClose={() => setAsking(false)}
          onConfirmClose={() => {
            setAsking(false);
            onOpenChange(false);
          }}
          onDone={() => onOpenChange(false)}
          details={
            <div className="space-y-3">
              <Callout tone="warning" live>
                {keyEmailFailureCopy(unsent.reason, email)}
              </Callout>
              {errorCallout}
              {canRetryKeyEmail(unsent.reason) ? (
                <p className="text-xs text-fg-muted">
                  Try again emails another new key. This one keeps working.
                </p>
              ) : null}
            </div>
          }
          actions={
            canRetryKeyEmail(unsent.reason) ? (
              <Button
                variant="outline"
                loading={busy}
                disabledReason={
                  !ack
                    ? "Tick “I've stored it” first"
                    : waitSeconds > 0
                      ? `Try again in ${minutesText(waitSeconds)}`
                      : undefined
                }
                onClick={() => void send(true)}
              >
                Try again
              </Button>
            ) : null
          }
        />
      ) : (
        <form
          noValidate
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
        >
          <DialogBody className="space-y-4">
            <Checkbox
              checked={revokeOthers}
              onCheckedChange={setRevokeOthers}
              label="Also revoke its other keys"
              description="Old keys can't activate more devices. Devices already activated keep working."
            />
            {errorCallout}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabledReason={
                refusal?.permanent
                  ? refusal.description
                  : waitSeconds > 0
                    ? `Try again in ${minutesText(waitSeconds)}`
                    : undefined
              }
            >
              Send key
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
