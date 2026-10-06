/**
 * The licence override migration's notice on a product's Licenses page (U-03): while the 30-day
 * notice runs and the daily inventory counts licences of this product carrying config or secret
 * overrides, say what happens to them on the run date and link to Platform → Override migration.
 *
 * It reads the platform state once (`GET /manage/api/platform/override-migration`, platform admins
 * only, like the whole console). An advisory: when that read fails or the session is not a
 * platform admin, the page simply has no notice.
 */

import * as React from "react";
import type { OverrideMigrationState } from "../../../api.js";
import { formatCount } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { useMe } from "../../data/hooks.js";
import {
  upcomingRunDate,
  useOverrideMigration,
} from "../../data/overrideMigration.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";

/** The notice's sentence for this product, or `null` when there is nothing to say. */
export function migrationNoticeText(
  state: OverrideMigrationState | undefined,
  slug: string,
  now: number = Date.now(),
): { tone: "warning" | "info"; text: string } | null {
  if (!state || state.phase !== "notice") return null;
  const counts = state.inventory?.products.find((p) => p.product === slug);
  if (!counts || (counts.dropped === 0 && counts.owned === 0)) return null;
  const date = upcomingRunDate(state.notice.runNotBefore, now);
  const on = date ? `on ${date}` : "when the migration runs";
  const licenses = (n: number) =>
    `${formatCount(n)} ${n === 1 ? "license's" : "licenses'"}`;
  const parts: string[] = [];
  if (counts.dropped > 0)
    parts.push(
      `${licenses(counts.dropped)} config overrides are dropped ${on} unless their customers add them to an account`,
    );
  if (counts.owned > 0)
    parts.push(
      counts.dropped > 0
        ? `${formatCount(counts.owned)} ${counts.owned === 1 ? "moves to its owner's" : "move to their owners'"} account overrides`
        : `${licenses(counts.owned)} config overrides move to their owners' account overrides ${on}`,
    );
  return {
    tone: counts.dropped > 0 ? "warning" : "info",
    text: `${parts.join("; ")}.`,
  };
}

export function OverrideMigrationNotice({
  slug,
}: {
  slug: string;
}): React.ReactElement | null {
  const admin = useMe().data?.platformAdmin === true;
  const q = useOverrideMigration(admin);
  const notice = migrationNoticeText(q.data?.state, slug);
  if (!notice) return null;
  return (
    <Callout
      tone={notice.tone}
      title="License config overrides are moving to account overrides"
      action={
        <Button size="sm" variant="outline" asChild>
          <Link to={r.platformOverrideMigration()}>Override migration</Link>
        </Button>
      }
    >
      {notice.text} Entitlements stay on each license.
    </Callout>
  );
}
