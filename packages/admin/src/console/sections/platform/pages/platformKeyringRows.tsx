/**
 * The Keyring panel's two progress rows (`platformSettings.tsx`): how far the re-seal has got,
 * and where the legacy `PLATFORM_KEK` stands. Both read counts the Worker bounds: when its scan
 * stopped at the row cap (`countsComplete: false`) every number is a floor, so the rows say
 * "at least" and a notice names the tables, and no row ever reads a stopped count as "done".
 */

import * as React from "react";
import type { PlatformKekStatus } from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { Callout } from "../../../../ui/Callout.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { SettingsRow } from "../../../templates/Settings.js";

/** The re-seal row: what is left under an older key, what cannot be opened, and whether to trust it. */
export function ResealProgressRow({
  status: k,
}: {
  status: PlatformKekStatus;
}): React.ReactElement {
  const floor = k.countsComplete ? "" : "At least ";
  return (
    <SettingsRow
      label="Re-seal progress"
      align={k.countsComplete ? undefined : "block"}
    >
      <div className="space-y-2">
        {k.unopenable > 0 ? (
          <Callout tone="danger" title="Values cannot be opened">
            {floor}
            {formatCount(k.unopenable)} sealed{" "}
            {k.unopenable === 1 ? "value is" : "values are"} under a key no
            longer in the ring. Put that key back in PLATFORM_KEK_KEYS.
          </Callout>
        ) : k.remaining > 0 ? (
          <StatusPill tone="warning">
            {floor}
            {formatCount(k.remaining)} still on an older key
          </StatusPill>
        ) : (
          <StatusPill tone="success">
            Every value is under the active key
          </StatusPill>
        )}
        {k.countsComplete ? null : (
          <Callout tone="warning" title="These counts are not complete">
            The scan stopped at its row limit in {k.countsTruncated.join(", ")},
            so every figure here is a minimum and none of them shows that a key
            can be deleted. Run the re-seal again until this notice goes away.
          </Callout>
        )}
      </div>
    </SettingsRow>
  );
}

/**
 * The legacy `PLATFORM_KEK` beside `PLATFORM_KEK_KEYS`: what is still sealed under it, and
 * whether `PLATFORM_KEK` can be deleted yet. The sweep moves the stored values; sealed Worker
 * secrets are re-sealed by hand, so they are named.
 */
export function LegacyKeyRow({
  legacy,
  complete,
}: {
  legacy: NonNullable<PlatformKekStatus["legacy"]>;
  /** False when the scan was cut short: the legacy count is a floor then. */
  complete: boolean;
}): React.ReactElement {
  return (
    <SettingsRow label="Legacy key" align="block">
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">
          {legacy.openOnly ? (
            <>
              PLATFORM_KEK is kept in the ring as{" "}
              <span className="font-mono text-xs text-fg">{legacy.kid}</span>,
              open only: nothing new is sealed under it.
            </>
          ) : (
            <>
              PLATFORM_KEK is a copy of the ring&apos;s{" "}
              <span className="font-mono text-xs text-fg">{legacy.kid}</span>{" "}
              key.
            </>
          )}
        </p>
        {legacy.safeToDelete ? (
          <StatusPill tone="success">Safe to delete PLATFORM_KEK</StatusPill>
        ) : legacy.remaining > 0 ? (
          <StatusPill tone="warning">
            {complete ? "" : "At least "}
            {formatCount(legacy.remaining)} still under {legacy.kid}
          </StatusPill>
        ) : (
          <StatusPill tone="warning">
            Worker secrets still under {legacy.kid}
          </StatusPill>
        )}
        {legacy.workerSecrets.length > 0 ? (
          <p className="text-sm text-fg-muted">
            Re-seal and set again before deleting it:{" "}
            {legacy.workerSecrets.map((name, i) => (
              <React.Fragment key={name}>
                {i > 0 ? ", " : null}
                <span className="font-mono text-xs text-fg">{name}</span>
              </React.Fragment>
            ))}
            .
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
