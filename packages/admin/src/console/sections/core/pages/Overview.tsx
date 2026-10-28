/**
 * Core → Overview (products.overview; docs/design/ADMIN.md §3): "is this product healthy, and what
 * is it running?" One grid for the page body:
 *
 * - The hero (`components/OverviewHero.tsx`) is the masthead: the product's identity, the one
 *   computed next step (the first attention item, else Integration's next step, else the main
 *   action) and, until the operator hides it, the Integration pane (a gauge per platform).
 * - The board: one card per feature in canonical order, each its key number, from the feature's
 *   own queries, loaded per card (one failing never blanks the page). A feature the product does
 *   not run is a dashed cell.
 * - Integration steps (`components/IntegrationSteps.tsx`): a rail, a row per feature, a badge per
 *   platform. Recent activity runs under the board.
 * - Moments (EXPERIENCE.md §0.7; MO-11): the first catalog publish, the first release, the first
 *   store connected and the product launched each show once per product, as one line with the
 *   success check and sparks (`components/Moment.tsx`).
 * - The columns follow the grid's own width (4 from 1488 px, 3 from 976, 2 from 680, else 1).
 */

import { deviceSummaryQuery, integrationQuery, coreBReads } from "../data.js";
import { licensesQuery } from "../../license/data.js";
import { catalogQuery, profilesQuery } from "../../config/data.js";
import { releaseStoreQuery } from "../../release/data.js";
import { storefrontsQuery } from "../../storefronts/data.js";
import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ArrowRight,
  Eye,
  Server,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  HttpError,
  type LicenseSummary,
  type ProductDetail,
  type ReleaseDto,
  type ServiceSlug,
} from "../../../../api.js";
import {
  formatCount,
  formatDateTime,
  formatShort,
  fromSeconds,
} from "../../../../lib/format.js";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton, Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import {
  MomentBanner,
  momentKey,
  useMoment,
  type MomentObservation,
} from "../../../components/Moment.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useAttention, useProduct } from "../../../data/hooks.js";
import { OverviewAttention } from "../components/OverviewAttention.js";
import { Link, navigate } from "../../../router.js";
import {
  FeatureCard,
  OffCard,
  SectionHead,
  tileTitle,
} from "../components/TileFrame.js";
import {
  ShipBuildsTile,
  latestAppRelease,
} from "../components/ShipBuildsTile.js";
import { CommerceTile } from "../../commerce/CommerceTile.js";
import { pendingRecipesOf, reviewHref } from "../../config/model/pending.js";
import { r } from "../../../routes.js";
import {
  heroStep,
  productAttentionItems,
  useAttentionPending,
} from "./overviewAttention.js";
import { ActivityTarget, actorName, useActivityFeed } from "./Activity.js";
import { verbFor } from "../model/activityVerbs.js";
import { declaresSaves, noCatalog, userSettings } from "../../sync/data.js";
import { IntegrationSteps } from "../components/IntegrationSteps.js";
import { IntegrationPane, OverviewHero } from "../components/OverviewHero.js";
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
  // The attention read is part of the first load (MO-11).
  const pending = useAttentionPending() || product.isPending;
  useLoadingAnnouncement("overview", pending);
  if (pending) {
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
      placeholder={product.isPlaceholderData}
    />
  );
}

function OverviewBody({
  slug,
  product: p,
  placeholder = false,
}: {
  slug: string;
  product: ProductDetail;
  /** The product is the products list's row standing in until its own read lands. */
  placeholder?: boolean;
}): React.ReactElement {
  const enabled = SERVICE_ORDER.filter((s) => on(p, s));
  const features = runningFeatures(p);
  const licenses = useQuery({
    ...licensesQuery(slug),
    enabled: on(p, "license"),
  });
  const integration = useQuery({
    ...integrationQuery(slug),
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
  const serverAttention = useAttention();
  const pending = pendingRecipesOf(serverAttention.data, slug);
  const next = view
    ? nextStep(slug, view, Boolean(p.signing?.publicKey), pending)
    : null;
  const setup = useSetup(slug);
  const licenseGate = useWriteGate("license", slug);
  const hidden = setup.choices.integrationHidden !== null;
  // Show Integration puts the pane back and the pane takes focus; nothing else moves it.
  const [justShown, setJustShown] = React.useState(false);
  const paneShown = enabled.length > 0 && !hidden;
  // Hide unmounts its own button: focus goes to ⋯ More, where Show Integration now lives.
  const focusHeroMenu = (): void => {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="overview-hero"] button[aria-label="More"]',
        )
        ?.focus(),
    );
  };
  const attention = productAttentionItems(
    slug,
    serverAttention.data,
    licenses.data?.licenses,
  );
  const step = heroStep(attention, next, (service) =>
    service ? tileTitle(service as ServiceSlug) : "Core",
  );
  const attentionOf = (s: ServiceSlug): number =>
    attention.filter((i) => i.service === s).length;
  // Nothing is decided until the read model answers, so the action never changes once it shows.
  const stepPending =
    enabled.length > 0 && attention.length === 0 && integration.isPending;

  const fallback = on(p, "license") ? (
    <Button asChild size="lg" disabledReason={licenseGate.disabledReason}>
      <Link to={r.newLicense(slug)}>New license</Link>
    </Button>
  ) : on(p, "config") ? (
    <Button asChild size="lg">
      <Link to={r.catalog(slug)}>Publish catalog</Link>
    </Button>
  ) : (
    <Button asChild size="lg">
      <Link to={r.services(slug)}>Enable features</Link>
    </Button>
  );
  const menu = [
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
            disabledReason: setup.allowed ? undefined : setup.disabledReason,
            onSelect: () =>
              void setup.setIntegrationHidden(false).then((ok) => {
                if (ok) setJustShown(true);
              }),
          },
        ]
      : []),
  ];
  const canHide = Boolean(view?.features.some((f) => f.status === "verified"));
  const stepsShown = paneShown && Boolean(view) && view!.features.length > 0;

  // The board's cells in canonical order; a feature the product does not run is a dashed cell.
  const cell = (s: ServiceSlug): React.ReactElement => {
    if (!on(p, s))
      return <OffCard key={s} service={s} href={r.services(slug)} />;
    switch (s) {
      case "license":
        return (
          <LicenseTile
            key={s}
            slug={slug}
            licenses={licenses}
            attention={attentionOf(s)}
          />
        );
      case "config":
        return <ConfigTile key={s} slug={slug} attention={attentionOf(s)} />;
      case "release":
        return (
          <ShipBuildsTile
            key={s}
            slug={slug}
            distribution={on(p, "distribution")}
            update={on(p, "update")}
            attention={
              attentionOf("release") +
              attentionOf("distribution") +
              attentionOf("update")
            }
          />
        );
      case "identity":
        return <IdentityTile key={s} slug={slug} attention={attentionOf(s)} />;
      case "sync":
        return <SyncTile key={s} slug={slug} attention={attentionOf(s)} />;
      default:
        return <CommerceTile key={s} slug={slug} attention={attentionOf(s)} />;
    }
  };
  const BOARD: ServiceSlug[] = [
    "license",
    "config",
    "release",
    "identity",
    "sync",
    "commerce",
  ];

  return (
    <div
      data-template="overview"
      className="@container mx-auto w-full max-w-[1760px]"
    >
      <div className="grid grid-cols-1 gap-6 @min-[680px]:grid-cols-2 @min-[976px]:grid-cols-3 @min-[1488px]:grid-cols-4">
        <div className="col-span-full space-y-3 empty:hidden">
          <OverviewMoments slug={slug} product={p} launched={launched} />
          <OverviewAttention read={serverAttention} />
        </div>
        <OverviewHero
          slug={slug}
          product={p}
          featureCount={features.length}
          step={step}
          fallback={fallback}
          stepPending={stepPending}
          menu={menu}
          pane={
            paneShown ? (
              <IntegrationPane
                slug={slug}
                query={integration}
                focusHeading={justShown}
                hide={
                  canHide
                    ? {
                        onHide: () =>
                          void setup.setIntegrationHidden(true).then((ok) => {
                            if (ok) focusHeroMenu();
                          }),
                        disabledReason: setup.allowed
                          ? undefined
                          : setup.disabledReason,
                      }
                    : null
                }
              />
            ) : null
          }
        />
        {enabled.length === 0 ? (
          <div className="col-span-full">
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
          </div>
        ) : (
          <>
            <section
              aria-labelledby="overview-features"
              className="grid grid-cols-subgrid content-start gap-y-4 @min-[680px]:col-span-2 @min-[680px]:col-start-1 @min-[680px]:row-start-2 @min-[1488px]:col-span-3"
            >
              <SectionHead
                id="overview-features"
                title="Features"
                action={{ label: "Manage features", to: r.services(slug) }}
              />
              <div className="col-span-full grid grid-cols-subgrid gap-y-4">
                {BOARD.map(cell)}
              </div>
            </section>
            {stepsShown ? (
              <section
                aria-labelledby="overview-steps"
                className="space-y-4 @min-[680px]:col-start-2 @min-[680px]:row-start-3 @min-[976px]:col-start-3 @min-[976px]:row-span-2 @min-[976px]:row-start-2 @min-[1488px]:col-start-4"
              >
                <SectionHead id="overview-steps" title="Integration steps" />
                <div className="@container overflow-hidden rounded-xl border border-border bg-surface-raised">
                  <IntegrationSteps slug={slug} view={view!} />
                </div>
              </section>
            ) : null}
            <RecentActivity
              slug={slug}
              className={cn(
                stepsShown
                  ? "@min-[680px]:col-start-1 @min-[680px]:row-start-3 @min-[976px]:col-span-2 @min-[1488px]:col-span-3"
                  : "@min-[680px]:col-span-2 @min-[680px]:col-start-1 @min-[680px]:row-start-3 @min-[976px]:col-span-1 @min-[976px]:col-start-3 @min-[976px]:row-start-2 @min-[1488px]:col-start-4",
              )}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Moments (EXPERIENCE.md §0.7; MO-11) ────────────────────────────────────────────────────────
const UNKNOWN: MomentObservation = { state: "unknown" };
const BEFORE: MomentObservation = { state: "before" };

const ACTION_LINK =
  "inline-flex min-h-6 items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline";

/** The first catalog: published once it has entries; a 404 is "not yet", any other error unknown. */
export function catalogMoment(
  enabled: boolean,
  catalog: { data?: { entries?: unknown[] }; error: unknown; isError: boolean },
): MomentObservation {
  if (!enabled) return UNKNOWN;
  if (catalog.isError)
    return catalog.error instanceof HttpError && catalog.error.status === 404
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
    ...catalogQuery(slug),
    enabled: on(p, "config"),
    retry: false,
  });
  const store = useQuery({
    ...releaseStoreQuery(slug),
    enabled: on(p, "release"),
  });
  const stores = useQuery({
    ...storefrontsQuery(slug),
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

// ── Feature cards ──────────────────────────────────────────────────────────────────────────────
function LicenseTile({
  slug,
  licenses,
  attention,
}: {
  slug: string;
  licenses: LicensesQuery;
  attention: number;
}): React.ReactElement {
  const devices = useQuery(deviceSummaryQuery(slug));
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
    <FeatureCard
      service="license"
      href={r.licenses(slug)}
      attention={attention}
      loading={licenses.isPending}
      error={licenses.isError ? licenses.error : undefined}
      onRetry={() => void licenses.refetch()}
      number={formatCount(active)}
      unit="active"
      foot={[
        `${formatCount(expiring)} expiring soon`,
        `${formatCount(disabled)} disabled`,
        devices.data ? `${formatCount(devices.data.total)} devices` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    />
  );
}

function ConfigTile({
  slug,
  attention,
}: {
  slug: string;
  attention: number;
}): React.ReactElement {
  const catalog = useQuery({
    ...catalogQuery(slug),
    retry: false,
  });
  const profiles = useQuery(profilesQuery(slug));
  const missing =
    catalog.error instanceof HttpError && catalog.error.status === 404;
  const entries = catalog.data?.entries ?? [];
  const secrets = entries.filter(
    (e) => (e as { kind?: string }).kind === "secret",
  ).length;
  const count = profiles.data?.profiles.length;
  return (
    <FeatureCard
      service="config"
      href={r.catalog(slug)}
      attention={attention}
      loading={catalog.isPending}
      error={catalog.isError && !missing ? catalog.error : undefined}
      onRetry={() => void catalog.refetch()}
      number={
        missing || !catalog.data ? undefined : `v${catalog.data.schemaVersion}`
      }
      unit={missing || !catalog.data ? undefined : "catalog"}
      foot={
        missing || !catalog.data
          ? "No catalog yet"
          : [
              `${formatCount(entries.length - secrets)} ${entries.length - secrets === 1 ? "setting" : "settings"}`,
              `${formatCount(secrets)} ${secrets === 1 ? "secret" : "secrets"}`,
              count === undefined
                ? null
                : `${formatCount(count)} ${count === 1 ? "profile" : "profiles"}`,
            ]
              .filter(Boolean)
              .join(" · ")
      }
    />
  );
}

function IdentityTile({
  slug,
  attention,
}: {
  slug: string;
  attention: number;
}): React.ReactElement {
  const portal = useQuery(coreBReads.portal(slug));
  const s = portal.data;
  return (
    <FeatureCard
      service="identity"
      href={r.appSignIn(slug)}
      attention={attention}
      loading={portal.isPending}
      error={portal.isError ? portal.error : undefined}
      onRetry={() => void portal.refetch()}
      foot={
        s
          ? s.portalEnabled
            ? "Sign-in by email code and passkeys"
            : "Sign-in is off"
          : undefined
      }
    />
  );
}

function SyncTile({
  slug,
  attention,
}: {
  slug: string;
  attention: number;
}): React.ReactElement {
  const catalog = useQuery({
    ...catalogQuery(slug),
    retry: false,
  });
  const empty = noCatalog(catalog.error);
  const data = empty ? null : catalog.data;
  const settings = userSettings(data ?? null).length;
  const collections = data?.cloudSync?.collections?.length ?? 0;
  const syncing = settings > 0 || collections > 0;
  return (
    <FeatureCard
      service="sync"
      href={r.syncData(slug)}
      attention={attention}
      loading={catalog.isPending}
      error={catalog.isError && !empty ? catalog.error : undefined}
      onRetry={() => void catalog.refetch()}
      number={syncing ? formatCount(settings) : undefined}
      unit={syncing ? (settings === 1 ? "setting" : "settings") : undefined}
      foot={
        data !== undefined
          ? syncing
            ? `${formatCount(collections)} ${collections === 1 ? "collection" : "collections"} · saves ${declaresSaves(data ?? null) ? "declared" : "not declared"}`
            : "Not syncing yet"
          : undefined
      }
    />
  );
}

/** "Today, 10:42" or "Oct 6, 4:20 PM": the mockup's flat-row time, in the viewer's locale. */
function activityWhen(at: number, now = Date.now()): string {
  const day = (t: number): string => new Date(t).toDateString();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (day(at) === day(now)) return `Today, ${time}`;
  return `${formatShort(at)}, ${time}`;
}

function activityInitials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  const l =
    w.length >= 2
      ? `${w[0]![0]}${w[w.length - 1]![0]}`
      : (w[0] ?? "?").slice(0, 2);
  return l.toUpperCase();
}

// ── Recent activity ────────────────────────────────────────────────────────────────────────────

function RecentActivity({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}): React.ReactElement {
  const feed = useActivityFeed(slug, {});
  const items = (feed.data?.pages.flatMap((pg) => pg.items) ?? []).slice(0, 5);
  return (
    <section
      aria-labelledby="overview-activity"
      className={cn("space-y-4", className)}
    >
      <SectionHead
        id="overview-activity"
        title="Recent activity"
        action={{ label: "Open Activity", to: r.activity(slug) }}
      />
      <div className="rounded-xl border border-border bg-surface-raised p-4">
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
          <ul aria-label="Recent activity" className="divide-y divide-border">
            {items.map((i) => {
              const name = i.actor.sub ? actorName(i) : "Polaris Key";
              return (
                <li
                  key={i.id}
                  className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0"
                >
                  <span
                    aria-hidden
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-fg-muted"
                  >
                    {i.actor.sub ? (
                      activityInitials(name)
                    ) : (
                      <Server className="size-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-fg [overflow-wrap:anywhere]">
                    <span className="font-medium text-fg-strong">{name}</span>{" "}
                    {verbFor(i.action)} <ActivityTarget slug={slug} item={i} />
                  </span>
                  <time
                    dateTime={new Date(fromSeconds(i.at)).toISOString()}
                    title={formatDateTime(fromSeconds(i.at))}
                    className="shrink-0 text-xs text-fg-subtle tabular-nums"
                  >
                    {activityWhen(fromSeconds(i.at))}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
