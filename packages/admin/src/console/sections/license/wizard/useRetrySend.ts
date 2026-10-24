/**
 * New license: Done's **Try again** for a send that did not go out: a new key through `send-key`,
 * or the invitation again through `send-invite` (nothing minted, the key on screen untouched).
 * It owns the busy flag, the refusal and the 10-minute wait; the result is the wizard's.
 */

import * as React from "react";
import { HttpError } from "../../../../api.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { inviteRefusal } from "../components/inviteCopy.js";
import { sendKeyRefusal } from "../components/SendKeyDialog.js";
import type { Result } from "./DoneStep.js";
import { focusHeading } from "./helpers.js";

export function useRetrySend({
  slug,
  result,
  setResult,
  setKept,
}: {
  slug: string;
  result: Result | null;
  setResult: (r: Result) => void;
  setKept: (kept: boolean) => void;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<unknown>(null);
  const [retryUntil, setRetryUntil] = React.useState(0);

  const [makingKey, setMakingKey] = React.useState(false);
  /** An invitation that did not go out left no key: make one, shown once like any other. */
  const makeKey = async (): Promise<void> => {
    if (result?.kind !== "single") return;
    setMakingKey(true);
    try {
      const res = await mutate(
        "mintKey",
        slug,
        result.id,
        "Created with the license",
      );
      setResult({ ...result, key: res.key, showKey: true, onlyCopy: true });
      setKept(false);
      announce("Key created. Copy it now.");
    } catch {
      toast.warning("The key wasn't created. Try again.");
    } finally {
      setMakingKey(false);
    }
  };

  const tryAgain = async (): Promise<void> => {
    if (result?.kind !== "single" || !result.email) return;
    setRetrying(true);
    setRetryError(null);
    try {
      if (result.invite) {
        // An invitation again: nothing is minted and the key on screen is untouched.
        const res = await mutate("sendLicenseInvite", slug, result.id);
        const sent = res.delivered.invite === "sent";
        setResult({
          ...result,
          invite: {
            outcome: res.delivered.invite,
            ...(res.delivered.reason ? { reason: res.delivered.reason } : {}),
          },
        });
        if (sent) announce(`Invitation sent to ${result.email}.`);
        focusHeading();
        return;
      }
      // A retry never revokes: the key on screen may already be copied.
      const res = await mutate("sendLicenseKey", slug, result.id, false);
      if (!res.key) return;
      if (res.delivered.email === "sent") {
        setResult({
          ...result,
          onlyCopy: false,
          retried: true,
          delivered: { email: "sent" },
        });
        announce(`License created. Key sent to ${result.email}.`);
        focusHeading();
      } else {
        setResult({
          ...result,
          key: res.key,
          showKey: true,
          onlyCopy: true,
          delivered: res.delivered,
        });
        setKept(false);
        focusHeading();
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429)
        setRetryUntil(Date.now() + (err.retryAfter ?? 600) * 1000);
      setRetryError(err);
    } finally {
      setRetrying(false);
    }
  };
  const retryWait = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
  const single = retryError && result?.kind === "single" ? result : null;
  const refusal =
    single && !single.invite
      ? sendKeyRefusal(retryError, single.email ?? "", retryWait || 600)
      : null;
  const inviteNote = single?.invite
    ? inviteRefusal(retryError, single.email ?? "", retryWait || 600)
    : null;
  return {
    retrying,
    retryWait,
    refusal,
    inviteNote,
    tryAgain,
    makeKey,
    makingKey,
    clearRetryError: () => setRetryError(null),
  };
}
