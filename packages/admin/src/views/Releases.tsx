import * as React from "react";
import { AlertTriangle, GitBranch, Info, Package } from "lucide-react";
import type { ProductDetail } from "../api.js";
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
 * Releases view: the product's release/distribution configuration.
 *
 * API GAP (flagged): the admin surface exposes NO read endpoint for the release block itself —
 * GitHub coordinates (owner/repo/binaryName/channel workflow/Sparkle key) and edge-mint recipes
 * live in `release_config` / `edge_mint_config`, sourced from the repo's `.pkey/release.*`, but
 * the only release-related admin route is `POST /products/<slug>/release/resync`. So this view
 * renders the read-only product metadata that IS exposed (`getProduct`) plus a clear note that
 * release config is managed via the repo manifest and applied with the Resync action. If/when a
 * `GET .../release` endpoint lands, this view should grow a coordinates panel + minter list.
 */
export function Releases({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`product:${slug}`, () =>
    api.product(slug).then((r) => r.product),
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
        <EmptyState icon={<Package aria-hidden />} title="No product details available" />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <Header slug={slug} />
      <ManifestNote />
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
          Release distribution &amp; minters for <span className="font-mono">{slug}</span>.
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
          <p className="font-medium">Release config is managed from the repo manifest.</p>
          <p className="text-muted-foreground">
            GitHub coordinates (owner / repo / binary name / channel workflow / Sparkle key) and
            edge-mint recipes live in the product’s <span className="font-mono">.pkey/release</span>{" "}
            file. Edit them there, then use <span className="font-medium">Resync from repo</span>{" "}
            above to re-apply. These values are not editable directly from the admin panel.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The release-adjacent product metadata the admin API DOES expose: signing key id, the
 * compatibility version window enforced on update checks, and the per-product defaults.
 */
function DistributionCard({ product }: { product: ProductDetail }): React.ReactElement {
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
          <Row term="Default max offline days">{String(product.defaultMaxOfflineDays)}</Row>
          <Row term="Default device limit">
            {product.defaultMachineLimit === 0 ? "unlimited" : String(product.defaultMachineLimit)}
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
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{term}</dt>
      <dd className={mono ? "break-words font-mono text-sm" : "text-sm"}>{children}</dd>
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
