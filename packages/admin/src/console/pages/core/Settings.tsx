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
 *   refused, what it kept because the console claimed it, and the pack-set outcome (RSY-3).
 * - ST-01b (S-18 model C): on a repo-linked product the display name and the licence defaults
 *   carry a SourceBadge. Saving one claims it for the console (an L1 confirm says so) and every
 *   resync leaves it alone until Revert to manifest, which restores the last applied manifest's
 *   value at once (or at the next resync when there is no snapshot yet). The admin group is
 *   manifest-only there and shown read-only. The system product is manifest-authoritative, so its
 *   fields are read-only until ST-20's break-glass claims.
 * - A manual product offers Link repository… instead (EXPERIENCE.md §0.4 S1, AS 1.5): the drawer
 *   checks the repository, shows the plan, then links and applies; the same result panel
 *   follows.
 * - Delete product is L3: the operator types the slug, which is what is sent as `confirmSlug`
 *   (SET-2, PRD-4). Afterwards `me` and the registry refresh (the mutation table) and the console
 *   goes Home.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  type BlobGcDryRun,
  type ClaimKey,
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
import { ErrorState } from "../../../ui/ErrorState.js";
import { Form, FormField, diffValues, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { DeleteProductDialog } from "../../components/DeleteProductDialog.js";
import {
  CLAIM_LABELS,
  RevertClaimDialog,
} from "../../components/RevertClaimDialog.js";
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
import { SaveCancelled, intentOf, useConfirmGate } from "./confirmGate.js";
import { LinkRepositoryDrawer } from "./LinkRepository.js";

/** Which draft field writes which claimable key. */
const CLAIM_OF_FIELD: Partial<Record<keyof Draft, ClaimKey>> = {
  name: "core.name",
  defaultMaxOfflineDays: "license.defaults.maxOfflineDays",
  defaultDeviceLimit: "license.defaults.deviceLimit",
};

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A resync's `claimed` entry in words: a setting's label, or "tier gold". */
function claimedLabel(entry: string): string {
  const [kind, id] = entry.split(":", 2);
  if (id !== undefined && (kind === "tier" || kind === "profile"))
    return `${kind} ${id}`;
  return CLAIM_LABELS[entry as ClaimKey] ?? entry;
}

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
  const linked = product.releaseSource === "github";
  const system = product.system === true;
  // Only a repo-linked product has a manifest to claim from; the system product refuses claims.
  const claimable = linked && !system;
  const claims = React.useMemo(
    () => new Set((product.claims ?? []).map((c) => c.key)),
    [product.claims],
  );
  const gate = useConfirmGate<string[]>();
  const [reverting, setReverting] = React.useState<ClaimKey | null>(null);
  const values = React.useMemo(() => draftOf(product), [product]);
  const form = useAdminForm<Draft>({
    values,
    resetOn: [product.modifiedAt, product.name, product.adminGroup],
    validate: validateSettings,
    onSubmit: async (draft, { server }) => {
      const body = diffValues(server, draft, { nullable: ["adminGroup"] });
      // ST-01b: saving a manifest-owned value claims it; the operator confirms that first.
      const newClaims = claimable
        ? (Object.keys(CLAIM_OF_FIELD) as (keyof Draft)[])
            .filter((f) => body[f] !== undefined)
            .map((f) => CLAIM_OF_FIELD[f]!)
            .filter((key) => !claims.has(key))
            .map((key) => CLAIM_LABELS[key])
        : [];
      if (newClaims.length > 0 && !(await gate.ask(newClaims)))
        throw new SaveCancelled();
      await mutate("updateProduct", slug, {
        ...(body.name !== undefined ? { name: draft.name.trim() } : {}),
        ...(!linked && body.adminGroup !== undefined
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
  /** The SourceBadge for one claimable row, on a product that has a manifest to claim from. */
  const source = (key: ClaimKey): React.ReactNode =>
    claimable ? (
      <SourceBadge
        source={claims.has(key) ? "admin" : "manifest"}
        path=".pkey/product"
        onRevert={claims.has(key) ? () => setReverting(key) : undefined}
      />
    ) : undefined;
  const systemHelp = system
    ? "Set by the monorepo's .pkey/product: the system product follows its manifest."
    : undefined;

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
    form.submitError &&
    !(form.submitError instanceof SaveCancelled) &&
    Object.keys(form.errors).length === 0
      ? errorCopy(form.submitError)
      : null;

  return (
    <SettingsTemplate header={header} sections={sections}>
      <Form form={form} aria-label="Product settings" className="space-y-6">
        <SettingsSection id="settings-general" title="General">
          <SettingsRow
            label="Display name"
            source={source("core.name")}
            help={systemHelp}
          >
            <FormField
              className="w-full sm:w-80"
              hideLabel
              name="name"
              label="Display name"
              required
              disabled={system}
            >
              {(f) => <Input {...f} autoComplete="off" />}
            </FormField>
          </SettingsRow>
          {linked ? (
            <SettingsRow
              label="Admin group"
              help="Set by adminGroup in .pkey/product. It grants nothing: console access is platform-wide."
            >
              {product.adminGroup ? (
                <span className="font-mono text-sm">{product.adminGroup}</span>
              ) : (
                <span className="text-fg-muted">None</span>
              )}
            </SettingsRow>
          ) : (
            <SettingsRow
              label="Admin group"
              help="Metadata only. It grants nothing: console access is platform-wide. Clear it to remove the group."
            >
              <FormField
                className="w-full sm:w-80"
                hideLabel
                name="adminGroup"
                label="Admin group"
              >
                {(f) => <Input {...f} mono clearable autoComplete="off" />}
              </FormField>
            </SettingsRow>
          )}
        </SettingsSection>

        {licenseOn ? (
          <SettingsSection id="settings-license" title="License defaults">
            <SettingsRow
              label="Default max offline days"
              source={source("license.defaults.maxOfflineDays")}
            >
              <FormField
                className="w-44"
                hideLabel
                name="defaultMaxOfflineDays"
                label="Default max offline days"
                required
                disabled={system}
                help={systemHelp ?? "From 1 to 365 days."}
              >
                {(f) => (
                  <NumberInput {...f} integer min={1} max={365} unit="days" />
                )}
              </FormField>
            </SettingsRow>
            <SettingsRow
              label="Default device limit"
              source={source("license.defaults.deviceLimit")}
            >
              <FormField
                className="w-44"
                hideLabel
                name="defaultDeviceLimit"
                label="Default device limit"
                required
                disabled={system}
                help={systemHelp}
              >
                {(f) => <NumberInput {...f} integer min={1} unit="devices" />}
              </FormField>
            </SettingsRow>
            <SettingsRow label="Compatibility window">
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
      <ConfirmDialog
        open={gate.open}
        onOpenChange={(open) => {
          if (!open) gate.cancel();
        }}
        intent={intentOf("setting.claim")}
        title="Claim these settings for the console?"
        description={`Saving sets ${listOf(gate.payload ?? [])} here instead of in .pkey/product.`}
        consequences={[
          "Resyncs from the repository leave claimed settings alone.",
          "Revert to manifest, in each setting's source badge, hands one back to .pkey/product.",
        ]}
        confirmLabel="Save and claim"
        onConfirm={gate.confirm}
      />
      {reverting ? (
        <RevertClaimDialog
          slug={slug}
          claim={reverting}
          onOpenChange={(open) => {
            if (!open) setReverting(null);
          }}
        />
      ) : null}
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
  const [linking, setLinking] = React.useState(false);
  const [result, setResult] = React.useState<{
    title: string;
    result: ResyncResult;
  } | null>(null);
  const linked = product.releaseSource === "github";
  const sync = product.setup?.sync ?? null;
  return (
    <SettingsSection
      id="settings-repository"
      title="Repository"
      actions={
        linked ? (
          <Button
            variant="outline"
            size="sm"
            iconStart={<RefreshCw aria-hidden />}
            onClick={() => setOpen(true)}
          >
            Resync from repo…
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            iconStart={<GitBranch aria-hidden />}
            onClick={() => setLinking(true)}
          >
            Link repository…
          </Button>
        )
      }
    >
      <SettingsRow
        label="Source"
        help={
          linked
            ? "Pushes to the repository re-apply its .pkey/ manifest."
            : "Set in the console. Link a repository to manage it from .pkey/ instead."
        }
      >
        {linked ? "Linked GitHub repository" : "Manual"}
      </SettingsRow>
      <SettingsRow label="Last sync">
        {sync?.lastSyncedAt ? (
          <Timestamp at={fromSeconds(sync.lastSyncedAt)} format="detail" />
        ) : (
          <span className="text-fg-muted">Never</span>
        )}
      </SettingsRow>
      <SettingsRow label="Sync status" help={sync?.message ?? undefined}>
        {!sync ? (
          <StatusPill tone="neutral">Not run</StatusPill>
        ) : sync.status === "error" ? (
          <StatusPill tone="danger">Failed</StatusPill>
        ) : (
          <StatusPill tone="success">In sync</StatusPill>
        )}
      </SettingsRow>
      {result ? (
        <div className="px-5 pb-4">
          <ResyncResultPanel
            title={result.title}
            result={result.result}
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
          "Services, catalog, tiers, profiles, channels and update settings follow the manifest.",
          "Values claimed in the console, and tiers and profiles created or edited there, are kept.",
          "Clients see the result on their next document fetch.",
        ]}
        confirmLabel="Resync from repo"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("resyncProduct", slug);
          setResult({ title: "Resync finished", result: res });
          toast.success("Resynced from repo");
        }}
      />
      {!linked ? (
        <LinkRepositoryDrawer
          slug={slug}
          productName={product.name}
          open={linking}
          onClose={() => setLinking(false)}
          onLinked={(res) =>
            setResult({ title: `Linked to ${res.repository}`, result: res })
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/** What a resync did: the panel §5.3 asks for, not just a toast (RSY-3). */
export function ResyncResultPanel({
  title = "Resync finished",
  result,
  onDismiss,
}: {
  title?: string;
  result: ResyncResult;
  onDismiss: () => void;
}): React.ReactElement {
  const updated = result.updated ?? [];
  const refused = result.refused ?? [];
  const claimed = result.claimed ?? [];
  const conflicts = result.conflicts ?? [];
  const packs = result.packSets;
  return (
    <Callout
      tone={
        refused.length || conflicts.length || (packs && !packs.ok)
          ? "warning"
          : "success"
      }
      title={title}
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
      {conflicts.length ? (
        <div className="mt-2">
          <p className="font-bold">Conflicts</p>
          <ul className="list-disc pl-5">
            {conflicts.map((x) => (
              <li key={x.path}>
                <span className="font-mono text-xs">{x.path}</span>: {x.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {claimed.length ? (
        <p className="mt-2">
          Kept as set in the console: {claimed.map(claimedLabel).join(", ")}.
        </p>
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
      description="What the nightly blob collector would remove. Nothing here deletes anything."
    >
      {gc.isPending ? (
        <div className="px-5 py-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : gc.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            compact
            error={gc.error}
            onRetry={() => void gc.refetch()}
          />
        </div>
      ) : (
        <StorageFacts dry={gc.data} />
      )}
    </SettingsSection>
  );
}

function StorageFacts({ dry }: { dry: BlobGcDryRun }): React.ReactElement {
  const drops = dry.drops.packObject + dry.drops.packUpload;
  return (
    <>
      <SettingsRow label="Collector">
        {dry.enabled ? (
          <StatusPill tone="success">
            On · {formatDuration(dry.graceSeconds * 1000).replace(/^for /, "")}{" "}
            grace
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">Off on this deployment</StatusPill>
        )}
      </SettingsRow>
      <SettingsRow
        label="Eligible for removal"
        help={`${formatCount(dry.drops.packObject)} pack objects, ${formatCount(dry.drops.packUpload)} abandoned uploads${dry.restores.count ? `; ${formatCount(dry.restores.count)} would be restored` : ""}.`}
      >
        <span className="tabular-nums">
          {`${formatCount(drops)}${dry.drops.truncated ? "+" : ""} ${drops === 1 ? "object" : "objects"}`}
        </span>
      </SettingsRow>
      <SettingsRow label="Earliest deletion">
        {dry.earliestDeletion ? (
          <Timestamp at={fromSeconds(dry.earliestDeletion)} format="detail" />
        ) : (
          <span className="text-fg-muted">None scheduled</span>
        )}
      </SettingsRow>
    </>
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
      {/* Chunk 4's shared L3 dialog: one wording and one guard for Delete product, here and in
          the Products registry. It sends the typed slug as `confirmSlug`. */}
      <DeleteProductDialog
        product={product}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => navigate(r.home())}
      />
    </>
  );
}
