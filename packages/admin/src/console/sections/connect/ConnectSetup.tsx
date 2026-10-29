/**
 * Cloud Connect → Setup (CC-16, first slice). One "Relay" card over reads the API already serves
 * (D1):
 *
 *  - the relay switch `cloudConnect.relay.enabled`, a product setting with its own control (the
 *    manifest's `connect.relay` is the default; a save here claims it, as on every product setting);
 *  - the monthly relay ceiling `cloudConnect.ceiling.relayBytes`, a product setting a member with
 *    Cloud Connect edit changes with `CeilingDialog` (as Cloud Sync's storage ceiling);
 *  - the per-person relay quota, set per tier (the reserved entitlement `pkey.cloudConnect.relayBytes`
 *    in the tier editor): a link to Tiers, with the platform default
 *    `cloudConnect.quota.defaultRelayBytes` beside it when the member can read the platform list.
 *
 * Under the card, one notice while the platform holds the feature back: a launch gate
 * (`launch.connect`, `launch.relay`) or the relay pause (`cloudConnect.relayPaused`). They are
 * platform settings, so only a member who can read the platform list sees them (and the quota
 * row); for anyone else nothing is drawn: the page never guesses. A product with Cloud Connect off
 * never reaches this page (the shell's service-off page answers).
 *
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PlatformIntegerSetting,
  type PlatformSwitchSetting,
  type ProductSetting,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { SourceBadge, type Source } from "../../../ui/SourceBadge.js";
import { useWriteGate } from "../../access/useCan.js";
import { ProductSettingsSection } from "../../components/ProductSettingsSection.js";
import { reads } from "../../data/reads.js";
import { useProduct } from "../../data/hooks.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsRow, SettingsSection } from "../../templates/Settings.js";
import { useSettingTarget } from "../../useSettingTarget.js";
import { ConnectHeader } from "./ConnectHeader.js";
import { CeilingDialog, type CeilingCopy } from "../sync/CeilingDialog.js";
import { PlatformPill, WhoLine } from "../sync/SetupParts.js";
import { formatBinaryBytes } from "../sync/pages/SyncData.js";

export const CONNECT_AREA = "cloudConnect";
const RELAY = "cloudConnect.relay.enabled";
const CEILING = "cloudConnect.ceiling.relayBytes";
const DEFAULT_QUOTA = "cloudConnect.quota.defaultRelayBytes";
const PAUSED = "cloudConnect.relayPaused";
const GATE_CONNECT = "launch.connect";
const GATE_RELAY = "launch.relay";

const BADGE: Record<ProductSetting["source"], Source> = {
  manifest: "manifest",
  console: "admin",
  default: "default",
};

const CEILING_COPY: CeilingCopy = {
  title: "Change the relay ceiling",
  field: "Relay data per month for this product (GiB)",
  same: "Everyone on this product shares the ceiling.",
  raise: (c) => `Everyone on this product can use up to ${c} of relay a month.`,
  lower: (c, bytes) => [
    bytes === 0
      ? "The relay refuses every new connection until you raise it."
      : `The relay refuses new connections once the product reaches ${c} in a UTC month.`,
    "Devices on the same network keep connecting.",
  ],
  set: (c) => `Relay ceiling set to ${c}`,
  reset: "Relay ceiling is the platform default",
};

/** One platform setting of a kind, from the list. */
function platformSetting<
  T extends PlatformSwitchSetting | PlatformIntegerSetting,
>(
  settings: readonly { key: string; kind: string }[],
  key: string,
  kind: T["kind"],
): T | undefined {
  return settings.find((s): s is T => s.key === key && s.kind === kind);
}

export function ConnectSetupPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const platformGate = useWriteGate("platform", null, "Platform");
  const platform = useQuery({
    ...reads.platformSettings(),
    retry: false,
    enabled: platformGate.allowed,
  });
  const settings = platform.data?.settings ?? [];
  const off = (key: string): boolean =>
    platformSetting<PlatformSwitchSetting>(settings, key, "switch")?.value ===
    "off";
  const paused =
    platformSetting<PlatformSwitchSetting>(settings, PAUSED, "switch")
      ?.value === "on";
  const quota = platformSetting<PlatformIntegerSetting>(
    settings,
    DEFAULT_QUOTA,
    "integer",
  );

  const open = (
    <Link
      to={r.platformSettings()}
      className="inline-flex py-1 text-sm text-accent-fg underline underline-offset-2"
    >
      Open Platform settings
    </Link>
  );
  const notice = off(GATE_CONNECT) ? (
    <Callout tone="warning" title="Cloud Connect is not live yet" action={open}>
      Devices can&apos;t link until Launch gate: Cloud Connect is on. Your
      settings apply then.
    </Callout>
  ) : off(GATE_RELAY) ? (
    <Callout tone="warning" title="The relay is not live yet" action={open}>
      Devices connect on the same network only until Launch gate: Cloud Connect
      relay is on.
    </Callout>
  ) : paused ? (
    <Callout
      tone="warning"
      title="The relay is paused for every product"
      action={open}
    >
      Devices connect on the same network only.
    </Callout>
  ) : null;

  return (
    <div className="space-y-6" data-template="record">
      <ConnectHeader
        slug={slug}
        tab="connect-setup"
        refetching={platform.isFetching && !platform.isPending}
      />
      <div className="max-w-4xl space-y-6 min-[1280px]:max-w-none">
        <SettingsSection id="connect-relay" title="Relay">
          <ProductSettingsSection
            bare
            slug={slug}
            area={CONNECT_AREA}
            id="connect-relay"
            title="Relay"
            keys={[RELAY]}
            copy={{
              [RELAY]: {
                consequences: (to) =>
                  to === false
                    ? [
                        "Devices on different networks stop connecting. Devices on the same network keep connecting.",
                      ]
                    : [],
              },
            }}
          />
          <RelayCeiling slug={slug} />
          <TierQuota slug={slug} fallback={quota} />
          {platformGate.allowed && platform.isError ? (
            <div className="px-5 py-4">
              <ErrorState
                compact
                thing="Platform settings"
                error={platform.error}
                onRetry={() => void platform.refetch()}
              />
            </div>
          ) : null}
        </SettingsSection>
        {notice}
      </div>
    </div>
  );
}

/** The product's monthly relay ceiling, with Change… for a member who can edit Cloud Connect. */
function RelayCeiling({ slug }: { slug: string }): React.ReactElement | null {
  const q = useQuery(reads.productSettings(slug, CONNECT_AREA));
  const gate = useWriteGate("connect", slug, "Cloud Connect");
  const [dialog, setDialog] = React.useState(false);
  useSettingTarget(!q.isPending);
  // A failed read is drawn once, by the relay row above.
  const row: ProductSetting | undefined = q.data?.settings.find(
    (s) => s.key === CEILING,
  );
  if (!row || (row.visibleWhen?.offBehaviour === "hide" && !row.serviceEnabled))
    return null;
  const value = Number(row.value);
  return (
    <>
      <SettingsRow
        id={`setting-${CEILING}`}
        label={row.label}
        help={row.description}
        source={
          <SourceBadge
            source={BADGE[row.source]}
            label={row.source === "default" ? "Platform default" : undefined}
            by={row.updatedBy ?? undefined}
            at={row.updatedAt ? row.updatedAt * 1000 : undefined}
          />
        }
        footer={
          !gate.allowed && gate.disabledReason ? (
            <WhoLine text={gate.disabledReason} />
          ) : undefined
        }
      >
        <p
          className="min-w-0 tabular-nums text-fg-strong"
          data-testid="connect-ceiling-value"
        >
          {!Number.isFinite(value)
            ? "Not set"
            : value === 0
              ? "0 GiB: no relay traffic"
              : `${formatBinaryBytes(value)} a month`}
        </p>
        {gate.allowed ? (
          <Button
            variant="outline"
            size="sm"
            aria-label="Change the relay ceiling"
            onClick={() => setDialog(true)}
          >
            Change…
          </Button>
        ) : null}
      </SettingsRow>
      <CeilingDialog
        open={dialog}
        onOpenChange={setDialog}
        slug={slug}
        setting={row}
        usedBytes={null}
        copy={CEILING_COPY}
      />
    </>
  );
}

/**
 * The per-person relay quota lives on the tier (`pkey.cloudConnect.relayBytes`), so this row only
 * points there; the platform default, a platform setting, is what a tier that sets none gets.
 */
function TierQuota({
  slug,
  fallback,
}: {
  slug: string;
  fallback: PlatformIntegerSetting | undefined;
}): React.ReactElement | null {
  const licenseOn = useProduct(slug).data?.services?.license?.enabled ?? false;
  if (!licenseOn) return null;
  return (
    <SettingsRow
      id="setting-cloudConnect.quota.tier"
      label="Relay quota per person"
      help="Per person per day. A tier sets it with the pkey.cloudConnect.relayBytes entitlement; a tier that sets none gets the platform default."
      source={fallback ? <PlatformPill /> : undefined}
    >
      {fallback ? (
        <p className="tabular-nums text-fg-strong">
          {formatBinaryBytes(fallback.value)} a day by default
        </p>
      ) : null}
      <Link
        to={r.tiers(slug)}
        className="inline-flex min-h-6 items-center text-sm text-accent-fg underline underline-offset-2"
      >
        Edit tiers
      </Link>
    </SettingsRow>
  );
}
