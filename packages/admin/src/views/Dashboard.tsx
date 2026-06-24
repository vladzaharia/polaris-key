import * as React from "react";
import { ArrowRight, Boxes, KeyRound, PackageOpen, ShieldCheck } from "lucide-react";
import { useAdmin } from "../context.js";
import { hashFor } from "../route.js";
import type { ProductRef } from "../api.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
} from "../components/ui/index.js";

/**
 * The operator landing view: who you are, what you administer, and quick links into each
 * product. Products come straight off the session (`me.products`) — name, slug, and the
 * config schema version each carries. A welcome/empty state covers operators with no products.
 */
export function Dashboard(): React.ReactElement {
  const { me } = useAdmin();
  const firstName = me.name.split(/\s+/)[0] || me.name;
  const products = me.products;

  return (
    <section aria-labelledby="dashboard-title" className="space-y-6">
      <header className="space-y-1">
        <h2 id="dashboard-title" className="text-2xl font-semibold tracking-tight">
          Welcome, {firstName}
        </h2>
        <p className="text-sm text-muted-foreground">
          {me.platformAdmin ? "Platform administrator" : "Product administrator"} · {me.email}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<Boxes aria-hidden />} label="Products" value={String(products.length)} />
        <StatCard
          icon={<ShieldCheck aria-hidden />}
          label="Role"
          value={me.platformAdmin ? "Platform" : "Product"}
        />
        <StatCard icon={<KeyRound aria-hidden />} label="Session" value="Active" />
      </div>

      <section aria-labelledby="products-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3
            id="products-heading"
            className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Your products
          </h3>
          {me.platformAdmin ? (
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <a href={hashFor({ kind: "products" })}>Manage registry</a>
            </Button>
          ) : null}
        </div>

        {products.length === 0 ? (
          <EmptyState
            icon={<PackageOpen aria-hidden />}
            title="No products yet"
            description={
              me.platformAdmin
                ? "Link a repository or create a product to get started."
                : "You don’t administer any products yet. Ask a platform admin to grant access."
            }
            action={
              me.platformAdmin ? (
                <Button asChild size="sm">
                  <a href={hashFor({ kind: "products" })}>Open registry</a>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid list-none gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((prod) => (
              <li key={prod.slug}>
                <ProductCard product={prod} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function ProductCard({ product }: { product: ProductRef }): React.ReactElement {
  const href = hashFor({ kind: "product", slug: product.slug, view: "licenses" });
  return (
    <Card className="flex h-full flex-col transition-colors hover:border-primary/40">
      <CardHeader className="flex-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate">{product.name}</CardTitle>
          <Badge variant="outline" title={`Config schema version ${product.schemaVersion}`}>
            schema v{product.schemaVersion}
          </Badge>
        </div>
        <CardDescription className="font-mono text-xs">{product.slug}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button asChild variant="secondary" size="sm" className="w-full">
          <a href={href} aria-label={`Open ${product.name}`}>
            Open
            <ArrowRight aria-hidden />
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/15 text-primary [&_svg]:size-5">
          {icon}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="text-lg font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
