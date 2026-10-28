// The focused refusal step for the two key refusals a different key cannot fix: the key-entry
// limit and a license another account holds (SIGN-IN.md §3.9, UI-KITS DL6). No field, lede or
// paste, since resubmitting the same key cannot succeed; the way on is the kit's own sign-in,
// then (for the limit) the add-key page in the browser, or a QR on a TV. Activate and the
// sign-in form's key step both draw it. A refusal a different key can fix (disabled, expired,
// not a key) stays stacked under the field.

import type { ActivationInput, Context } from "../input.js";
import { platformClass } from "../input.js";
import { linkVerdict, type LinkVerdict } from "../link.js";

export type KeyRefusal = "key-entry-limit" | "license-owned";

/** Which focused refusal an activation answer is, or `null` for any other result. */
export function keyRefusalOf(
  a: ActivationInput | undefined,
): KeyRefusal | null {
  if (!a) return null;
  if (a.result === "key-entry-limit") return "key-entry-limit";
  if (
    a.result === "license-owned" ||
    ((a.result === "refused" || a.result === "error") &&
      a.code === "license_owned")
  )
    return "license-owned";
  return null;
}

export interface KeyRefusalSpec {
  copy: string[];
  primary: string;
  link: LinkVerdict | null;
  qr: boolean;
}

const SIGN_IN = "signin.key.ownedSignIn";

/** The step's copy and decisions: title and message, Sign in (the primary), the add-key page for
 *  the limit (a button, or a QR with its caption on a TV), and Use a different key. */
export function keyRefusalSpec(
  ctx: Context,
  kind: KeyRefusal,
  a: ActivationInput,
): KeyRefusalSpec {
  const limit = kind === "key-entry-limit";
  const link = limit ? linkVerdict(a.manageUrl, ctx.platform, "manage") : null;
  const c = platformClass(ctx.platform);
  const tv = c === "tv" || c === "console";
  const add = link !== null && link.url !== null;
  return {
    copy: [
      limit
        ? "core.activation.key-entry-limit.title"
        : "core.codes.license_owned.title",
      limit
        ? "core.activation.key-entry-limit.message"
        : "core.codes.license_owned.message",
      SIGN_IN,
      ...(add
        ? tv
          ? ["signin.key.scan", "a11y.qrAddKey"]
          : ["signin.key.addInLocker", "a11y.externalLink"]
        : []),
      "signin.key.differentKey",
    ],
    primary: SIGN_IN,
    link,
    qr: add && tv,
  };
}
