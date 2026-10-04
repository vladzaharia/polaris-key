/**
 * Distribution → Outlets & feeds (ADMIN.md §6.4, T2 + drawer): the outlets the manifest declares
 * (`GET …/distribution/outlets`, an API with no console UI before chunk 9), what each permits,
 * its storefront feed URLs, and the distribution signing-key inventory.
 *
 * - An outlet opens in a drawer routed by `?outlet=<id>` (the `EntityLink` "outlet" target).
 * - **Narrow capabilities…** (L1) can only narrow below the kind's default; **Revert to
 *   manifest** (L1) restores the default.
 * - Feeds: for the feed-capable kinds, one public URL per channel, from the documented scheme
 *   (`docs/services/distribution/feeds.md`), with copy.
 * - Keys: `GET/PUT/DELETE …/distribution/keys`, the inventory and CI's unmatched observations.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import type {
  CapabilityKey,
  DistributionKeyDto,
  DistributionKeyObservationDto,
  OutletCapabilitiesDto,
  OutletDto,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { humanize } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { FormField } from "../../../ui/form.js";
import { Hash } from "../../../ui/Hash.js";
import { Input } from "../../../ui/Input.js";
import { Popover } from "../../../ui/Popover.js";
import { Select } from "../../../ui/Select.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Textarea } from "../../../ui/Textarea.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { Link, useSearchParam } from "../../router.js";
import { Panel } from "../../templates/Dashboard.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import {
  hrefWithQuery,
  patchQuery,
  QUERY,
  useDistributionKeys,
  useOutlets,
  useReleaseStore,
} from "./data.js";
import {
  BINARY_ORDER,
  BINARY_UPDATE_LABEL,
  CAPABILITY_HELP,
  CAPABILITY_LABEL,
  capabilityValue,
  COMMERCE_LABEL,
  FEED_KINDS,
  outletKindLabel,
  publicUrl,
} from "./format.js";

const describe = (thing: string) => (e: unknown) =>
  errorCopy(e, { area: "distribution", thing });

/** The channels a feed is published for: Release's channel pointers, `stable` at least. */
function useChannels(slug: string): string[] {
  const store = useReleaseStore(slug);
  return React.useMemo(() => {
    const set = new Set<string>(["stable"]);
    for (const c of store.data?.channels ?? []) set.add(c.channel);
    return [...set].sort((a, b) =>
      a === "stable" ? -1 : b === "stable" ? 1 : a.localeCompare(b),
    );
  }, [store.data]);
}

const FEED_RULES = (
  <div className="max-w-sm space-y-2 text-sm">
    <p className="font-bold text-fg-strong">Which releases a feed lists</p>
    <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
      <li>
        The channel serves them (beta includes stable; yanked ones drop out).
      </li>
      <li>They have a build for the outlet.</li>
      <li>They are live on the outlet, or the outlet is self-hosted.</li>
      <li>No rollout, halt or readiness hold keeps them back.</li>
      <li>Their payload has an immutable delivery URL.</li>
    </ol>
  </div>
);

function FeedLinks({
  slug,
  outlet,
  channels,
  compact = false,
}: {
  slug: string;
  outlet: OutletDto;
  channels: string[];
  compact?: boolean;
}): React.ReactElement | null {
  const feed = FEED_KINDS[outlet.kind];
  if (!feed) return null;
  if (compact)
    return (
      <span className="text-sm text-fg">
        {feed.label} · {channels.length}{" "}
        {channels.length === 1 ? "channel" : "channels"}
      </span>
    );
  return (
    <ul className="space-y-2" aria-label={`${feed.label} URLs`}>
      {channels.map((c) => {
        const url = publicUrl(slug, `distribution/${feed.path(c)}`);
        return (
          <li key={c} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs font-bold text-fg-muted">
              {c}
            </span>
            <code className="min-w-0 flex-1 truncate rounded-sm bg-surface-sunken px-2 py-1 font-mono text-xs">
              {url}
            </code>
            <CopyButton value={url} label={`Copy the ${c} ${feed.label} URL`} />
          </li>
        );
      })}
    </ul>
  );
}

function capabilitySummary(o: OutletDto): string {
  const c = o.capabilities;
  if (!c) return "Unknown kind";
  const on = (
    [
      "codeUpdates",
      "dataUpdates",
      "channelSwitch",
      "downloadedScripts",
    ] as const
  )
    .filter((k) => c[k])
    .map((k) => CAPABILITY_LABEL[k]!.toLowerCase());
  return [BINARY_UPDATE_LABEL[c.binaryUpdates] ?? c.binaryUpdates, ...on].join(
    " · ",
  );
}

export function OutletsPage({ slug }: { slug: string }): React.ReactElement {
  const outlets = useOutlets(slug);
  const channels = useChannels(slug);
  const [openId] = useSearchParam("outlet", QUERY.outlet);
  const [state, setState] = useTableUrlState("outlets", {
    facets: ["kind"],
    namespace: true,
  });
  const live = React.useMemo(
    () => (outlets.data?.outlets ?? []).filter((o) => o.removedAt === null),
    [outlets.data],
  );
  const kinds = [...new Set(live.map((o) => o.kind))].sort();
  const open = live.find((o) => o.outletId === openId);

  const columns: DataColumn<OutletDto>[] = [
    {
      id: "outlet",
      header: "Outlet",
      accessorKey: "outletId",
      meta: { priority: 1, primary: true },
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap">{getValue() as string}</span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      accessorKey: "kind",
      meta: { priority: 1, csv: (o) => outletKindLabel(o.kind) },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {outletKindLabel(row.original.kind)}
        </span>
      ),
    },
    {
      id: "transport",
      header: "Transport",
      accessorFn: (o) => o.transports.map((t) => t.transport).join(", "),
      meta: { priority: 2 },
      cell: ({ row }) => {
        const ts = row.original.transports;
        if (ts.length === 0)
          return <span className="text-fg-subtle">pkey-cdn</span>;
        return (
          <span className="flex flex-col gap-0.5">
            {ts.map((t) => (
              <span
                key={`${t.deliverableId}:${t.transport}`}
                className="text-xs"
              >
                <span className="font-mono">{t.transport}</span>
                {t.deliverableId !== "app" ? ` (${t.deliverableId})` : ""}
                {t.supported ? "" : " · not delivered by Polaris Key"}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      id: "capabilities",
      header: "Capabilities",
      accessorFn: (o) => capabilitySummary(o),
      meta: { priority: 2 },
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <span
            className="line-clamp-2 max-w-[22rem] text-sm text-fg"
            title={capabilitySummary(row.original)}
          >
            {capabilitySummary(row.original)}
          </span>
          {row.original.capabilitiesSource === "admin" ? (
            <StatusPill tone="info" size="sm">
              Narrowed in console
            </StatusPill>
          ) : null}
        </span>
      ),
    },
    {
      id: "feeds",
      header: "Feeds",
      accessorFn: (o) => (FEED_KINDS[o.kind] ? FEED_KINDS[o.kind]!.label : ""),
      meta: { priority: 2 },
      cell: ({ row }) =>
        FEED_KINDS[row.original.kind] ? (
          <FeedLinks
            slug={slug}
            outlet={row.original}
            channels={channels}
            compact
          />
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-8" data-template="collection">
      <PageHeader
        title="Outlets & feeds"
        titleAside={
          outlets.data ? (
            <span className="text-sm tabular-nums text-fg-muted">
              {live.length}
            </span>
          ) : undefined
        }
        description="Outlets come from .pkey/distribution."
        meta={
          <Popover
            label="Feed listing rules"
            trigger={
              <Button variant="link" size="sm">
                Which releases a feed lists
              </Button>
            }
          >
            {FEED_RULES}
          </Popover>
        }
        refetching={outlets.isFetching && !outlets.isPending}
      />

      <DataTable<OutletDto>
        id="outlets"
        caption="Outlets"
        data={live}
        columns={columns}
        getRowId={(o) => o.outletId}
        rowHref={(o) => hrefWithQuery({ outlet: o.outletId })}
        linkComponent={Link}
        rowActions={(o) => [
          {
            label: "Open",
            onSelect: () => patchQuery({ outlet: o.outletId }, { push: true }),
          },
        ]}
        state={state}
        onStateChange={setState}
        search={{ placeholder: "Search outlets", columns: ["outlet", "kind"] }}
        facets={[
          {
            id: "kind",
            label: "Kind",
            options: kinds.map((k) => ({
              value: k,
              label: outletKindLabel(k),
            })),
          },
        ]}
        loading={outlets.isPending}
        error={outlets.isError && !outlets.data ? outlets.error : undefined}
        onRetry={() => void outlets.refetch()}
        mobile="cards"
        exportCsv={false}
        empty={
          <EmptyState
            kind="first-run"
            title="No outlets declared"
            description="Outlets are where a release reaches people: the direct download, the stores, AltStore, F-Droid, Flathub. Declare them under outlets in .pkey/distribution and resync."
            docs="/docs/services/distribution/"
          />
        }
      />

      <KeysSection slug={slug} outlets={live} />

      <OutletDrawer
        slug={slug}
        outlet={open}
        missing={openId !== "" && !open && !outlets.isPending ? openId : null}
        channels={channels}
        capabilityKeys={outlets.data?.capabilityKeys ?? []}
        onClose={() => patchQuery({ outlet: null })}
      />
    </div>
  );
}

function OutletDrawer({
  slug,
  outlet,
  missing,
  channels,
  capabilityKeys,
  onClose,
}: {
  slug: string;
  outlet: OutletDto | undefined;
  missing: string | null;
  channels: string[];
  capabilityKeys: CapabilityKey[];
  onClose: () => void;
}): React.ReactElement {
  const [narrowing, setNarrowing] = React.useState(false);
  const [reverting, setReverting] = React.useState(false);
  const open = Boolean(outlet) || missing !== null;
  const identity = outlet ? Object.entries(outlet.identity) : [];
  return (
    <>
      <Drawer
        open={open && !narrowing}
        onOpenChange={(o) => !o && onClose()}
        size="lg"
        title={outlet ? outlet.outletId : "Outlet not found"}
        description={outlet ? outletKindLabel(outlet.kind) : undefined}
      >
        <DrawerBody className="space-y-6">
          {!outlet ? (
            <Callout tone="warning" title={`No outlet ${missing ?? ""}`}>
              It is not declared in .pkey/distribution any more, or the link is
              out of date.
            </Callout>
          ) : (
            <>
              <section className="space-y-2" aria-label="Identity">
                <h3 className="text-sm font-bold text-fg-strong">Identity</h3>
                {identity.length ? (
                  <DescriptionList
                    columns={2}
                    items={identity.map(([k, v]) => ({
                      term: humanize(k),
                      detail: (
                        <span className="font-mono text-xs">
                          {typeof v === "string" ? v : JSON.stringify(v)}
                        </span>
                      ),
                    }))}
                  />
                ) : (
                  <p className="text-sm text-fg-muted">
                    No identity fields declared.
                  </p>
                )}
                <p className="text-xs text-fg-muted">
                  Declared <Timestamp at={fromSeconds(outlet.createdAt)} /> ·
                  changed <Timestamp at={fromSeconds(outlet.modifiedAt)} />
                </p>
              </section>

              <section className="space-y-3" aria-label="Capabilities">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-fg-strong">
                      Capabilities
                    </h3>
                    <SourceBadge
                      source={
                        outlet.capabilitiesSource === "admin"
                          ? "admin"
                          : "manifest"
                      }
                      path=".pkey/distribution"
                      onRevert={
                        outlet.capabilitiesSource === "admin"
                          ? () => setReverting(true)
                          : undefined
                      }
                    />
                  </span>
                  {outlet.capabilities ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setNarrowing(true)}
                    >
                      Narrow capabilities…
                    </Button>
                  ) : null}
                </div>
                {outlet.capabilities ? (
                  <DescriptionList
                    columns={2}
                    items={capabilityKeys.map((k) => ({
                      term: CAPABILITY_LABEL[k] ?? k,
                      detail: capabilityValue(k, outlet.capabilities![k]),
                      help:
                        outlet.defaultCapabilities &&
                        outlet.defaultCapabilities[k] !==
                          outlet.capabilities![k]
                          ? `Kind default: ${capabilityValue(k, outlet.defaultCapabilities[k])}`
                          : undefined,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-fg-muted">
                    This build has no defaults for the {outlet.kind} kind, so it
                    carries no capabilities.
                  </p>
                )}
              </section>

              <section className="space-y-2" aria-label="Transports">
                <h3 className="text-sm font-bold text-fg-strong">Transports</h3>
                {outlet.transports.length ? (
                  <ul className="space-y-1 text-sm">
                    {outlet.transports.map((t) => (
                      <li key={`${t.deliverableId}:${t.transport}`}>
                        <span className="font-mono text-xs">{t.transport}</span>{" "}
                        for{" "}
                        {t.deliverableId === "app"
                          ? "the app"
                          : t.deliverableId}
                        {t.supported
                          ? ""
                          : " · recorded, not delivered by Polaris Key"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Polaris Key's own CDN (pkey-cdn) for every deliverable.
                  </p>
                )}
              </section>

              {FEED_KINDS[outlet.kind] ? (
                <section className="space-y-2" aria-label="Feeds">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-bold text-fg-strong">
                      {FEED_KINDS[outlet.kind]!.label}
                    </h3>
                    <Popover
                      label="Feed listing rules"
                      trigger={
                        <Button variant="link" size="xs">
                          Which releases it lists
                        </Button>
                      }
                    >
                      {FEED_RULES}
                    </Popover>
                  </div>
                  <FeedLinks slug={slug} outlet={outlet} channels={channels} />
                </section>
              ) : null}
            </>
          )}
        </DrawerBody>
      </Drawer>
      {outlet ? (
        <ConfirmDialog
          open={reverting}
          onOpenChange={setReverting}
          intent="caution"
          title={`Revert ${outlet.outletId}'s capabilities to the manifest?`}
          consequences={[
            `The ${outletKindLabel(outlet.kind)} defaults apply again at once.`,
            "The SDKs read the wider set on their next configuration fetch.",
          ]}
          confirmLabel="Revert to manifest"
          describeError={describe("Outlet")}
          onConfirm={async () => {
            await mutate("revertOutletCapabilities", slug, outlet.outletId);
            toast.success(
              `Reverted ${outlet.outletId}'s capabilities to the manifest`,
            );
          }}
        />
      ) : null}
      {outlet && narrowing ? (
        <NarrowDrawer
          slug={slug}
          outlet={outlet}
          capabilityKeys={capabilityKeys}
          onClose={() => setNarrowing(false)}
        />
      ) : null}
    </>
  );
}

/** Values a capability may take below `base` (narrowing only). */
function narrowerValues(
  key: CapabilityKey,
  base: OutletCapabilitiesDto,
): string[] {
  const v = base[key];
  if (typeof v === "boolean") return v ? ["true", "false"] : ["false"];
  if (key === "binaryUpdates") {
    const i = (BINARY_ORDER as readonly string[]).indexOf(String(v));
    return i === -1 ? [String(v)] : BINARY_ORDER.slice(i).map(String);
  }
  if (key === "commerce") return v === "none" ? ["none"] : [String(v), "none"];
  return [String(v)];
}

function NarrowDrawer({
  slug,
  outlet,
  capabilityKeys,
  onClose,
}: {
  slug: string;
  outlet: OutletDto;
  capabilityKeys: CapabilityKey[];
  onClose: () => void;
}): React.ReactElement {
  const base = outlet.defaultCapabilities ?? outlet.capabilities!;
  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      capabilityKeys.map((k) => [
        k,
        String(outlet.capabilities?.[k] ?? base[k]),
      ]),
    ),
  );
  const [confirming, setConfirming] = React.useState(false);
  const changed = capabilityKeys.filter(
    (k) => draft[k] !== String(outlet.capabilities?.[k] ?? base[k]),
  );
  const body = (): Partial<OutletCapabilitiesDto> =>
    Object.fromEntries(
      capabilityKeys
        .filter((k) => draft[k] !== String(base[k]))
        .map((k) => [
          k,
          typeof base[k] === "boolean" ? draft[k] === "true" : draft[k],
        ]),
    ) as Partial<OutletCapabilitiesDto>;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Narrow ${outlet.outletId}`}
      description={`Below the ${outletKindLabel(outlet.kind)} default only. Revert to manifest restores it.`}
    >
      <DrawerBody className="space-y-4">
        {capabilityKeys.map((k) => {
          const options = narrowerValues(k, base);
          return (
            <FormField<string | null>
              key={k}
              name={`cap-${k}`}
              label={CAPABILITY_LABEL[k] ?? k}
              help={CAPABILITY_HELP[k]}
              value={draft[k] ?? null}
              onChange={(v) =>
                setDraft((d) => ({ ...d, [k]: v ?? String(base[k]) }))
              }
              dirty={changed.includes(k)}
            >
              {(field) => (
                <Select
                  {...field}
                  ref={undefined}
                  disabled={options.length < 2}
                  options={options.map((v) => ({
                    value: v,
                    label:
                      v === "true"
                        ? "Allowed"
                        : v === "false"
                          ? "Not allowed"
                          : k === "binaryUpdates"
                            ? (BINARY_UPDATE_LABEL[v] ?? v)
                            : (COMMERCE_LABEL[v] ?? v),
                  }))}
                />
              )}
            </FormField>
          );
        })}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabledReason={
            changed.length === 0 ? "Change a capability first." : undefined
          }
          onClick={() => setConfirming(true)}
        >
          Review narrowing…
        </Button>
      </DrawerFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        intent="caution"
        title={`Narrow ${outlet.outletId}'s capabilities?`}
        consequences={changed.map(
          (k) =>
            `${CAPABILITY_LABEL[k]}: ${capabilityValue(k, outlet.capabilities?.[k])} → ${capabilityValue(
              k,
              typeof base[k] === "boolean" ? draft[k] === "true" : draft[k],
            )}`,
        )}
        confirmLabel="Narrow capabilities"
        describeError={describe("Outlet")}
        onConfirm={async () => {
          const b = body();
          if (Object.keys(b).length === 0) {
            await mutate("revertOutletCapabilities", slug, outlet.outletId);
          } else {
            await mutate("narrowOutletCapabilities", slug, outlet.outletId, b);
          }
          toast.success(`Narrowed ${outlet.outletId}'s capabilities`);
          onClose();
        }}
      />
    </Drawer>
  );
}

// ── Distribution keys ──────────────────────────────────────────────────────────────────────────

const PURPOSE_LABEL: Record<string, string> = {
  "android-app-signing": "Android app signing",
  "android-upload": "Android upload",
  "android-sideload": "Android sideload",
  "fdroid-repo": "F-Droid repository",
  "sparkle-ed25519": "Sparkle EdDSA",
  release: "Release signing",
  "msix-publisher": "MSIX publisher",
};

const purposeLabel = (p: string) => PURPOSE_LABEL[p] ?? humanize(p);

interface KeyDraft {
  purpose: string;
  sha256: string;
  outlet: string | null;
  notes: string;
  registered: boolean;
  /** Editing an existing entry (purpose and fingerprint fixed). */
  existing: boolean;
}

function KeysSection({
  slug,
  outlets,
}: {
  slug: string;
  outlets: OutletDto[];
}): React.ReactElement {
  const keys = useDistributionKeys(slug);
  const [state, setState] = useTableUrlState("keys", {
    facets: ["purpose"],
    namespace: true,
  });
  const [draft, setDraft] = React.useState<KeyDraft | null>(null);
  const [removing, setRemoving] = React.useState<DistributionKeyDto | null>(
    null,
  );
  const [dismissing, setDismissing] =
    React.useState<DistributionKeyObservationDto | null>(null);
  const purposes = keys.data?.purposes ?? Object.keys(PURPOSE_LABEL);
  const observations = keys.data?.observations ?? [];

  const columns: DataColumn<DistributionKeyDto>[] = [
    {
      id: "purpose",
      header: "Purpose",
      accessorKey: "purpose",
      meta: { priority: 1, csv: (k) => purposeLabel(k.purpose) },
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <span>{purposeLabel(row.original.purpose)}</span>
          {row.original.flagged ? (
            <StatusPill tone="warning" size="sm">
              CI saw another key
            </StatusPill>
          ) : null}
        </span>
      ),
    },
    {
      id: "sha256",
      header: "SHA-256",
      accessorKey: "sha256",
      meta: { priority: 1, mono: true },
      cell: ({ row }) => <Hash value={row.original.sha256} label="SHA-256" />,
    },
    {
      id: "outlet",
      header: "Outlet",
      accessorFn: (k) => k.outletId ?? "",
      meta: { priority: 2 },
      cell: ({ row }) =>
        row.original.outletId ?? <span className="text-fg-subtle">Any</span>,
    },
    {
      id: "registered",
      header: "Registered",
      accessorFn: (k) => (k.registered ? "yes" : "no"),
      meta: { priority: 2 },
      cell: ({ row }) =>
        row.original.registered ? (
          <StatusPill tone="success" size="sm">
            Registered
          </StatusPill>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "notes",
      header: "Notes",
      accessorFn: (k) => k.notes ?? "",
      meta: { priority: 3 },
    },
  ];

  const rowActions = (k: DistributionKeyDto): RowActionItem[] => [
    {
      label: "Edit…",
      onSelect: () =>
        setDraft({
          purpose: k.purpose,
          sha256: k.sha256,
          outlet: k.outletId,
          notes: k.notes ?? "",
          registered: k.registered,
          existing: true,
        }),
    },
    { type: "separator" },
    { label: "Remove…", tone: "danger", onSelect: () => setRemoving(k) },
  ];

  return (
    <Panel
      title="Distribution keys"
      description="CI flags any key it sees that matches no entry here."
      action={
        <Button
          size="sm"
          iconStart={<Plus aria-hidden />}
          onClick={() =>
            setDraft({
              purpose: purposes[0] ?? "release",
              sha256: "",
              outlet: null,
              notes: "",
              registered: false,
              existing: false,
            })
          }
        >
          Add key…
        </Button>
      }
    >
      <div className="space-y-4">
        {observations.length ? (
          <Callout tone="warning" title="Keys CI saw that match no entry">
            <ul className="mt-2 space-y-2">
              {observations.map((o) => (
                <li
                  key={`${o.purpose}:${o.sha256}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{purposeLabel(o.purpose)}</span>
                    <Hash value={o.sha256} label="SHA-256" />
                    <span className="text-xs text-fg-muted">
                      first seen <Timestamp at={fromSeconds(o.firstSeenAt)} />
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        setDraft({
                          purpose: o.purpose,
                          sha256: o.sha256,
                          outlet: o.outletId,
                          notes: "",
                          registered: false,
                          existing: true,
                        })
                      }
                    >
                      Add to inventory…
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setDismissing(o)}
                    >
                      Dismiss…
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        <DataTable<DistributionKeyDto>
          id="keys"
          caption="Distribution keys"
          mobile="cards"
          data={keys.data?.keys ?? []}
          columns={columns}
          getRowId={(k) => `${k.purpose}:${k.sha256}`}
          rowLabel={(k) => `${purposeLabel(k.purpose)} key`}
          rowActions={rowActions}
          state={state}
          onStateChange={setState}
          facets={[
            {
              id: "purpose",
              label: "Purpose",
              options: purposes.map((p) => ({
                value: p,
                label: purposeLabel(p),
              })),
            },
          ]}
          loading={keys.isPending}
          error={keys.isError && !keys.data ? keys.error : undefined}
          onRetry={() => void keys.refetch()}
          exportCsv={false}
          empty={
            <EmptyState
              kind="first-run"
              title="No keys in the inventory"
              description="List the fingerprints of the keys that sign your Android, F-Droid, Sparkle and MSIX builds, so a build signed by anything else is flagged."
            />
          }
        />
      </div>

      {draft ? (
        <KeyDrawer
          slug={slug}
          draft={draft}
          purposes={purposes}
          outlets={outlets}
          onClose={() => setDraft(null)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        intent="caution"
        title={
          removing ? `Remove the ${purposeLabel(removing.purpose)} key?` : ""
        }
        consequences={[
          "Builds signed with it are flagged from the next CI report.",
          "Add it again at any time with the same fingerprint.",
        ]}
        confirmLabel="Remove key"
        describeError={describe("Key")}
        onConfirm={async () => {
          if (!removing) return;
          await mutate(
            "deleteDistributionKey",
            slug,
            removing.purpose,
            removing.sha256,
          );
          toast.success(`Removed the ${purposeLabel(removing.purpose)} key`);
        }}
      />
      <ConfirmDialog
        open={dismissing !== null}
        onOpenChange={(o) => !o && setDismissing(null)}
        intent="caution"
        title={
          dismissing
            ? `Dismiss the ${purposeLabel(dismissing.purpose)} key CI saw?`
            : ""
        }
        consequences={[
          "The observation is cleared; CI flags the key again if it sees it again.",
        ]}
        confirmLabel="Dismiss"
        describeError={describe("Key")}
        onConfirm={async () => {
          if (!dismissing) return;
          await mutate(
            "deleteDistributionKey",
            slug,
            dismissing.purpose,
            dismissing.sha256,
          );
          toast.success("Dismissed the observation");
        }}
      />
    </Panel>
  );
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

function KeyDrawer({
  slug,
  draft: initial,
  purposes,
  outlets,
  onClose,
}: {
  slug: string;
  draft: KeyDraft;
  purposes: string[];
  outlets: OutletDto[];
  onClose: () => void;
}): React.ReactElement {
  const [d, setD] = React.useState(initial);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const sha = d.sha256.trim().toLowerCase().replace(/:/g, "");
    const next: Record<string, string> = {};
    if (!FINGERPRINT.test(sha))
      next.sha256 = "Use the 64 hex characters of the SHA-256 fingerprint.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setFailure(null);
    try {
      await mutate("putDistributionKey", slug, {
        purpose: d.purpose,
        sha256: sha,
        outlet: d.outlet,
        notes: d.notes.trim() === "" ? null : d.notes.trim(),
        registered: d.registered,
      });
      toast.success(`Saved the ${purposeLabel(d.purpose)} key`);
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = failure ? describe("Key")(failure) : null;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      dismissible={!busy}
      title={initial.existing ? "Edit key" : "Add key"}
      description="A fingerprint, never the key itself."
    >
      <form
        noValidate
        onSubmit={(e) => void save(e)}
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Distribution key"
      >
        <DrawerBody className="space-y-4">
          <FormField<string | null>
            name="key-purpose"
            label="Purpose"
            required
            value={d.purpose}
            onChange={(v) => setD({ ...d, purpose: v ?? d.purpose })}
            disabled={initial.existing}
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                options={purposes.map((p) => ({
                  value: p,
                  label: purposeLabel(p),
                }))}
              />
            )}
          </FormField>
          <FormField<string>
            name="key-sha256"
            label="SHA-256 fingerprint"
            required
            help="64 hex characters; colons are removed."
            value={d.sha256}
            onChange={(v) => setD({ ...d, sha256: v })}
            error={errors.sha256}
            announceError
            disabled={initial.existing}
          >
            {(field) => (
              <Input
                id={field.id}
                value={d.sha256}
                mono
                autoComplete="off"
                spellCheck={false}
                disabled={initial.existing}
                onValueChange={(v) => setD({ ...d, sha256: v })}
                aria-describedby={field["aria-describedby"]}
                aria-invalid={field["aria-invalid"]}
                aria-required
              />
            )}
          </FormField>
          <FormField<string | null>
            name="key-outlet"
            label="Outlet"
            help="Leave as Any when the key signs for every outlet."
            value={d.outlet}
            onChange={(v) => setD({ ...d, outlet: v })}
          >
            {(field) => (
              <Select
                {...field}
                ref={undefined}
                allowEmpty
                emptyLabel="Any"
                options={outlets.map((o) => ({
                  value: o.outletId,
                  label: o.outletId,
                }))}
              />
            )}
          </FormField>
          <FormField<string>
            name="key-notes"
            label="Notes"
            value={d.notes}
            onChange={(v) => setD({ ...d, notes: v })}
          >
            {(field) => (
              <Textarea
                id={field.id}
                value={d.notes}
                rows={2}
                onValueChange={(v) => setD({ ...d, notes: v })}
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
          <Checkbox
            checked={d.registered}
            onCheckedChange={(registered) => setD({ ...d, registered })}
            label="Registered for Android developer verification"
          />
          {copy ? (
            <Callout tone="danger" title={copy.title} live>
              {copy.description}
            </Callout>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save key
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}
