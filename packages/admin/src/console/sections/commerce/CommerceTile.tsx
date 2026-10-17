import * as React from "react";
import { r } from "../../routes.js";
import { Line, TileFrame } from "../core/components/TileFrame.js";

/** Commerce's tile on the Overview (CM-29); CM-23 adds the offers and purchases counts. */
export function CommerceTile({ slug }: { slug: string }): React.ReactElement {
  return (
    <TileFrame
      service="commerce"
      href={r.commerce(slug)}
      linkLabel="In-app purchases"
      loading={false}
    >
      <Line>Store purchases that give licenses and add-ons.</Line>
    </TileFrame>
  );
}
