/**
 * Core → Overview (T1; docs/design/ADMIN.md §6.2): "is this product healthy, and what is it
 * running?"
 *
 * - The header's primary action follows enablement: Create license with License on, else
 *   Publish catalog with Config on, else Enable services (OVR-1).
 * - Needs attention lists operational problems only; setup steps live in the checklist, so
 *   nothing shows twice (OVR-2).
 * - One tile per **enabled** service, each its section's accent, numbers from that service's own
 *   queries, loaded per tile (one failing never blanks the page; OVR-1, OVR-5).
 * - The setup checklist derives from the product's setup state and real data ("Issue a first
 *   license" is done once a license exists), links only elsewhere, never truncates silently and
 *   hides once complete; the header's "Setup checklist" action reopens it (healthy states get no
 *   pill, ADMIN.md §5.11). Each item states its status in
 *   words (OVR-2, OVR-7).
 * - Trust & SDK: the signing key in gold with copy, the JWKS URL, and a quick start per SDK
 *   (`sdkQuickStart.ts`, UX-59): the install from pkg.plrs.im with its registry line first, and
 *   an initialisation pinning every active and staged key, with a placeholder for the app's own
 *   version (OVR-3).
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  ListChecks,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  ApiError,
  api,
  type LicenseSummary,
  type ProductDetail,
  type ServiceSlug,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { formatCount, formatDate, fromSeconds } from "../../../lib/format.js";
import { ACCESS_LABELS } from "../../../lib/labels.js";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { IdChip } from "../../../ui/IdChip.js";
import { KeyDisplay } from "../../../ui/KeyDisplay.js";
import { Callout } from "../../../ui/Callout.js";
import { Select } from "../../../ui/Select.js";
import { ServiceGlyph, serviceLabel } from "../../../ui/ServiceBadge.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timeline, TimelineItem } from "../../../ui/Timeline.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  type AttentionItem,
} from "../../templates/Dashboard.js";
import { ActivityTarget, actorName, useActivityFeed } from "./Activity.js";
import { verbFor } from "./activityVerbs.js";
import { fetchDeviceSummary } from "./Devices.js";
import { fetchSigningKeys } from "./Keys.js";
import {
  SDK_OPTIONS,
  SDK_QUICK_START_ID,
  sdkInit,
  sdkInstall,
  sdkInstallNote,
  trustPins,
  type SdkId,
} from "./sdkQuickStart.js";

const DAY = 86_400;
const SERVICE_ORDER: ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
];

/** The licenses query, made once by the page and shared with the License tile. */
type LicensesQuery = UseQueryResult<{ licenses: LicenseSummary[] }>;

const on = (p: ProductDetail, s: ServiceSlug): boolean =>
  p.services?.[s]?.enabled === true;

export function OverviewPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  useLoadingAnnouncement("overview", product.isPending);
  if (product.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" />
        <PageSkeleton template="dashboard" label="overview" />
      </div>
    );
  }
  if (product.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" />
        <ErrorState
          error={product.error}
          onRetry={() => void product.refetch()}
        />
      </div>
    );
  }
  return <OverviewBody slug={slug} product={product.data} />;
}

function OverviewBody({
  slug,
  product: p,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const enabled = SERVICE_ORDER.filter((s) => on(p, s));
  const licenses = useQuery(
    {
      queryKey: qk.licenses(slug),
      queryFn: () => api.licenses(slug),
      enabled: on(p, "license"),
    },
    queryClient,
  );
  const checklist = useChecklist(slug, p, licenses.data?.licenses.length);
  const [showChecklist, setShowChecklist] = React.useState(false);
  const complete = checklist.every((i) => i.state === "done");
  const attention = useAttention(slug, p, licenses.data?.licenses);
  const sync = p.setup?.sync;

  const primary = on(p, "license") ? (
    <Button asChild>
      <Link to={r.licenses(slug)}>Create license</Link>
    </Button>
  ) : on(p, "config") ? (
    <Button asChild>
      <Link to={r.catalog(slug)}>Publish catalog</Link>
    </Button>
  ) : (
    <Button asChild>
      <Link to={r.services(slug)}>Enable services</Link>
    </Button>
  );

  return (
    <DashboardTemplate
      header={
        <PageHeader
          title={p.name}
          titleAside={<IdChip value={slug} noun="slug" head={32} />}
          description={
            <>
              Runs {enabled.length}{" "}
              {enabled.length === 1 ? "service" : "services"}
              {p.releaseSource === "github" ? " · linked to a repository" : ""}
              {sync?.lastSyncedAt
                ? ` · last resync ${formatDate(fromSeconds(sync.lastSyncedAt))}`
                : ""}{" "}
              · created {formatDate(fromSeconds(p.createdAt))}
            </>
          }
          primaryAction={primary}
          secondaryActions={[
            {
              label: "Settings",
              icon: <SettingsIcon aria-hidden />,
              onSelect: () => navigate(r.settings(slug)),
            },
            // A finished checklist is hidden, and healthy states get no pill (pills mean
            // attention, ADMIN.md §5.11): it comes back from here instead of a "Setup
            // complete" chip.
            ...(complete && !showChecklist
              ? [
                  {
                    label: "Setup checklist",
                    icon: <ListChecks aria-hidden />,
                    onSelect: () => setShowChecklist(true),
                  },
                ]
              : []),
          ]}
        />
      }
      attention={<AttentionList items={attention} />}
      firstRun={
        enabled.length === 0 ? (
          <EmptyState
            kind="first-run"
            title="This product runs no services yet"
            description="Core keeps its devices, keys and settings. Turn on the services it needs: License for licenses, Config for signed config, Release and Distribution to ship builds."
            primaryAction={
              <Button asChild>
                <Link to={r.services(slug)}>Enable services</Link>
              </Button>
            }
          />
        ) : undefined
      }
      tiles={
        <div className="col-span-full grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {enabled.map((s) => (
            <ServiceTile
              key={s}
              slug={slug}
              service={s}
              licenses={s === "license" ? licenses : undefined}
            />
          ))}
        </div>
      }
      primary={
        !complete || showChecklist ? (
          <ChecklistPanel
            items={checklist}
            onHide={complete ? () => setShowChecklist(false) : undefined}
          />
        ) : (
          <RecentActivity slug={slug} />
        )
      }
    >
      {/* Trust & SDK carries a code sample and is far taller than the checklist or the activity
          feed: it takes its own full-width row, so no card stretches to match it. */}
      <TrustPanel slug={slug} product={p} />
      {!complete || showChecklist ? <RecentActivity slug={slug} /> : null}
    </DashboardTemplate>
  );
}

// ── Attention ──────────────────────────────────────────────────────────────────────────────────

function useAttention(
  slug: string,
  p: ProductDetail,
  licenses: { status: string; expiresAt: number | null }[] | undefined,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const setup = p.setup;
  if (setup?.sync?.status === "error") {
    items.push({
      id: "sync",
      tone: "danger",
      object: "Manifest sync",
      reason:
        setup.sync.message ?? "The last resync from the repository failed.",
      action: { label: "Repository", href: `${r.settings(slug)}` },
    });
  }
  const edge = moduleOf(p, "edgeMint");
  for (const id of (edge?.pendingApproval as string[] | undefined) ?? []) {
    items.push({
      id: `edge-${id}`,
      tone: "warning",
      object: `Edge-mint recipe ${id}`,
      reason: "Mints nothing until it is approved as it stands.",
      action: { label: "Review", href: r.edgeMint(slug) },
    });
  }
  for (const w of setup?.warnings ?? []) {
    items.push({
      id: `warn-${w}`,
      tone: "warning",
      object: w.startsWith("release:") ? "Release" : "Setup",
      reason: w.replace(/^release:\s*/, ""),
      action: w.startsWith("release:")
        ? { label: "Releases", href: r.releases(slug) }
        : undefined,
    });
  }
  if (licenses) {
    const now = Date.now() / 1000;
    const expiring = licenses.filter(
      (l) =>
        l.status === "active" &&
        l.expiresAt !== null &&
        l.expiresAt > now &&
        l.expiresAt - now <= 14 * DAY,
    ).length;
    if (expiring > 0) {
      items.push({
        id: "expiring",
        tone: "warning",
        object: "Licenses",
        reason: `${formatCount(expiring)} ${expiring === 1 ? "license expires" : "licenses expire"} within 14 days.`,
        action: { label: "View", href: r.licenses(slug) },
      });
    }
  }
  return items;
}

function moduleOf(
  p: ProductDetail,
  id: string,
): Record<string, unknown> | undefined {
  const modules = p.setup?.modules;
  if (!Array.isArray(modules)) return undefined;
  return modules.find((m) => m.id === id) as
    | Record<string, unknown>
    | undefined;
}

// ── Checklist ──────────────────────────────────────────────────────────────────────────────────

type ItemState = "done" | "todo" | "problem";

interface ChecklistItem {
  id: string;
  label: string;
  state: ItemState;
  action?: { label: string; href: string };
}

function useChecklist(
  slug: string,
  p: ProductDetail,
  licenseCount: number | undefined,
): ChecklistItem[] {
  const catalog = useQuery(
    {
      queryKey: qk.catalog(slug),
      queryFn: () => api.schema(slug),
      enabled: on(p, "config"),
      retry: false,
    },
    queryClient,
  );
  const items: ChecklistItem[] = [];
  const signing = Boolean(p.signing?.publicKey);
  items.push({
    id: "signing",
    label: signing
      ? "Signing key active"
      : "Prepare and activate a signing key",
    state: signing ? "done" : "problem",
    action: signing
      ? undefined
      : { label: "Keys & secrets", href: r.keys(slug) },
  });
  for (const s of p.setup?.secrets ?? []) {
    items.push({
      id: `secret-${s.name}`,
      label: s.configured ? `Secret ${s.name} set` : `Set secret ${s.name}`,
      state: s.configured ? "done" : "problem",
      action: s.configured ? undefined : { label: "Set", href: r.keys(slug) },
    });
  }
  // A catalog that failed to load is unknown, not unpublished: say nothing rather than "To do".
  const catalogUnknown =
    catalog.isError &&
    !(catalog.error instanceof ApiError && catalog.error.status === 404);
  if (on(p, "config") && !catalogUnknown) {
    const published =
      catalog.data !== undefined && (catalog.data.entries?.length ?? 0) > 0;
    items.push({
      id: "catalog",
      label: published ? "Catalog published" : "Publish a catalog",
      state: published ? "done" : "todo",
      action: published
        ? undefined
        : { label: "Catalog", href: r.catalog(slug) },
    });
  }
  if (on(p, "license") && licenseCount !== undefined) {
    items.push({
      id: "license",
      label:
        licenseCount > 0 ? "First license issued" : "Issue a first license",
      state: licenseCount > 0 ? "done" : "todo",
      action:
        licenseCount > 0
          ? undefined
          : { label: "Create", href: r.licenses(slug) },
    });
  }
  const release = moduleOf(p, "release");
  if (on(p, "release") && release && release.status !== "not-configured") {
    const ok = release.configured === true;
    items.push({
      id: "release",
      label: ok
        ? "Release source configured"
        : `Finish release setup: ${((release.missing as string[]) ?? []).join(", ")}`,
      state: ok ? "done" : "problem",
      action: ok ? undefined : { label: "Releases", href: r.releases(slug) },
    });
  }
  const edge = moduleOf(p, "edgeMint");
  if (on(p, "config") && edge && edge.status !== "not-configured") {
    const ok = edge.configured === true;
    items.push({
      id: "edge",
      label: ok ? "Edge-mint recipes approved" : "Approve edge-mint recipes",
      state: ok ? "done" : "todo",
      action: ok ? undefined : { label: "Edge mint", href: r.edgeMint(slug) },
    });
  }
  return items;
}

const ITEM_STATE: Record<
  ItemState,
  { word: string; icon: React.ReactNode; className: string }
> = {
  done: {
    word: "Done",
    icon: <CheckCircle2 aria-hidden className="size-4" />,
    className: "text-success",
  },
  todo: {
    word: "To do",
    icon: <Circle aria-hidden className="size-4" />,
    className: "text-fg-muted",
  },
  problem: {
    word: "Needs attention",
    icon: <AlertTriangle aria-hidden className="size-4" />,
    className: "text-warning",
  },
};

const VISIBLE_ITEMS = 5;

function ChecklistPanel({
  items,
  onHide,
}: {
  items: ChecklistItem[];
  onHide?: () => void;
}): React.ReactElement {
  const [all, setAll] = React.useState(false);
  // Open items first, so "Show more" never hides one that needs doing.
  const sorted = [...items].sort(
    (a, b) => Number(a.state === "done") - Number(b.state === "done"),
  );
  const shown = all ? sorted : sorted.slice(0, VISIBLE_ITEMS);
  const done = items.filter((i) => i.state === "done").length;
  return (
    <Panel
      title="Setup"
      action={
        <span className="flex items-center gap-2">
          {done === items.length ? (
            <span className="text-xs text-fg-muted">All done</span>
          ) : (
            <StatusPill tone="warning" icon={false} size="sm">
              {done} of {items.length} done
            </StatusPill>
          )}
          {onHide ? (
            <Button variant="ghost" size="sm" onClick={onHide}>
              Hide
            </Button>
          ) : null}
        </span>
      }
    >
      <ul className="divide-y divide-border">
        {shown.map((item) => {
          const st = ITEM_STATE[item.state];
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
            >
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-bold",
                  st.className,
                )}
              >
                {st.icon}
                {st.word}
              </span>
              <span className="min-w-0 flex-1 text-sm text-fg">
                {item.label}
              </span>
              {item.action ? (
                <Link
                  to={item.action.href}
                  className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
                >
                  {item.action.label}
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
      {sorted.length > VISIBLE_ITEMS ? (
        <Button
          variant="link"
          size="sm"
          className="mt-2"
          onClick={() => setAll((v) => !v)}
        >
          {all ? "Show fewer" : `Show ${sorted.length - VISIBLE_ITEMS} more`}
        </Button>
      ) : null}
    </Panel>
  );
}

// ── Service tiles ──────────────────────────────────────────────────────────────────────────────

function TileFrame({
  service,
  badge,
  href,
  linkLabel,
  loading,
  error,
  onRetry,
  children,
}: {
  service: ServiceSlug;
  /**
   * A pill at the header's right edge: a neutral fact ("Schema v8") or an issue ("Needs
   * setup"). Never a healthy state: pills mean attention (ADMIN.md §5.11).
   */
  badge?: React.ReactNode;
  href: string;
  linkLabel: string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const id = `tile-${service}`;
  return (
    <section
      data-service={service}
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-border border-t-2 border-t-accent bg-surface-raised p-4"
    >
      <div data-card-header="" className="flex items-center gap-2">
        <h2
          id={id}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-bold text-fg-strong"
        >
          <ServiceGlyph id={service} />
          {serviceLabel(service)}
        </h2>
        {badge}
      </div>
      <div className="min-h-12 flex-1 space-y-1 text-sm text-fg">
        {loading ? (
          <>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-32" />
          </>
        ) : error ? (
          <ErrorState compact error={error} onRetry={onRetry} />
        ) : (
          children
        )}
      </div>
      <Link
        to={href}
        className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
      >
        {linkLabel}
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </section>
  );
}

function Big({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="text-xl font-bold tabular-nums text-fg-strong">{children}</p>
  );
}

function Line({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="text-sm text-fg-muted">{children}</p>;
}

function ServiceTile({
  slug,
  service,
  licenses,
}: {
  slug: string;
  service: ServiceSlug;
  licenses?: LicensesQuery;
}): React.ReactElement {
  switch (service) {
    case "license":
      return <LicenseTile slug={slug} licenses={licenses!} />;
    case "config":
      return <ConfigTile slug={slug} />;
    case "release":
      return <ReleaseTile slug={slug} />;
    case "distribution":
      return <DistributionTile slug={slug} />;
    case "update":
      return <UpdateTile slug={slug} />;
    case "identity":
      return <IdentityTile slug={slug} />;
  }
}

function LicenseTile({
  slug,
  licenses,
}: {
  slug: string;
  licenses: LicensesQuery;
}): React.ReactElement {
  const devices = useQuery(
    {
      queryKey: qk.devicesSummary(slug),
      queryFn: () => fetchDeviceSummary(slug),
    },
    queryClient,
  );
  const list = licenses.data?.licenses ?? [];
  const now = Date.now() / 1000;
  const active = list.filter(
    (l) => l.status === "active" && (l.expiresAt === null || l.expiresAt > now),
  ).length;
  const expiring = list.filter(
    (l) =>
      l.status === "active" &&
      l.expiresAt !== null &&
      l.expiresAt > now &&
      l.expiresAt - now <= 14 * DAY,
  ).length;
  const disabled = list.filter((l) => l.status === "disabled").length;
  return (
    <TileFrame
      service="license"
      href={r.licenses(slug)}
      linkLabel="Licenses"
      loading={licenses.isPending}
      error={licenses.isError ? licenses.error : undefined}
      onRetry={() => void licenses.refetch()}
    >
      <Big>{formatCount(active)} active</Big>
      <Line>
        {formatCount(expiring)} expiring soon · {formatCount(disabled)} disabled
      </Line>
      {devices.data ? (
        <Line>{formatCount(devices.data.total)} devices</Line>
      ) : null}
    </TileFrame>
  );
}

function ConfigTile({ slug }: { slug: string }): React.ReactElement {
  const catalog = useQuery(
    {
      queryKey: qk.catalog(slug),
      queryFn: () => api.schema(slug),
      retry: false,
    },
    queryClient,
  );
  const profiles = useQuery(
    { queryKey: qk.profiles(slug), queryFn: () => api.profiles(slug) },
    queryClient,
  );
  const missing =
    catalog.error instanceof ApiError && catalog.error.status === 404;
  return (
    <TileFrame
      service="config"
      badge={
        catalog.data && !missing ? (
          <StatusPill tone="neutral" icon={false} size="sm">
            Schema v{catalog.data.schemaVersion}
          </StatusPill>
        ) : undefined
      }
      href={r.catalog(slug)}
      linkLabel="Catalog"
      loading={catalog.isPending}
      error={catalog.isError && !missing ? catalog.error : undefined}
      onRetry={() => void catalog.refetch()}
    >
      {missing || !catalog.data ? (
        <Big>No catalog yet</Big>
      ) : (
        <>
          <Big>{formatCount(catalog.data.entries.length)} keys</Big>
        </>
      )}
      {profiles.data ? (
        <Line>
          {formatCount(profiles.data.profiles.length)}{" "}
          {profiles.data.profiles.length === 1 ? "profile" : "profiles"}
        </Line>
      ) : null}
    </TileFrame>
  );
}

function ReleaseTile({ slug }: { slug: string }): React.ReactElement {
  const store = useQuery(
    { queryKey: qk.releases(slug), queryFn: () => api.releases(slug) },
    queryClient,
  );
  const health = useQuery(
    {
      queryKey: qk.releaseHealth(slug),
      queryFn: () => api.releaseHealth(slug).then((r) => r.health),
    },
    queryClient,
  );
  const latest = latestAppRelease(store.data?.releases);
  const stable = store.data?.channels.find((c) => c.channel === "stable");
  const stableVersion = stable
    ? store.data?.releases.find((x) => x.releaseId === stable.releaseId)
        ?.version
    : undefined;
  return (
    <TileFrame
      service="release"
      badge={
        health.data && !health.data.healthy ? (
          <StatusPill tone="warning" size="sm">
            Needs setup
          </StatusPill>
        ) : undefined
      }
      href={r.releases(slug)}
      linkLabel="Releases"
      loading={store.isPending}
      error={store.isError ? store.error : undefined}
      onRetry={() => void store.refetch()}
    >
      <Big>
        {latest ? (
          <span className="font-mono">{latest.version}</span>
        ) : (
          "No releases"
        )}
      </Big>
      {stableVersion && stableVersion !== latest?.version ? (
        <Line>
          stable → <span className="font-mono">{stableVersion}</span>
        </Line>
      ) : null}
    </TileFrame>
  );
}

function latestAppRelease(
  releases:
    | {
        deliverable: string;
        version: string;
        publishedAt: number | null;
        yank: unknown;
      }[]
    | undefined,
): { version: string } | undefined {
  return (releases ?? [])
    .filter((x) => x.deliverable === "app" && !x.yank)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
}

function DistributionTile({ slug }: { slug: string }): React.ReactElement {
  const rollouts = useQuery(
    { queryKey: qk.rollouts(slug), queryFn: () => api.rollouts(slug) },
    queryClient,
  );
  const list = rollouts.data?.rollouts ?? [];
  const count = (s: string) => list.filter((x) => x.state === s).length;
  const active = list.filter((x) => x.state === "active");
  return (
    <TileFrame
      service="distribution"
      href={r.matrix(slug)}
      linkLabel="Matrix"
      loading={rollouts.isPending}
      error={rollouts.isError ? rollouts.error : undefined}
      onRetry={() => void rollouts.refetch()}
    >
      <Big>
        {formatCount(active.length)}{" "}
        {active.length === 1 ? "rollout" : "rollouts"} live
      </Big>
      <Line>
        {formatCount(count("paused"))} paused · {formatCount(count("halted"))}{" "}
        halted
      </Line>
    </TileFrame>
  );
}

function UpdateTile({ slug }: { slug: string }): React.ReactElement {
  const feed = useQuery(
    { queryKey: qk.feed(slug), queryFn: () => api.updateSettings(slug) },
    queryClient,
  );
  return (
    <TileFrame
      service="update"
      href={r.feed(slug)}
      linkLabel="Feed"
      loading={feed.isPending}
      error={feed.isError ? feed.error : undefined}
      onRetry={() => void feed.refetch()}
    >
      {feed.data ? (
        <>
          <Big>
            {ACCESS_LABELS[feed.data.metadataAccess] ??
              feed.data.metadataAccess}
          </Big>
          <Line>
            Supports <span className="font-mono">{feed.data.compatMin}</span> to{" "}
            <span className="font-mono">{feed.data.compatMax}</span>
          </Line>
        </>
      ) : null}
    </TileFrame>
  );
}

function IdentityTile({ slug }: { slug: string }): React.ReactElement {
  const portal = useQuery(
    {
      queryKey: qk.portal(slug),
      queryFn: () => api.portalSettings(slug).then((r) => r.settings),
    },
    queryClient,
  );
  const s = portal.data;
  const methods = s
    ? [
        s.oidcEnabled ? "single sign-on" : null,
        s.magicEnabled ? "email link" : null,
      ]
        .filter(Boolean)
        .join(" and ")
    : "";
  return (
    <TileFrame
      service="identity"
      href={r.portal(slug)}
      linkLabel="Portal"
      loading={portal.isPending}
      error={portal.isError ? portal.error : undefined}
      onRetry={() => void portal.refetch()}
    >
      {s ? (
        <>
          <Big>Portal {s.portalEnabled ? "on" : "off"}</Big>
          <Line>
            {methods ? `Sign-in by ${methods}` : "No sign-in method on"}
          </Line>
        </>
      ) : null}
    </TileFrame>
  );
}

// ── Trust & SDK ────────────────────────────────────────────────────────────────────────────────

function TrustPanel({
  slug,
  product: p,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const [sdk, setSdk] = React.useState<SdkId>("node");
  // Every key an app pins: active plus staged, from the authenticated admin API (D16).
  const keys = useQuery(
    { queryKey: qk.keys(slug), queryFn: () => fetchSigningKeys(slug) },
    queryClient,
  );
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const jwks = p.jwksUrl ? `${origin}${p.jwksUrl}` : undefined;
  const kid = p.signing?.kid ?? p.signingKid;
  const pub = p.signing?.publicKey;
  const services = SERVICE_ORDER.filter((s) => on(p, s));
  const pins = trustPins(keys.data?.keys, { kid, publicKey: pub });
  const staged = pins.length > 1;
  const install = sdkInstall(sdk);
  const note = sdkInstallNote(sdk);
  const init = sdkInit(sdk, { slug, origin, pins, services });
  return (
    <Panel
      title="Trust & SDK"
      action={
        <Link
          to={r.keys(slug)}
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          Keys & secrets
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      <div className="space-y-4">
        {pub ? (
          <KeyDisplay
            label="Signing key"
            kind="signing"
            kid={kid}
            status="active"
            value={pub}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            No active signing key: nothing can be signed until one is activated.
          </p>
        )}
        {jwks ? (
          <div className="space-y-1">
            <p className="text-xs font-bold text-fg-muted">JWKS</p>
            <p className="flex items-center gap-1">
              <code className="min-w-0 flex-1 font-mono text-xs text-fg [overflow-wrap:anywhere]">
                {jwks}
              </code>
              <CopyButton value={jwks} label="Copy the JWKS URL" />
            </p>
          </div>
        ) : null}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={SDK_QUICK_START_ID}
              className="text-xs font-bold text-fg-muted"
            >
              SDK quick start
            </label>
            <Select
              id={SDK_QUICK_START_ID}
              className="w-auto min-w-44"
              value={sdk}
              onChange={(v) => v && setSdk(v as SdkId)}
              options={SDK_OPTIONS}
            />
          </div>
          <p className="text-sm text-fg-muted">
            Every Polaris Key SDK installs from pkg.plrs.im, and only from
            there: route the package name to it before installing.
          </p>
          {install.map((s) => (
            <div key={s.id} className="space-y-1.5">
              <p className="text-xs font-bold text-fg-muted">{s.title}</p>
              {s.warning ? <Callout tone="warning">{s.warning}</Callout> : null}
              {s.description ? (
                <p className="text-sm text-fg-muted">{s.description}</p>
              ) : null}
              <CodeBlock
                code={s.code}
                language={s.language}
                filename={s.filename}
                wrap
              />
            </div>
          ))}
          {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
          <div className="space-y-1.5">
            <p className="text-xs font-bold text-fg-muted">
              Initialise the client
            </p>
            {staged ? (
              <p className="text-sm text-fg-muted">
                Pins the active key and the key staged to replace it, so this
                build keeps working after the rotation.
              </p>
            ) : null}
            {init.hint ? (
              <p className="text-sm text-fg-muted">{init.hint}</p>
            ) : null}
            <CodeBlock
              code={init.code}
              language={init.language}
              filename={init.filename}
              wrap
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ── Recent activity ────────────────────────────────────────────────────────────────────────────

function RecentActivity({ slug }: { slug: string }): React.ReactElement {
  const feed = useActivityFeed(slug, {});
  const items = (feed.data?.pages.flatMap((pg) => pg.items) ?? []).slice(0, 5);
  return (
    <Panel
      title="Recent activity"
      action={
        <Link
          to={r.activity(slug)}
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          View activity
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      {feed.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : feed.isError ? (
        <ErrorState
          compact
          error={feed.error}
          onRetry={() => void feed.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-muted">No activity yet.</p>
      ) : (
        <Timeline
          label="Recent activity"
          groupBy="day"
          items={items}
          getKey={(i) => i.id}
          getTime={(i) => fromSeconds(i.at)}
          renderItem={(i) => (
            <TimelineItem
              actor={i.actor.sub ? { name: actorName(i) } : "system"}
              verb={verbFor(i.action)}
              target={<ActivityTarget slug={slug} item={i} />}
              at={fromSeconds(i.at)}
            />
          )}
        />
      )}
    </Panel>
  );
}
