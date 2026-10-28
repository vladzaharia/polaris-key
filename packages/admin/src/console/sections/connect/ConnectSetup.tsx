/**
 * Cloud Connect → Setup (CC-16, first slice). Over reads the API already serves (D1):
 *
 *  - the relay switch `cloudConnect.relay.enabled`, a product setting with its own control (the
 *    manifest's `connect.relay` is the default; a save here claims it, as on every product setting);
 *  - the monthly relay ceiling `cloudConnect.ceiling.relayBytes`, operator-owned: read-only, with
 *    the operator's value and where it comes from;
 *  - the launch gates `launch.connect` and `launch.relay`, said in words while one is off. They are
 *    platform settings, so only a member who can read the platform list sees them; for anyone else
 *    nothing is drawn (the page never guesses a gate).
 *
 * Usage and Linked devices are later CC-16 slices.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PlatformSwitchSetting,
  type ProductSetting,
} from "../../../api.js";
import { Callout } from "../../../ui/Callout.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { useWriteGate } from "../../access/useCan.js";
import { ProductSettingsSection } from "../../components/ProductSettingsSection.js";
import { useProduct } from "../../data/hooks.js";
import { reads } from "../../data/reads.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsRow, SettingsSection } from "../../templates/Settings.js";
import { useSettingTarget } from "../../useSettingTarget.js";
import { formatBinaryBytes } from "../sync/pages/SyncData.js";

export const CONNECT_AREA = "cloudConnect";
const RELAY = "cloudConnect.relay.enabled";
const CEILING = "cloudConnect.ceiling.relayBytes";
const GATE_CONNECT = "launch.connect";
const GATE_RELAY = "launch.relay";

/** Whether a launch gate is off, `null` while the platform list does not say. */
function gateOff(
  settings: readonly { key: string; kind: string; value?: unknown }[],
  key: string,
): boolean | null {
  const s = settings.find(
    (x): x is PlatformSwitchSetting => x.key === key && x.kind === "switch",
  );
  return s ? s.value === "off" : null;
}

export function ConnectSetupPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const platformGate = useWriteGate("platform", null, "Platform");
  const platform = useQuery({
    ...reads.platformSettings(),
    retry: false,
    enabled: platformGate.allowed,
  });
  const settings = platform.data?.settings ?? [];
  const connectOff = gateOff(settings, GATE_CONNECT);
  const relayOff = gateOff(settings, GATE_RELAY);

  const header = (
    <PageHeader
      title="Cloud Connect"
      description="Link a person's devices and move data between them."
      refetching={platform.isFetching && !platform.isPending}
    />
  );

  if (product.data?.services?.connect?.enabled === false)
    return (
      <div className="space-y-6" data-template="record">
        {header}
        <EmptyState
          kind="service-off"
          service="connect"
          headingLevel={2}
          title="Cloud Connect is off for this product"
          description="Devices link only while it is on."
          docs="/docs/features/cloud-connect/"
          primaryAction={
            <Link
              to={r.services(slug)}
              className="py-1 text-accent-fg underline underline-offset-2"
            >
              Open Features
            </Link>
          }
        />
      </div>
    );

  return (
    <div className="space-y-6" data-template="record">
      {header}
      <div className="max-w-4xl space-y-6">
        {connectOff ? (
          <Callout tone="warning" title="Cloud Connect is not live yet">
            Devices can&apos;t link until the platform turns it on. Your
            settings are saved and apply then.
          </Callout>
        ) : relayOff ? (
          <Callout tone="warning" title="The relay is not live yet">
            Devices connect on the same network only until the platform turns it
            on.
          </Callout>
        ) : null}
        <ProductSettingsSection
          slug={slug}
          area={CONNECT_AREA}
          id="connect-relay"
          title="Relay"
          description="Carries device traffic when the local network can't."
          keys={[RELAY]}
        />
        <RelayCeiling slug={slug} />
      </div>
    </div>
  );
}

/** The operator's monthly relay ceiling: a read-only fact, with who owns it. */
function RelayCeiling({ slug }: { slug: string }): React.ReactElement | null {
  const q = useQuery(reads.productSettings(slug, CONNECT_AREA));
  useSettingTarget(!q.isPending);
  const row: ProductSetting | undefined = q.data?.settings.find(
    (s) => s.key === CEILING,
  );
  const card = (body: React.ReactNode): React.ReactElement => (
    <SettingsSection
      id="connect-limits"
      title="Relay ceiling"
      description="All people on the product, together, per UTC month."
    >
      {body}
    </SettingsSection>
  );
  if (q.isPending)
    return card(<Skeleton className="m-5 h-6 w-3/4" aria-busy="true" />);
  if (!q.data)
    return card(
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        compact
        className="p-5"
      />,
    );
  if (!row || (row.visibleWhen?.offBehaviour === "hide" && !row.serviceEnabled))
    return null;
  const value = Number(row.value);
  return card(
    <SettingsRow
      id={`setting-${CEILING}`}
      label={row.label}
      help={row.description}
      source={
        <SourceBadge
          source={row.source === "default" ? "default" : "runtime"}
          label={row.source === "default" ? "Default" : undefined}
          by={row.updatedBy ?? undefined}
          at={row.updatedAt ? row.updatedAt * 1000 : undefined}
        />
      }
      aside={
        <p className="text-sm text-fg-muted">Set by the platform operator.</p>
      }
    >
      <p
        className="tabular-nums text-fg-strong"
        data-testid="connect-ceiling-value"
      >
        {Number.isFinite(value)
          ? `${formatBinaryBytes(value)} a month`
          : "Not set"}
      </p>
    </SettingsRow>,
  );
}
