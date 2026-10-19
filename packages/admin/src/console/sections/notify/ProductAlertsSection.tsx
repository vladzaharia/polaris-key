/** A product's Settings → Alerts section (ST-27): its destinations, which replace the platform's. */

import * as React from "react";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { AlertDestinations } from "./AlertDestinations.js";

export function ProductAlertsSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  return (
    <SettingsSection
      id="settings-alerts"
      title="Alerts"
      description="Where this product's alerts go, instead of the platform's. Auto-halts, store and commerce problems, access changes."
    >
      <AlertDestinations
        scope={{ kind: "product", slug }}
        returnHash={r.settings(slug)}
      />
    </SettingsSection>
  );
}
