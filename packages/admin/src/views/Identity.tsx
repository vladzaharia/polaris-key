import * as React from "react";
import {
  AlertTriangle,
  Download,
  FileCog,
  Globe2,
  KeyRound,
  Link2,
  Mail,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import {
  api,
  type PortalProductSettings,
  type UpdatePortalSettingsBody,
} from "../api.js";
import { useResource } from "../context.js";
import { docsUrl } from "../lib/docsLinks.js";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from "../components/ui/index.js";
import { releaseSourceOf } from "../lib/products.js";
import { qk } from "../console/data/queries.js";
import { fetchProduct } from "../console/data/hooks.js";
import { mutate } from "../console/data/mutations.js";

/**
 * The Identity section (spec §8) — how a HUMAN reaches this product.
 *
 * Two things landed here from elsewhere and they belong together: the customer-portal module
 * toggles (previously the last card in the product Settings grab-bag) and the OIDC explainer
 * (previously its own top-level tab). Both answer "who can sign in and how", and the portal's
 * sign-in switches are meaningless without knowing where the OIDC provider is authored — an
 * operator who turns "OIDC access" on and then cannot find where the provider is configured
 * has been handed half an answer.
 *
 * Each card loads independently rather than sitting behind one gate: a portal-settings failure
 * should not hide the explainer that tells the operator where identity config actually lives.
 */
export function Identity({ slug }: { slug: string }): React.ReactElement {
  return (
    <section aria-labelledby="identity-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="identity-title"
          className="text-xl font-semibold tracking-tight"
        >
          Sign-in &amp; portal
        </h2>
        <p className="text-sm text-muted-foreground">
          How users sign in to{" "}
          <span className="font-medium text-foreground">{slug}</span>, and what
          the customer portal offers them once they have.
        </p>
      </header>

      <PortalCard slug={slug} />
      <OidcCard slug={slug} />
    </section>
  );
}

// ── customer portal ───────────────────────────────────────────────────────────

const DEFAULT_PORTAL_SETTINGS: PortalProductSettings = {
  portalEnabled: true,
  oidcEnabled: true,
  magicEnabled: true,
  licenseKeyClaimEnabled: true,
  releasesEnabled: true,
  autoLinkEnabled: null,
  branding: null,
  modifiedAt: 0,
};

type PortalToggleKey = Exclude<
  keyof UpdatePortalSettingsBody,
  "branding" | "autoLinkEnabled"
>;

/**
 * `autoLinkEnabled` is the one portal setting that is NOT a switch, because it has three
 * states and the third is the one an operator should usually be on (R5-01/R5-02). A switch
 * would have to pick a side for "auto", and whichever side it picked would silently become an
 * explicit override the moment anyone touched it — turning a value that TRACKS the product's
 * OIDC issuer into a frozen one. So: a select, with "auto" nameable and returnable.
 */
const AUTO_LINK_OPTIONS: {
  value: "auto" | "on" | "off";
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Auto (follow the OIDC issuer)",
    description:
      "On for products on the platform issuer; off for a product on its own ‘custom’ issuer, whose email and subject claims this platform does not vouch for.",
  },
  {
    value: "on",
    label: "Always link",
    description:
      "Link matching licenses on sign-in even when the issuer is tenant-controlled. Only for an issuer you operate.",
  },
  {
    value: "off",
    label: "Never link",
    description:
      "Customers must claim each license explicitly, even on the platform issuer.",
  },
];

const autoLinkValue = (v: boolean | null): "auto" | "on" | "off" =>
  v === null ? "auto" : v ? "on" : "off";
const autoLinkSetting = (v: "auto" | "on" | "off"): boolean | null =>
  v === "auto" ? null : v === "on";

const PORTAL_ROWS: {
  key: PortalToggleKey;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    key: "portalEnabled",
    label: "Customer portal",
    description: "Show this product’s licenses to verified customers.",
    icon: <Globe2 aria-hidden className="size-4 text-accent-fg" />,
  },
  {
    key: "oidcEnabled",
    label: "OIDC access",
    description: "Allow portal account linking from the shared OIDC subject.",
    icon: <ShieldCheck aria-hidden className="size-4 text-accent-fg" />,
  },
  {
    key: "magicEnabled",
    label: "Email magic links",
    description: "Allow verified email sign-in to link matching licenses.",
    icon: <Mail aria-hidden className="size-4 text-accent-fg" />,
  },
  {
    key: "licenseKeyClaimEnabled",
    label: "License-key claim",
    description: "Allow customers to add a license by entering a valid key.",
    icon: <KeyRound aria-hidden className="size-4 text-accent-fg" />,
  },
  {
    key: "releasesEnabled",
    label: "Release downloads",
    description: "Expose entitled release artifacts in the customer portal.",
    icon: <Download aria-hidden className="size-4 text-accent-fg" />,
  },
];

function PortalCard({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  // Read through Identity's own endpoint rather than the copy embedded in the product row:
  // `identity/portal` is the table's owner, so it is the value a save round-trips against.
  const { data, loading, error, reload } = useResource(qk.portal(slug), () =>
    api.portalSettings(slug).then((r) => r.settings),
  );
  const settings = data ?? DEFAULT_PORTAL_SETTINGS;
  const [form, setForm] = React.useState<Required<UpdatePortalSettingsBody>>({
    ...DEFAULT_PORTAL_SETTINGS,
    branding: null,
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setForm({
      portalEnabled: settings.portalEnabled,
      oidcEnabled: settings.oidcEnabled,
      magicEnabled: settings.magicEnabled,
      licenseKeyClaimEnabled: settings.licenseKeyClaimEnabled,
      releasesEnabled: settings.releasesEnabled,
      autoLinkEnabled: settings.autoLinkEnabled,
      branding: settings.branding ?? null,
    });
  }, [settings]);

  const dirty =
    form.portalEnabled !== settings.portalEnabled ||
    form.oidcEnabled !== settings.oidcEnabled ||
    form.magicEnabled !== settings.magicEnabled ||
    form.licenseKeyClaimEnabled !== settings.licenseKeyClaimEnabled ||
    form.releasesEnabled !== settings.releasesEnabled ||
    form.autoLinkEnabled !== settings.autoLinkEnabled;

  const setToggle =
    (key: PortalToggleKey) =>
    (checked: boolean): void =>
      setForm((current) => ({ ...current, [key]: checked }));

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      await mutate("updatePortalSettings", slug, {
        portalEnabled: form.portalEnabled,
        oidcEnabled: form.oidcEnabled,
        magicEnabled: form.magicEnabled,
        licenseKeyClaimEnabled: form.licenseKeyClaimEnabled,
        releasesEnabled: form.releasesEnabled,
        autoLinkEnabled: form.autoLinkEnabled,
      });
      toast.success("Portal settings saved");
    } catch (err) {
      toast.error(
        "Couldn’t save portal settings",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Couldn’t load portal settings"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  const autoLinkId = `portal-${slug}-autoLinkEnabled`;

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Customer portal</CardTitle>
          <CardDescription>
            Per-product module and access settings for the root customer portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {PORTAL_ROWS.map((row) => {
            const id = `portal-${slug}-${row.key}`;
            return (
              <div
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    {row.icon}
                  </div>
                  <div className="min-w-0">
                    <label
                      htmlFor={id}
                      className="text-sm font-medium text-foreground"
                    >
                      {row.label}
                    </label>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                      {row.description}
                    </p>
                  </div>
                </div>
                <Switch
                  id={id}
                  checked={Boolean(form[row.key])}
                  onCheckedChange={setToggle(row.key)}
                />
              </div>
            );
          })}

          {/* The tri-state, kept in the same list so it reads as one more access decision. */}
          <div className="flex flex-wrap items-start justify-between gap-4 py-4 last:pb-0">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                <Link2 aria-hidden className="size-4 text-accent-fg" />
              </div>
              <div className="min-w-0">
                <label
                  htmlFor={autoLinkId}
                  className="text-sm font-medium text-foreground"
                >
                  Automatic license linking
                </label>
                <p
                  id={`${autoLinkId}-help`}
                  className="mt-1 max-w-2xl text-sm text-muted-foreground"
                >
                  {
                    AUTO_LINK_OPTIONS.find(
                      (o) => o.value === autoLinkValue(form.autoLinkEnabled),
                    )!.description
                  }
                </p>
              </div>
            </div>
            <Select
              value={autoLinkValue(form.autoLinkEnabled)}
              onValueChange={(next) =>
                setForm((current) => ({
                  ...current,
                  autoLinkEnabled: autoLinkSetting(
                    next as "auto" | "on" | "off",
                  ),
                }))
              }
            >
              <SelectTrigger
                id={autoLinkId}
                aria-describedby={`${autoLinkId}-help`}
                className="w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_LINK_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" loading={saving} disabled={!dirty}>
            Save portal settings
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

// ── OIDC & provisioning ───────────────────────────────────────────────────────

/**
 * API gap (flagged, unchanged from the standalone OIDC tab this replaces): the admin surface
 * exposes NO read or write endpoints for a product's OIDC provider selection, custom provider
 * fields, group→tier map, or provisioning hooks. Those live exclusively in the product's
 * `.pkey/product` manifest and are applied by re-syncing the repo.
 *
 * So this card is, by design, a read-only explainer offering the one action the API does
 * support. When the worker grows a `GET …/identity/oidc` projection (its admin handler already
 * has the seam — it routes only `portal` today), wire the forms here; do NOT invent endpoints
 * in the meantime.
 */
function OidcCard({ slug }: { slug: string }): React.ReactElement {
  const toast = useToast();
  const { data, loading, error, reload } = useResource(qk.product(slug), () =>
    fetchProduct(slug),
  );
  const [resyncing, setResyncing] = React.useState(false);
  // `release/resync.ts` refuses ("product is not linked to a repo" -> 422) for anything whose
  // `release_source` is not `github`, so for a manually-created product this button could only
  // ever fail. `Products.tsx` gates its equivalent menu item the same way.
  const linked = data != null && releaseSourceOf(data) === "github";

  const onResync = React.useCallback(async () => {
    setResyncing(true);
    try {
      await mutate("resyncProduct", slug);
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

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Couldn’t load the product"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileCog aria-hidden className="size-5 text-accent-fg" />
          <CardTitle>Identity config is authored in your repo</CardTitle>
        </div>
        <CardDescription>
          The OIDC provider, custom provider fields, group → tier map, and
          provisioning hooks for{" "}
          <span className="font-medium text-foreground">
            {data?.name ?? slug}
          </span>{" "}
          live in its{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
            .pkey/product
          </code>{" "}
          manifest. Platform OIDC is the default; use{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
            oidc.provider: custom
          </code>{" "}
          only when a product needs its own OIDC client. Edit the manifest,
          commit, then re-sync to apply the change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="note"
          className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            The admin API does not expose OIDC settings for in-place editing.
            Re-syncing re-reads{" "}
            <code className="font-mono text-xs">.pkey/</code> and re-applies the
            manifest (config schema, product metadata, OIDC provider, tiers, and
            provisioning) without touching licenses.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("identityOidcNote")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </p>
        </div>
        <Button
          onClick={() => void onResync()}
          loading={resyncing}
          disabled={!linked}
          title={
            linked ? undefined : "This product is not linked to a GitHub repo."
          }
        >
          <RefreshCw aria-hidden />
          Re-sync from linked repo
        </Button>
      </CardContent>
    </Card>
  );
}
