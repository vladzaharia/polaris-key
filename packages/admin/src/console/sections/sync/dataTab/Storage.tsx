/** Users → Data → Storage: the person's use against their limit, and the tier the limit came from. */

import * as React from "react";
import type { SubjectData } from "./index.js";
import { Meter, type MeterTone } from "../../../../ui/charts/Meter.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { formatStorage } from "../pages/usageParts.js";

/** Warn from 80 % of the limit, and at the limit. */
export function storageTone(used: number, limit: number): MeterTone {
  if (limit <= 0) return used > 0 ? "danger" : "accent";
  const ratio = used / limit;
  return ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "accent";
}

export function Storage({
  slug,
  data,
}: {
  slug: string;
  data: SubjectData;
}): React.ReactElement {
  const { usage, quota } = data;
  // Before the person's first write lands in the directory, the platform default is their limit.
  const limit = quota.bytes ?? quota.defaultBytes;
  const known = quota.bytes !== null;
  return (
    <SettingsSection id="sync-data-storage" title="Storage">
      <div className="space-y-3 px-5 py-4">
        {limit > 0 ? (
          <Meter
            label="Storage used"
            value={usage.bytes}
            max={limit}
            tone={storageTone(usage.bytes, limit)}
            text={`${formatStorage(usage.bytes)} of ${formatStorage(limit)}`}
          />
        ) : (
          <p className="text-sm text-fg">
            {formatStorage(usage.bytes)} stored. This tier allows reads only.
          </p>
        )}
        <p className="text-xs text-fg-muted">
          {quota.tierId ? (
            <>
              Limit from the{" "}
              <Link
                to={r.tier(slug, quota.tierId)}
                className="text-accent-fg underline underline-offset-2"
              >
                {quota.tierLabel ?? quota.tierId}
              </Link>{" "}
              tier.
            </>
          ) : known ? (
            "Limit from the default."
          ) : (
            "Default limit, until their first sync."
          )}
        </p>
      </div>
    </SettingsSection>
  );
}
