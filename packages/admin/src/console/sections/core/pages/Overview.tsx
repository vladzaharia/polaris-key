/**
 * Core → Overview (T1; docs/design/ADMIN.md §6.2): "is this product healthy, and what is it
 * running?"
 *
 * - The header's primary action is the Integration card's computed next step (ST-41); with none
 *   left it follows enablement: Create license with License on, else Publish catalog with Config
 *   on, else Enable services (OVR-1).
 * - Needs attention lists operational problems: a missing signing key, unset secrets, failed
 *   syncs, recipes awaiting approval, expiring licenses (OVR-2).
 * - One tile per **enabled** service, each its section's accent, numbers from that service's own
 *   queries, loaded per tile (one failing never blanks the page; OVR-1, OVR-5).
 * - The Integration card (`components/IntegrationCard.tsx`) replaces the setup checklist, Trust &
 *   SDK and the welcome: features Verified, per platform, the next step; the install and the
 *   pins moved to the Integration page.
 * - Moments (EXPERIENCE.md §0.7; MO-11): the first catalog publish, the first release, the first
 *   store connected and the product launched each show once per product, as one line with the
 *   success check and sparks (`components/Moment.tsx`); the attention list staggers in on the
 *   page's first load.
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Eye, Settings as SettingsIcon } from "lucide-react";
import {
  ApiError,
  api,
  type LicenseSummary,
  type ProductDetail,
  type ReleaseDto,
  type ServiceSlug,
} from "../../../../api.js";
import {
  formatCount,
  formatDate,
  fromSeconds,
} from "../../../../lib/format.js";
import { ACCESS_LABELS } from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { IdChip } from "../../../../ui/IdChip.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { PageSkeleton, Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timeline, TimelineItem } from "../../../../ui/Timeline.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import {
  MomentBanner,
  momentKey,
  useMoment,
  type MomentObservation,
} from "../../../components/Moment.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useProduct } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { Link, navigate } from "../../../router.js";
import { Big, Line, TileFrame } from "../components/TileFrame.js";
import { CommerceTile } from "../../commerce/CommerceTile.js";
import { pendingRecipes, reviewHref } from "../../config/model/pending.js";
import { r } from "../../../routes.js";
import {
  AttentionList,
  DashboardTemplate,
  Panel,
  useFirstLoad,
} from "../../../templates/Dashboard.js";
import { useAttention } from "./overviewAttention.js";
import { ActivityTarget, actorName, useActivityFeed } from "./Activity.js";
import { verbFor } from "../model/activityVerbs.js";
import { fetchDeviceSummary } from "./Devices.js";
import { declaresSaves, noCatalog, userSettings } from "../../sync/data.js";
import { IntegrationCard } from "../components/IntegrationCard.js";
import { nextStep } from "../model/integration.js";
import { runningFeatures } from "../../global/model/home.js";
import { useSetup } from "../../../wizard/useSetup.js";

const DAY = 86_400;
const SERVICE_ORDER: ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
];

/** The licenses query, made once by the page and shared with the License tile. */
type LicensesQuery = UseQueryResult<{ licenses: LicenseSummary[] }>;

const on = (p: ProductDetail, s: ServiceSlug): boolean =>
  p.services?.[s]?.enabled === true;

export function OverviewPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  useLoadingAnnouncement("overview", product.isPending);
  // The attention list staggers in on this page's first load in the document (MO-11).
  const firstLoad = useFirstLoad(`overview:${slug}`, product.isPending);
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
  return (
    <OverviewBody
      slug={slug}
      product={product.data}
      firstLoad={firstLoad}
      placeholder={product.isPlaceholderData}
    />
  );
}

function OverviewBody({
  slug,
  product: p,
  firstLoad,
  placeholder = false,
}: {
  slug: string;
  product: ProductDetail;
  /** The page's first-load key (`useFirstLoad`), for the attention list's stagger. */
  firstLoad?: string;
  /** The product is the products list's row standing in until its own read lands. */
  placeholder?: boolean;
}): React.ReactElement {
  const enabled = SERVICE_ORDER.filter((s) => on(p, s));
  const features = runningFeatures(p);
  const licenses = useQuery({
    queryKey: qk.licenses(slug),
    queryFn: () => api.licenses(slug),
    enabled: on(p, "license"),
  });
  const integration = useQuery({
    queryKey: qk.integration(slug),
    queryFn: () => api.integration(slug),
    enabled: enabled.length > 0,
  });
  const view = integration.data;
  // Launched: every enabled feature has been seen working, judged only once the read model has
  // answered (and not from the products list's row standing in for the product).
  const launched: MomentObservation =
    enabled.length > 0 && !placeholder && view && view.features.length > 0
      ? {
          state: view.features.every((f) => f.status === "verified")
            ? "after"
            : "before",
        }
      : UNKNOWN;
  const sync = p.setup?.sync;
  const next = view
    ? nextStep(slug, view, Boolean(p.signing?.publicKey), pendingRecipes(p))
    : null;
  const setup = useSetup(slug);
  const hidden = setup.choices.integrationHidden !== null;
  // Show Integration puts the card back and the card takes focus; nothing else moves it.
  const [justShown, setJustShown] = React.useState(false);
  const cardShown = enabled.length > 0 && !hidden;
  const attention = useAttention(slug, p, licenses.data?.licenses, {
    signing: cardShown && (integration.isPending || next?.to === r.keys(slug)),
    recipes:
      cardShown &&
      (integration.isPending ||
        next?.to === reviewHref(slug, pendingRecipes(p))),
  });

  const fallback = on(p, "license") ? (
    <Button asChild>
      <Link to={r.newLicense(slug)}>New license</Link>
    </Button>
  ) : on(p, "config") ? (
    <Button asChild>
      <Link to={r.catalog(slug)}>Publish catalog</Link>
    </Button>
  ) : (
    <Button asChild>
      <Link to={r.services(slug)}>Enable features</Link>
    </Button>
  );
  // The card's hero carries the next step while it shows; otherwise the header does. Nothing is
  // decided until the read model answers, so the primary never changes after it appears.
  const primary =
    enabled.length > 0 && integration.isPending ? (
      <Skeleton className="h-9 w-36" />
    ) : cardShown && next && integration.isSuccess ? undefined : next ? (
      <Button asChild>
        <Link to={next.to}>{next.text}</Link>
      </Button>
    ) : (
      fallback
    );

  return (
    <DashboardTemplate
      header={
        <PageHeader
          title={p.name}
          titleAside={<IdChip value={slug} noun="slug" head={32} />}
          description={
            <>
              Runs {features.length}{" "}
              {features.length === 1 ? "feature" : "features"}
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
            ...(hidden && enabled.length > 0
              ? [
                  {
                    label: "Show Integration",
                    icon: <Eye aria-hidden />,
                    disabledReason: setup.allowed
                      ? undefined
                      : setup.disabledReason,
                    onSelect: () =>
                      void setup.setIntegrationHidden(false).then((ok) => {
                        if (ok) setJustShown(true);
                      }),
                  },
                ]
              : []),
          ]}
        />
      }
      attention={
        <>
          <OverviewMoments slug={slug} product={p} launched={launched} />
          <AttentionList items={attention} stagger={firstLoad} />
        </>
      }
      firstRun={
        enabled.length === 0 ? (
          <EmptyState
            kind="first-run"
            title="This product runs no features yet"
            description="Core keeps its devices, keys and settings. Turn on the features it needs: Licensing for licenses, Managed config for signed config, Ship builds to release and distribute."
            primaryAction={
              <Button asChild>
                <Link to={r.services(slug)}>Enable features</Link>
              </Button>
            }
          />
        ) : undefined
      }
      tiles={
        <>
          {cardShown ? (
            <IntegrationCard
              slug={slug}
              query={integration}
              next={next}
              focusHeading={justShown}
            />
          ) : null}
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
        </>
      }
      primary={<RecentActivity slug={slug} />}
    ></DashboardTemplate>
  );
}

// ── Moments (EXPERIENCE.md §0.7; MO-11) ────────────────────────────────────────────────────────

const UNKNOWN: MomentObservation = { state: "unknown" };
const BEFORE: MomentObservation = { state: "before" };

const ACTION_LINK =
  "inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline";

/** The first catalog: published once it has entries; a 404 is "not yet", any other error unknown. */
export function catalogMoment(
  enabled: boolean,
  catalog: { data?: { entries?: unknown[] }; error: unknown; isError: boolean },
): MomentObservation {
  if (!enabled) return UNKNOWN;
  if (catalog.isError)
    return catalog.error instanceof ApiError && catalog.error.status === 404
      ? BEFORE
      : UNKNOWN;
  if (!catalog.data) return UNKNOWN;
  return (catalog.data.entries?.length ?? 0) > 0 ? { state: "after" } : BEFORE;
}

/** The first release: the product's app releases that stand (yanked ones do not), and when. */
export function releaseMoment(
  enabled: boolean,
  releases:
    | Pick<ReleaseDto, "deliverable" | "publishedAt" | "yank">[]
    | undefined,
): MomentObservation {
  if (!enabled || !Array.isArray(releases)) return UNKNOWN;
  const live = releases.filter((x) => x.deliverable === "app" && !x.yank);
  if (live.length === 0) return BEFORE;
  const times = live
    .map((x) => x.publishedAt)
    .filter((t): t is number => typeof t === "number");
  return { state: "after", at: times.length ? Math.min(...times) : null };
}

/**
 * The once-per-product moments Overview owns, each a `MomentBanner` above the attention list. The
 * queries are the tiles' own (the same keys and fetchers), so they cost no extra request, except
 * the storefronts read, made only while Distribution is on.
 */
function OverviewMoments({
  slug,
  product: p,
  launched,
}: {
  slug: string;
  product: ProductDetail;
  launched: MomentObservation;
}): React.ReactElement {
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    enabled: on(p, "config"),
    retry: false,
  });
  const store = useQuery({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
    enabled: on(p, "release"),
  });
  const stores = useQuery({
    queryKey: qk.storefronts(slug),
    queryFn: () => api.storefronts(slug),
    enabled: on(p, "distribution"),
    retry: false,
  });
  const connected = stores.data?.stores?.find(
    (s) => s.connection.state === "connected",
  );
  const latest = latestAppRelease(store.data?.releases);
  const channel = latest
    ? (latest.channel ??
      store.data?.channels?.find((c) => c.releaseId === latest.releaseId)
        ?.channel ??
      null)
    : null;
  const titles = {
    launched: `${p.name} is launched`,
    release: latest
      ? channel
        ? `${latest.version} is live on ${channel}`
        : `${latest.version} is live`
      : "",
    catalog: catalog.data
      ? `Catalog v${catalog.data.schemaVersion} is live`
      : "",
    store: connected ? `${connected.label} is connected` : "",
  };
  const keys = {
    launched: momentKey("product-launched", slug),
    release: momentKey("first-release", slug),
    catalog: momentKey("first-catalog", slug),
    store: momentKey("store-connected", slug),
  };
  // The announcement is said only for a moment that lands while the page is open.
  const shows = {
    launched: useMoment(keys.launched, launched, `${titles.launched}.`),
    release: useMoment(
      keys.release,
      releaseMoment(on(p, "release"), store.data?.releases),
      `${titles.release}: your first release.`,
    ),
    catalog: useMoment(
      keys.catalog,
      catalogMoment(on(p, "config"), catalog),
      `${titles.catalog}.`,
    ),
    store: useMoment(
      keys.store,
      !on(p, "distribution") || !Array.isArray(stores.data?.stores)
        ? UNKNOWN
        : connected
          ? { state: "after" }
          : BEFORE,
      `${titles.store}.`,
    ),
  };
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visible = (key: string, show: boolean): boolean =>
    show && !dismissed.has(key);
  // Dismissing a banner removes the focused button: focus moves to the next banner's Dismiss, or
  // else to the page's heading, never to the body. Consumed by the commit that removes it.
  const focusAfterDismiss = React.useRef<string | null>(null);
  const dismiss = (key: string) => () => {
    const banners = [
      ...document.querySelectorAll<HTMLElement>("section[data-moment]"),
    ];
    const i = banners.findIndex((b) => b.dataset.moment === key);
    focusAfterDismiss.current = banners[i + 1]?.dataset.moment ?? "";
    setDismissed((d) => new Set(d).add(key));
  };
  React.useLayoutEffect(() => {
    const next = focusAfterDismiss.current;
    if (next === null) return;
    focusAfterDismiss.current = null;
    const banner = next
      ? [
          ...document.querySelectorAll<HTMLElement>("section[data-moment]"),
        ].find((b) => b.dataset.moment === next)
      : undefined;
    const target =
      banner?.querySelector<HTMLElement>("[data-moment-dismiss]") ??
      document.querySelector<HTMLElement>("h1[data-page-title]");
    if (target && target.tagName === "H1" && !target.hasAttribute("tabindex"))
      target.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
  }, [dismissed]);

  return (
    <>
      {visible(keys.launched, shows.launched) ? (
        <MomentBanner
          momentKey={keys.launched}
          title={titles.launched}
          detail="Every setup step is done."
          onDismiss={dismiss(keys.launched)}
        />
      ) : null}
      {visible(keys.release, shows.release) && latest ? (
        <MomentBanner
          momentKey={keys.release}
          title={titles.release}
          detail={
            <>
              Your first release
              {latest.signer?.kid ? (
                <>
                  {" · signed by "}
                  <span className="font-mono">{latest.signer.kid}</span>
                </>
              ) : null}
              {latest.publishedAt ? (
                <>
                  {" · published "}
                  <Timestamp
                    at={fromSeconds(latest.publishedAt)}
                    format="relative"
                  />
                </>
              ) : null}
            </>
          }
          action={
            on(p, "distribution") ? (
              <Link to={r.rollouts(slug)} className={ACTION_LINK}>
                Roll it out
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            ) : (
              <Link
                to={r.release(slug, latest.releaseId)}
                className={ACTION_LINK}
              >
                View release
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            )
          }
          onDismiss={dismiss(keys.release)}
        />
      ) : null}
      {visible(keys.catalog, shows.catalog) && catalog.data ? (
        <MomentBanner
          momentKey={keys.catalog}
          title={titles.catalog}
          detail="Your app reads it on its next launch."
          action={
            <Link to={r.catalog(slug)} className={ACTION_LINK}>
              Catalog
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          }
          onDismiss={dismiss(keys.catalog)}
        />
      ) : null}
      {visible(keys.store, shows.store) && connected ? (
        <MomentBanner
          momentKey={keys.store}
          title={titles.store}
          detail="Builds and the listing can go out to it from Storefronts."
          action={
            <Link to={r.storefronts(slug)} className={ACTION_LINK}>
              Storefronts
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          }
          onDismiss={dismiss(keys.store)}
        />
      ) : null}
    </>
  );
}

// ── Service tiles ──────────────────────────────────────────────────────────────────────────────

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
    case "sync":
      return <SyncTile slug={slug} />;
    case "commerce":
      return <CommerceTile slug={slug} />;
  }
}

function LicenseTile({
  slug,
  licenses,
}: {
  slug: string;
  licenses: LicensesQuery;
}): React.ReactElement {
  const devices = useQuery({
    queryKey: qk.devicesSummary(slug),
    queryFn: () => fetchDeviceSummary(slug),
  });
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
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
  });
  const profiles = useQuery({
    queryKey: qk.profiles(slug),
    queryFn: () => api.profiles(slug),
  });
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
  const store = useQuery({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
  });
  const health = useQuery({
    queryKey: qk.releaseHealth(slug),
    queryFn: () => api.releaseHealth(slug).then((r) => r.health),
  });
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

function latestAppRelease<
  T extends {
    deliverable: string;
    version: string;
    publishedAt: number | null;
    yank: unknown;
  },
>(releases: T[] | undefined): T | undefined {
  return (releases ?? [])
    .filter((x) => x.deliverable === "app" && !x.yank)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
}

function DistributionTile({ slug }: { slug: string }): React.ReactElement {
  const rollouts = useQuery({
    queryKey: qk.rollouts(slug),
    queryFn: () => api.rollouts(slug),
  });
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
  const feed = useQuery({
    queryKey: qk.feed(slug),
    queryFn: () => api.updateSettings(slug),
  });
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
  const portal = useQuery({
    queryKey: qk.portal(slug),
    queryFn: () => api.portalSettings(slug).then((r) => r.settings),
  });
  const s = portal.data;
  return (
    <TileFrame
      service="identity"
      href={r.appSignIn(slug)}
      linkLabel="App sign-in"
      loading={portal.isPending}
      error={portal.isError ? portal.error : undefined}
      onRetry={() => void portal.refetch()}
    >
      {s ? (
        <>
          <Big>Locker {s.portalEnabled ? "on" : "off"}</Big>
          <Line>Sign-in by email code and passkeys</Line>
        </>
      ) : null}
    </TileFrame>
  );
}

function SyncTile({ slug }: { slug: string }): React.ReactElement {
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
  });
  const empty = noCatalog(catalog.error);
  const data = empty ? null : catalog.data;
  const settings = userSettings(data ?? null).length;
  const collections = data?.cloudSync?.collections?.length ?? 0;
  return (
    <TileFrame
      service="sync"
      href={r.syncData(slug)}
      linkLabel="Data"
      loading={catalog.isPending}
      error={catalog.isError && !empty ? catalog.error : undefined}
      onRetry={() => void catalog.refetch()}
    >
      {data !== undefined ? (
        <>
          <Big>
            {formatCount(settings)} synced{" "}
            {settings === 1 ? "setting" : "settings"}
          </Big>
          <Line>
            {formatCount(collections)}{" "}
            {collections === 1 ? "collection" : "collections"} · saves{" "}
            {declaresSaves(data ?? null) ? "declared" : "not declared"}
          </Line>
        </>
      ) : null}
    </TileFrame>
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
