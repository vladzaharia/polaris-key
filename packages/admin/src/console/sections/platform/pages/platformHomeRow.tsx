import * as React from "react";
import { Section } from "../../../../ui/Section.js";
import { Switch } from "../../../../ui/Switch.js";
import { useMe } from "../../../data/hooks.js";
import { SettingsRow } from "../../../templates/Settings.js";
import { useSetupGuideHidden } from "../../global/model/setupGuide.js";

/**
 * Whether Home shows Platform ready, kept per operator in this browser (the same
 * `pk-admin-setup-guide-hidden:<sub>` preference Home's ✕ writes), so a hidden guide has a way
 * back that is not Home's menu alone. Self-contained: it reads and writes only that preference.
 */
export function PlatformReadyOnHomeRow(): React.ReactElement {
  const operator = useMe().data?.sub;
  const [hidden, setHidden] = useSetupGuideHidden(operator);
  const id = React.useId();
  return (
    <Section variant="settings" id="platform-home" title="Home">
      <SettingsRow
        label="Platform ready on Home"
        htmlFor={id}
        help="The setup checklist on your Home page. Kept in this browser, for you only."
        aside={
          <span className="text-sm text-fg-muted">
            {hidden ? "Hidden" : "Shown"}
          </span>
        }
      >
        <Switch
          id={id}
          checked={!hidden}
          onCheckedChange={(on) => setHidden(!on)}
          aria-label="Show Platform ready on Home"
        />
      </SettingsRow>
    </Section>
  );
}
