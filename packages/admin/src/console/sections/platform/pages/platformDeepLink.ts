/**
 * Platform → Settings: where a `?setting=` link lands (B-043, B-048). The row of a setting, the
 * control of a package feed's policy, or a deploy value inside the folded Advanced card, which
 * opens first.
 */

import * as React from "react";
import type { PlatformSettingsView } from "../../../../api.js";
import { useLocation } from "../../../router.js";
import { namesOf } from "../../../useSettingTarget.js";

/** Dispatched to open the folded Advanced card. */
export const OPEN_ADVANCED = "platform-open-advanced";

/** The element a `?setting=` link lands on: the row, or a package feed's control. */
export function platformRowId(key: string): string {
  const feed = /^feeds\.policy\.([a-z0-9-]+)\.([a-z]+)$/.exec(key);
  return feed
    ? `platform-feeds-${feed[1]}-${feed[2]}`
    : `platform-setting-${key}`;
}

/** A link to a setting the page draws only inside the closed Advanced card opens it. */
export function useOpenAdvancedFor(
  view: PlatformSettingsView | undefined,
): void {
  const target = useLocation().route.query.get("setting");
  React.useEffect(() => {
    if (!view || !target) return;
    const names = namesOf(target);
    if (names.some((n) => document.getElementById(platformRowId(n)))) return;
    const known =
      view.settings.some((s) => names.includes(s.key)) ||
      view.deployTime.some((d) => names.includes(d.name)) ||
      view.secrets.some((s) => names.includes(s.name)) ||
      view.constants.some((c) => names.includes(c.name));
    if (known) window.dispatchEvent(new Event(OPEN_ADVANCED));
  }, [view, target]);
}
