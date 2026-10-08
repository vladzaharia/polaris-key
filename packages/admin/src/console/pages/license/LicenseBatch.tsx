/**
 * Licence batches (LX-30; notes/S-24 §5.6, §7.1, §8.8, D10; LX-28's batch reads).
 *
 *   - **Batches** (`#/p/<slug>/license/batches`): every batch of the product, newest first, with
 *     how many of its keys were used. Reached from Licenses ("Batches", and the Batch filter).
 *   - **A batch** (`…/license/batches/<id>`): its label, when and by whom it was created, used of
 *     count, the plain statement that its keys cannot be downloaded again (the Worker kept only
 *     their hashes), a link to its licences, and **Disable unused keys…** for a batch whose CSV
 *     leaked: L3, typed with the batch label (the Worker compares). It disables only the batch's
 *     active licences that no device ever used; licences already in use keep working.
 */

import * as React from "react";
import { Power } from "lucide-react";
import { ApiError, type LicenseBatch } from "../../../api.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { Link, navigate } from "../../router.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../../ui/PageHeader.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Meter } from "../../../ui/charts/Meter.js";
import { Section } from "../../../ui/Section.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { intentOf } from "../core/confirmGate.js";
import { useLicenseBatch, useLicenseBatches } from "./holders.js";
import { actorName, useTiers } from "./shared.js";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ── Batches ──────────────────────────────────────────────────────────────────────────────────

export function LicenseBatchesPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = useLicenseBatches(slug);
  const me = useMe().data;
  const batches = q.data?.batches ?? [];
  const columns = React.useMemo<DataColumn<LicenseBatch>[]>(
    () => [
      {
        id: "label",
        header: "Batch",
        accessorKey: "label",
        meta: { priority: 1, primary: true },
        cell: ({ row }) => (
          <span
            className="block max-w-[22rem] truncate"
            title={row.original.label}
          >
            {row.original.label}
          </span>
        ),
      },
      {
        id: "created",
        header: "Created",
        accessorKey: "createdAt",
        meta: { priority: 1, numeric: true },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.createdAt)} format="date" />
        ),
      },
      {
        id: "by",
        header: "By",
        accessorFn: (b) => actorName(b.createdBy, me) ?? "",
        meta: { priority: 3 },
      },
      {
        id: "used",
        header: "Used",
        accessorKey: "used",
        meta: { priority: 1, numeric: true },
        cell: ({ row }) => (
          <div className="ml-auto w-28">
            <Meter
              label="Used"
              hideLabel
              value={row.original.used}
              max={row.original.count}
            />
          </div>
        ),
      },
      {
        id: "unused",
        header: "Unused",
        accessorKey: "unused",
        meta: { priority: 2, numeric: true },
      },
      {
        id: "disabled",
        header: "Disabled",
        accessorKey: "disabled",
        meta: { priority: 3, numeric: true },
      },
    ],
    [me],
  );
  return (
    <CollectionTemplate
      header={
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Licenses", to: r.licenses(slug) },
                { label: "Batches" },
              ]}
            />
          }
          title="Batches"
          titleAside={
            q.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {batches.length.toLocaleString()}
              </span>
            ) : null
          }
          description="Floating licenses created together under one label."
          refetching={q.isFetching && !q.isPending}
        />
      }
    >
      <DataTable<LicenseBatch>
        id="license-batches"
        caption="Batches"
        data={batches}
        columns={columns}
        getRowId={(b) => b.id}
        rowLabel={(b) => b.label}
        rowHref={(b) => r.licenseBatch(slug, b.id)}
        linkComponent={Link}
        search={{ placeholder: "Search labels", columns: ["label"] }}
        loading={q.isPending}
        error={q.error ?? undefined}
        onRetry={() => void q.refetch()}
        empty={
          <EmptyState
            kind="first-run"
            headingLevel={2}
            title="No batches yet"
            description="A batch is many floating licenses created at once, each with its own key."
            primaryAction={
              <Button
                variant="outline"
                onClick={() => navigate(r.licenses(slug))}
              >
                Back to licenses
              </Button>
            }
          />
        }
        mobile="cards"
      />
    </CollectionTemplate>
  );
}

// ── One batch ────────────────────────────────────────────────────────────────────────────────

export function LicenseBatchPage({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const q = useLicenseBatch(slug, id);
  const batch = q.data;
  const crumbs = (label: string) => (
    <Breadcrumbs
      items={[
        { label: "Licenses", to: r.licenses(slug) },
        { label: "Batches", to: r.licenseBatches(slug) },
        { label },
      ]}
    />
  );
  if (q.isPending) return <PageSkeleton template="record" label="batch" />;
  if (!batch) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={crumbs(id)}
          title={notFound ? "Batch not found" : "Batch"}
        />
        {notFound ? (
          <EmptyState
            kind="not-found"
            title="This batch doesn't exist"
            description="The link may have a typo, or the batch belongs to another product."
            primaryAction={
              <Button
                variant="outline"
                onClick={() => navigate(r.licenseBatches(slug))}
              >
                All batches
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ thing: "Batch", collectionHref: r.licenseBatches(slug) }}
          />
        )}
      </div>
    );
  }
  return (
    <BatchBody
      slug={slug}
      batch={batch}
      crumbs={crumbs(batch.label)}
      refetching={q.isFetching}
    />
  );
}

function BatchBody({
  slug,
  batch,
  crumbs,
  refetching,
}: {
  slug: string;
  batch: LicenseBatch;
  crumbs: React.ReactNode;
  refetching: boolean;
}): React.ReactElement {
  const me = useMe().data;
  const tiers = useTiers(slug).data?.tiers ?? [];
  const [confirming, setConfirming] = React.useState(false);
  const by = actorName(batch.createdBy, me);
  const tier = batch.tier
    ? (tiers.find((t) => t.id === batch.tier)?.label ?? batch.tier)
    : null;
  const unused = batch.unused;
  const policy = confirmFor("batch.disableUnused");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={crumbs}
        title={batch.label}
        description={
          <>
            Created{" "}
            <Timestamp at={fromSeconds(batch.createdAt)} format="date" />
            {by ? ` by ${by}` : ""}
          </>
        }
        primaryAction={
          <Button
            variant="outline"
            onClick={() => navigate(r.licenses(slug, { batch: batch.id }))}
          >
            Show its licenses
          </Button>
        }
        dangerActions={[
          {
            label: "Disable unused keys…",
            icon: <Power aria-hidden />,
            onSelect: () => setConfirming(true),
            disabledReason:
              unused === 0
                ? "Every active license of this batch has been used."
                : undefined,
          },
        ]}
        refetching={refetching}
      />

      <Callout tone="info" title="Keys can't be downloaded again">
        Polaris Key kept only a fingerprint of each key, so the CSV made when
        the batch was created is the only copy. If it leaked, disable the unused
        keys.
      </Callout>

      <Section title="Keys">
        <div className="space-y-5">
          <Meter
            label="Used"
            value={batch.used}
            max={batch.count}
            className="max-w-md"
          />
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Licenses",
                detail: batch.count.toLocaleString(),
              },
              {
                term: "Unused",
                detail: unused.toLocaleString(),
                help: "Active, and no device has ever entered the key.",
              },
              {
                term: "Disabled",
                detail: batch.disabled.toLocaleString(),
              },
              ...(tier ? [{ term: "Tier", detail: tier }] : []),
            ]}
          />
        </div>
      </Section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent={intentOf("batch.disableUnused")}
        title={`Disable the unused keys of ${batch.label}?`}
        consequences={[
          `${plural(unused, "license")} of this batch that no device has used ${unused === 1 ? "is" : "are"} disabled. Nobody can activate ${unused === 1 ? "it" : "them"} with the key.`,
          "Licenses already in use keep working.",
          "You can enable a license again from its record.",
        ]}
        confirmLabel={`Disable ${plural(unused, "unused key")}`}
        typedConfirmation={
          policy.typedConfirmation
            ? { value: batch.label, label: "Type the batch label to confirm:" }
            : undefined
        }
        describeError={(e) => errorCopy(e, { thing: "Batch" })}
        onConfirm={async () => {
          const res = await mutate(
            "disableUnusedLicenses",
            slug,
            batch.id,
            batch.label,
          );
          toast.success(
            res.disabled === 0
              ? "No unused keys to disable"
              : `${plural(res.disabled, "unused key")} disabled`,
          );
        }}
      />
    </div>
  );
}
