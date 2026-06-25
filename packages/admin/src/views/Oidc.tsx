import * as React from "react";
import {
  AlertTriangle,
  FileCog,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";
import { api } from "../api.js";
import { invalidate, useResource } from "../context.js";
import { useToast } from "../components/ui/index.js";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "../components/ui/index.js";

/**
 * OIDC & provisioning.
 *
 * API gap (flagged): the admin surface in `src/api.ts` exposes NO read or write endpoints for a
 * product's OIDC config (issuer / clientId / redirect URIs / group→tier map) or provisioning
 * hooks. Those live exclusively in the product's `.pkey/product` manifest in the linked repo and
 * are applied to the platform by re-syncing the repo (`resyncProduct` → `release.resync`).
 *
 * So this view is, by design, a read-only explainer: it states where identity config is authored
 * and offers the one action the API does support — re-sync from the linked repo. When the worker
 * grows a `GET …/oidc` projection (or a write endpoint / a `putProductSecret`-backed client
 * secret form), wire the forms here; do NOT invent endpoints in the meantime.
 */
export function Oidc({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const { data, loading, error } = useResource(`product:${slug}`, () =>
    api.product(slug),
  );
  const [resyncing, setResyncing] = React.useState(false);

  const onResync = React.useCallback(async () => {
    setResyncing(true);
    try {
      await api.resyncProduct(slug);
      invalidate(`product:${slug}`);
      toast.success(
        "Re-sync complete",
        "Identity config was re-applied from the linked repo.",
      );
    } catch (e) {
      toast.error(
        "Re-sync failed",
        e instanceof Error ? e.message : "Could not re-sync from the repo.",
      );
    } finally {
      setResyncing(false);
    }
  }, [slug, toast]);

  return (
    <section aria-labelledby="oidc-title" className="space-y-6">
      <header className="space-y-1">
        <h2 id="oidc-title" className="text-xl font-semibold tracking-tight">
          OIDC &amp; provisioning
        </h2>
        <p className="text-sm text-muted-foreground">
          How users sign in to{" "}
          <span className="font-medium text-foreground">{slug}</span> and how
          licenses are provisioned on first login.
        </p>
      </header>

      {loading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
        </Card>
      ) : error ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the product"
          description={error}
        />
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileCog aria-hidden className="size-5 text-primary" />
              <CardTitle>Identity config is authored in your repo</CardTitle>
            </div>
            <CardDescription>
              The OIDC issuer, client ID, redirect URIs, the group → tier map,
              and provisioning hooks for{" "}
              <span className="font-medium text-foreground">
                {data?.product.name ?? slug}
              </span>{" "}
              live in its{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                .pkey/product
              </code>{" "}
              manifest. Edit them there, commit, then re-sync to apply the
              change to the platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              role="note"
              className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
            >
              <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p>
                The admin API does not expose OIDC settings for in-place
                editing. Re-syncing re-reads{" "}
                <code className="font-mono text-xs">.pkey/</code> and re-applies
                the manifest (config schema, product metadata, OIDC, tiers, and
                provisioning) without touching licenses.
              </p>
            </div>
            <Button onClick={() => void onResync()} loading={resyncing}>
              <RefreshCw aria-hidden />
              Re-sync from linked repo
            </Button>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
