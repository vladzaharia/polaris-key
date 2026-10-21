// The default "Powered by Polaris Locker" badge, on its own entry (`@polaris-key/brand/badge`).
// `poweredBySvg` (./svg.ts) draws any of the three treatments, so a bundle that imports it carries
// all three templates and the outlined prefix, about 7 KB gzip. The SDK kits draw `transparent`
// only and load this module when a badge is first shown (SP-47 size budget).

import {
  LOCKER_BADGE_TRANSPARENT,
  LOCKER_POWERED_BY_PREFIX,
} from "../generated/locker-badge.js";
import { ALT } from "../tokens/primitives.js";
import { lockerBadgeBodyFrom, type LockerBadgeOptions } from "./locker.js";
import { badgeSvgOf, escapeHtml, type PoweredByOptions } from "./svg.js";

/** `poweredBySvg` in its default `transparent` treatment: the same markup, byte for byte. */
export function poweredByTransparentSvg(
  opts: Omit<PoweredByOptions, "treatment"> = {},
): string {
  const title = opts.title ?? ALT.poweredBy;
  const badge: LockerBadgeOptions = {
    kind: "locker-powered-by",
    treatment: "transparent",
    theme: opts.theme,
    width: opts.width,
    title,
  };
  const inner = `${title ? `<title>${escapeHtml(title)}</title>` : ""}${lockerBadgeBodyFrom(
    LOCKER_BADGE_TRANSPARENT,
    LOCKER_POWERED_BY_PREFIX,
    "transparent",
    opts.theme ?? "dark",
  )}`;
  return badgeSvgOf(badge, inner, LOCKER_BADGE_TRANSPARENT);
}
