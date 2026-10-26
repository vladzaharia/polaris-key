import * as React from "react";
import type { MatrixCellDto } from "../../../../api.js";
import { EntityLink } from "../../../components/EntityLink.js";

/** The packs an `auto` Background Assets route serves from the CDN until App Store Connect approves them. */
export function CdnFallbackNote({
  slug,
  notes,
}: {
  slug: string;
  notes: NonNullable<MatrixCellDto["readiness"]>["notes"];
}): React.ReactElement | null {
  const packs = [
    ...new Set(
      (notes ?? []).filter((n) => n.note === "cdn-fallback").map((n) => n.pack),
    ),
  ];
  if (packs.length === 0) return null;
  return (
    <p className="text-sm text-fg-muted">
      {packs.map((pack, i) => (
        <React.Fragment key={pack}>
          {i === 0 ? "" : i === packs.length - 1 ? " and " : ", "}
          <EntityLink slug={slug} kind="deliverable" id={pack} label={pack} />
        </React.Fragment>
      ))}{" "}
      {packs.length === 1
        ? "is served from the Polaris Key CDN until its Background Asset is approved in App Store Connect."
        : "are served from the Polaris Key CDN until their Background Assets are approved in App Store Connect."}
    </p>
  );
}
