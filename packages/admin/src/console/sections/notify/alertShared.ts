/** Copy and checks the alert destinations UI shares (ST-27). */

import {
  HttpError,
  type AlertDestination,
  type AlertDestinationsView,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";

export const LABEL_MAX = 64;

export type KindInfo = AlertDestinationsView["kinds"][number];
export type Field = "target" | "label" | "alerts";

/** What the Worker's refusal reasons say, and which field they belong under. */
export const REASONS: Record<string, { text: string; field?: Field }> = {
  url_not_https: {
    text: "A webhook URL must start with https://.",
    field: "target",
  },
  url_refused: {
    text: "That URL cannot be used. It must be a public address: no IP address, port or private name.",
    field: "target",
  },
  target_invalid: { text: "Enter a valid email address.", field: "target" },
  alerts_required: { text: "Pick at least one alert.", field: "alerts" },
  alert_unknown: { text: "Pick from the alerts listed.", field: "alerts" },
  label_invalid: {
    text: `The label is up to ${LABEL_MAX} characters.`,
    field: "label",
  },
  too_many: { text: "That is the most destinations. Remove one first." },
  too_many_tests: { text: "Too many test alerts. Try again later." },
  test_unavailable: {
    text: "A product's email address cannot be tested until it is confirmed.",
  },
  stale: { text: "Changed elsewhere. Reload and try again." },
};

export function failureText(err: unknown): string {
  const reason = err instanceof HttpError ? err.reason : undefined;
  return (reason && REASONS[reason]?.text) || errorCopy(err).title;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The client's pre-check of a target, in the Worker's words; `null` when it looks fine. */
export function targetProblem(
  kind: "email" | "webhook",
  raw: string,
): string | null {
  const v = raw.trim();
  if (v === "")
    return kind === "email"
      ? "Enter an email address."
      : "Enter a webhook URL.";
  if (kind === "email")
    return EMAIL_SHAPE.test(v) ? null : REASONS.target_invalid!.text;
  return /^https:\/\//i.test(v) ? null : REASONS.url_not_https!.text;
}

export const nameOf = (d: AlertDestination): string => d.label ?? d.target;

export const isStepUp = (e: unknown): boolean =>
  e instanceof HttpError && e.code === "step_up_required";

/** A wait in words: seconds up to 90, then minutes ("28 s", "57 min"). */
export function formatWait(seconds: number): string {
  const n = Math.max(1, Math.ceil(seconds));
  return n <= 90 ? `${n} s` : `${Math.ceil(n / 60)} min`;
}

/** Seconds left until `at` (ms since the epoch); 0 once it has passed. */
export const secondsUntil = (at: number): number =>
  Math.max(0, Math.ceil((at - Date.now()) / 1000));

/** Split after "@" and "." so a phone breaks an address at a word boundary, not mid-word. */
export function breakPoints(text: string): string[] {
  return text.split(/(?<=[@.])/);
}
