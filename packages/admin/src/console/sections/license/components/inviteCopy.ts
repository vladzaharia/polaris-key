/**
 * LX-27c: the words for an invitation that did not go out, and for a refused send-invite. Pure.
 * The key's counterparts are in `SendKeyDialog.tsx`; an invitation carries no key, so nothing here
 * tells the operator to copy one.
 */

import { ApiError, type KeyEmailFailure } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";

/** One line for why the invitation did not go out. */
export function inviteFailureCopy(
  reason: KeyEmailFailure | undefined,
  email: string,
): string {
  if (reason === "no_mail_binding")
    return "Email isn't set up on this Polaris Key server.";
  if (reason === "address_unusable")
    return `${email} isn't an address we can email.`;
  if (reason === "suppressed") return `${email} can't receive email from us.`;
  if (reason === "daily_cap")
    return "This product has reached today's email limit.";
  return "The email provider didn't accept it.";
}

/** Whether another try could help: only a provider hiccup can clear on its own. */
export const canRetryInvite = (reason?: KeyEmailFailure): boolean =>
  reason === undefined || reason === "provider_refused";

const minutesText = (seconds: number): string =>
  `${Math.max(1, Math.ceil(seconds / 60))} min`;

export interface InviteRefusal {
  title: string;
  description: string;
  tone: "danger" | "warning" | "success";
  /** A 409 that no retry changes. */
  permanent: boolean;
  /** `wait`: the 10-minute window; `in_account`: they already have it (good news, not an error). */
  kind: "wait" | "in_account" | "other";
}

/** What a refused send-invite says: each 409 reason, the 429 with its wait, else errorCopy's. */
export function inviteRefusal(
  error: unknown,
  email: string,
  waitSeconds: number,
): InviteRefusal {
  const base = { tone: "danger", title: "No invitation was sent" } as const;
  if (error instanceof ApiError && error.status === 409) {
    const say = (description: string, permanent = false): InviteRefusal => ({
      ...base,
      permanent,
      description,
      kind: "other",
    });
    switch (error.reason) {
      case "in_account":
        return {
          tone: "success",
          title: "Already in their account",
          description: `${email} already has it in their account. Nothing to send.`,
          permanent: true,
          kind: "in_account",
        };
      case "identity_off":
        return say("Turn on Sign-in for this product to invite people.", true);
      case "auto_link_off":
        return say(
          "This product's sign-in doesn't add licenses by email, so an invitation couldn't reach it.",
          true,
        );
      case "license_not_active":
        return say("Enable the license first, then invite them.");
      case "license_expired":
        return say("This license has expired. Extend it first.");
      case "no_mail_binding":
      case "address_unusable":
      case "suppressed":
      case "daily_cap":
        return say(inviteFailureCopy(error.reason, email), true);
    }
  }
  if (error instanceof ApiError && error.status === 429)
    return {
      tone: "warning",
      permanent: false,
      kind: "wait",
      title: "Sent a moment ago",
      description: `You can send another in ${minutesText(waitSeconds)}.`,
    };
  const copy = errorCopy(error, { thing: "License" });
  return {
    tone: "danger",
    permanent: false,
    kind: "other",
    title: copy.title,
    description: copy.description,
  };
}
