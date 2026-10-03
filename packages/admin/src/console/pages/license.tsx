import * as React from "react";
import { Licenses } from "../../views/Licenses.js";
import { LicenseDetail } from "../../views/LicenseDetail.js";
import { Tiers } from "../../views/Tiers.js";
import { FingerprintPolicy } from "../../views/FingerprintPolicy.js";
import type { SectionPageProps } from "./types.js";

/** License: the legacy views at their new URLs, unchanged until chunk 6. */
export default function LicensePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "licenses":
      return route.id !== undefined ? (
        <LicenseDetail slug={slug} id={route.id} />
      ) : (
        <Licenses slug={slug} />
      );
    case "tiers":
      return <Tiers slug={slug} />;
    case "enrollment":
      return <FingerprintPolicy slug={slug} />;
    default:
      return null;
  }
}
