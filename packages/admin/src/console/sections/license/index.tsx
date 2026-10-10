import * as React from "react";
import { EnrollmentPage } from "./pages/EnrollmentPage.js";
import { LicenseBatchPage, LicenseBatchesPage } from "./pages/LicenseBatch.js";
import { LicenseSettingsPage } from "./pages/LicenseSettingsPage.js";
import { LicenseRecord } from "./pages/LicenseRecord.js";
import { LicensesPage } from "./pages/LicensesPage.js";
import { TierRecord } from "./pages/TierRecord.js";
import { TiersPage } from "./pages/TiersPage.js";
import type { SectionPageProps } from "../../pages/types.js";

/**
 * License (ADMIN.md §6.5): Licenses and the license record, Tiers and the tier record, Enrollment,
 * Settings (LX-06: S-19's licensing settings), and licence batches with each batch's page (LX-30).
 */
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
    case "license-settings":
      return <LicenseSettingsPage slug={slug} />;
    case "license-batches":
      return route.id !== undefined ? (
        <LicenseBatchPage slug={slug} id={route.id} />
      ) : (
        <LicenseBatchesPage slug={slug} />
      );
    default:
      return null;
  }
}
