/**
 * Core → Keys & secrets (T4; docs/design/ADMIN.md §6.7). Signing keys, write-only product
 * secrets and CI publishing credentials, one section each (SEC-1).
 *
 * - **Signing keys** (gold: this is where it means the most). The full lifecycle from A-4:
 *   Prepare (L1) → a staged row with a live countdown to its trust window → Activate (L1) → the
 *   old key retires → Revoke (L3, type the kid). Activating before the window is break-glass:
 *   behind a disclosure, L3, with the trust-cache risk stated (SET-1, OVR-3).
 * - **Rotation** (UX-29; docs/design/EXPERIENCE.md §0.5 O3): while a key is staged, a strip
 *   Prepared → Trust window (countdown) → Activate → Old key retires owns the rotation. Activate
 *   is its primary and enables itself when the window ends; break-glass and cancelling stay in
 *   its overflow, and Prepare is disabled with the reason. After activation one line says how
 *   many active devices have refreshed since (§0.9: derived from `last_seen`, never a trust
 *   fetch count).
 * - **Secrets**: the union of what is stored (A-5) and what the configuration requires (SEC-2).
 * - **CI publishing**: the trusted publisher and static CI tokens.
 * - Edge mint and store credentials have their own pages, under Config and Distribution.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, KeyRound, Plus } from "lucide-react";
import {
  api,
  type ProductDetail,
  type SigningKeyDto,
  type SigningKeyRefreshDto,
  type SigningKeysResponse,
} from "../../../api.js";
import { cn } from "../../../lib/cn.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatSpan, fromSeconds } from "../../../lib/format.js";
import { ActionMenu } from "../../../ui/ActionMenu.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { KeyDisplay } from "../../../ui/KeyDisplay.js";
import { LiveRegion } from "../../../ui/LiveRegion.js";
import { SignedGlyph } from "../../../ui/SignedBadge.js";
import { PageSkeleton, Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { PageHeader } from "../../components/PageHeader.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { Link } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection, SettingsTemplate } from "../../templates/Settings.js";
import { intentOf } from "./confirmGate.js";
import { CiPublishingSection } from "./KeysCi.js";
import { SecretsSection } from "./KeysSecrets.js";

export function fetchSigningKeys(slug: string): Promise<SigningKeysResponse> {
  return api.productKeys(slug);
}

export function KeysPage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  useLoadingAnnouncement("keys and secrets", product.isPending);
  const name = product.data?.name ?? slug;
  const header = (
    <PageHeader
      title="Keys & secrets"
      refetching={product.isFetching && !product.isPending}
    />
  );
  if (product.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageSkeleton template="form" label="keys and secrets" />
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
  const p = product.data;
  return (
    <SettingsTemplate
      header={header}
      sections={[
        { id: "keys-signing", title: "Signing keys" },
        { id: "keys-secrets", title: "Secrets" },
        { id: "keys-ci", title: "CI publishing" },
      ]}
    >
      <SigningKeysSection slug={slug} product={p} />
      <SecretsSection slug={slug} product={p} />
      <CiPublishingSection slug={slug} />
    </SettingsTemplate>
  );
}

// ── Signing keys ───────────────────────────────────────────────────────────────────────────────

/** Server time now, in seconds: the server's clock at fetch plus local elapsed time. */
function useServerNow(
  data: SigningKeysResponse | undefined,
  fetchedAt: number,
): number {
  const [tick, setTick] = React.useState(() => Date.now());
  const waiting =
    data?.keys.some(
      (k) =>
        k.status === "staged" &&
        k.activateAfter !== null &&
        k.activateAfter > data.now + (tick - fetchedAt) / 1000,
    ) ?? false;
  React.useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  if (!data) return Math.floor(tick / 1000);
  return data.now + Math.max(0, (tick - fetchedAt) / 1000);
}

type KeyAction = "activate" | "breakGlass" | "retire" | "revoke";

function SigningKeysSection({
  slug,
  product,
}: {
  slug: string;
  product: ProductDetail;
}): React.ReactElement {
  const keys = useQuery(
    { queryKey: qk.keys(slug), queryFn: () => fetchSigningKeys(slug) },
    queryClient,
  );
  const now = useServerNow(keys.data, keys.dataUpdatedAt || Date.now());
  const [prepare, setPrepare] = React.useState(false);
  const [action, setAction] = React.useState<{
    kind: KeyAction;
    key: SigningKeyDto;
  } | null>(null);
  const jwks =
    typeof window !== "undefined" && product.jwksUrl
      ? new URL(product.jwksUrl, window.location.origin).toString()
      : product.jwksUrl;
  const releaseOn = product.services?.release?.enabled ?? false;
  // The list is ordered active → staged → retired, newest first: the first staged key is the
  // rotation in progress.
  const staged = keys.data?.keys.find((k) => k.status === "staged");
  const active = keys.data?.keys.find((k) => k.status === "active");
  const refresh = keys.data?.refresh ?? null;

  return (
    <SettingsSection
      id="keys-signing"
      title="Signing keys"
      source={<SignedGlyph size={12} />}
      actions={
        <Button
          size="sm"
          iconStart={<Plus aria-hidden />}
          disabledReason={
            staged
              ? `A rotation is in progress. Activate or retire ${staged.kid} first.`
              : undefined
          }
          onClick={() => setPrepare(true)}
        >
          Prepare signing key
        </Button>
      }
    >
      {staged ? (
        <RotationStrip
          staged={staged}
          active={active}
          now={now}
          onAction={(kind) => setAction({ kind, key: staged })}
        />
      ) : refresh ? (
        <RefreshedLine refresh={refresh} />
      ) : null}
      <div className="px-5 py-4">
        {keys.isPending ? (
          <div className="space-y-2" aria-label="signing keys">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : keys.isError ? (
          <ErrorState
            compact
            error={keys.error}
            onRetry={() => void keys.refetch()}
          />
        ) : keys.data.keys.length === 0 ? (
          <EmptyState
            kind="first-run"
            headingLevel={3}
            title="No signing key"
            description="Without an active key this product can sign nothing. Prepare one, then activate it."
          />
        ) : (
          <ul className="divide-y divide-border" aria-label="Signing keys">
            {keys.data.keys.map((k) => (
              <SigningKeyRow
                key={k.kid}
                k={k}
                now={now}
                onAction={(kind) => setAction({ kind, key: k })}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2 px-5 py-4 text-sm">
        {jwks ? (
          <p className="flex items-center gap-2">
            <span className="shrink-0 text-fg-muted">JWKS</span>
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg-strong">
              {jwks}
            </code>
            <span className="shrink-0">
              <CopyButton value={jwks} label="Copy the JWKS URL" />
            </span>
          </p>
        ) : null}
        {releaseOn ? (
          <p className="text-fg-muted">
            App release records are signed by your CI release key, and content
            keys are delegated per pack.{" "}
            <Link
              to={r.contentKeys(slug)}
              className="inline-flex items-center gap-1 text-accent-fg underline-offset-4 hover:underline"
            >
              Content keys
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={prepare}
        onOpenChange={setPrepare}
        intent={intentOf("signing.prepare")}
        title="Prepare a signing key?"
        consequences={[
          "A new Ed25519 key is created as staged and published for trust discovery.",
          "Nothing is signed with it until you activate it.",
          "It can be activated once clients have had the trust window to refresh.",
        ]}
        confirmLabel="Prepare signing key"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          const res = await mutate("rotateProductKey", slug);
          toast.success(`Signing key ${res.kid} prepared`, {
            description:
              "It is staged; activate it once its trust window ends.",
          });
        }}
      />
      <KeyActionDialog
        slug={slug}
        action={action}
        onClose={() => setAction(null)}
      />
    </SettingsSection>
  );
}

/** A countdown: "4:32" under an hour, a spoken span ("2 hours") above it. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return formatSpan(s * 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type StepState = "done" | "current" | "upcoming";

function RotationStep({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="flex min-w-0 items-start gap-2.5"
    >
      <span
        aria-hidden
        className={cn(
          "mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold tabular-nums",
          state === "current" && "border-accent bg-accent text-accent-on",
          state === "done" && "border-accent text-accent-fg",
          state === "upcoming" && "border-border-strong text-fg-muted",
        )}
      >
        {state === "done" ? <Check className="size-3.5" /> : n}
      </span>
      <span className="min-w-0 space-y-0.5">
        <span
          className={cn(
            "block text-sm font-bold",
            state === "upcoming" ? "text-fg-muted" : "text-fg-strong",
          )}
        >
          {title}
          {state === "done" ? (
            <span className="sr-only"> (completed)</span>
          ) : null}
        </span>
        <span className="block text-xs text-fg-muted">{children}</span>
      </span>
    </li>
  );
}

/**
 * The rotation in progress (EXPERIENCE.md §0.5 O3): four steps and the one primary. Before the
 * trust window ends Activate is disabled with the reason and the countdown says when; break-glass
 * and cancelling (retiring the staged key) are in the overflow. When the window ends a polite
 * live region says so once, and the button enables itself in place (§7.1: nothing moves).
 */
function RotationStrip({
  staged,
  active,
  now,
  onAction,
}: {
  staged: SigningKeyDto;
  active: SigningKeyDto | undefined;
  now: number;
  onAction: (kind: KeyAction) => void;
}): React.ReactElement {
  const wait =
    staged.activateAfter === null ? 0 : Math.max(0, staged.activateAfter - now);
  const ready = wait <= 0;
  // Announce the window ending only when it ended while the page was open.
  const sawWaiting = React.useRef(!ready);
  if (!ready) sawWaiting.current = true;
  const announcement =
    ready && sawWaiting.current
      ? `Trust window ended. ${staged.kid} is ready to activate.`
      : "";
  return (
    <div className="space-y-4 px-5 py-4">
      <ol
        aria-label="Key rotation"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <RotationStep n={1} state="done" title="Prepared">
          <span className="font-mono">{staged.kid}</span> ·{" "}
          <Timestamp at={fromSeconds(staged.createdAt)} format="relative" />
        </RotationStep>
        <RotationStep
          n={2}
          state={ready ? "done" : "current"}
          title="Trust window"
        >
          {ready ? (
            "Ended: clients have had time to pick the key up"
          ) : (
            <>
              <span aria-live="off" className="font-mono tabular-nums">
                {clock(wait)}
              </span>{" "}
              left while clients refresh their trust
            </>
          )}
        </RotationStep>
        <RotationStep
          n={3}
          state={ready ? "current" : "upcoming"}
          title="Activate"
        >
          {ready
            ? `${staged.kid} starts signing`
            : "Available when the window ends"}
        </RotationStep>
        <RotationStep n={4} state="upcoming" title="Old key retires">
          {active ? (
            <>
              <span className="font-mono">{active.kid}</span> retires on
              activation and keeps verifying what it signed
            </>
          ) : (
            "Nothing to retire: no key is active"
          )}
        </RotationStep>
      </ol>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          disabledReason={
            ready
              ? undefined
              : `Activatable when the trust window ends, in ${clock(wait)}.`
          }
          onClick={() => onAction("activate")}
        >
          Activate {staged.kid}…
        </Button>
        <ActionMenu
          label="More rotation actions"
          items={[
            ...(ready
              ? []
              : [
                  {
                    label: "Activate now (break-glass)…",
                    onSelect: () => onAction("breakGlass"),
                    tone: "danger" as const,
                  },
                ]),
            {
              label: `Cancel rotation (retire ${staged.kid})…`,
              onSelect: () => onAction("retire"),
              tone: "danger" as const,
            },
          ]}
        />
      </div>
      <LiveRegion message={announcement} />
    </div>
  );
}

/**
 * After a rotation, one reassurance line (EXPERIENCE.md §0.5 O3, §0.9). "Refreshed" means the
 * device reached the server after the key went live; the server keeps no per-device record of a
 * trust fetch, so the copy never claims one.
 */
export function refreshedCopy(r: SigningKeyRefreshDto): string {
  if (r.activeDevices === 0)
    return `No device has been active in the last ${r.windowDays} days, so none has refreshed since ${r.kid} went live.`;
  const pct = Math.floor((r.refreshedDevices / r.activeDevices) * 100);
  return `${pct}% of active devices have refreshed since ${r.kid} went live.`;
}

function RefreshedLine({
  refresh,
}: {
  refresh: SigningKeyRefreshDto;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2 px-5 py-3 text-sm">
      <span className="mt-1 shrink-0">
        <SignedGlyph size={12} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-fg">{refreshedCopy(refresh)}</p>
        {refresh.activeDevices > 0 ? (
          <p className="text-xs text-fg-muted">
            {refresh.refreshedDevices.toLocaleString()} of{" "}
            {refresh.activeDevices.toLocaleString()} seen in the last{" "}
            {refresh.windowDays} days · live since{" "}
            <Timestamp
              at={fromSeconds(refresh.activatedAt)}
              format="relative"
            />
          </p>
        ) : null}
      </div>
    </div>
  );
}

const KEY_STATUS_TEXT: Record<string, string> = {
  active: "Active",
  staged: "Staged",
  retired: "Retired",
  revoked: "Revoked",
};

function SigningKeyRow({
  k,
  now,
  onAction,
}: {
  k: SigningKeyDto;
  now: number;
  onAction: (kind: KeyAction) => void;
}): React.ReactElement {
  const ready =
    k.status === "staged" &&
    (k.activateAfter === null || k.activateAfter <= now);
  const status = k.status as "active" | "staged" | "retired" | "revoked";
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      {/* Name, status and actions on one line; the public key gets the full width under it. */}
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {k.status === "active" || k.status === "staged" ? (
            <SignedGlyph size={12} />
          ) : (
            <KeyRound aria-hidden className="size-3 text-fg-subtle" />
          )}
          <span className="font-mono text-sm font-bold text-fg-strong">
            {k.kid}
          </span>
          <StatusPill
            tone={
              status === "active"
                ? "success"
                : status === "staged"
                  ? "info"
                  : "neutral"
            }
          >
            {KEY_STATUS_TEXT[k.status] ?? k.status}
          </StatusPill>
          <span className="text-xs text-fg-muted">{k.alg}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status === "retired" ? (
            <ActionMenu
              label={`More actions for ${k.kid}`}
              items={[
                {
                  label: "Revoke…",
                  onSelect: () => onAction("revoke"),
                  tone: "danger" as const,
                },
              ]}
            />
          ) : status === "active" ? (
            <ActionMenu
              label={`More actions for ${k.kid}`}
              items={[
                {
                  label: "Retire…",
                  onSelect: () => undefined,
                  disabledReason:
                    "Retire is unavailable for the active key. Activate another key first.",
                },
              ]}
            />
          ) : null}
        </div>
      </div>
      <p className="text-xs text-fg-muted">
        {status === "active" && k.activatedAt ? (
          <>
            Active since{" "}
            <Timestamp at={fromSeconds(k.activatedAt)} format="date" />
          </>
        ) : status === "staged" ? (
          <>
            Prepared <Timestamp at={fromSeconds(k.createdAt)} format="date" />
            {ready ? " · its trust window has ended" : null}
          </>
        ) : status === "retired" && k.retiredAt ? (
          <>
            Retired <Timestamp at={fromSeconds(k.retiredAt)} format="date" />
          </>
        ) : status === "revoked" && k.revokedAt ? (
          <>
            Revoked <Timestamp at={fromSeconds(k.revokedAt)} format="date" />
          </>
        ) : (
          <>
            Created <Timestamp at={fromSeconds(k.createdAt)} format="date" />
          </>
        )}
      </p>
      <KeyDisplay label="Public key" kind="public" value={k.publicKey} />
    </li>
  );
}

function KeyActionDialog({
  slug,
  action,
  onClose,
}: {
  slug: string;
  action: { kind: KeyAction; key: SigningKeyDto } | null;
  onClose: () => void;
}): React.ReactElement {
  const kid = action?.key.kid ?? "";
  const kind = action?.kind;
  const common = {
    open: action !== null,
    onOpenChange: (o: boolean) => {
      if (!o) onClose();
    },
    describeError: (e: unknown) => errorCopy(e),
  };
  if (kind === "breakGlass") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.breakGlassActivate")}
        title={`Activate ${kid} before its trust window ends?`}
        description="Break-glass activation is for a compromised active key. Clients that have not refreshed their trust reject documents signed with a key they do not know yet."
        consequences={[
          `${kid} signs everything from now on; the current key retires.`,
          "Clients still caching the old trust set fail to verify until they refresh (up to the trust cache window).",
        ]}
        typedConfirmation={{ value: kid, label: "Type the key id" }}
        confirmLabel="Activate now"
        onConfirm={async () => {
          await mutate("activateProductKey", slug, kid, true);
          toast.success(`Signing key ${kid} is active`);
        }}
      />
    );
  }
  if (kind === "retire" && action?.key.status === "staged") {
    // Cancelling a rotation: the strip's overflow retires the staged key.
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.retire")}
        title={`Cancel the rotation to ${kid}?`}
        consequences={[
          `${kid} is retired and can no longer be activated.`,
          "The active key keeps signing; devices see no change.",
        ]}
        confirmLabel={`Retire ${kid}`}
        onConfirm={async () => {
          await mutate("retireProductKey", slug, kid);
          toast.success(`Rotation cancelled: ${kid} retired`);
        }}
      />
    );
  }
  if (kind === "retire") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.retire")}
        title={`Retire ${kid}?`}
        consequences={[
          "The key can no longer be activated.",
          "It stays listed in the trust set until it ages out, so documents it signed keep verifying.",
        ]}
        confirmLabel="Retire"
        onConfirm={async () => {
          await mutate("retireProductKey", slug, kid);
          toast.success(`Signing key ${kid} retired`);
        }}
      />
    );
  }
  if (kind === "revoke") {
    return (
      <ConfirmDialog
        {...common}
        intent={intentOf("signing.revoke")}
        title={`Revoke ${kid}?`}
        description="Revoke a key you believe was compromised."
        consequences={[
          "The trust manifest lists the key as revoked: clients reject anything it signed.",
          "This cannot be undone.",
        ]}
        typedConfirmation={{ value: kid, label: "Type the key id" }}
        confirmLabel="Revoke"
        onConfirm={async () => {
          await mutate("revokeProductKey", slug, kid);
          toast.success(`Signing key ${kid} revoked`);
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      {...common}
      intent={intentOf("signing.activate")}
      title={`Activate ${kid}?`}
      consequences={[
        `${kid} signs every document from now on.`,
        "The current active key retires; documents it signed keep verifying.",
      ]}
      confirmLabel="Activate"
      onConfirm={async () => {
        await mutate("activateProductKey", slug, kid);
        toast.success(`Signing key ${kid} is active`);
      }}
    >
      {action && action.key.activateAfter ? (
        <Callout tone="signed">
          Clients have had the trust window to pick this key up from the trust
          manifest.
        </Callout>
      ) : null}
    </ConfirmDialog>
  );
}
