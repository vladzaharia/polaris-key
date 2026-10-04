/**
 * `errorCopy(error, context)`: the console's one error mapper (docs/design/ADMIN.md §5.9,
 * components.md §5.5). It reads an `ApiError` (status, code, reason, errors, fields) and returns a
 * title, a description and the next step, so no view ever shows "api 422" again (P9). Toasts,
 * `ErrorState` and confirm dialogs all render through it.
 */

import { ApiError, SERVICE_ERROR_MESSAGES } from "../api.js";
import { RELEASE_POLICY_ERROR_MESSAGES } from "./releasePolicyMessages.js";

/** What the operator can do next. The renderer turns it into a button or a link. */
export type ErrorAction =
  | "retry"
  | "reload"
  | "sign-in"
  | "fields"
  | "copy-details"
  | "review"
  | "platform"
  | "none";

export interface ErrorContext {
  /** The thing the request was about, for "{Thing} not found": "License", "Profile". */
  thing?: string;
  /** Where that thing's collection lives, for the not-found link. */
  collectionHref?: string;
  /**
   * The area the request belongs to. It breaks ties between tables (`release_yanked` means a
   * different thing to a rollout than to a channel promote) and marks a 409 as the catalog's
   * concurrent-publish conflict (A-6).
   */
  area?: "release" | "distribution" | "catalog";
}

export interface ErrorCopy {
  title: string;
  description: string;
  action: ErrorAction;
  /** What still references the thing (409 in use), when the server listed them. */
  references?: string[];
  /** The fields the server refused (422): shown inline on those fields. */
  fieldErrors?: string[];
  /** One line per coherence code (422 `errors[]`, services). */
  lines?: string[];
  /** A JSON-able blob for "Copy details" (status, code, reason, path, time). */
  details: Record<string, unknown>;
}

/**
 * The release policy reasons the console words (worker `services/release/policy.ts`: 18). The
 * first 12 live in `api.ts` beside the client; these are the rest, so every reason has copy.
 */
export const RELEASE_REASON_MESSAGES: Record<string, string> = {
  ...RELEASE_POLICY_ERROR_MESSAGES,
  bad_deliverable: "Choose a deliverable.",
  bad_pinned: "Pinned must be on or off.",
  bad_critical: "Critical must be on or off.",
  bad_content_api:
    "A floor per content API line applies to packs only, and the line must be 1 or higher.",
  content_api_floor_only:
    "With a content API line, only the minimum supported version can be set.",
  release_revoked:
    "This release was revoked by a CI-signed revocation, which is permanent. Publish a newer release instead.",
};

/**
 * Distribution refusals (worker `services/distribution/*`), as the console words them.
 * ADMIN.md §5.9 lists every code.
 */
export const DISTRIBUTION_ERROR_MESSAGES: Record<string, string> = {
  rollout_mirrored:
    "This rollout is mirrored from a store. Control it in the store's console.",
  invalid_transition:
    "The rollout can't move to that state from where it is now.",
  stale_release:
    "Someone changed this rollout. The matrix has been refreshed; try again.",
  release_yanked: "This release is yanked, so it can't be rolled out.",
  no_rollout: "There is no rollout here to change.",
  no_override: "There is no readiness override to clear.",
  candidate_closed: "This candidate has already been decided.",
  credential_pin_missing:
    "The App Store Connect credential has no pin. Set the pin in Outlet credentials.",
  credential_pin_mismatch:
    "The App Store Connect credential's pin doesn't match. Check it in Outlet credentials.",
  not_configured:
    "This store connector isn't configured. Set it up in Outlet credentials.",
  store_refused:
    "The store refused the request. Its message is in the details.",
  unknown_version: "The store doesn't know this version yet.",
  no_phased_release: "This version has no phased release in App Store Connect.",
  not_held: "This version isn't held for release.",
  unknown_beta_group:
    "That TestFlight group doesn't exist in App Store Connect.",
  no_webhook_secret: "No webhook secret is set for this connector.",
  unknown_track: "Google Play doesn't have that track.",
};

/** Is this a network failure (fetch rejected before any response)? */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    /network|failed to fetch|load failed/i.test(error.message)
  );
}

/** The server's own message, when it sent one (ApiError's default message is "api {status}"). */
function serverMessage(error: ApiError): string | null {
  return error.message && error.message !== `api ${error.status}`
    ? error.message
    : null;
}

function detailsOf(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    time: new Date().toISOString(),
    path: typeof window !== "undefined" ? window.location.hash : undefined,
  };
  if (error instanceof ApiError) {
    return {
      ...base,
      status: error.status,
      code: error.code,
      reason: error.reason,
      fields: error.fields,
      errors: error.errors,
      message: serverMessage(error) ?? undefined,
    };
  }
  if (error instanceof Error) return { ...base, message: error.message };
  return { ...base, value: String(error) };
}

function referencesOf(error: ApiError): string[] | undefined {
  const refs = (error as ApiError & { references?: unknown }).references;
  return Array.isArray(refs) ? refs.map(String) : undefined;
}

/** Map any thrown value to the console's copy. Total: it never throws. */
export function errorCopy(
  error: unknown,
  context: ErrorContext = {},
): ErrorCopy {
  const details = detailsOf(error);
  const thing = context.thing ?? "This item";

  if (!(error instanceof ApiError)) {
    if (isNetworkError(error)) {
      return {
        title: "Can't reach Polaris Key",
        description:
          "Check your connection and try again. Nothing was changed.",
        action: "retry",
        details,
      };
    }
    return {
      title: "Something went wrong",
      description:
        error instanceof Error && error.message
          ? error.message
          : "The console hit an unexpected error.",
      action: "copy-details",
      details,
    };
  }

  const { status, code, reason } = error;
  const message = serverMessage(error);

  // Reason tables first: they are the most specific. Distribution first in its own area.
  const distribution =
    (reason && DISTRIBUTION_ERROR_MESSAGES[reason]) || undefined;
  if (distribution && context.area === "distribution") {
    return {
      title: "Distribution refused this",
      description: distribution,
      action: reason === "stale_release" ? "retry" : "none",
      details,
    };
  }
  if (reason && RELEASE_REASON_MESSAGES[reason]) {
    return {
      title: "The release policy refused this",
      description: RELEASE_REASON_MESSAGES[reason]!,
      action: "none",
      fieldErrors: error.fields,
      details,
    };
  }
  if (distribution) {
    return {
      title: "Distribution refused this",
      description: distribution,
      action: reason === "stale_release" ? "retry" : "none",
      details,
    };
  }

  if (status === 401) {
    return {
      title: "Your session ended",
      description:
        "Sign in again to continue; your unsaved changes stay in this tab.",
      action: "sign-in",
      details,
    };
  }
  if (status === 403) {
    if (/csrf/i.test(`${code ?? ""} ${reason ?? ""} ${message ?? ""}`)) {
      return {
        title: "Your session token is out of date",
        description: "Reload the page to refresh it, then try again.",
        action: "reload",
        details,
      };
    }
    return {
      title: "You can't do that",
      description: message ?? "Your session isn't allowed to make this change.",
      action: "none",
      details,
    };
  }
  if (status === 404) {
    return {
      title: `${thing} not found`,
      description:
        message ?? "It may have been deleted, or the link may be out of date.",
      action: "none",
      details,
    };
  }
  if (status === 409) {
    const references = referencesOf(error);
    if (references || /in use|referenc/i.test(message ?? "")) {
      return {
        title: `${thing} is still in use`,
        description: references?.length
          ? `Used by ${references.length} ${references.length === 1 ? "item" : "items"}.`
          : (message ?? "Remove what uses it first."),
        action: "none",
        references,
        details,
      };
    }
    if (context.area === "catalog") {
      return {
        title: "The catalog changed since you started",
        description: "Review the newer version, or discard your draft.",
        action: "review",
        details,
      };
    }
    return {
      title: "This changed on the server",
      description:
        message ?? "Reload to see the latest version, then try again.",
      action: "reload",
      details,
    };
  }
  if (status === 422 && error.errors?.length) {
    return {
      title: "These services depend on each other",
      description: "Change the settings below so they fit together.",
      action: "fields",
      lines: error.errors.map((c) => SERVICE_ERROR_MESSAGES[c] ?? c),
      details,
    };
  }
  if ((status === 422 || status === 400) && error.fields?.length) {
    const n = error.fields.length;
    return {
      title: n === 1 ? "Fix 1 field" : `Fix ${n} fields`,
      description: message ?? "Some values weren't accepted.",
      action: "fields",
      fieldErrors: error.fields,
      details,
    };
  }
  if (status === 429) {
    return {
      title: "Too many requests",
      description: "Wait a moment and try again.",
      action: "retry",
      details,
    };
  }
  if (status === 413) {
    return {
      title: "The request was too large",
      description: "This is a console problem. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (code === "invalid_json") {
    return {
      title: "The request was malformed",
      description: "This is a console problem. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (status === 503) {
    return {
      title: "The platform keyring is unavailable",
      description:
        "Polaris Key can't unseal product keys right now. Check the keyring on the Platform page.",
      action: "platform",
      details,
    };
  }
  if (code === "catalog_unavailable") {
    return {
      title: "The catalog couldn't be read",
      description:
        "The stored catalog is unavailable. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (code === "document_not_representable") {
    return {
      title: "This document can't be represented",
      description:
        "The server couldn't build a signed document from this data. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  return {
    title: `The server refused this (${status}${code ? ` ${code}` : ""})`,
    description: message ?? "Copy the details for a support report.",
    action: "copy-details",
    details,
  };
}
