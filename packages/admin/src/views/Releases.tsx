import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Info,
  Package,
} from "lucide-react";
import type {
  ProductDetail,
  ProductSyncState,
  ReleaseHealth,
  ReleaseHealthCheck,
} from "../api.js";
import { api } from "../api.js";
import { useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "../components/ui/index.js";
import { ResyncButton } from "./releases/ResyncButton.js";

/**
 * Releases view: manifest-driven release/distribution status. Release config is still edited
 * in `.pkey/release.*`; admin exposes health checks, last sync state, and manual resync.
 */
export function Releases({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`product:${slug}`, () =>
    api.product(slug).then((r) => r.product),
  );
  const health = useResource(`release-health:${slug}`, () =>
    api.releaseHealth(slug).then((r) => r.health),
  );

  if (loading && !data) return <ReleasesSkeleton />;

  if (error && !data) {
    return (
      <section className="space-y-6">
        <Header slug={slug} />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the product"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  if (!data) {
    return (
      <section className="space-y-6">
        <Header slug={slug} />
        <EmptyState
          icon={<Package aria-hidden />}
          title="No product details available"
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <Header slug={slug} />
      <ManifestNote />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <ReleaseHealthCard
          health={health.data ?? null}
          loading={health.loading}
          error={health.error}
          onRetry={health.reload}
        />
        <SyncStateCard sync={data.setup?.sync ?? null} />
      </div>
      <DistributionCard product={data} />
    </section>
  );
}

function Header({ slug }: { slug: string }): React.ReactElement {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Releases</h2>
        <p className="text-sm text-muted-foreground">
          Release distribution &amp; minters for{" "}
          <span className="font-mono">{slug}</span>.
        </p>
      </div>
      <ResyncButton slug={slug} />
    </header>
  );
}

/**
 * Explains the source of truth for release config. Editing happens in the repo's `.pkey/`
 * manifest, then is applied with the Resync action — there is no per-field release form because
 * the admin API exposes no release CRUD.
 */
function ManifestNote(): React.ReactElement {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex gap-3 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            Release config is managed from the repo manifest.
          </p>
          <p className="text-muted-foreground">
            GitHub coordinates (owner / repo / binary name / channel workflow /
            Sparkle key) and edge-mint recipes live in the product’s{" "}
            <span className="font-mono">.pkey/release</span> file. Edit them
            there, then use{" "}
            <span className="font-medium">Resync from repo</span> above to
            re-apply. These values are not editable directly from the admin
            panel.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ReleaseHealthCard({
  health,
  loading,
  error,
  onRetry,
}: {
  health: ReleaseHealth | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            <CardTitle>Release health</CardTitle>
          </div>
          {health ? <StatusBadge status={health.status} /> : null}
        </div>
        <CardDescription>
          GitHub App access, published releases, assets, and Sparkle material.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !health ? <Skeleton className="h-28 w-full" /> : null}
        {error && !health ? (
          <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium text-warning">Health check failed</p>
            <p className="text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : null}
        {health ? (
          <>
            {health.release ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Row term="Latest tag" mono>
                  {health.release.tag}
                </Row>
                <Row term="Assets">{String(health.release.assetCount)}</Row>
              </dl>
            ) : null}
            <ul className="space-y-2">
              {health.checks.map((item) => (
                <HealthCheckRow key={item.id} check={item} />
              ))}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HealthCheckRow({
  check,
}: {
  check: ReleaseHealthCheck;
}): React.ReactElement {
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{check.label}</span>
        <StatusBadge status={check.status} />
      </div>
      {check.message ? (
        <p className="mt-1 text-xs text-muted-foreground">{check.message}</p>
      ) : null}
      {check.missing?.length ? (
        <p className="mt-1 text-xs text-warning">
          Missing: {check.missing.join(", ")}
        </p>
      ) : null}
    </li>
  );
}

function SyncStateCard({
  sync,
}: {
  sync: ProductSyncState | null;
}): React.ReactElement {
  const changed = sync?.changedPaths ?? [];
  const updated = sync?.updated ?? [];
  const errors = sync?.errors ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle>Manifest sync</CardTitle>
          </div>
          {sync?.status ? <StatusBadge status={sync.status} /> : null}
        </div>
        <CardDescription>
          Last `.pkey/` sync attempt, changed paths, and applied sections.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sync ? (
          <>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row term="Source">{sync.source ?? "—"}</Row>
              <Row term="Last checked">
                {formatStamp(sync.lastCheckedAt ?? undefined)}
              </Row>
              <Row term="Last synced">
                {formatStamp(sync.lastSyncedAt ?? undefined)}
              </Row>
              <Row term="Commit" mono>
                {sync.commitSha ?? "—"}
              </Row>
            </dl>
            <SyncList title="Changed paths" values={changed} mono />
            <SyncList title="Updated sections" values={updated} />
            <SyncList title="Errors" values={errors} tone="warning" />
            {sync.message ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                {sync.message}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No repo sync attempt has been recorded yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SyncList({
  title,
  values,
  mono,
  tone,
}: {
  title: string;
  values: string[];
  mono?: boolean;
  tone?: "warning";
}): React.ReactElement | null {
  if (!values.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className="flex flex-wrap gap-2">
        {values.slice(0, 12).map((value) => (
          <li key={value}>
            <Badge variant={tone === "warning" ? "warning" : "outline"}>
              <span className={mono ? "font-mono" : undefined}>{value}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The release-adjacent product metadata the admin API DOES expose: signing key id, the
 * compatibility version window enforced on update checks, and the per-product defaults.
 */
function DistributionCard({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Distribution &amp; compatibility</CardTitle>
        </div>
        <CardDescription>
          Read-only product metadata that governs releases and update checks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Row term="Product">{product.name}</Row>
          <Row term="Slug" mono>
            {product.slug}
          </Row>
          <Row term="Signing key id" mono>
            {product.signingKid || "—"}
          </Row>
          <Row term="Compatibility window">
            <span className="inline-flex items-center gap-1.5">
              <Badge variant="outline">min {product.compatMin}</Badge>
              <span aria-hidden>→</span>
              <Badge variant="outline">max {product.compatMax}</Badge>
            </span>
          </Row>
          <Row term="Default max offline days">
            {String(product.defaultMaxOfflineDays)}
          </Row>
          <Row term="Default device limit">
            {product.defaultMachineLimit === 0
              ? "unlimited"
              : String(product.defaultMachineLimit)}
          </Row>
          <Row term="Admin group" mono>
            {product.adminGroup ?? "—"}
          </Row>
          <Row term="Last modified">{formatStamp(product.modifiedAt)}</Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({
  term,
  children,
  mono,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {term}
      </dt>
      <dd className={mono ? "break-words font-mono text-sm" : "text-sm"}>
        {children}
      </dd>
    </div>
  );
}

function formatStamp(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const normalized = status.toLowerCase();
  const variant =
    normalized === "ok" || normalized === "healthy"
      ? "success"
      : normalized === "warning" ||
          normalized === "needs-setup" ||
          normalized === "not-configured" ||
          normalized === "missing"
        ? "warning"
        : normalized === "error"
          ? "destructive"
          : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function ReleasesSkeleton(): React.ReactElement {
  return (
    <section className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-64 w-full" />
    </section>
  );
}
