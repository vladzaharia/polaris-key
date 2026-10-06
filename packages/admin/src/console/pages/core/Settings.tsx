/**
 * Core → Settings (T4; docs/design/ADMIN.md §6.9). General, License defaults (when License is
 * on), Repository, Storage and the Danger zone.
 *
 * - General and License defaults are one resource (`PATCH /products/:slug`), so one form and one
 *   `SaveBar` whose summary counts both sections' changes. Validation matches the server: a blank
 *   display name is refused, a cleared admin group is sent as `null` (A-3, PRD-6), never dropped.
 * - Signing moved to Keys & secrets and the compatibility window to Update → Feed; this page
 *   links to each instead of describing where they went (SET-3).
 * - Resync from repo is the console's one resync flow (`components/ResyncDialog.tsx`, UX-78):
 *   an L1 confirm that shows the dry run's plan, then a focused, announced result panel listing
 *   what it re-applied, what it refused, what it kept because the console claimed it, and the
 *   pack-set outcome (RSY-3).
 * - ST-01b (S-18 model C): on a repo-linked product the display name and the licence defaults
 *   carry a SourceBadge. Saving one claims it for the console (an L1 confirm says so) and every
 *   resync leaves it alone until Revert to manifest, which restores the last applied manifest's
 *   value at once (or at the next resync when there is no snapshot yet). The admin group is
 *   manifest-only there and shown read-only.
 * - ST-20 (S-18 §4.5 items 7–8): a manifest-authoritative product (the switch in Repository; on
 *   and locked for the system product) takes a save of a manifest-declared value only as a
 *   break-glass claim: an L2 confirm with a reason, and the claim ends after 7 days or at the
 *   first resync or deploy that changes the value. Each such row says when its claim ends. The
 *   system product keeps its name, and it has no Resync: the deploy hook is its only writer.
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
  formatDateTime,
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
import { Switch } from "../../../ui/Switch.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { BreakGlassDialog } from "../../components/BreakGlassDialog.js";
import { DeleteProductDialog } from "../../components/DeleteProductDialog.js";
import {
  ResyncDialog,
  ResyncResultPanel,
} from "../../components/ResyncDialog.js";
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
  // ST-20: manifest-authoritative mode (an older Worker omits it: the system product is on).
  const authoritative = product.manifestAuthoritative?.value ?? system;
  // A repo-linked product, or the system product (whose manifest the deploy hook applies), has a
  // manifest to claim from.
  const claimable = linked || system;
  const claims = React.useMemo(
    () => new Set((product.claims ?? []).map((c) => c.key)),
    [product.claims],
  );
  const breakGlassOf = React.useMemo(
    () =>
      new Map(
        (product.claims ?? []).flatMap((c) =>
          c.breakGlass ? [[c.key, c.breakGlass] as const] : [],
        ),
      ),
    [product.claims],
  );
  const gate = useConfirmGate<string[]>();
  const breakGlassGate = useConfirmGate<string[]>();
  const breakGlassReason = React.useRef("");
  const [reverting, setReverting] = React.useState<ClaimKey | null>(null);
  const values = React.useMemo(() => draftOf(product), [product]);
  const form = useAdminForm<Draft>({
    values,
    resetOn: [product.modifiedAt, product.name, product.adminGroup],
    validate: validateSettings,
    onSubmit: async (draft, { server }) => {
      const body = diffValues(server, draft, { nullable: ["adminGroup"] });
      const claimed = claimable
        ? (Object.keys(CLAIM_OF_FIELD) as (keyof Draft)[])
            .filter((f) => body[f] !== undefined)
            .map((f) => CLAIM_OF_FIELD[f]!)
        : [];
      // ST-20: on a manifest-authoritative product every such save is a break-glass claim (L2,
      // with a reason), even over a live claim: a second one restarts its 7 days.
      let breakGlass: { reason: string } | undefined;
      if (authoritative && claimed.length > 0) {
        if (!(await breakGlassGate.ask(claimed.map((k) => CLAIM_LABELS[k]))))
          throw new SaveCancelled();
        breakGlass = { reason: breakGlassReason.current };
      }
      // ST-01b: saving a manifest-owned value claims it; the operator confirms that first.
      const newClaims = authoritative
        ? []
        : claimed
            .filter((key) => !claims.has(key))
            .map((key) => CLAIM_LABELS[key]);
      if (newClaims.length > 0 && !(await gate.ask(newClaims)))
        throw new SaveCancelled();
      await mutate("updateProduct", slug, {
        ...(breakGlass ? { breakGlass } : {}),
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
  /** A row's help: when its break-glass claim ends, or how a change here is taken. */
  const claimHelp = (key: ClaimKey, fallback?: string): string | undefined => {
    const bg = breakGlassOf.get(key);
    if (bg)
      return `Break-glass claim until ${formatDateTime(fromSeconds(bg.expiresAt))}, or the first ${system ? "deploy" : "resync"} that changes it in .pkey/: ${bg.reason}`;
    if (authoritative)
      return system
        ? "Set by the monorepo's .pkey/product, which the deploy hook applies. A change here is a break-glass claim."
        : "Set by .pkey/product: this product is manifest-authoritative, so a change here is a break-glass claim.";
    return fallback;
  };

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
            help={
              system
                ? "The system product keeps its name."
                : claimHelp("core.name")
            }
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
                help={claimHelp(
                  "license.defaults.maxOfflineDays",
                  "From 1 to 365 days.",
                )}
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
                help={claimHelp("license.defaults.deviceLimit")}
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
      <BreakGlassDialog
        open={breakGlassGate.open}
        settings={breakGlassGate.payload ?? []}
        system={system}
        onConfirm={(reason) => {
          breakGlassReason.current = reason;
          breakGlassGate.confirm();
        }}
        onCancel={breakGlassGate.cancel}
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
    title?: string;
    repository: string | null;
    result: ResyncResult;
  } | null>(null);
  const linked = product.releaseSource === "github";
  const system = product.system === true;
  const sync = product.setup?.sync ?? null;
  return (
    <SettingsSection
      id="settings-repository"
      title="Repository"
      actions={
        system ? undefined : linked ? (
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
          system
            ? "The deploy hook is the only writer: every production deploy applies the monorepo's .pkey/ release configuration, deliverables, trusted publisher and service rows at the deployed commit. Pushes and Resync do not apply it."
            : linked
              ? "Pushes to the repository re-apply its .pkey/ manifest."
              : "Set in the console. Link a repository to manage it from .pkey/ instead."
        }
      >
        {system
          ? "The deploy hook"
          : linked
            ? "Linked GitHub repository"
            : "Manual"}
      </SettingsRow>
      {linked || system ? (
        <ManifestAuthorityRow slug={slug} product={product} />
      ) : null}
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
            productName={product.name}
            repository={result.repository}
            onDismiss={() => setResult(null)}
          />
        </div>
      ) : null}
      <ResyncDialog
        target={{ slug, name: product.name }}
        open={open}
        onOpenChange={setOpen}
        onResult={(o) =>
          setResult({ repository: o.repository, result: o.result })
        }
      />
      {!linked ? (
        <LinkRepositoryDrawer
          slug={slug}
          productName={product.name}
          open={linking}
          onClose={() => setLinking(false)}
          onLinked={(res) =>
            setResult({
              title: `Linked to ${res.repository}`,
              repository: res.repository,
              result: res,
            })
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * ST-20: manifest-authoritative mode (S-18 §4.5 item 7, D14). A switch with an L1 confirm on a
 * repository-linked product; on and locked for the system product.
 */
function ManifestAuthorityRow({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const system = product.system === true;
  const mode = product.manifestAuthoritative ?? {
    value: system,
    locked: system,
  };
  const [asking, setAsking] = React.useState<boolean | null>(null);
  return (
    <SettingsRow
      label="Manifest-authoritative"
      help={
        mode.locked
          ? "Always on for the system product: a console change to a licence default is a break-glass claim with a reason, which ends within 7 days or at the first deploy that changes it."
          : "When on, .pkey/ is the only writer of the display name, licence defaults, web origins and catalog: a console change to one is a break-glass claim with a reason, which ends after 7 days or at the first resync that changes it. Other settings .pkey/ declares are not covered yet."
      }
    >
      {mode.locked ? (
        <StatusPill tone="info">On, locked</StatusPill>
      ) : (
        <Switch
          aria-label="Manifest-authoritative"
          checked={mode.value}
          onCheckedChange={(next) => setAsking(next)}
        />
      )}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        intent={intentOf("setting.manifestAuthoritative")}
        title={
          asking
            ? "Make .pkey/ the only writer?"
            : "Let the console claim settings again?"
        }
        description={
          asking
            ? `Console changes to ${product.name}'s display name, licence defaults, web origins and catalog are refused, except as break-glass claims.`
            : `A console change to ${product.name}'s display name, licence defaults, web origins or catalog claims it again, until it is reverted.`
        }
        consequences={
          asking
            ? [
                "A break-glass claim needs a reason and ends after 7 days, or at the first resync that changes the value.",
                "Settings already claimed in the console stay claimed until you revert them.",
                "Not covered yet: services, the fingerprint and auto-issue policies, the compatibility window, access modes, tiers, profiles and the trusted publisher still claim on a console edit.",
              ]
            : ["Live break-glass claims keep their expiry."]
        }
        confirmLabel={asking ? "Turn on" : "Turn off"}
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("updateProduct", slug, {
            manifestAuthoritative: asking === true,
          });
          toast.success(
            asking
              ? "Manifest-authoritative mode is on"
              : "Manifest-authoritative mode is off",
          );
        }}
      />
    </SettingsRow>
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
