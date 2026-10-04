/**
 * Core → Settings (T4; docs/design/ADMIN.md §6.9). General, License defaults (when License is
 * on), Repository, Storage and the Danger zone.
 *
 * - General and License defaults are one resource (`PATCH /products/:slug`), so one form and one
 *   `SaveBar` whose summary counts both sections' changes. Validation matches the server: a blank
 *   display name is refused, a cleared admin group is sent as `null` (A-3, PRD-6), never dropped.
 * - Signing moved to Keys & secrets and the compatibility window to Update → Feed; this page
 *   links to each instead of describing where they went (SET-3).
 * - Resync from repo is L1 and ends in a result panel listing what it re-applied, what it
 *   refused and the pack-set outcome (RSY-3).
 * - Delete product is L3: the operator types the slug, which is what is sent as `confirmSlug`
 *   (SET-2, PRD-4). Afterwards `me` and the registry refresh (the mutation table) and the console
 *   goes Home.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  type BlobGcDryRun,
  type ProductDetail,
  type ResyncResult,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import {
  formatCount,
  formatDuration,
  fromSeconds,
} from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, FormField, diffValues, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link, navigate } from "../../router.js";
import { r } from "../../routes.js";
import {
  DangerAction,
  DangerZone,
  SettingsRow,
  SettingsSection,
  SettingsTemplate,
} from "../../templates/Settings.js";
import { intentOf } from "./confirmGate.js";

/** The row's own label is visible; the field's stays for assistive tech only. */
const HIDE_LABEL = "[&>div:first-child]:sr-only";

interface Draft extends Record<string, unknown> {
  name: string;
  adminGroup: string;
  defaultMaxOfflineDays: number | null;
  defaultDeviceLimit: number | null;
}

function draftOf(p: ProductDetail): Draft {
  return {
    name: p.name,
    adminGroup: p.adminGroup ?? "",
    defaultMaxOfflineDays: p.defaultMaxOfflineDays,
    defaultDeviceLimit: p.defaultDeviceLimit,
  };
}

/** Client checks that mirror the server's (worker `admin/handlers/products.ts`). */
export function validateSettings(v: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v.name.trim()) out.name = "Enter a display name.";
  const days = v.defaultMaxOfflineDays;
  if (days === null || !Number.isInteger(days) || days < 1 || days > 365)
    out.defaultMaxOfflineDays = "Use a whole number of days from 1 to 365.";
  const limit = v.defaultDeviceLimit;
  if (limit === null || !Number.isInteger(limit) || limit < 1)
    out.defaultDeviceLimit = "Use a whole number of devices, 1 or more.";
  return out;
}

export function SettingsPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  useLoadingAnnouncement("settings", product.isPending);
  const header = (
    <PageHeader
      title="Settings"
      description="This product's name, license defaults, repository, storage and deletion."
      refetching={product.isFetching && !product.isPending}
    />
  );
  if (product.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="settings" />
      </div>
    );
  }
  if (product.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          error={product.error}
          onRetry={() => void product.refetch()}
        />
      </div>
    );
  }
  return <SettingsBody slug={slug} product={product.data} header={header} />;
}

function SettingsBody({
  slug,
  product,
  header,
}: {
  slug: string;
  product: ProductDetail;
  header: React.ReactNode;
}): React.ReactElement {
  const licenseOn = product.services?.license?.enabled ?? true;
  const values = React.useMemo(() => draftOf(product), [product]);
  const form = useAdminForm<Draft>({
    values,
    resetOn: [product.modifiedAt, product.name, product.adminGroup],
    validate: validateSettings,
    onSubmit: async (draft, { server }) => {
      const body = diffValues(server, draft, { nullable: ["adminGroup"] });
      await mutate("updateProduct", slug, {
        ...(body.name !== undefined ? { name: draft.name.trim() } : {}),
        ...(body.adminGroup !== undefined
          ? {
              adminGroup:
                body.adminGroup === null ? null : draft.adminGroup.trim(),
            }
          : {}),
        ...(body.defaultMaxOfflineDays !== undefined
          ? { defaultMaxOfflineDays: draft.defaultMaxOfflineDays! }
          : {}),
        ...(body.defaultDeviceLimit !== undefined
          ? { defaultDeviceLimit: draft.defaultDeviceLimit! }
          : {}),
      });
      toast.success("Settings saved");
    },
  });
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: "Discard your changes to settings?",
    onDiscard: form.discard,
  });

  const sections = [
    { id: "settings-general", title: "General" },
    ...(licenseOn
      ? [{ id: "settings-license", title: "License defaults" }]
      : []),
    { id: "settings-repository", title: "Repository" },
    { id: "settings-storage", title: "Storage" },
    { id: "danger-zone", title: "Danger zone" },
  ];
  const nonFieldError =
    form.submitError && Object.keys(form.errors).length === 0
      ? errorCopy(form.submitError)
      : null;

  return (
    <SettingsTemplate header={header} sections={sections}>
      <Form form={form} aria-label="Product settings" className="space-y-6">
        <SettingsSection
          id="settings-general"
          title="General"
          description="How this product is named across the console."
        >
          <SettingsRow
            label="Display name"
            help="Shown in the console and the customer portal."
          >
            <FormField
              className={HIDE_LABEL}
              name="name"
              label="Display name"
              required
            >
              {(f) => <Input {...f} autoComplete="off" />}
            </FormField>
          </SettingsRow>
          <SettingsRow
            label="Admin group"
            help="Metadata only. It grants nothing: console access is platform-wide. Clear it to remove the group."
          >
            <FormField
              className={HIDE_LABEL}
              name="adminGroup"
              label="Admin group"
            >
              {(f) => <Input {...f} mono clearable autoComplete="off" />}
            </FormField>
          </SettingsRow>
        </SettingsSection>

        {licenseOn ? (
          <SettingsSection
            id="settings-license"
            title="License defaults"
            description="What a new license inherits when neither it nor its tier says otherwise."
          >
            <SettingsRow label="Default max offline days">
              <FormField
                className={HIDE_LABEL}
                name="defaultMaxOfflineDays"
                label="Default max offline days"
                required
                help="From 1 to 365 days."
              >
                {(f) => (
                  <NumberInput {...f} integer min={1} max={365} unit="days" />
                )}
              </FormField>
            </SettingsRow>
            <SettingsRow label="Default device limit">
              <FormField
                className={HIDE_LABEL}
                name="defaultDeviceLimit"
                label="Default device limit"
                required
                help="How many devices one license may authorize."
              >
                {(f) => <NumberInput {...f} integer min={1} unit="devices" />}
              </FormField>
            </SettingsRow>
            <SettingsRow
              label="Compatibility window"
              help="Which app versions this product supports is set with the update feed."
            >
              {product.services?.update?.enabled ? (
                <Link
                  to={r.feed(slug)}
                  className="inline-flex items-center gap-1 text-accent-fg underline-offset-4 hover:underline"
                >
                  Open Update → Feed
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              ) : (
                <span className="text-fg-muted">
                  Turn on Update in{" "}
                  <Link
                    to={r.services(slug)}
                    className="text-accent-fg underline-offset-4 hover:underline"
                  >
                    Services
                  </Link>{" "}
                  to set it.
                </span>
              )}
            </SettingsRow>
          </SettingsSection>
        ) : null}

        {nonFieldError ? (
          <Callout tone="danger" title={nonFieldError.title}>
            {nonFieldError.description}
          </Callout>
        ) : null}
        <SaveBar form={form} saveLabel="Save settings" />
      </Form>

      <RepositorySection slug={slug} product={product} />
      <StorageSection slug={slug} />

      <DangerZone>
        <DangerAction
          title="Delete product"
          consequence={`Tombstones ${product.name}: every license is disabled and every device token is evicted. Audit history is kept and the slug stays reserved.`}
          action={<DeleteProduct slug={slug} product={product} />}
        />
      </DangerZone>
      {guard.dialog}
    </SettingsTemplate>
  );
}

function RepositorySection({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<ResyncResult | null>(null);
  const linked = product.releaseSource === "github";
  const sync = product.setup?.sync ?? null;
  return (
    <SettingsSection
      id="settings-repository"
      title="Repository"
      description="Where this product's .pkey/ manifest comes from."
      actions={
        <Button
          variant="outline"
          size="sm"
          iconStart={<RefreshCw aria-hidden />}
          disabledReason={
            linked ? undefined : "This product isn't linked to a repository."
          }
          onClick={() => setOpen(true)}
        >
          Resync from repo…
        </Button>
      }
    >
      <div className="px-5 py-4">
        <DescriptionList
          columns={3}
          items={[
            {
              term: "Source",
              detail: linked ? "Linked GitHub repository" : "Manual",
              help: linked
                ? "Pushes to the repository re-apply its .pkey/ manifest."
                : "Settings are edited here; nothing syncs from a repository.",
            },
            {
              term: "Last sync",
              detail: sync?.lastSyncedAt ? (
                <Timestamp
                  at={fromSeconds(sync.lastSyncedAt)}
                  format="detail"
                />
              ) : (
                "Never"
              ),
            },
            {
              term: "Sync status",
              detail: !sync ? (
                <StatusPill tone="neutral">Not run</StatusPill>
              ) : sync.status === "error" ? (
                <StatusPill tone="danger">Failed</StatusPill>
              ) : (
                <StatusPill tone="success">In sync</StatusPill>
              ),
              help: sync?.message ?? undefined,
            },
          ]}
        />
      </div>
      {result ? (
        <div className="px-5 pb-4">
          <ResyncResultPanel
            result={result}
            onDismiss={() => setResult(null)}
          />
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={intentOf("repo.resync")}
        title="Resync from repo?"
        description={`Fetches ${product.name}'s .pkey/ manifest from its repository now and applies it.`}
        consequences={[
          "Services, catalog, tiers, profiles, channels and update settings follow the manifest, except values set in the console.",
          "Clients see the result on their next document fetch.",
        ]}
        confirmLabel="Resync from repo"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("resyncProduct", slug);
          setResult(res);
          toast.success("Resynced from repo");
        }}
      />
    </SettingsSection>
  );
}

/** What a resync did: the panel §5.3 asks for, not just a toast (RSY-3). */
export function ResyncResultPanel({
  result,
  onDismiss,
}: {
  result: ResyncResult;
  onDismiss: () => void;
}): React.ReactElement {
  const updated = result.updated ?? [];
  const refused = result.refused ?? [];
  const packs = result.packSets;
  return (
    <Callout
      tone={refused.length || (packs && !packs.ok) ? "warning" : "success"}
      title="Resync finished"
      live
      action={
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <p>
        {updated.length
          ? `Re-applied: ${updated.join(", ")}.`
          : "Nothing changed: the product already matched its manifest."}
      </p>
      {refused.length ? (
        <div className="mt-2">
          <p className="font-bold">Refused</p>
          <ul className="list-disc pl-5">
            {refused.map((x) => (
              <li key={`${x.code}:${x.path}`}>
                <span className="font-mono text-xs">{x.path}</span>: {x.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {packs ? (
        <p className="mt-2">
          {packs.ok
            ? `Pack sets resolved: ${formatCount(packs.sets)}.`
            : `Pack sets were cleared: ${packs.message}`}
        </p>
      ) : null}
    </Callout>
  );
}

function StorageSection({ slug }: { slug: string }): React.ReactElement {
  const gc = useQuery(
    { queryKey: qk.blobGc(slug), queryFn: () => api.blobGc(slug) },
    queryClient,
  );
  return (
    <SettingsSection
      id="settings-storage"
      title="Storage"
      description="What the nightly blob collector would remove for this product. Nothing here deletes anything."
    >
      <div className="px-5 py-4">
        {gc.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : gc.isError ? (
          <ErrorState
            compact
            error={gc.error}
            onRetry={() => void gc.refetch()}
          />
        ) : (
          <StorageFacts dry={gc.data} />
        )}
      </div>
    </SettingsSection>
  );
}

function StorageFacts({ dry }: { dry: BlobGcDryRun }): React.ReactElement {
  const drops = dry.drops.packObject + dry.drops.packUpload;
  return (
    <DescriptionList
      columns={3}
      items={[
        {
          term: "Collector",
          detail: dry.enabled ? (
            <StatusPill tone="success">On</StatusPill>
          ) : (
            <StatusPill tone="neutral">Off on this deployment</StatusPill>
          ),
          help: `Unreferenced objects are kept ${formatDuration(dry.graceSeconds * 1000)} before deletion.`,
        },
        {
          term: "Eligible for removal",
          detail: `${formatCount(drops)}${dry.drops.truncated ? "+" : ""} ${drops === 1 ? "object" : "objects"}`,
          help: `${formatCount(dry.drops.packObject)} pack objects, ${formatCount(dry.drops.packUpload)} abandoned uploads${dry.restores.count ? `; ${formatCount(dry.restores.count)} would be restored` : ""}.`,
        },
        {
          term: "Earliest deletion",
          detail: dry.earliestDeletion ? (
            <Timestamp at={fromSeconds(dry.earliestDeletion)} format="detail" />
          ) : (
            "None scheduled"
          ),
        },
      ]}
    />
  );
}

function DeleteProduct({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="danger"
        iconStart={<Trash2 aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Delete product…
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={intentOf("product.delete")}
        title={`Delete ${product.name}?`}
        description="Deleting tombstones the product. It cannot be undone from the console."
        consequences={[
          "Every license is disabled and its personal data is erased.",
          "Every device token is evicted: devices stop working at their next check.",
          "Audit history is kept, and the slug stays reserved.",
        ]}
        typedConfirmation={{ value: slug, label: `Type ${slug} to confirm` }}
        confirmLabel="Delete product"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          // The dialog enables confirm only once the operator has typed the slug exactly, so the
          // slug sent as `confirmSlug` is the value they typed.
          await mutate("deleteProduct", slug, slug);
          toast.success("Product deleted");
          navigate(r.home());
        }}
      />
    </>
  );
}
