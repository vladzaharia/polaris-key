/**
 * The words of a failed Connections request (I-31): which party failed, and which field a
 * refusal is about. A refusal that names a field is shown on that field (and focused); only an
 * error with no field gets a callout.
 */

import { ApiError } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";

/** A pop-up the browser would not open, and one the operator closed before it came back. */
export class PopupBlockedError extends Error {}
export class PopupClosedError extends Error {}

export interface Failure {
  title: string;
  description?: string;
  /** The request fields the server refused. */
  fields: string[];
}

export function failureOf(e: unknown): Failure | null {
  if (!e) return null;
  if (e instanceof PopupBlockedError) {
    return {
      title: "Your browser blocked the sign-in window",
      description:
        "Allow pop-ups for this site and try again, or open it in this tab instead.",
      fields: [],
    };
  }
  if (e instanceof PopupClosedError) {
    return {
      title: "The sign-in window closed",
      description: "Try again.",
      fields: [],
    };
  }
  if (e instanceof ApiError) {
    const fields = e.fields ?? [];
    if (e.code === "discovery_unreachable") {
      return {
        title: "The provider didn't answer",
        description: e.message || "Check the issuer address and try again.",
        fields,
      };
    }
    if (e.code === "discovery_invalid") {
      return {
        title: "The provider's discovery document isn't usable",
        description: e.message,
        fields,
      };
    }
  }
  const c = errorCopy(e, { thing: "The connection" });
  return {
    title: c.title,
    description: e instanceof ApiError && e.message ? e.message : c.description,
    fields: e instanceof ApiError ? (e.fields ?? []) : [],
  };
}

/** The message for `field` when the failure is about it, else undefined. */
export function fieldMessage(
  f: Failure | null,
  field: string,
): string | undefined {
  return f && f.fields.includes(field) ? (f.description ?? f.title) : undefined;
}

/** Move focus to the input named `name` on the page (an error was just put on it). */
export function focusField(name: string): void {
  queueMicrotask(() =>
    window.setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(`#content [name="${name}"]`)
          ?.focus(),
      0,
    ),
  );
}
