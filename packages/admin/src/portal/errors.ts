import { HttpError, readSsoNext } from "./api.js";
import type { PortalSsoNext } from "./api.js";
import { t } from "../lib/copy.js";
import { focusAfterRetry } from "./focus.js";
import { helpForRefusal } from "./helpLinks.js";
import { HelpLink } from "./components/HelpLink.js";
import type { PortalVoice, PortalVoiceCopy } from "../ui/errorVoice.js";

/**
 * Error copy for the customer site (PORTAL.md §6.4): what happened, in the person's terms, and
 * the next step. Never an HTTP status, an internal code or "portal api 404".
 */
export type PortalErrorCopy = PortalVoiceCopy;

export function isSignedOut(err: unknown): boolean {
  return (
    err instanceof HttpError &&
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
  return err instanceof HttpError && err.code === "step_up_required";
}

/** I-30: the connection an enforced domain's refusal names instead (`body.next`), if any. */
export function ssoNextOf(err: unknown): PortalSsoNext | undefined {
  if (!(err instanceof HttpError)) return undefined;
  const body = err.body as { next?: unknown } | null | undefined;
  return body && typeof body === "object" ? readSsoNext(body.next) : undefined;
}

/** I-16: a passkey sign-in refused because no account here holds that credential. */
export function isUnknownCredential(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const body = err.body as { unknownCredential?: unknown } | null | undefined;
  return !!body && typeof body === "object" && body.unknownCredential === true;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/**
 * The download-link mint's reasons (`POST …/artifacts/<id>/token`). The Worker sends them only
 * to an account that owns the product, so they can say exactly what is wrong; a stranger gets a
 * plain 404. The last three match the downloads view's per-file `reason`. `not_entitled` has a
 * code in the catalog, so it reads `core.codes.not_entitled`; the others are Polaris Locker's own
 * wording (`locker.error.*`).
 */
const DOWNLOAD_REFUSALS: Record<string, () => PortalErrorCopy> = {
  file_not_found: () =>
    own(
      t("locker.error.fileGone.title"),
      t("locker.error.fileGone.body"),
      false,
    ),
  not_hosted: () =>
    own(
      t("locker.error.notHosted.title"),
      t("locker.error.notHosted.body"),
      false,
    ),
  license_inactive: () =>
    own(
      t("locker.error.licenseInactive.title"),
      t("locker.error.licenseInactive.body"),
      false,
    ),
  not_entitled: () => fromCode("not_entitled", false),
};

/** Polaris Locker's own wording: the line reads "Title. Description". */
function own(
  title: string,
  description: string,
  retry: boolean,
): PortalErrorCopy {
  return { title, description, retry, line: `${title}. ${description}` };
}

/** The catalog's wording for a refusal code (`core.codes.<code>`): its title, then its sentence. */
function fromCode(
  code:
    | "not_entitled"
    | "step_up_required"
    | "network"
    | "forbidden"
    | "not_found"
    | "rate_limited"
    | "unknown",
  retry: boolean,
): PortalErrorCopy {
  const title = t(`core.codes.${code}.title`);
  const message = t(`core.codes.${code}.message`);
  // A catalog sentence often restates its title ("Too many attempts. Wait a moment and try
  // again."): under a heading it says only the rest, so no fact shows twice.
  const rest = message.startsWith(`${title}. `)
    ? message.slice(title.length + 2)
    : message;
  return {
    title,
    description: rest,
    retry,
    line: message,
    ...(code === "unknown" ? { generic: true } : {}),
  };
}

/**
 * Browser errors read the catalog's refusal wording wherever a code exists (lead decision
 * 2026-10-21): the HTTP statuses map to the code that names them. Only a signed-out browser has no
 * code (`core.codes.unauthorized` says "this device"), so it keeps its own wording.
 *
 * `opts.account` is kept for callers; the catalog's sentences name no developer to contact, so the
 * account pages and the product pages now read alike.
 */
export function portalErrorCopy(
  err: unknown,
  _opts: { account?: boolean } = {},
): PortalErrorCopy {
  if (err instanceof HttpError) {
    // Erasing the account, removing a license and minting a package token ask for a
    // sign-in from the last five minutes.
    if (isStepUpRequired(err)) return fromCode("step_up_required", false);
    if (
      err.code &&
      Object.prototype.hasOwnProperty.call(DOWNLOAD_REFUSALS, err.code)
    ) {
      const help = helpForRefusal(err.code);
      return { ...DOWNLOAD_REFUSALS[err.code]!(), ...(help ? { help } : {}) };
    }
    if (err.status === 0) return fromCode("network", true);
    if (err.status === 401)
      return own(
        t("signin.console.signedOut"),
        t("locker.error.signInAgain"),
        false,
      );
    if (err.status === 403) return fromCode("forbidden", false);
    if (err.status === 404) return fromCode("not_found", false);
    if (err.status === 429) return fromCode("rate_limited", true);
  }
  return fromCode("unknown", true);
}

/** What a bug report needs from a failed load: the refusal's code and status, or the error's name and message. */
function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof HttpError)
    return { code: error.code, status: error.status, message: error.message };
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  return { message: String(error) };
}

/** The customer site's voice for `ErrorState` (mounted by `PortalApp`). */
export const portalVoice: PortalVoice = {
  tone: "portal",
  copy: (error, opts) => portalErrorCopy(error, opts),
  details: errorDetails,
  retryLabel: t("signin.retry"),
  afterRetry: focusAfterRetry,
  helpLabel: t("locker.help.whatToDo"),
  HelpLink,
};
