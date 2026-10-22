import * as React from "react";
import { KeyRound } from "lucide-react";
import type { RegistryTokenDto } from "../../../../api.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { ECOSYSTEM_ICONS, ECOSYSTEM_LABELS } from "../model/model.js";

/** The feeds a registry token reaches, as pills. */
export function FeedList({
  ecosystems,
}: {
  ecosystems: RegistryTokenDto["ecosystems"];
}): React.ReactElement {
  if (ecosystems === null)
    return (
      <StatusPill tone="neutral" icon={null} size="sm">
        Every feed
      </StatusPill>
    );
  return (
    <span className="flex flex-wrap gap-1">
      {ecosystems.map((e) => {
        const Icon = ECOSYSTEM_ICONS[e] ?? KeyRound;
        return (
          <StatusPill key={e} tone="neutral" size="sm" icon={Icon}>
            {ECOSYSTEM_LABELS[e] ?? e}
          </StatusPill>
        );
      })}
    </span>
  );
}
