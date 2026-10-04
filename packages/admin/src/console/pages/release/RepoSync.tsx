import * as React from "react";
import { buildLabel } from "@polaris-key/manifest";
import { ExternalLink, RefreshCw } from "lucide-react";
import type {
  ProductDetail,
  ReleaseHealth,
  ReleaseHealthCheck,
  ResyncResult,
} from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import type { Tone } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";

/**
 * The repo sync surface (ADMIN.md §6.3.1, REL-1 to REL-3, REL-8, REL-9, RSY-1 to RSY-3): health
 * checks, the last sync attempt and its lists (never truncated), and Resync from repo with a
 * result panel. It used to be three cards and a note stacked under the releases table.
 */

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  "needs-setup": { label: "Needs setup", tone: "warning" },
  "not-configured": { label: "Not configured", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

const CHECK: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "success" },
  missing: { label: "Missing", tone: "warning" },
  warning: { label: "Warning", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

const SYNC: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "Synced", tone: "success" },
  error: { label: "Failed", tone: "danger" },
};

export function healthEntry(status: string): { label: string; tone: Tone } {
  return HEALTH[status] ?? { label: status, tone: "neutral" };
}

/** Is the product linked to a repository (the resync route 422s otherwise)? */
export function isRepoLinked(product: ProductDetail | undefined): boolean {
  const s = (product?.releaseSource ?? "").trim().toLowerCase();
  return s === "github" || s === "gh" || s === "repo" || s === "repository";
}

export const NOT_LINKED = "This product isn't linked to a repository.";

/** The floor checks an operator answers with a channel's floor action (R6-10, P0-02). */
function isFloorCheck(id: string): boolean {
  return (
    id === "channel-regressed" ||
    id.startsWith("channel-regressed-") ||
    id.startsWith("channel-floor-unverified-")
  );
}

/** The header's health summary: a pill plus "synced 2 h ago". */
export function SyncSummary({
  health,
  product,
}: {
  health: ReleaseHealth | undefined;
  product: ProductDetail | undefined;
}): React.ReactElement | null {
  const last = product?.setup?.sync?.lastSyncedAt ?? null;
  if (!health && !last) return null;
  const h = health ? healthEntry(health.status) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {h ? <StatusPill tone={h.tone}>{h.label}</StatusPill> : null}
      {last ? (
        <span className="text-sm text-fg-muted">
          synced <Timestamp at={fromSeconds(last)} format="relative" />
        </span>
      ) : null}
    </span>
  );
}

/** Resync from repo (L1 caution), then a result panel listing what changed (RSY-3). */
export function ResyncButton({
  slug,
  linked,
  onResult,
  variant = "outline",
}: {
  slug: string;
  linked: boolean;
  onResult?: (result: ResyncResult) => void;
  variant?: "outline" | "primary";
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const policy = confirmFor("repo.resync");
  return (
    <>
      <Button
        variant={variant}
        iconStart={<RefreshCw aria-hidden />}
        disabledReason={linked ? undefined : NOT_LINKED}
        onClick={() => setOpen(true)}
      >
        Resync from repo
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={policy.intent === "none" ? "neutral" : policy.intent}
        title="Resync from repo"
        description="Polaris Key reads .pkey/ from the repository's default branch and applies it now."
        consequences={[
          "Release config, the catalog, services, tiers, profiles, update settings and delivery access are re-applied from the manifest.",
          "Values set in the console stay as they are until you revert them to the manifest.",
          "A part the manifest gets wrong is refused and listed; the rest still applies.",
        ]}
        confirmLabel="Resync from repo"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const result = await mutate("resyncProduct", slug);
          toast.success("Resynced from repo", {
            description: result.updated?.length
              ? `Updated: ${result.updated.join(", ")}.`
              : "Nothing in the manifest had changed.",
          });
          onResult?.(result);
        }}
      />
    </>
  );
}

/** What the last resync did: updated sections, refused parts, pack sets. */
export function ResyncResultPanel({
  result,
  onDismiss,
}: {
  result: ResyncResult;
  onDismiss: () => void;
}): React.ReactElement {
  const updated = result.updated ?? [];
  const refused = result.refused ?? [];
  return (
    <Callout
      tone={refused.length ? "warning" : "success"}
      title={
        refused.length
          ? `Resynced, with ${refused.length} ${refused.length === 1 ? "part" : "parts"} refused`
          : "Resynced from repo"
      }
      action={
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
      live
    >
      <div className="space-y-2">
        <p>
          {updated.length
            ? `Updated: ${updated.join(", ")}.`
            : "Nothing in the manifest had changed."}
        </p>
        {refused.length ? (
          <ul className="list-disc space-y-1 pl-5" aria-label="Refused">
            {refused.map((x) => (
              <li key={`${x.code}:${x.path}`}>
                <span className="font-mono text-xs">{x.path}</span>: {x.message}
              </li>
            ))}
          </ul>
        ) : null}
        {result.packSets ? (
          <p>
            {result.packSets.ok
              ? `Pack sets re-resolved: ${result.packSets.sets}.`
              : `Pack sets were not re-resolved: ${result.packSets.message}`}
          </p>
        ) : null}
      </div>
    </Callout>
  );
}

function ValueList({
  title,
  values,
  mono,
}: {
  title: string;
  values: string[];
  mono?: boolean;
}): React.ReactElement | null {
  if (!values.length) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-bold text-fg-muted">
        {title} ({values.length})
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <li
            key={v}
            className={
              mono
                ? "rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-fg"
                : "rounded-sm bg-surface-sunken px-1.5 py-0.5 text-xs text-fg"
            }
          >
            {v}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckRow({
  check,
  slug,
}: {
  check: ReleaseHealthCheck;
  slug: string;
}): React.ReactElement {
  const s = CHECK[check.status] ?? { label: check.status, tone: "neutral" };
  return (
    <li className="space-y-1 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-fg-strong">{check.label}</span>
        <StatusPill tone={s.tone}>{s.label}</StatusPill>
      </div>
      {check.message ? (
        <p className="text-xs text-fg-muted">{check.message}</p>
      ) : null}
      {check.missing?.length ? (
        <p className="text-xs text-fg">Missing: {check.missing.join(", ")}</p>
      ) : null}
      {check.files?.length ? (
        <ul className="space-y-0.5 text-xs" aria-label={`${check.label} files`}>
          {check.files.map((f) => (
            <li key={f.name} className="flex flex-wrap justify-between gap-x-3">
              <span className="break-all font-mono">{f.name}</span>
              <span className="text-fg-muted">
                {f.platform || f.arch
                  ? buildLabel({
                      platform: f.platform,
                      arch: f.arch,
                      format: f.format,
                    }).long
                  : (f.format ?? "")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isFloorCheck(check.id) ? (
        <p className="text-xs text-fg">
          Lower or clear the floor from the channel's menu on{" "}
          <Link
            to={r.channels(slug)}
            className="text-accent-fg underline-offset-4 hover:underline"
          >
            Channels
          </Link>
          .
        </p>
      ) : null}
    </li>
  );
}

/** The Repo sync drawer: health, the last attempt, and the resync. */
export function RepoSyncDrawer({
  open,
  onOpenChange,
  slug,
  product,
  health,
  healthError,
  healthLoading,
  onRetryHealth,
  result,
  onResult,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  product: ProductDetail | undefined;
  health: ReleaseHealth | undefined;
  healthError: unknown;
  healthLoading: boolean;
  onRetryHealth: () => void;
  /** The last resync's result (the page holds it, so a header resync shows it here too). */
  result: ResyncResult | null;
  onResult: (result: ResyncResult | null) => void;
}): React.ReactElement {
  const linked = isRepoLinked(product);
  const sync = product?.setup?.sync ?? null;
  const h = health ? healthEntry(health.status) : null;
  const s = sync?.status ? SYNC[sync.status] : undefined;
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Repo sync"
      description={
        linked
          ? "How Polaris Key's view of the repository was formed, and whether it is current."
          : "Release health for a product that publishes from CI."
      }
    >
      <DrawerBody className="space-y-6">
        {result ? (
          <ResyncResultPanel result={result} onDismiss={() => onResult(null)} />
        ) : null}
        <section className="space-y-3" aria-labelledby="repo-sync-health">
          <div className="flex items-center justify-between gap-2">
            <h2
              id="repo-sync-health"
              className="text-sm font-bold text-fg-strong"
            >
              Release health
            </h2>
            {h ? <StatusPill tone={h.tone}>{h.label}</StatusPill> : null}
          </div>
          {healthLoading && !health ? (
            <Skeleton className="h-24 w-full" />
          ) : healthError && !health ? (
            <ErrorState error={healthError} onRetry={onRetryHealth} compact />
          ) : health ? (
            <>
              {health.release ? (
                <DescriptionList
                  columns={2}
                  items={[
                    {
                      term: "Latest tag",
                      detail: (
                        <a
                          href={health.release.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
                        >
                          {health.release.tag}
                          <ExternalLink aria-hidden className="size-3" />
                          <span className="sr-only">(opens GitHub)</span>
                        </a>
                      ),
                    },
                    {
                      term: "Assets",
                      detail: String(health.release.assetCount),
                    },
                  ]}
                />
              ) : null}
              <ul className="space-y-2">
                {health.checks.map((c) => (
                  <CheckRow key={c.id} check={c} slug={slug} />
                ))}
              </ul>
            </>
          ) : null}
        </section>
        {linked ? (
          <section className="space-y-3" aria-labelledby="repo-sync-last">
            <div className="flex items-center justify-between gap-2">
              <h2
                id="repo-sync-last"
                className="text-sm font-bold text-fg-strong"
              >
                Last sync
              </h2>
              {s ? <StatusPill tone={s.tone}>{s.label}</StatusPill> : null}
            </div>
            {sync ? (
              <>
                <DescriptionList
                  columns={2}
                  items={[
                    {
                      term: "Triggered by",
                      detail:
                        sync.source === "webhook"
                          ? "A push to the repository"
                          : sync.source === "manual"
                            ? "Resync from repo"
                            : (sync.source ?? "—"),
                    },
                    {
                      term: "Commit",
                      detail: sync.commitSha ? (
                        <span className="font-mono text-xs">
                          {sync.commitSha.slice(0, 12)}
                        </span>
                      ) : (
                        "—"
                      ),
                    },
                    {
                      term: "Last checked",
                      detail: sync.lastCheckedAt ? (
                        <Timestamp
                          at={fromSeconds(sync.lastCheckedAt)}
                          format="detail"
                        />
                      ) : (
                        "—"
                      ),
                    },
                    {
                      term: "Last synced",
                      detail: sync.lastSyncedAt ? (
                        <Timestamp
                          at={fromSeconds(sync.lastSyncedAt)}
                          format="detail"
                        />
                      ) : (
                        "—"
                      ),
                    },
                  ]}
                />
                {sync.message ? (
                  <Callout tone="warning">{sync.message}</Callout>
                ) : null}
                <ValueList
                  title="Changed paths"
                  values={sync.changedPaths ?? []}
                  mono
                />
                <ValueList
                  title="Updated sections"
                  values={sync.updated ?? []}
                />
                <ValueList title="Errors" values={sync.errors ?? []} />
              </>
            ) : (
              <p className="text-sm text-fg-muted">
                No sync has run yet. Push to the repository or resync to read
                its manifest.
              </p>
            )}
          </section>
        ) : null}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <ResyncButton
          slug={slug}
          linked={linked}
          variant="primary"
          onResult={onResult}
        />
      </DrawerFooter>
    </Drawer>
  );
}
