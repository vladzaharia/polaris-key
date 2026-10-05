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
  return err instanceof PortalApiError && err.status === 401;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof PortalApiError && err.status === 404;
}

export function portalErrorCopy(err: unknown): PortalErrorCopy {
  if (err instanceof PortalApiError) {
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
