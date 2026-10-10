import { t } from "../../lib/copy.js";

/**
 * What a wrong or spent sign-in code says, from the kit copy catalog: the one wording for the
 * sign-in card, the step-up dialog and Account's add-an-email step.
 */

/** A code that did not match: out of tries, or the catalog's "isn't right" with the tries left. */
export function wrongCodeText(triesLeft: number | undefined): string {
  if (triesLeft === 0) return t("signin.code.tooMany");
  const wrong = t("core.codes.invalid_code.message");
  return triesLeft !== undefined && triesLeft <= 2
    ? `${wrong} ${t("signin.code.triesLeft", { n: triesLeft })}`
    : wrong;
}

/** A code whose sign-in has expired. */
export function expiredCodeText(): string {
  return t("signin.code.expired");
}
