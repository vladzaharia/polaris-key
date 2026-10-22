/**
 * Cloud Sync → Setup (config.cloud-sync, -paused, -product-role). What the operator controls
 * today, over reads the API serves (D1):
 *
 *  - the default storage per person, `cloudSync.quota.defaultBytes` (a platform setting; its
 *    change confirms with who it reaches, `StorageDefaultDialog`);
 *  - the platform's writes-paused switch, `cloudSync.writesPaused` (`PauseWritesDialog`), with a
 *    banner while it is on.
 *
 * Both are platform controls: a member with a product role only sees them drawn disabled, with
 * who can change them. A setting the platform list does not serve (U-05 is not live) draws nothing.
 * The per-tier values are set on Tiers, which the card links to; people near a limit and the
 * Usage tab wait for U-05's reads.
 */

import * as React from "react";
import { Lock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type PlatformIntegerSetting,
  type PlatformSwitchSetting,
  type ProductCatalog,
} from "../../../api.js";
import { CLOUD_SYNC_CEILINGS, CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import { formatCount, formatDateTime } from "../../../lib/format.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Button } from "../../../ui/Button.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Callout } from "../../../ui/Callout.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { useWriteGate } from "../../access/useCan.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { hasSavedStepUp } from "../../../ui/ConfirmDialog.js";
import { PauseWritesDialog, stepUpKeyFor } from "./PauseWritesDialog.js";
import { StorageDefaultDialog } from "./StorageDefaultDialog.js";
import { localSettings, userSettings } from "./data.js";
import { SyncHeader } from "./SyncHeader.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const WRITES_PAUSED = "cloudSync.writesPaused";
const DEFAULT_QUOTA = "cloudSync.quota.defaultBytes";

function PlatformPill(): React.ReactElement {
  return (
    <StatusPill tone="neutral" icon={false} size="sm">
      Platform
    </StatusPill>
  );
}

export function CloudSyncSetupPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const gate = useWriteGate("platform", null, "Platform");
  const platform = useQuery({
    queryKey: qk.platformSettings(),
    queryFn: () => api.platformSettings(),
    retry: false,
    enabled: gate.allowed,
  });
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
  });
  const [dialog, setDialog] = React.useState<
    null | "storage" | "pause" | "resume"
  >(null);

  const lastTo = React.useRef<"on" | "off">("on");
  if (dialog === "pause") lastTo.current = "on";
  if (dialog === "resume") lastTo.current = "off";
  const settings = platform.data?.settings ?? [];
  const paused = settings.find(
    (s): s is PlatformSwitchSetting =>
      s.key === WRITES_PAUSED && s.kind === "switch",
  );
  const quota = settings.find(
    (s): s is PlatformIntegerSetting =>
      s.key === DEFAULT_QUOTA && s.kind === "integer",
  );
  // A member without Platform access cannot read the list: the controls are drawn, disabled.
  const drawn = gate.allowed
    ? { paused, quota }
    : { paused: true, quota: true };
  const isPaused = paused?.value === "on";
  const propagation = platform.data?.propagationSeconds ?? 30;

  // Back from the step-up sign-in: reopen the pause dialog that was left, reason and all.
  const reopened = React.useRef(false);
  React.useEffect(() => {
    if (reopened.current || !paused) return;
    reopened.current = true;
    if (hasSavedStepUp(stepUpKeyFor(WRITES_PAUSED, "on"))) setDialog("pause");
    else if (hasSavedStepUp(stepUpKeyFor(WRITES_PAUSED, "off")))
      setDialog("resume");
  }, [paused]);

  const header = (
    <SyncHeader
      slug={slug}
      tab="sync-setup"
      refetching={platform.isFetching && !platform.isPending}
    />
  );

  if (product.data?.services?.sync?.enabled === false) {
    return (
      <div className="space-y-6" data-template="record">
        {header}
        <EmptyState
          kind="service-off"
          service="sync"
          headingLevel={2}
          title="Cloud Sync is off for this product"
          description="Settings stay on each device and nothing syncs until Cloud Sync is on. It needs Managed config and Sign-in."
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
  }
  if (gate.allowed && platform.isPending)
    return (
      <div className="space-y-6" data-template="record">
        {header}
        <PageSkeleton template="record" label="Cloud Sync setup" />
      </div>
    );

  // A member without Platform access sees who can change these once, at the top, not per row.
  const who = gate.disabledReason
    ? `Platform admins only. ${gate.disabledReason}`
    : undefined;
  const readFailed = gate.allowed && platform.isError;

  return (
    <div className="space-y-6" data-template="record">
      {header}

      {!gate.allowed && who ? (
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          {who}
        </p>
      ) : null}

      {readFailed ? (
        <ErrorState
          error={platform.error}
          onRetry={() => void platform.refetch()}
        />
      ) : null}

      {isPaused && paused ? (
        <Callout
          tone="warning"
          title="Cloud Sync writes are paused for every product"
          action={
            gate.allowed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialog("resume")}
              >
                Resume writes
              </Button>
            ) : undefined
          }
        >
          {paused.stored
            ? `Paused ${formatDateTime(paused.stored.updatedAt * 1000)}${paused.stored.updatedBy ? ` by ${paused.stored.updatedBy}` : ""}. `
            : ""}
          Devices keep their changes and send them on resume.
        </Callout>
      ) : null}

      {drawn.quota && !readFailed ? (
        <SettingsSection
          id="sync-storage"
          title="Storage per person"
          description={
            <>
              The{" "}
              <code className="font-mono text-xs">pkey.cloudSync.bytes</code>{" "}
              entitlement. Tiers set their own on{" "}
              <Link
                to={r.tiers(slug)}
                className="py-1 text-accent-fg underline underline-offset-2"
              >
                Tiers
              </Link>
              .
            </>
          }
        >
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 grow basis-full sm:basis-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg-strong">
                  Default <PlatformPill />
                </p>
                <p className="text-sm text-fg-muted">
                  For tiers that don&apos;t set their own
                </p>
              </div>
              {quota ? (
                <p className="tabular-nums text-fg-strong">
                  {formatBinaryBytes(quota.value)}
                </p>
              ) : null}
              {gate.allowed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabledReason={quota ? undefined : "Not available yet."}
                  onClick={() => setDialog("storage")}
                >
                  Change…
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-fg-muted">
              Lowering a limit deletes nothing. New saves wait for room.
            </p>
          </div>
        </SettingsSection>
      ) : null}

      {drawn.paused && !readFailed ? (
        <SettingsSection
          id="sync-limits"
          title="Product limits"
          description={`Each product holds up to ${formatBinaryBytes(CLOUD_SYNC_CEILINGS.perProduct.bytes)} of Cloud Sync data.`}
        >
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 grow basis-full sm:basis-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg-strong">
                  Pause all writes <PlatformPill />
                </p>
                <p className="text-sm text-fg-muted">
                  Stops new settings and saves in every product. Devices send
                  them on resume.
                </p>
              </div>
              {paused ? (
                <StatusPill
                  tone={isPaused ? "warning" : "neutral"}
                  icon={isPaused ? undefined : false}
                  size="sm"
                >
                  {isPaused ? "Paused" : "Off"}
                </StatusPill>
              ) : null}
              {gate.allowed ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabledReason={paused ? undefined : "Not available yet."}
                  onClick={() => setDialog(isPaused ? "resume" : "pause")}
                >
                  {isPaused ? "Resume writes" : "Pause writes…"}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {catalog.data ? <WhatSyncs slug={slug} catalog={catalog.data} /> : null}

      {quota ? (
        <StorageDefaultDialog
          open={dialog === "storage"}
          onOpenChange={(o) => setDialog(o ? "storage" : null)}
          setting={quota}
          propagationSeconds={propagation}
        />
      ) : null}
      {paused ? (
        <PauseWritesDialog
          open={dialog === "pause" || dialog === "resume"}
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          setting={paused}
          to={lastTo.current}
          propagationSeconds={propagation}
        />
      ) : null}
    </div>
  );
}

const FIRST_KEYS = 8;

/** What syncs, read from the catalog: the keys, the two that stay on each device, the limits. */
function WhatSyncs({
  slug,
  catalog,
}: {
  slug: string;
  catalog: ProductCatalog;
}): React.ReactElement {
  const synced = userSettings(catalog);
  const local = localSettings(catalog);
  const shown = synced.slice(0, FIRST_KEYS);
  return (
    <SettingsSection
      id="sync-what"
      title="What syncs"
      description={
        <>
          From the catalog, v{catalog.schemaVersion}.{" "}
          <Link
            to={r.catalog(slug)}
            className="py-1 text-accent-fg underline underline-offset-2"
          >
            Open the catalog
          </Link>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium text-fg-strong">
            Settings: {formatCount(synced.length)} sync
          </p>
          {synced.length > 0 ? (
            <p className="text-fg">
              {shown.map((e, i) => (
                <React.Fragment key={e.key}>
                  {i > 0 ? ", " : null}
                  <code className="font-mono text-xs text-fg-strong">
                    {e.key}
                  </code>
                </React.Fragment>
              ))}
              {synced.length > shown.length
                ? ` and ${formatCount(synced.length - shown.length)} more`
                : null}
            </p>
          ) : null}
          {local.length > 0 ? (
            <p className="text-fg-muted">
              {formatCount(local.length)} stay on each device:{" "}
              {local.map((k, i) => (
                <React.Fragment key={k}>
                  {i > 0 ? ", " : null}
                  <code className="font-mono text-xs">{k}</code>
                </React.Fragment>
              ))}
            </p>
          ) : null}
          <p className="text-fg-muted">Keys the app adds itself also sync.</p>
        </div>
        <DescriptionList
          columns={2}
          items={[
            {
              term: "Keys per person",
              detail: `Up to ${formatCount(CLOUD_SYNC_DEFAULTS.settings.maxKeys)}`,
            },
            {
              term: "Size per person",
              detail: `Up to ${formatBinaryBytes(CLOUD_SYNC_DEFAULTS.settings.maxBytes)}`,
            },
          ]}
        />
      </div>
    </SettingsSection>
  );
}
