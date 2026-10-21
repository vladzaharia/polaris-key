/**
 * The product Overview's one-line summary under the title. The count and the creation date are
 * always there; the repository link and the last resync are detail that folds away when the
 * masthead is narrow (a phone, or 200 % text: the container query is in rem, so it follows the
 * text size) so the sentence stays within the masthead's height cap. Both are on Settings.
 */

import * as React from "react";
import { formatDate, fromSeconds } from "../../../../lib/format.js";

export function OverviewByline({
  features,
  linked,
  resyncedAt,
  createdAt,
}: {
  features: number;
  linked: boolean;
  resyncedAt?: number | null;
  createdAt: number;
}): React.ReactElement {
  return (
    <>
      Runs {features} {features === 1 ? "feature" : "features"}
      {linked || resyncedAt ? (
        <span className="hidden @xl:inline">
          {linked ? " · linked to GitHub" : ""}
          {resyncedAt
            ? ` · last resync ${formatDate(fromSeconds(resyncedAt))}`
            : ""}
        </span>
      ) : null}{" "}
      · created {formatDate(fromSeconds(createdAt))}
    </>
  );
}
