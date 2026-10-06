/**
 * The license record (ADMIN.md §6.5.2, T3). One header with the status once (LDT-7), the expiry,
 * who changed it last (LDT-9), a primary action and a menu with the rare ones (LDT-8); route tabs
 * (LDT-4): Overview (one Terms form, LDT-1), Keys, Devices and Config overrides. A dirty Terms
 * form stays mounted across tabs, and leaving the record asks first.
 */

import * as React from "react";
import { KeyRound, Power } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type LicenseDetail } from "../../../api.js";
import { useMe, useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { r } from "../../routes.js";
import { navigate } from "../../router.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { LicenseRegistryTokens } from "../../areas/feeds/RegistryTokens.js";
import { confirmFor } from "../../../lib/actions.js";
import { fromSeconds, formatRelative } from "../../../lib/format.js";
import { SIGN_IN_LABELS } from "../../../lib/labels.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { IdChip } from "../../../ui/IdChip.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { toast } from "../../../ui/toast.js";
import { LicenseConfig } from "./LicenseConfig.js";
import { LicenseDevices } from "./LicenseDevices.js";
import { DeviceLimitSheet } from "./LicenseDeviceLimit.js";
import { EditHolderDialog, OfflineBundleDialog } from "./LicenseDialogs.js";
import { DeleteLicenseDialog, deletionBlockedReason } from "./LicenseDelete.js";
import { LicenseKeys, MintKeyDialog } from "./LicenseKeys.js";
import { LicenseTerms } from "./LicenseTerms.js";
import {
  actorName,
  daysUntil,
  expiryText,
  LicenseStatus,
  seatLimitOf,
  seatLimitText,
  useTiers,
} from "./shared.js";

export const LICENSE_TABS = ["overview", "keys", "devices", "config"] as const;
export type LicenseTab = (typeof LICENSE_TABS)[number];

export function useLicense(slug: string, id: string) {
  return useQuery(
    { queryKey: qk.license(slug, id), queryFn: () => api.license(slug, id) },
    queryClient,
  );
}

export function LicenseRecord({
  slug,
  id,
  tab: rawTab,
}: {
  slug: string;
  id: string;
  tab?: string;
}): React.ReactElement {
  const tab: LicenseTab = (LICENSE_TABS as readonly string[]).includes(
    rawTab ?? "",
  )
    ? (rawTab as LicenseTab)
    : "overview";
  const q = useLicense(slug, id);
  const license = q.data;

  if (q.isPending) {
    return <PageSkeleton template="record" label="license" />;
  }
  if (!license) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Licenses", to: r.licenses(slug) },
                { label: id },
              ]}
            />
          }
          title={notFound ? "License not found" : "License"}
        />
        {notFound ? (
          <EmptyState
            kind="not-found"
            title="This license doesn't exist"
            description="It may have been deleted, or the link has a typo."
            primaryAction={
              <Button
                variant="outline"
                onClick={() => navigate(r.licenses(slug))}
              >
                Back to licenses
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ thing: "License", collectionHref: r.licenses(slug) }}
          />
        )}
      </div>
    );
  }
  return (
    <LicenseRecordBody
      slug={slug}
      license={license}
      tab={tab}
      refetching={q.isFetching}
    />
  );
}

function LicenseRecordBody({
  slug,
  license,
  tab,
  refetching,
}: {
  slug: string;
  license: LicenseDetail;
  tab: LicenseTab;
  refetching: boolean;
}): React.ReactElement {
  const me = useMe().data;
  const product = useProduct(slug).data;
  const tiers = useTiers(slug).data?.tiers ?? [];
  const [termsDirty, setTermsDirty] = React.useState(false);
  const [dialog, setDialog] = React.useState<
    | "holder"
    | "bundle"
    | "mint"
    | "deviceLimit"
    | "disable"
    | "enable"
    | "delete"
    | null
  >(null);
  // Config overrides keep their draft across tab switches once opened (the editor owns it).
  const [configOpened, setConfigOpened] = React.useState(tab === "config");
  React.useEffect(() => {
    if (tab === "config") setConfigOpened(true);
  }, [tab]);

  const id = license.id;
  const active = license.status === "active";
  // LX-14a: the limit the Worker enforces and where it comes from.
  const seats = seatLimitOf(license, tiers, product?.defaultDeviceLimit);
  const limit = seats.limit;
  const activeKeys = license.keys.filter((k) => k.status === "active").length;
  const configOn = product?.services?.config?.enabled ?? true;

  const toggle = async (enable: boolean): Promise<void> => {
    await mutate("setLicenseEnabled", slug, id, enable);
    toast.success(enable ? "License enabled" : "License disabled");
  };

  const expiry =
    license.expiresAt == null ? (
      "No expiry"
    ) : fromSeconds(license.expiresAt) > Date.now() ? (
      <>
        Expires {expiryText(license.expiresAt)} (in{" "}
        {daysUntil(license.expiresAt)}{" "}
        {daysUntil(license.expiresAt) === 1 ? "day" : "days"})
      </>
    ) : (
      <>Expired {expiryText(license.expiresAt)}</>
    );
  const changedBy = actorName(license.modifiedBy, me);

  const tabHref = (t: LicenseTab) =>
    r.license(slug, id, t === "overview" ? undefined : t);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Licenses", to: r.licenses(slug) },
              { label: license.name || id },
            ]}
          />
        }
        title={license.name || "Unnamed license"}
        titleAside={<LicenseStatus license={license} />}
        description={expiry}
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {license.email ? <span>{license.email}</span> : null}
            <IdChip value={id} noun="license id" />
            <span data-testid="record-device-limit">
              Device limit {seatLimitText(seats)}
            </span>
            <span>
              {SIGN_IN_LABELS[license.identityProvider] ??
                license.identityProvider}
            </span>
            {license.modifiedAt ? (
              <span>
                Changed {formatRelative(fromSeconds(license.modifiedAt))}
                {changedBy ? ` by ${changedBy}` : ""}
              </span>
            ) : null}
          </span>
        }
        primaryAction={
          active ? (
            <Button iconStart={<KeyRound />} onClick={() => setDialog("mint")}>
              Mint key
            </Button>
          ) : (
            <Button iconStart={<Power />} onClick={() => setDialog("enable")}>
              Enable license
            </Button>
          )
        }
        secondaryActions={[
          { label: "Edit holder…", onSelect: () => setDialog("holder") },
          ...(active
            ? []
            : [{ label: "Mint key…", onSelect: () => setDialog("mint") }]),
          {
            label: "Mint offline bundle…",
            onSelect: () => setDialog("bundle"),
          },
          { label: "Device limit…", onSelect: () => setDialog("deviceLimit") },
          {
            label: "View in activity",
            onSelect: () => navigate(r.activity(slug, { q: id })),
          },
        ]}
        dangerActions={[
          ...(active
            ? [
                {
                  label: "Disable license…",
                  onSelect: () => setDialog("disable"),
                },
              ]
            : []),
          {
            label: "Delete license…",
            onSelect: () => setDialog("delete"),
            disabledReason: deletionBlockedReason(license.deletion),
          },
        ]}
        refetching={refetching}
        tabs={
          <PageTabs
            label="License sections"
            value={tab}
            items={[
              {
                value: "overview",
                label: "Overview",
                to: tabHref("overview"),
                dirty: termsDirty,
              },
              {
                value: "keys",
                label: "Keys",
                to: tabHref("keys"),
                count: activeKeys,
              },
              {
                value: "devices",
                label: "Devices",
                to: tabHref("devices"),
                count:
                  limit === null
                    ? license.deviceCount
                    : `${license.deviceCount}/${limit}`,
              },
              {
                value: "config",
                label: "Config overrides",
                to: tabHref("config"),
              },
            ]}
          />
        }
      />

      {/* Overview stays mounted while its draft is dirty, so a tab switch keeps it. */}
      {tab === "overview" || termsDirty ? (
        <div hidden={tab !== "overview"}>
          <LicenseTerms
            slug={slug}
            license={license}
            onDirtyChange={setTermsDirty}
          />
        </div>
      ) : null}
      {tab === "keys" ? (
        <div className="space-y-6">
          <LicenseKeys slug={slug} license={license} />
          {/* F-21: tokens bound to this licence, while the product's package feeds are on. */}
          {product?.packageFeeds ? (
            <LicenseRegistryTokens slug={slug} licenseId={id} />
          ) : null}
        </div>
      ) : null}
      {tab === "devices" ? (
        <LicenseDevices slug={slug} license={license} seats={seats} />
      ) : null}
      {configOpened ? (
        <div hidden={tab !== "config"}>
          <LicenseConfig slug={slug} license={license} configOn={configOn} />
        </div>
      ) : null}

      <EditHolderDialog
        slug={slug}
        license={license}
        open={dialog === "holder"}
        onOpenChange={(o) => setDialog(o ? "holder" : null)}
      />
      <DeviceLimitSheet
        slug={slug}
        license={license}
        tiers={tiers}
        productLimit={product?.defaultDeviceLimit}
        open={dialog === "deviceLimit"}
        onOpenChange={(o) => setDialog(o ? "deviceLimit" : null)}
      />
      <OfflineBundleDialog
        slug={slug}
        licenseId={id}
        configOn={configOn}
        open={dialog === "bundle"}
        onOpenChange={(o) => setDialog(o ? "bundle" : null)}
      />
      <MintKeyDialog
        slug={slug}
        licenseId={id}
        open={dialog === "mint"}
        onOpenChange={(o) => setDialog(o ? "mint" : null)}
      />
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={confirmFor("license.disable").intent as "caution"}
        title={`Disable ${license.name || "this license"}?`}
        consequences={[
          "Its devices stop authenticating right away: their cached tokens are purged.",
          "Keys, devices and terms are kept. Enabling the license restores access.",
        ]}
        confirmLabel="Disable license"
        onConfirm={() => toggle(false)}
      />
      <DeleteLicenseDialog
        slug={slug}
        license={license}
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
      />
      <ConfirmDialog
        open={dialog === "enable"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={confirmFor("license.enable").intent as "caution"}
        title={`Enable ${license.name || "this license"}?`}
        consequences={["Its devices regain access at their next check-in."]}
        confirmLabel="Enable license"
        onConfirm={() => toggle(true)}
      />
    </div>
  );
}
