import * as React from "react";
import { EnrollmentPage } from "./license/EnrollmentPage.js";
import { LicenseRecord } from "./license/LicenseRecord.js";
import { LicensesPage } from "./license/LicensesPage.js";
import { TierRecord } from "./license/TierRecord.js";
import { TiersPage } from "./license/TiersPage.js";
import type { SectionPageProps } from "./types.js";

/** License (ADMIN.md §6.5): Licenses and the license record, Tiers and the tier record, Enrollment. */
export default function LicensePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "licenses":
      return route.id !== undefined ? (
        <LicenseRecord slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <LicensesPage slug={slug} />
      );
    case "tiers":
      return route.id !== undefined ? (
        <TierRecord slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <TiersPage slug={slug} />
      );
    case "enrollment":
      return <EnrollmentPage slug={slug} />;
    default:
      return null;
  }
}
