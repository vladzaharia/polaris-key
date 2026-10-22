/**
 * Retired credentials (ST-34.9, D-5).
 *
 * `PKEY_ADMIN_COOKIE` once carried a console session cookie for `pkey listing import`. Nothing
 * reads it any more: the admin commands take a `pkey login` sign-in or a `pkeya_` / `pkeyp_`
 * token (`credentials.ts`). A machine that still sets it is told so, once and before anything is
 * sent, instead of silently ignoring a variable its owner believes is in use.
 *
 * This file is the ONLY place the name appears in code. `test/noAdminCookie.test.ts` holds it
 * there, so a later change cannot start reading the cookie again by accident.
 */

const RETIRED_COOKIE_ENV = "PKEY_ADMIN_COOKIE";

/** The refusal's two lines: what is wrong, and the one fix. */
export const RETIRED_COOKIE_REFUSAL = {
  message: `${RETIRED_COOKIE_ENV} isn't used any more.`,
  fix: "Run pkey login once.",
} as const;

/** True when the retired variable is set to anything, so an admin command must refuse. */
export function retiredCookieSet(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env[RETIRED_COOKIE_ENV] ?? "") !== "";
}
