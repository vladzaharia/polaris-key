import * as React from "react";
import { Releases } from "../../views/Releases.js";
import { Deliverables } from "../../views/releases/Deliverables.js";
import { DeliverableDetail } from "../../views/releases/DeliverableDetail.js";
import { Compatibility } from "../../views/releases/Compatibility.js";
import type { SectionPageProps } from "./types.js";

/** Release: the legacy views at their new URLs, unchanged until chunk 8. */
export default function ReleasePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "releases":
      return <Releases slug={slug} />;
    case "deliverables":
      return route.id !== undefined ? (
        <DeliverableDetail slug={slug} id={route.id} />
      ) : (
        <Deliverables slug={slug} />
      );
    case "compatibility":
      return <Compatibility slug={slug} />;
    default:
      return null;
  }
}
