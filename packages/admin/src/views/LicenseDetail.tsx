import * as React from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { api, type OverrideUpdate } from "../api.js";
import { invalidate, useResource } from "../context.js";
import { hashFor } from "../route.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "../components/ui/index.js";
import {
  ChannelList,
  formatDate,
  formatStamp,
  LicenseStatusBadge,
  MetaItem,
} from "./licenses/shared.js";
import { EditMetadataDialog } from "./licenses/EditMetadataDialog.js";
import { PolicySection } from "./licenses/PolicySection.js";
import { KeysSection } from "./licenses/KeysSection.js";
import { DevicesSection } from "./licenses/DevicesSection.js";
import { OverridesEditor } from "./licenses/OverridesEditor.js";

/**
 * The license detail view. Loads the license (with embedded keys, devices, and redacted override
 * payload) plus the product catalog (for the override editor's schema). The header owns the
 * status + enable/disable toggle + metadata edit; the body is tabbed into policy, keys, devices,
 * and overrides. Every mutation toasts and invalidates the license cache key so the view refreshes.
 */
export function LicenseDetail({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const toast = useToast();
  const licenseKey = `license:${slug}:${id}`;
  const {
    data: license,
    loading,
    error,
    reload,
  } = useResource(licenseKey, () => api.license(slug, id));
  // Tiers drive the re-licensing selector in the edit dialog.
  const { data: tierData } = useResource(`tiers:${slug}`, () =>
    api.tiers(slug),
  );
  const { data: catalog } = useResource(`schema:${slug}`, () =>
    api.schema(slug),
  );

  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmEnable, setConfirmEnable] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [savingOverrides, setSavingOverrides] = React.useState(false);

  const refresh = React.useCallback(() => {
    invalidate(licenseKey);
    invalidate(`licenses:${slug}`);
    reload();
  }, [licenseKey, slug, reload]);

  const toggleEnabled = async (): Promise<void> => {
    if (!license) return;
    const enable = license.status !== "active";
    setToggling(true);
    try {
      await api.setLicenseEnabled(slug, id, enable);
      toast.success(enable ? "License enabled" : "License disabled");
      refresh();
      setConfirmEnable(false);
    } catch (err) {
      toast.error(
        "Could not change status",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setToggling(false);
    }
  };

  const submitOverrides = async (updates: OverrideUpdate[]): Promise<void> => {
    if (updates.length === 0) return;
    setSavingOverrides(true);
    try {
      await api.putLicenseOverrides(slug, id, updates);
      toast.success(
        "Overrides saved",
        `${updates.length} change${updates.length === 1 ? "" : "s"} applied.`,
      );
      refresh();
    } catch (err) {
      toast.error(
        "Could not save overrides",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSavingOverrides(false);
    }
  };

  const backHref = hashFor({ kind: "product", slug, view: "licenses" });

  if (error) {
    return (
      <section className="space-y-6">
        <BackLink href={backHref} />
        <EmptyState
          title="Could not load license"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              Retry
            </Button>
          }
        />
      </section>
    );
  }

  if (loading && !license) {
    return (
      <section className="space-y-6">
        <BackLink href={backHref} />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 w-full" />
      </section>
    );
  }

  if (!license) return <BackLink href={backHref} />;

  const isActive = license.status === "active";

  return (
    <section className="space-y-6">
      <BackLink href={backHref} />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">
              {license.name || "Unnamed license"}
            </h2>
            <LicenseStatusBadge status={license.status} />
            <Badge
              variant={
                license.identityProvider === "oidc" ? "primary" : "default"
              }
            >
              {license.identityProvider}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{license.email}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {license.id}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {isActive ? "Enabled" : "Disabled"}
            </span>
            <Switch
              checked={isActive}
              disabled={toggling}
              onCheckedChange={() => setConfirmEnable(true)}
              aria-label={isActive ? "Disable license" : "Enable license"}
            />
          </label>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil aria-hidden />
            Edit
          </Button>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-3 lg:grid-cols-4">
        <MetaItem label="Tier">
          {license.tier ? <Badge variant="outline">{license.tier}</Badge> : "—"}
        </MetaItem>
        <MetaItem label="Profiles">
          {license.profiles?.length ? license.profiles.join(" -> ") : "—"}
        </MetaItem>
        <MetaItem label="Activated">
          {formatStamp(license.activatedAt)}
        </MetaItem>
        <MetaItem label="Expires">{formatDate(license.expiresAt)}</MetaItem>
        <MetaItem label="Max offline days">
          {license.maxOfflineDays ?? "—"}
        </MetaItem>
        <MetaItem label="Active keys">
          <span className="tabular-nums">
            {license.activeKeyCount} / {license.keyCount}
          </span>
        </MetaItem>
        <MetaItem label="Devices">
          <span className="tabular-nums">{license.deviceCount}</span>
        </MetaItem>
        <MetaItem label="Channels">
          <ChannelList channels={license.channels} />
        </MetaItem>
      </dl>

      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="keys">Keys ({license.keys.length})</TabsTrigger>
          <TabsTrigger value="devices">
            Devices ({license.devices.length})
          </TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
        </TabsList>

        <TabsContent value="policy">
          <PolicySection slug={slug} license={license} onSaved={refresh} />
        </TabsContent>

        <TabsContent value="keys">
          <KeysSection
            slug={slug}
            id={id}
            keys={license.keys}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="devices">
          <DevicesSection
            slug={slug}
            id={id}
            devices={license.devices}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="overrides">
          {catalog ? (
            <OverridesEditor
              catalog={catalog}
              payload={license.overrides}
              saving={savingOverrides}
              onSubmit={submitOverrides}
            />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </TabsContent>
      </Tabs>

      <EditMetadataDialog
        slug={slug}
        license={license}
        tiers={tierData?.tiers}
        deviceCount={
          license.devices.filter((d) => d.status === "authorized").length
        }
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={confirmEnable}
        onOpenChange={(o) => !o && setConfirmEnable(false)}
        title={isActive ? "Disable this license?" : "Enable this license?"}
        description={
          isActive
            ? "Devices will lose access at their next check-in until the license is re-enabled."
            : "Devices on this license will regain access at their next check-in."
        }
        confirmLabel={isActive ? "Disable" : "Enable"}
        confirmVariant={isActive ? "destructive" : "primary"}
        loading={toggling}
        onConfirm={toggleEnabled}
      />
    </section>
  );
}

function BackLink({ href }: { href: string }): React.ReactElement {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back to licenses
    </a>
  );
}
