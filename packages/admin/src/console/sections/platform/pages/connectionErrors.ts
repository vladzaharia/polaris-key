/**
 * The words of a failed Connections request (I-31): which party failed, and which field a
 * refusal is about. A refusal that names a field is shown on that field (and focused); only an
 * error with no field gets a callout.
 */

import { HttpError } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";

/** A pop-up the browser would not open, and one the operator closed before it came back. */
export class PopupBlockedError extends Error {}
export class PopupClosedError extends Error {}

export interface Failure {
  title: string;
  description?: string;
  /** The request fields the server refused. */
  fields: string[];
  /** What happened, for a caller that offers a way on. */
  code?: string;
  /** A page that explains the next step. */
  link?: { label: string; href: string };
}

/** The server's own words, or nothing: `HttpError`'s default message is just "http 500". */
function serverWords(e: HttpError): string | undefined {
  return e.message && !/^http \d{3}$/.test(e.message) ? e.message : undefined;
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
      fields: [],
      code: "popup_closed",
    };
  }
  if (e instanceof HttpError && e.status !== 0) {
    const fields = e.fields ?? [];
    if (e.code === "exists") {
      return {
        title: "Already connected",
        description:
          serverWords(e) ?? "This issuer and client ID are already connected.",
        fields,
        code: "exists",
      };
    }
    if (e.code === "no_kek") {
      return {
        title: "Secrets can't be sealed yet",
        description:
          "The platform key is not set up, so a client secret cannot be stored.",
        fields,
        code: "no_kek",
        link: {
          label: "Rotate the KEK",
          href: "/docs/operate/platform/runbook/rotate-the-kek/",
        },
      };
    }
    if (e.code === "discovery_unreachable") {
      return {
        title: "The provider didn't answer",
        description:
          serverWords(e) ?? "Check the issuer address and try again.",
        fields,
      };
    }
    if (e.code === "discovery_invalid") {
      return {
        title: "The provider's discovery document isn't usable",
        description: serverWords(e),
        fields,
      };
    }
  }
  const c = errorCopy(e, { thing: "The connection" });
  return {
    title: c.title,
    description:
      (e instanceof HttpError && e.status !== 0 ? serverWords(e) : undefined) ??
      c.description,
    fields: e instanceof HttpError ? (e.fields ?? []) : [],
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
