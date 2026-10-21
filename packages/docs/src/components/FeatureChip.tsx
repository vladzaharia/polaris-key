import { createElement } from "react";
import { ServiceGlyph, StatusPill } from "./console";

/**
 * A feature chip in the Requires row: the console's pill with the feature's service glyph as its
 * icon (the glyph sits where the pill's own icon would, so it never overlaps the label).
 */
export function FeatureChip({
  service,
  label,
}: {
  service: string;
  label: string;
}) {
  const Glyph = () =>
    createElement(ServiceGlyph as never, { id: service as never, size: 16 });
  return createElement(
    StatusPill as never,
    { tone: "neutral", icon: Glyph as never },
    label,
  );
}
