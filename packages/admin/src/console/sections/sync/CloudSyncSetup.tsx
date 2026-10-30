/**
 * Cloud Sync → Setup (config.cloud-sync, -paused, -product-role). What the operator controls,
 * over reads the API serves (D1):
 *
 *  - storage per person: the platform default `cloudSync.quota.defaultBytes` (a platform setting;
 *    its change confirms with who it reaches, `StorageDefaultDialog`) and each tier's value, read
 *    from the usage read and edited on Tiers; where people are near a limit, in words;
 *  - the product's storage ceiling `cloudSync.ceiling.bytes` (a meter and `CeilingDialog`);
 *  - the platform's writes-paused switch, `cloudSync.writesPaused` (`PauseWritesDialog`), with a
 *    banner while it is on. The banner reads the pause from the usage read, so a member with a
 *    product role sees it too (who, when; the reason only for Platform). Home's attention item
 *    lands here with `?resume=1`, which opens the resume dialog and leaves the URL.
 *
 * The platform controls are drawn without buttons for a member with a product role, with who can
 * change them. A setting the platform list does not serve draws nothing. Each read has its own
 * placeholder and its own error with Retry inside its card: a failed read never drops content
 * silently.
 *
 * Layout: one column, Product limits first on a phone (Pause is the urgent control); from 1600 px
 * Storage and What syncs take the main column and Product limits is a 400 px aside.
 */

import * as React from "react";
import { ArrowRight, CircleAlert, Lock, TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  type PlatformIntegerSetting,
  type PlatformSwitchSetting,
  type ProductCatalog,
  type ProductSetting,
  type SyncUsageResponse,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import { formatCount } from "../../../lib/format.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Button } from "../../../ui/Button.js";
import { FillRect } from "../../../ui/charts/FillRect.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Callout } from "../../../ui/Callout.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { useWriteGate } from "../../access/useCan.js";
import { useProduct } from "../../data/hooks.js";
import { reads } from "../../data/reads.js";
import { catalogQuery } from "../config/data.js";
import { Link, navigate, useLocation } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { hasSavedStepUp } from "../../../ui/ConfirmDialog.js";
import {
  PauseNoticeLine,
  PauseWritesDialog,
  stepUpKeyFor,
  type PauseNotice,
} from "./PauseWritesDialog.js";
import {
  PlatformPill,
  RowsSkeleton,
  TierRows,
  TotalStorage,
  WhatSyncs,
  WhoLine,
  type Usage,
} from "./SetupParts.js";
import { StorageDefaultDialog } from "./StorageDefaultDialog.js";
import { CeilingDialog } from "./CeilingDialog.js";
import { useProductCeilingSetting, useSyncUsage } from "./data.js";
import { SyncHeader } from "./SyncHeader.js";
import { formatBinaryBytes } from "./pages/SyncData.js";

const WRITES_PAUSED = "cloudSync.writesPaused";
const DEFAULT_QUOTA = "cloudSync.quota.defaultBytes";
const CEILING = "cloudSync.ceiling.bytes";

export function CloudSyncSetupPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const gate = useWriteGate("platform", null, "Platform");
  const platform = useQuery({
    ...reads.platformSettings(),
    retry: false,
    enabled: gate.allowed,
  });
  const catalog = useQuery({
    ...catalogQuery(slug),
    retry: false,
  });
  const usageQuery = useSyncUsage(slug);
  const usage: Usage | null = usageQuery.data?.enabled ? usageQuery.data : null;
  const ceilingQuery = useProductCeilingSetting(slug);
  const ceiling: ProductSetting | undefined = ceilingQuery.data?.settings.find(
    (x) => x.key === CEILING,
  );
  const ceilingGate = useWriteGate("sync", slug, "Cloud Sync");
  const [dialog, setDialog] = React.useState<
    null | "storage" | "pause" | "resume" | "ceiling"
  >(null);
  const resumeAsked = useLocation().route.query.get("resume") === "1";

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
  // The platform list is the live read for a platform admin; the usage read answers for everyone.
  const pausedKnown = paused !== undefined || usage !== null;
  const isPaused = paused ? paused.value === "on" : usage?.paused != null;
  const notice: PauseNotice | null = isPaused
    ? (usage?.paused ?? {
        since: paused?.stored?.updatedAt || null,
        by: null,
        reason: null,
      })
    : null;
  const propagation = platform.data?.propagationSeconds ?? 30;

  // Back from the step-up sign-in: reopen the pause dialog that was left, reason and all. Home's
  // "Resume writes" arrives with `?resume=1`: the dialog opens while writes are paused and the
  // member can edit the platform, and the URL loses the query so a reload does not reopen it.
  const reopened = React.useRef(false);
  React.useEffect(() => {
    if (reopened.current) return;
    if (gate.allowed && !paused) return;
    reopened.current = true;
    if (paused) {
      if (hasSavedStepUp(stepUpKeyFor(WRITES_PAUSED, "on"))) setDialog("pause");
      else if (hasSavedStepUp(stepUpKeyFor(WRITES_PAUSED, "off")))
        setDialog("resume");
      else if (resumeAsked && gate.allowed && paused.value === "on")
        setDialog("resume");
    }
    if (resumeAsked)
      navigate(r.syncSetup(slug), { replace: true, force: true });
  }, [paused, gate.allowed]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Who can change the platform controls, said at the controls (not once at the top of a page
  // whose product ceiling the same member can edit).
  const who = gate.disabledReason
    ? `Platform admins only. ${gate.disabledReason}`
    : "Platform admins only.";
  const readFailed = gate.allowed && platform.isError;
  const defaultBytes = quota ? quota.value : (usage?.defaultBytes ?? null);

  return (
    <div className="space-y-6" data-template="record">
      {header}

      {readFailed ? (
        <ErrorState
          error={platform.error}
          onRetry={() => void platform.refetch()}
        />
      ) : null}

      <div className="grid max-w-4xl gap-6 min-[1280px]:max-w-none min-[1280px]:grid-cols-[minmax(0,1fr)_22rem] min-[1280px]:items-start min-[1600px]:grid-cols-[minmax(0,56rem)_25rem]">
        {isPaused ? (
          <div className="order-[-2] col-span-full">
            <Callout
              tone="warning"
              title="Cloud Sync writes are paused for every product"
              action={
                gate.allowed && paused ? (
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
              {notice ? <PauseNoticeLine notice={notice} /> : null} Devices keep
              their changes and send them on resume.
            </Callout>
          </div>
        ) : null}

        <div className="min-w-0 space-y-6">
          <SettingsSection
            id="sync-storage"
            title="Storage per person"
            description={
              <>
                The{" "}
                <code className="font-mono text-xs">pkey.cloudSync.bytes</code>{" "}
                entitlement.
              </>
            }
            actions={
              <Link
                to={r.tiers(slug)}
                className="inline-flex items-center gap-1 py-1 text-sm text-accent-fg underline underline-offset-2"
              >
                Edit on Tiers
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            }
          >
            <div className="space-y-3 px-5 py-4">
              {drawn.quota && !readFailed ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-0 grow basis-full sm:basis-48">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-fg-strong">
                        Default <PlatformPill />
                      </p>
                      <p className="text-sm text-fg-muted">
                        For tiers that don&apos;t set their own
                      </p>
                    </div>
                    {defaultBytes !== null ? (
                      <p className="tabular-nums text-fg-strong">
                        {formatBinaryBytes(defaultBytes)}
                      </p>
                    ) : null}
                    {gate.allowed ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Change the default storage"
                        disabledReason={
                          quota ? undefined : "Not available yet."
                        }
                        onClick={() => setDialog("storage")}
                      >
                        Change…
                      </Button>
                    ) : null}
                  </div>
                  {!gate.allowed ? <WhoLine text={who} /> : null}
                </div>
              ) : null}

              {usageQuery.isPending ? <RowsSkeleton rows={3} tall /> : null}
              {usageQuery.isError ? (
                <ErrorState
                  compact
                  thing="Usage"
                  error={usageQuery.error}
                  onRetry={() => void usageQuery.refetch()}
                />
              ) : null}
              <TierRows
                slug={slug}
                usage={usage}
                defaultBytes={defaultBytes ?? 0}
              />

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3">
                <p className="text-sm text-fg-muted">
                  Lowering a limit deletes nothing. New saves wait for room.
                </p>
                <Link
                  to={r.syncUsage(slug)}
                  className="inline-flex items-center gap-1 py-1 text-sm text-accent-fg underline underline-offset-2"
                >
                  See Usage
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              </div>
            </div>
          </SettingsSection>

          {catalog.data ? (
            <WhatSyncs slug={slug} catalog={catalog.data} />
          ) : null}
        </div>

        <div className="order-[-1] min-w-0 min-[1280px]:order-none">
          <SettingsSection id="sync-limits" title="Product limits">
            <div className="space-y-5 px-5 py-4">
              <TotalStorage
                ceilingQuery={ceilingQuery}
                ceiling={ceiling}
                usage={usage}
                usageError={usageQuery.isError ? usageQuery.error : null}
                onRetryUsage={() => void usageQuery.refetch()}
                canEdit={ceilingGate.allowed}
                whoText={ceilingGate.disabledReason}
                onChange={() => setDialog("ceiling")}
              />

              {drawn.paused && !readFailed ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-fg-strong">
                    Pause all writes <PlatformPill />
                  </p>
                  <p className="text-sm text-fg-muted">
                    Stops new settings and saves in every product. Devices send
                    them on resume.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    {pausedKnown ? (
                      <StatusPill
                        tone={isPaused ? "warning" : "neutral"}
                        icon={isPaused ? undefined : false}
                        size="sm"
                      >
                        {isPaused ? "Paused" : "Off"}
                      </StatusPill>
                    ) : null}
                    {gate.allowed && !isPaused ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabledReason={
                          paused ? undefined : "Not available yet."
                        }
                        onClick={() => setDialog("pause")}
                      >
                        Pause writes…
                      </Button>
                    ) : null}
                  </div>
                  {!gate.allowed ? <WhoLine text={who} /> : null}
                </div>
              ) : null}
            </div>
          </SettingsSection>
        </div>
      </div>

      {quota ? (
        <StorageDefaultDialog
          open={dialog === "storage"}
          onOpenChange={(o) => setDialog(o ? "storage" : null)}
          setting={quota}
          propagationSeconds={propagation}
        />
      ) : null}
      {ceiling ? (
        <CeilingDialog
          open={dialog === "ceiling"}
          onOpenChange={(o) => setDialog(o ? "ceiling" : null)}
          slug={slug}
          setting={ceiling}
          usedBytes={usage ? usage.usage.bytes : null}
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
          notice={notice}
        />
      ) : null}
    </div>
  );
}
