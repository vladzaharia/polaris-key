import { PortalApiError } from "./api.js";

/**
 * Error copy for the customer site (PORTAL.md §6.4): what happened, in the person's terms, and
 * the next step. Never an HTTP status, an internal code or "portal api 404".
 */
export interface PortalErrorCopy {
  title: string;
  description: string;
  /** Whether trying again can help (a Retry button is offered). */
  retry: boolean;
}

export function isNetworkError(err: unknown): boolean {
  return err instanceof PortalApiError && err.status === 0;
}

export function isSignedOut(err: unknown): boolean {
  return (
    err instanceof PortalApiError &&
    err.status === 401 &&
    // Still signed in, only not recently enough for an account change (PX-W12).
    err.code !== "step_up_required"
  );
}

/**
 * An account change needs a sign-in from the last 5 minutes (PX-W12, I-16): the page asks the
 * person to confirm it's them, then tries again.
 */
export function isStepUpRequired(err: unknown): boolean {
  return err instanceof PortalApiError && err.code === "step_up_required";
}

export function isNotFound(err: unknown): boolean {
  return err instanceof PortalApiError && err.status === 404;
}

/**
 * The download-link mint's reasons (`POST …/artifacts/<id>/token`). The Worker sends them only
 * to an account that owns the product, so they can say exactly what is wrong; a stranger gets a
 * plain 404. The last three match the downloads view's per-file `reason`.
 */
const DOWNLOAD_REFUSALS: Record<string, PortalErrorCopy> = {
  file_not_found: {
    title: "That file is no longer offered",
    description:
      "A newer release may have replaced it. Reload the page to see the current downloads.",
    retry: false,
  },
  not_hosted: {
    title: "Not available here yet",
    description:
      "This file can't be downloaded from here yet. Contact the developer for another way to get it.",
    retry: false,
  },
  license_inactive: {
    title: "Your license isn't active",
    description:
      "Renew or reactivate your license, then try the download again.",
    retry: false,
  },
  not_entitled: {
    title: "Your license doesn't include this version",
    description:
      "Download a version your license covers, or upgrade your license to get this one.",
    retry: false,
  },
};

export function portalErrorCopy(err: unknown): PortalErrorCopy {
  if (err instanceof PortalApiError) {
    if (
      err.code &&
      Object.prototype.hasOwnProperty.call(DOWNLOAD_REFUSALS, err.code)
    )
      return DOWNLOAD_REFUSALS[err.code]!;
    if (err.status === 0)
      return {
        title: "Can't reach Polaris Key",
        description: "Check your connection, then try again.",
        retry: true,
      };
    if (err.status === 401)
      return {
        title: "You're signed out",
        description: "Sign in again to carry on.",
        retry: false,
      };
    if (err.status === 403)
      return {
        title: "That didn't go through",
        description: "Reload the page and try again.",
        retry: false,
      };
    if (err.status === 404)
      return {
        title: "That isn't here",
        description: "It may have been removed, or the link is out of date.",
        retry: false,
      };
    if (err.status === 429)
      return {
        title: "Too many tries",
        description: "Wait a minute, then try again.",
        retry: true,
      };
  }
  return {
    title: "Something went wrong",
    description: "Try again. If it keeps happening, contact the developer.",
    retry: true,
  };
}
