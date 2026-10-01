import * as React from "react";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Code2,
  KeyRound,
  ListChecks,
  PackageOpen,
  ShieldCheck,
} from "lucide-react";
import { api, type ProductDetail } from "../api.js";
import { useResource } from "../context.js";
import { hashFor } from "../route.js";
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
import {
  modulesOf,
  nextActionsOf,
  onboardingOf,
  setupStateOf,
  signingBundleOf,
} from "./products/util.js";

export function ProductOverview({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const { data, loading, error, reload } = useResource(`product:${slug}`, () =>
    api.product(slug).then((r) => r.product),
  );

  if (loading && !data) return <OverviewSkeleton />;

  if (error && !data) {
    return (
      <section className="space-y-6">
        <Header slug={slug} title="Overview" />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Could not load product setup"
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
        <Header slug={slug} title="Overview" />
        <EmptyState
          icon={<PackageOpen aria-hidden />}
          title="No product details available"
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <Header slug={slug} title="Overview" product={data} />
      <HealthStrip product={data} />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <SetupCard product={data} />
        <SigningCard product={data} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ModulesCard product={data} />
        <SdkCard product={data} />
      </div>
    </section>
  );
}

function Header({
  slug,
  title,
  product,
}: {
  slug: string;
  title: string;
  product?: ProductDetail;
}): React.ReactElement {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">
          {product ? product.name : "Product"} control plane for{" "}
          <span className="font-mono">{slug}</span>.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={hashFor({ kind: "product", slug, view: "settings" })}>
            Settings
          </a>
        </Button>
        <Button asChild size="sm">
          <a href={hashFor({ kind: "product", slug, view: "licenses" })}>
            Create license
          </a>
        </Button>
      </div>
    </header>
  );
}

function HealthStrip({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  const signing = signingBundleOf(product);
  const modules = modulesOf(product);
  const setup = setupStateOf(product);
  const missing = [
    ...(setup?.missing ?? []),
    ...(setup?.missingSecrets ?? []),
  ].filter(Boolean);
  const warnings = setup?.warnings ?? [];
  const releaseSource = product.releaseSource ?? "manual";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        icon={<ShieldCheck aria-hidden />}
        label="Setup"
        value={setupLabel(setup)}
        tone={setupTone(setup)}
      />
      <MetricCard
        icon={<Boxes aria-hidden />}
        label="Modules"
        value={modules.length ? String(modules.length) : "Baseline"}
      />
      <MetricCard
        icon={<KeyRound aria-hidden />}
        label="Trust key"
        value={signing.publicKey ? "Ready" : "Missing"}
        tone={signing.publicKey ? "success" : "warning"}
      />
      <MetricCard
        icon={<PackageOpen aria-hidden />}
        label="Release source"
        value={releaseSource}
      />
      {missing.length || warnings.length ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <Card className="border-warning/40 bg-warning/10">
            <CardContent className="flex gap-3 p-4 text-sm">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden
              />
              <div className="space-y-1">
                <p className="font-medium">Setup needs attention</p>
                <p className="text-muted-foreground">
                  {[...missing, ...warnings].join(", ")}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function SetupCard({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  const checklist = setupChecklistOf(product);
  const rows = [
    ["Product", product.name],
    ["Slug", product.slug],
    // Manifest metadata only. Admin authority is platform-wide (PLATFORM_ADMIN_GROUP);
    // per-product admin was removed, so this value grants nothing and "not restricted" would
    // read as though some other value DID restrict.
    ["Admin group (metadata only)", product.adminGroup ?? "unset"],
    ["Compatibility", `${product.compatMin} to ${product.compatMax}`],
    ["Default devices", String(product.defaultDeviceLimit)],
    ["Offline window", `${product.defaultMaxOfflineDays} days`],
  ];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Setup state</CardTitle>
        </div>
        <CardDescription>
          Manifest baseline, generated state, and immediate operator actions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                {term}
              </dt>
              <dd className="mt-1 break-words text-sm font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Guided checklist
          </p>
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 gap-2">
                  {item.status === "done" ? (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden
                    />
                  ) : (
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0 text-warning"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </div>
                {item.href ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={item.href}>
                      {item.actionLabel}
                      <ArrowRight aria-hidden />
                    </a>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

interface SetupChecklistItem {
  id: string;
  title: string;
  description: string;
  status: "done" | "action";
  href?: string;
  actionLabel?: string;
}

function setupChecklistOf(product: ProductDetail): SetupChecklistItem[] {
  const setup = setupStateOf(product);
  const signing = signingBundleOf(product);
  // `requiredSecrets` is the FULL requirement list (configured or not) — only
  // `missingSecrets` belongs in the missing line. Folding requiredSecrets in here made
  // every required secret render as "Missing" forever, even when configured.
  const missing = [
    ...(setup?.missing ?? []),
    ...(setup?.missingSecrets ?? []),
  ].filter(Boolean);
  const warnings = setup?.warnings ?? [];
  const items: SetupChecklistItem[] = [
    {
      id: "trust-key",
      title: "Trust key readiness",
      description: signing.publicKey
        ? "A public key is available for client pinning."
        : "Prepare or rotate a signing key before SDKs rely on signed config.",
      status: signing.publicKey ? "done" : "action",
      href: hashFor({ kind: "product", slug: product.slug, view: "settings" }),
      actionLabel: signing.publicKey ? "Review key" : "Prepare key",
    },
    {
      id: "secrets",
      title: "Required secrets",
      description: missing.length
        ? `Missing: ${missing.join(", ")}`
        : "All reported setup requirements are configured.",
      status: missing.length ? "action" : "done",
      href: missing.length
        ? hashFor({ kind: "product", slug: product.slug, view: "secrets" })
        : undefined,
      actionLabel: "Set secrets",
    },
  ];

  // License-only steps: a product running without License (a Godot game distributing builds
  // only, say) has no defaults to edit and no licenses to issue. `services` is absent on older
  // payloads, which meant "the defaults", and License is on by default.
  if (product.services?.license?.enabled !== false) {
    items.push(
      {
        id: "license-defaults",
        title: "License defaults",
        description: `${product.defaultDeviceLimit} devices, ${product.defaultMaxOfflineDays} offline days by default.`,
        status: "done",
        href: hashFor({
          kind: "product",
          slug: product.slug,
          view: "settings",
        }),
        actionLabel: "Edit defaults",
      },
      {
        id: "first-license",
        title: "Issue a license",
        description:
          "Create a test license to verify keys, devices, and policy before rollout.",
        status: "action",
        href: hashFor({
          kind: "product",
          slug: product.slug,
          view: "licenses",
        }),
        actionLabel: "Create test license",
      },
    );
  }

  for (const [index, warning] of warnings.entries()) {
    items.push({
      id: `warning-${index}`,
      title: "Review setup warning",
      description: warning,
      status: "action",
      href: hashFor({ kind: "product", slug: product.slug, view: "overview" }),
      actionLabel: "Review",
    });
  }

  for (const [index, action] of nextActionsOf(product).entries()) {
    const title =
      action.label ?? action.title ?? action.description ?? "Review setup";
    const href = setupActionHref(product.slug, action.href ?? action.route);
    if (items.some((item) => item.title === title)) continue;
    items.push({
      id: action.id ?? `next-${index}`,
      title,
      description:
        action.description ?? "Recommended by the product setup state.",
      status:
        action.status === "done" || action.status === "complete"
          ? "done"
          : "action",
      href,
      actionLabel: href ? "Open" : undefined,
    });
  }

  return items.slice(0, 7);
}

function setupActionHref(slug: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("#/") || value.startsWith("http")) return value;
  const rawView = value.replace(/^\/+/, "");
  const view = !rawView || rawView === "setup" ? "overview" : rawView;
  return `#/p/${encodeURIComponent(slug)}/${encodeURIComponent(view || "overview")}`;
}

function SigningCard({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  const signing = signingBundleOf(product);
  const trustJson = JSON.stringify(signing.trustKeys, null, 2);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>SDK trust key</CardTitle>
        </div>
        <CardDescription>
          Pin this public key in clients that verify signed config documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="space-y-3">
          <Row term="Key id" value={signing.kid ?? product.signingKid} mono />
          <Row term="Public key" value={signing.publicKey ?? "missing"} mono />
          <Row
            term="JWKS"
            value={signing.jwksUrl ?? `/${product.slug}/.well-known/jwks.json`}
            mono
          />
        </dl>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs">
          <code>
            {trustJson === "{}" ? "// public key not available yet" : trustJson}
          </code>
        </pre>
      </CardContent>
    </Card>
  );
}

function ModulesCard({
  product,
}: {
  product: ProductDetail;
}): React.ReactElement {
  const modules = modulesOf(product);
  const fallback = [
    {
      id: "licensing",
      label: "Licensing",
      description: "License keys, devices, and policy",
      status: "baseline",
      configured: null,
      missing: [],
    },
    {
      id: "config",
      label: "Config",
      description: "Signed managed config",
      status: "baseline",
      configured: null,
      missing: [],
    },
    {
      id: "identity",
      label: "Identity",
      description: "OIDC activation when configured",
      status: "baseline",
      configured: null,
      missing: [],
    },
    {
      id: "releases",
      label: "Releases",
      description: "Release delivery when configured",
      status: product.releaseSource === "github" ? "github" : "manual",
      configured: null,
      missing: [],
    },
  ];
  const list = modules.length ? modules : fallback;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Modules</CardTitle>
        </div>
        <CardDescription>
          Capabilities enabled by manifest baseline or runtime overrides.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((module) => (
            <li key={module.id} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{module.label}</p>
                <Badge
                  variant={module.configured === false ? "warning" : "outline"}
                >
                  {module.status}
                </Badge>
              </div>
              {module.description ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {module.description}
                </p>
              ) : null}
              {module.missing.length ? (
                <p className="mt-2 text-xs text-warning">
                  Missing: {module.missing.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SdkCard({ product }: { product: ProductDetail }): React.ReactElement {
  const onboarding = onboardingOf(product);
  const signing = signingBundleOf(product);
  const baseUrl = onboarding?.baseUrl ?? window.location.origin;
  const snippet = `await PolarisKeyClient.create({\n  productSlug: "${product.slug}",\n  baseUrl: "${baseUrl}",\n  version: "1.0.0",\n  trust: { pinnedKeys: ${JSON.stringify(signing.trustKeys)} }\n});`;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Code2 className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>SDK starter</CardTitle>
        </div>
        <CardDescription>
          Use this as the first integration check after setup is healthy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs">
          <code>{snippet}</code>
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={hashFor({
                kind: "product",
                slug: product.slug,
                view: "config",
              })}
            >
              Review config
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a
              href={hashFor({
                kind: "product",
                slug: product.slug,
                view: "identity",
              })}
            >
              Review identity
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  term,
  value,
  mono,
}: {
  term: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {term}
      </dt>
      <dd
        className={
          mono
            ? "mt-1 break-all font-mono text-xs"
            : "mt-1 break-words text-sm font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "success" | "warning";
}): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-4">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p
            className={
              tone === "warning"
                ? "truncate text-sm font-semibold text-warning"
                : tone === "success"
                  ? "truncate text-sm font-semibold text-success"
                  : "truncate text-sm font-semibold"
            }
          >
            {value}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function setupLabel(setup: ReturnType<typeof setupStateOf>): string {
  if (!setup) return "Baseline";
  if (setup.complete || setup.healthy || setup.status === "ok")
    return "Healthy";
  if (setup.status) return setup.status;
  return "Review";
}

function setupTone(
  setup: ReturnType<typeof setupStateOf>,
): "default" | "success" | "warning" {
  if (!setup) return "default";
  if (setup.complete || setup.healthy || setup.status === "ok")
    return "success";
  return "warning";
}

function OverviewSkeleton(): React.ReactElement {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </section>
  );
}
