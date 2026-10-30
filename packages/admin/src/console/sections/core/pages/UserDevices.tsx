/** A user's Devices tab (I-12; the Linked devices link is CC-16.4). Split from `UserRecord.tsx`. */

import * as React from "react";
import type { ProductUserDetail } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsSection } from "../../../templates/Settings.js";

export function UserDevices({
  slug,
  user,
  connectOn,
}: {
  slug: string;
  user: ProductUserDetail;
  /** Cloud Connect is on for the product: link to this person's linked devices. */
  connectOn: boolean;
}): React.ReactElement {
  const linked = connectOn ? (
    <Link
      to={r.connectDevices(slug, user.subject)}
      className="inline-flex min-h-6 items-center text-sm text-accent-fg underline underline-offset-2"
    >
      Linked devices
    </Link>
  ) : undefined;
  if (user.devices.length === 0) {
    return (
      <EmptyState
        kind="first-run"
        title="No devices"
        description="This user has no device on a license of theirs, and has not signed in on one."
        primaryAction={linked}
      />
    );
  }
  return (
    <SettingsSection id="user-devices" title="Devices" actions={linked}>
      <ul className="divide-y divide-border">
        {user.devices.map((d) => (
          <li
            key={d.deviceId}
            className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <EntityLink slug={slug} kind="device" id={d.deviceId} />
                {d.status !== "authorized" ? (
                  <StatusPill domain="device" state={d.status} />
                ) : null}
              </span>
              <span className="text-xs text-fg-muted">
                {[
                  d.label,
                  d.platform ? platformName(d.platform) : null,
                  d.appVersion,
                  user.identityOn && d.signedIn ? "signed in" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="shrink-0 text-xs text-fg-muted">
              Last seen <Timestamp at={fromSeconds(d.lastSeen)} />
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
