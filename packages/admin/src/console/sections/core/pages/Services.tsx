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
import { PageHeader } from "../../../../ui/PageHeader.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { useWriteGate } from "../../../access/useCan.js";
import { SettingsTemplate } from "../../../templates/Settings.js";
import { FeatureSection } from "../components/FeatureSection.js";
import { ServiceOffConfirmation } from "../components/ServiceOffConfirmation.js";
import {
  mergeEnabled,
  readEnabled,
  type FailedChange,
  type OffConfirmation,
  type PendingChange,
  type ServiceChange,
} from "../components/serviceFeatures.js";

export function ServicesPage({ slug }: { slug: string }): React.ReactElement {
  const query = useQuery({
    queryKey: qk.services(slug),
    queryFn: () => api.services(slug),
  });
  useLoadingAnnouncement("services", query.isPending);

  const header = (
    <PageHeader
      title="Services"
      refetching={query.isFetching && !query.isPending}
    />
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="services" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  return <ServicesForm slug={slug} data={query.data} header={header} />;
}

function ServicesForm({
  slug,
  data,
  header,
}: {
  slug: string;
  data: ServicesResponse;
  header: React.ReactNode;
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

  return (
    <SettingsTemplate
      header={header}
      sections={FEATURES.map((feature) => ({
        id: `feature-${feature.id}`,
        title: feature.label,
      }))}
    >
      {gate.disabledReason ? (
        <p role="note" className="text-sm text-fg-muted">
          {gate.disabledReason}
        </p>
      ) : null}
      {FEATURES.map((feature) => (
        <FeatureSection
          key={feature.id}
          feature={feature}
          slug={slug}
          enabled={enabled}
          facts={data.facts}
          effectiveRegistration={data.effectiveRegistration}
          busy={busy}
          locked={!gate.allowed}
          source={source}
          error={failure?.change.feature === feature.id ? failure : null}
          codes={failure?.change.feature === feature.id ? codes : []}
          onRequestChange={requestChange}
          onRetry={retry}
        />
      ))}

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
    </SettingsTemplate>
  );
}
