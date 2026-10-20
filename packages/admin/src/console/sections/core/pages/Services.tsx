/**
 * Core → Services: product-facing features over the Worker’s service slugs.
 *
 * The Worker owns the requirement rule. A feature may turn its own slugs on together (Ship
 * builds enables Release, Distribution and In-app updates in one PATCH), but the console never
 * pulls an external prerequisite on. Turning a requirement off is previewed with the same PATCH
 * the Worker will write, so the confirmation names the server’s actual cascade.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { ApiError, api, type ServicesResponse } from "../../../../api.js";
import { FEATURES } from "../../../../services.generated.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { AdvancedRows } from "../components/AdvancedRows.js";
import { FeatureRowItem } from "../components/FeatureRows.js";
import { SettingsPage as ProductDetails } from "./Settings.js";
import { ServiceOffConfirmation } from "../components/ServiceOffConfirmation.js";
import {
  mergeEnabled,
  readEnabled,
  type FailedChange,
  type OffConfirmation,
  type PendingChange,
  type ServiceChange,
} from "../components/serviceFeatures.js";

export function ServicesPage({
  slug,
  openDetails = false,
}: {
  slug: string;
  /** The product's own settings (name, origins, repository, danger zone) start unfolded. */
  openDetails?: boolean;
}): React.ReactElement {
  const query = useQuery({
    queryKey: qk.services(slug),
    queryFn: () => api.services(slug),
  });
  useLoadingAnnouncement("features", query.isPending);

  if (query.isPending) {
    return <PageSkeleton template="form" label="features" />;
  }
  if (query.isError) {
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }

  return (
    <ServicesForm slug={slug} data={query.data} openDetails={openDetails} />
  );
}

function ServicesForm({
  slug,
  data,
  openDetails,
}: {
  slug: string;
  data: ServicesResponse;
  openDetails: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const gate = useWriteGate("core", slug);
  const [pending, setPending] = React.useState<PendingChange | null>(null);
  const [failure, setFailure] = React.useState<FailedChange | null>(null);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [offConfirmation, setOffConfirmation] =
    React.useState<OffConfirmation | null>(null);
  const [confirmRevert, setConfirmRevert] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(openDetails);
  const product = useProduct(slug);

  const saved = React.useMemo(() => readEnabled(data), [data]);
  const enabled =
    pending?.phase === "write"
      ? mergeEnabled(saved, pending.change.body)
      : saved;
  const busy = pending !== null || reverting;

  const commit = async (change: ServiceChange): Promise<void> => {
    setCodes([]);
    setFailure(null);
    setPending({ change, phase: "write" });
    try {
      const next = await mutate("updateServices", slug, change.body);
      // PATCH has the same shape as GET, including facts, so this is a complete replacement.
      queryClient.setQueryData(qk.services(slug), next);
      toast.success(`${change.label} turned ${change.on ? "on" : "off"}`);
    } catch (error) {
      const errors = error instanceof ApiError ? error.errors : undefined;
      if (errors?.length) setCodes(errors);
      setFailure({ change, phase: "write", error });
      throw error;
    } finally {
      setPending(null);
    }
  };

  const prepareOff = async (change: ServiceChange): Promise<void> => {
    setCodes([]);
    setFailure(null);
    setPending({ change, phase: "dry-run" });
    try {
      const dryRun = await mutate("servicesDryRun", slug, change.body);
      setOffConfirmation({ change, dryRun });
    } catch (error) {
      setFailure({ change, phase: "dry-run", error });
    } finally {
      setPending(null);
    }
  };

  const requestChange = (change: ServiceChange): void => {
    if (change.on) {
      void commit(change).catch(() => undefined);
      return;
    }
    void prepareOff(change);
  };

  const retry = (): void => {
    if (!failure) return;
    if (failure.phase === "dry-run") void prepareOff(failure.change);
    else void commit(failure.change).catch(() => undefined);
  };

  const source = data.source === "admin" ? "admin" : "manifest";

  const ctx = {
    slug,
    name: product.data?.name ?? slug,
    enabled,
    facts: data.facts,
    pending,
    failure,
    codes,
    busy,
    locked: !gate.allowed,
    onRequestChange: requestChange,
    onRetry: retry,
  };

  return (
    <div className="space-y-6" data-template="features">
      {gate.disabledReason ? (
        <p role="note" className="text-sm text-fg-muted">
          {gate.disabledReason}
        </p>
      ) : null}
      <section
        aria-label="Features"
        className="overflow-hidden rounded-lg border border-border bg-surface-raised"
      >
        <div
          aria-hidden
          className="hidden items-center gap-x-4 border-b border-border bg-surface-sunken px-5 py-2.5 text-sm font-medium text-fg-strong sm:grid sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,18rem)_auto]"
        >
          <span className="w-8" />
          <span>Feature</span>
          <span>Status</span>
          <span className="w-9" />
        </div>
        <ul className="divide-y divide-border">
          {FEATURES.map((feature) => (
            <FeatureRowItem key={feature.id} feature={feature} ctx={ctx} />
          ))}
        </ul>
        <AdvancedRows
          enabled={enabled}
          effectiveRegistration={data.effectiveRegistration}
          detailsOpen={detailsOpen}
          onDetails={setDetailsOpen}
        />
      </section>
      {detailsOpen ? (
        <div id="feature-details-panel">
          <ProductDetails slug={slug} />
        </div>
      ) : null}

      <ServiceOffConfirmation
        confirmation={offConfirmation}
        onOpenChange={(open) => {
          if (!open) setOffConfirmation(null);
        }}
        onConfirm={async () => {
          if (!offConfirmation) return;
          await commit(offConfirmation.change);
        }}
      />

      <ConfirmDialog
        open={confirmRevert}
        onOpenChange={setConfirmRevert}
        intent="caution"
        title="Revert services to the manifest?"
        description="Ownership of this product’s service set returns to its repo manifest."
        consequences={[
          "Nothing changes now: the services stay as they are.",
          "The manifest’s values apply on the next resync (a push, or Resync from repo).",
        ]}
        confirmLabel="Revert to manifest"
        describeError={(error) => errorCopy(error)}
        onConfirm={async () => {
          setReverting(true);
          try {
            const next = await mutate("revertServices", slug);
            queryClient.setQueryData(qk.services(slug), next);
            toast.success("Services follow the manifest again");
          } finally {
            setReverting(false);
          }
        }}
      />

      {data.source === "admin" ? (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            iconStart={<Undo2 aria-hidden />}
            disabled={busy || !gate.allowed}
            onClick={() => setConfirmRevert(true)}
          >
            Revert to manifest…
          </Button>
        </div>
      ) : null}
    </div>
  );
}
