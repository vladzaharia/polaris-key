import * as React from "react";
import type { PackReleaseDto, PackVariantDto } from "../../../api.js";
import { formatBytes, fromSeconds } from "../../../lib/format.js";
import { BINDING_LABELS, label } from "../../../lib/labels.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Hash } from "../../../ui/Hash.js";
import { Select } from "../../../ui/Select.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { Tooltip } from "../../../ui/Tooltip.js";
import { Version } from "../../../ui/Version.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { useProduct } from "../../data/hooks.js";
import { Link, codecs, navigate, useSearchParam } from "../../router.js";
import { productPage, r } from "../../routes.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { DeliverableLanes } from "./ChannelsPage.js";
import {
  useDeliverables,
  usePackReleases,
  useReleaseChannels,
} from "./data.js";
import { GateCell, PinnedCell } from "./DeliverablesPage.js";
import { PackFileBrowser } from "./PackFiles.js";
import { PackGateForm } from "./PackGateForm.js";
import { PolicyDialog, type PolicyAction } from "./PolicyDialog.js";
import { optionOfPackRelease, PackSigner } from "./shared.js";

/**
 * A pack's record (ADMIN.md §6.3.4, T3; PKD-1 to PKD-8): its declaration in the header, then
 * Releases (signer in gold, pinned-by links, Yank and Unyank), Channels (its lanes), Delivery (its
 * gate) and Files (the file browser). A release opens in a drawer (`?release=`) with its variants
 * as cards, their deltas and files.
 */

export type PackTab = "releases" | "channels" | "delivery" | "files";

/** A variant's parsed axes as `axis: value` chips (PKD-6). */
function AxisChips({ v }: { v: PackVariantDto }): React.ReactElement {
  const axes = Object.entries(v.variant);
  if (!axes.length)
    return <span className="text-xs text-fg-muted">Default variant</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {axes.map(([k, val]) => (
        <span
          key={k}
          className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-fg"
        >
          {k}: {val}
        </span>
      ))}
    </span>
  );
}

function VariantCard({
  slug,
  deliverable,
  release,
  v,
}: {
  slug: string;
  deliverable: string;
  release: PackReleaseDto;
  v: PackVariantDto;
}): React.ReactElement {
  const [files, setFiles] = React.useState(false);
  const name = v.variantKey || "default";
  return (
    <section
      aria-label={`Variant ${name}`}
      className="space-y-3 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AxisChips v={v} />
        {v.engine ? (
          <span className="text-xs text-fg-muted">Engine {v.engine}</span>
        ) : null}
      </div>
      <DescriptionList
        columns={2}
        items={[
          {
            term: "Payload",
            detail: (
              <span className="inline-flex flex-wrap items-center gap-2">
                {formatBytes(v.payload.size)}
                <Hash value={v.payload.sha256} label="payload SHA-256" />
              </span>
            ),
          },
          {
            term: "Full download",
            detail: v.fullBytes === null ? "—" : formatBytes(v.fullBytes),
          },
        ]}
      />
      <div className="space-y-1">
        <h4 className="text-xs text-fg-muted">Delta menu</h4>
        {v.deltas.length ? (
          <ul className="space-y-0.5 text-xs">
            {v.deltas.map((d, i) => (
              <li key={i}>
                <span className="font-bold">{d.scope}</span>
                {d.method ? (
                  <span className="text-fg-muted"> {d.method}</span>
                ) : null}{" "}
                from{" "}
                <span className="font-mono">
                  {d.fromVersion ??
                    (d.from ? `${d.from.slice(0, 12)}…` : "an unknown base")}
                </span>
                : {formatBytes(d.bytes)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">Full download only.</p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-expanded={files}
        onClick={() => setFiles((x) => !x)}
      >
        {files ? "Hide files" : "Show files"}
      </Button>
      {files ? (
        <PackFileBrowser
          slug={slug}
          deliverable={deliverable}
          releaseId={release.releaseId}
          variant={v.variantKey}
        />
      ) : null}
    </section>
  );
}

function PinnedBy({
  slug,
  release,
}: {
  slug: string;
  release: PackReleaseDto;
}): React.ReactElement {
  if (!release.pinnedBy.length)
    return <span className="text-fg-muted">No app release</span>;
  return (
    <ul aria-label="Pinned by" className="flex flex-wrap gap-x-2 gap-y-1">
      {release.pinnedBy.map((p) => (
        <li key={p.appReleaseId} className="inline-flex items-center gap-1">
          <EntityLink
            slug={slug}
            kind="release"
            id={p.appReleaseId}
            label={
              <span
                className={
                  p.appYank
                    ? "font-mono text-xs line-through"
                    : "font-mono text-xs"
                }
              >
                {p.appVersion ?? p.appReleaseId}
              </span>
            }
          />
          {p.appYank ? (
            <span className="text-xs text-fg-muted">(yanked)</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ReleaseDrawer({
  slug,
  deliverable,
  release,
  onClose,
}: {
  slug: string;
  deliverable: string;
  release: PackReleaseDto | undefined;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Drawer
      open={release !== undefined}
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={
        release ? (
          <span className="inline-flex items-center gap-2">
            {deliverable}{" "}
            <Version value={release.version} yanked={!!release.yank} />
          </span>
        ) : (
          deliverable
        )
      }
      description={
        release?.channel ? `Published to ${release.channel}` : undefined
      }
    >
      {release ? (
        <DrawerBody className="space-y-5">
          <DescriptionList
            columns={2}
            items={[
              {
                term: "Signed",
                detail: <PackSigner signer={release.signer} />,
              },
              {
                term: "Published",
                detail: release.publishedAt ? (
                  <Timestamp
                    at={fromSeconds(release.publishedAt)}
                    format="detail"
                  />
                ) : (
                  "—"
                ),
              },
              {
                term: "Record",
                detail: release.recordSha256 ? (
                  <Hash value={release.recordSha256} label="record SHA-256" />
                ) : (
                  "—"
                ),
              },
              {
                term: "Signed entitlement",
                detail: release.entitlement ? (
                  <span className="font-mono text-xs">
                    {release.entitlement}
                  </span>
                ) : (
                  "None"
                ),
              },
              {
                term: "Sequence",
                detail: release.seq === null ? "—" : String(release.seq),
              },
              {
                term: "Pinned by",
                detail: <PinnedBy slug={slug} release={release} />,
              },
            ]}
          />
          {release.yank ? (
            <Callout tone="warning" title="Yanked">
              {release.yank.reason}. Existing pins keep it; no new resolution
              picks it.
            </Callout>
          ) : null}
          <section className="space-y-3">
            <h3 className="text-sm font-bold text-fg-strong">
              Variants ({release.variants.length})
            </h3>
            {release.variants.length ? (
              release.variants.map((v) => (
                <VariantCard
                  key={v.variantKey}
                  slug={slug}
                  deliverable={deliverable}
                  release={release}
                  v={v}
                />
              ))
            ) : (
              <p className="text-sm text-fg-muted">
                This release's stored record does not read back.
              </p>
            )}
          </section>
        </DrawerBody>
      ) : null}
    </Drawer>
  );
}

function FilesTab({
  slug,
  deliverable,
  releases,
}: {
  slug: string;
  deliverable: string;
  releases: PackReleaseDto[];
}): React.ReactElement {
  const [releaseId, setReleaseId] = useSearchParam("release", codecs.string());
  const [variant, setVariant] = useSearchParam("variant", codecs.string());
  const release =
    releases.find((x) => x.releaseId === releaseId) ?? releases[0];
  const variants = release?.variants ?? [];
  const v =
    variants.find((x) => x.variantKey === variant) ?? variants[0] ?? null;
  if (!release)
    return (
      <EmptyState
        kind="first-run"
        title="No releases yet"
        description="CI publishes pack releases; once one exists its files are browsable here."
      />
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <span id="files-release" className="text-sm font-bold text-fg-strong">
            Release
          </span>
          <Select
            aria-labelledby="files-release"
            options={releases.map((x) => ({
              value: x.releaseId,
              label: x.version,
              description: x.yank ? "Yanked" : (x.channel ?? undefined),
            }))}
            value={release.releaseId}
            onChange={(id) => {
              setReleaseId(id ?? "");
            }}
          />
        </div>
        {variants.length > 1 ? (
          <div className="space-y-1.5">
            <span
              id="files-variant"
              className="text-sm font-bold text-fg-strong"
            >
              Variant
            </span>
            <Select
              aria-labelledby="files-variant"
              options={variants.map((x) => ({
                value: x.variantKey,
                label: x.variantKey || "default",
              }))}
              value={v?.variantKey ?? ""}
              onChange={(k) => setVariant(k ?? "")}
            />
          </div>
        ) : null}
      </div>
      {v ? (
        <PackFileBrowser
          slug={slug}
          deliverable={deliverable}
          releaseId={release.releaseId}
          variant={v.variantKey}
        />
      ) : (
        <p className="text-sm text-fg-muted">
          This release's stored record does not read back.
        </p>
      )}
    </div>
  );
}

export function PackRecord({
  slug,
  id,
  tab,
}: {
  slug: string;
  id: string;
  tab: string | undefined;
}): React.ReactElement {
  const list = useDeliverables(slug);
  const releasesQuery = usePackReleases(slug, id);
  const channelsQuery = useReleaseChannels(slug);
  const product = useProduct(slug);
  const [selected, setSelected] = useSearchParam("release", codecs.string());
  const [tableState, setTableState] = useTableUrlState("pack-releases");
  const [action, setAction] = React.useState<PolicyAction | null>(null);
  useLoadingAnnouncement("pack releases", releasesQuery.isPending);
  const distributionOn =
    product.data?.services?.distribution?.enabled !== false;
  const current: PackTab =
    tab === "channels" || tab === "delivery" || tab === "files"
      ? tab
      : "releases";

  const decl = list.data?.deliverables.find(
    (d) => d.id === id && d.kind === "pack",
  );
  const releases = releasesQuery.data?.releases ?? [];
  const lanes = channelsQuery.data?.deliverables.find(
    (d) => d.deliverable === id,
  );
  const crumbs = (
    <Breadcrumbs
      items={[
        { label: "Deliverables", to: r.deliverables(slug) },
        { label: id },
      ]}
    />
  );

  if (list.isPending) return <PageSkeleton template="record" label="pack" />;
  if (list.error && !list.data)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={crumbs} title={id} />
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          context={{
            thing: "Deliverable",
            collectionHref: r.deliverables(slug),
          }}
        />
      </div>
    );
  if (!decl)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={crumbs} title="Pack not found" />
        <EmptyState
          kind="not-found"
          title={`No pack ${id} in ${product.data?.name ?? slug}`}
          description="The release manifest no longer declares it, or the link is wrong."
          primaryAction={
            <Button asChild variant="outline">
              <Link to={r.deliverables(slug)}>All deliverables</Link>
            </Button>
          }
        />
      </div>
    );

  const currentPerChannel = (lanes?.channels ?? [])
    .filter((c) => c.resolved)
    .map((c) => ({
      channel: c.channel,
      version:
        releases.find((x) => x.releaseId === c.resolved)?.version ??
        c.resolved!,
    }));

  const columns: DataColumn<PackReleaseDto>[] = [
    {
      id: "version",
      header: "Version",
      accessorFn: (x) => x.version,
      sortingFn: (a, b) => (a.original.seq ?? 0) - (b.original.seq ?? 0),
      meta: {
        priority: 1,
        primary: true,
        label: "Version",
        alwaysVisible: true,
      },
      cell: ({ row }) => (
        <Tooltip
          content={
            row.original.seq === null
              ? "No sequence"
              : `Sequence ${row.original.seq}`
          }
        >
          <span>
            <Version
              value={row.original.version}
              yanked={!!row.original.yank}
            />
          </span>
        </Tooltip>
      ),
    },
    {
      id: "channel",
      header: "Channel",
      accessorFn: (x) => x.channel ?? "",
      meta: { priority: 2, label: "Channel" },
      cell: ({ row }) =>
        row.original.channel ?? <span className="text-fg-muted">—</span>,
    },
    {
      id: "published",
      header: "Published",
      accessorFn: (x) => x.publishedAt ?? 0,
      meta: { priority: 2, label: "Published" },
      cell: ({ row }) =>
        row.original.publishedAt ? (
          <Timestamp at={fromSeconds(row.original.publishedAt)} />
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      id: "variants",
      header: "Variants",
      accessorFn: (x) => x.variants.length,
      meta: { priority: 3, numeric: true, label: "Variants" },
    },
    {
      id: "signed",
      header: "Signed",
      enableSorting: false,
      meta: {
        priority: 2,
        label: "Signed",
        csv: (x) =>
          x.signer?.kind === "release"
            ? x.signer.kid
            : x.signer?.kind === "delegated"
              ? `${x.signer.scope}#${x.signer.seq}`
              : "",
      },
      cell: ({ row }) => <PackSigner signer={row.original.signer} />,
    },
    {
      id: "pinnedBy",
      header: "Pinned by",
      enableSorting: false,
      meta: {
        priority: 1,
        label: "Pinned by",
        csv: (x) =>
          x.pinnedBy.map((p) => p.appVersion ?? p.appReleaseId).join(" "),
      },
      cell: ({ row }) => <PinnedBy slug={slug} release={row.original} />,
    },
  ];

  const rowActions = (x: PackReleaseDto): RowActionItem[] =>
    x.yank
      ? [
          {
            label: "Unyank…",
            onSelect: () =>
              setAction({ kind: "unyank", release: optionOfPackRelease(x) }),
          },
        ]
      : [
          {
            label: "Yank…",
            tone: "danger",
            onSelect: () =>
              setAction({ kind: "yank", release: optionOfPackRelease(x) }),
          },
        ];

  const tabs = [
    {
      value: "releases",
      label: "Releases",
      count: decl.releaseCount,
      to: r.deliverable(slug, id, "releases"),
    },
    {
      value: "channels",
      label: "Channels",
      to: r.deliverable(slug, id, "channels"),
    },
    {
      value: "delivery",
      label: "Delivery",
      to: r.deliverable(slug, id, "delivery"),
    },
    { value: "files", label: "Files", to: r.deliverable(slug, id, "files") },
  ];

  return (
    <div className="space-y-6" data-template="record">
      <PageHeader
        eyebrow={crumbs}
        title={<span className="font-mono">{id}</span>}
        titleAside={
          <span className="inline-flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {decl.type ? (
              <span className="font-mono text-xs">{decl.type}</span>
            ) : null}
            {decl.binding ? (
              <StatusPill tone="neutral">
                {label(BINDING_LABELS, decl.binding)}
              </StatusPill>
            ) : null}
            {decl.required ? (
              <StatusPill tone="info">Required</StatusPill>
            ) : null}
            <PinnedCell d={decl} />
          </span>
        }
        description={
          <>
            Gate{" "}
            <GateCell
              slug={slug}
              d={decl}
              gateKnown={list.data?.gateKnown ?? true}
            />
            {" · "}
            {decl.latest ? (
              <>
                latest <span className="font-mono">{decl.latest.version}</span>
              </>
            ) : (
              "no release yet"
            )}
            {" · "}
            {decl.releaseCount}{" "}
            {decl.releaseCount === 1 ? "release" : "releases"}
          </>
        }
        secondaryActions={[
          {
            label: "Open in Compatibility",
            onSelect: () => navigate(r.compatibility(slug)),
          },
        ]}
        tabs={<PageTabs label="Pack" items={tabs} value={current} />}
        sticky
      />
      {!decl.declared ? (
        <Callout
          tone="warning"
          title="This pack's stored declaration does not read back"
        >
          A resync rewrites it; until then app releases that need it are
          refused.
        </Callout>
      ) : null}
      {current === "releases" ? (
        <div className="space-y-4">
          {currentPerChannel.length ? (
            <p className="text-sm text-fg">
              <span className="text-fg-muted">Current per channel: </span>
              {currentPerChannel.map((c, i) => (
                <React.Fragment key={c.channel}>
                  {i ? " · " : null}
                  {c.channel} <span className="font-mono">{c.version}</span>
                </React.Fragment>
              ))}
            </p>
          ) : null}
          <DataTable<PackReleaseDto>
            id="pack-releases"
            caption={`Releases of ${id}`}
            data={releases}
            columns={columns}
            getRowId={(x) => x.releaseId}
            rowLabel={(x) => x.version}
            rowHref={(x) =>
              productPage(slug, "deliverables", {
                id,
                tab: "releases",
                query: { release: x.releaseId },
              })
            }
            linkComponent={Link}
            rowActions={rowActions}
            state={tableState}
            onStateChange={setTableState}
            search={{
              placeholder: "Search versions",
              columns: ["version", "channel"],
            }}
            pagination={{ mode: "client" }}
            loading={releasesQuery.isPending}
            error={releasesQuery.error}
            onRetry={() => void releasesQuery.refetch()}
            mobile="cards"
            empty={
              <EmptyState
                kind="first-run"
                title="No releases yet"
                description="CI publishes pack releases; none has been published for this pack."
              />
            }
          />
          <ReleaseDrawer
            slug={slug}
            deliverable={id}
            release={releases.find((x) => x.releaseId === selected)}
            onClose={() => setSelected("")}
          />
        </div>
      ) : null}
      {current === "channels" ? (
        channelsQuery.isPending ? (
          <PageSkeleton template="record" label="channels" />
        ) : channelsQuery.error ? (
          <ErrorState
            error={channelsQuery.error}
            onRetry={() => void channelsQuery.refetch()}
          />
        ) : (
          <DeliverableLanes
            slug={slug}
            deliverable={id}
            channels={lanes?.channels ?? []}
            platforms={lanes?.platforms ?? []}
          />
        )
      ) : null}
      {current === "delivery" ? (
        <PackGateForm
          slug={slug}
          deliverable={decl}
          distributionOn={distributionOn}
        />
      ) : null}
      {current === "files" ? (
        releasesQuery.isPending ? (
          <PageSkeleton template="table" label="releases" />
        ) : releasesQuery.error ? (
          <ErrorState
            error={releasesQuery.error}
            onRetry={() => void releasesQuery.refetch()}
          />
        ) : (
          <FilesTab slug={slug} deliverable={id} releases={releases} />
        )
      ) : null}
      <PolicyDialog
        slug={slug}
        action={action}
        channels={lanes?.channels ?? []}
        releases={releases.map(optionOfPackRelease)}
        onClose={() => setAction(null)}
      />
    </div>
  );
}
