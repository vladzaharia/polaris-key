/** The Licenses page's smaller parts: the server-side filter, the bulk confirm and the 403 state. */

import * as React from "react";
import {
  Clock,
  KeyRound,
  KeySquare,
  Layers,
  Mail,
  MonitorSmartphone,
  Plus,
  Sparkles,
  UserRound,
} from "lucide-react";
import { r } from "../../../routes.js";
import { Link, navigate } from "../../../router.js";
import { Button } from "../../../../ui/Button.js";
import { HttpError, type LicenseSummary } from "../../../../api.js";
import { mutateEach } from "../../../data/mutations.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { toast } from "../../../../ui/toast.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import { NoAccessPage } from "../../../access/NoAccessPage.js";
import { useWriteGate } from "../../../access/useCan.js";
import { cn } from "../../../../lib/cn.js";
import {
  fromSeconds,
  formatDate,
  formatShort,
} from "../../../../lib/format.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import {
  HOLDER_STATES,
  holderOf,
  holderState,
  licenseInitials,
  type HolderState,
} from "./holders.js";
import { expiresInText } from "../../../../lib/vocab/license.js";
import { daysUntil, licenseState, type LicenseState } from "./shared.js";

/** The facet value for "not in a batch": only the client can filter on it. */
export const NO_BATCH = "__none__";

/**
 * What the Worker can narrow before it pages: one holder state, one batch, one tier, as the URL
 * (a deep link) or a single chip says. Everything else filters the loaded rows.
 */
export function useServerFilter(filters: Record<string, string[]>): {
  holder?: string;
  batch?: string;
  tier?: string;
  state?: string;
} {
  return React.useMemo(() => {
    const one = (id: string, not?: string): string | undefined => {
      const v = filters[id] ?? [];
      return v.length === 1 && v[0] !== not ? v[0] : undefined;
    };
    const holder = one("holder");
    const batch = one("batch", NO_BATCH);
    const tier = one("tier");
    const status = one("status");
    return {
      // The Status facet is the computed state: one value goes to the Worker.
      ...(status && LIST_STATES.includes(status) ? { state: status } : {}),
      ...(holder && HOLDER_STATES.includes(holder as HolderState)
        ? { holder }
        : {}),
      ...(batch ? { batch } : {}),
      ...(tier ? { tier } : {}),
    };
  }, [filters]);
}

const LIST_STATES = ["active", "expiring", "expired", "disabled"];

/** The facet ids the Worker applied: its `state` is the Status facet. */
export function serverFacetIds(filter: Record<string, string>): string[] {
  return Object.keys(filter).map((k) => (k === "state" ? "status" : k));
}

export function isForbidden(error: unknown): boolean {
  return error instanceof HttpError && error.status === 403;
}

/** Permission refused: the console's no-access page, for the Licensing area. */
export function LicensesForbidden({
  slug,
}: {
  slug: string;
}): React.ReactElement | null {
  const me = useMe().data;
  const name = useProduct(slug).data?.name ?? slug;
  if (!me) return null;
  return <NoAccessPage me={me} area="license" slug={slug} productName={name} />;
}

const noun = (n: number): string => (n === 1 ? "license" : "licenses");

/** Enable or disable the selected licenses: one confirm, one refetch for the whole change. */
export function BulkEnableDialog({
  slug,
  bulk,
  onClose,
}: {
  slug: string;
  bulk: { enable: boolean; rows: LicenseSummary[] } | null;
  onClose: () => void;
}): React.ReactElement {
  const run = async (): Promise<void> => {
    if (!bulk) return;
    const outcomes = await mutateEach(
      "setLicenseEnabled",
      bulk.rows.map(
        (l) => [slug, l.id, bulk.enable] as [string, string, boolean],
      ),
    );
    const failed = bulk.rows
      .filter((_, i) => outcomes[i])
      .map((l) => l.name || l.id);
    const done = bulk.rows.length - failed.length;
    if (failed.length) {
      throw new Error(
        `${done} of ${bulk.rows.length} changed. Failed: ${failed.join(", ")}.`,
      );
    }
    toast.success(
      `${done} ${noun(done)} ${bulk.enable ? "enabled" : "disabled"}`,
    );
  };
  const verb = bulk?.enable ? "Enable" : "Disable";
  const what = bulk ? `${bulk.rows.length} ${noun(bulk.rows.length)}` : "";
  return (
    <ConfirmDialog
      open={bulk !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="caution"
      title={bulk ? `${verb} ${what}?` : ""}
      consequences={
        bulk
          ? bulk.enable
            ? [
                "Devices on these licenses regain access at their next check-in.",
                "Keys and devices are unchanged.",
              ]
            : [
                "Devices on these licenses stop authenticating right away: their cached tokens are purged.",
                "Keys and devices are kept; enabling a license restores access.",
              ]
          : []
      }
      confirmLabel={bulk ? `${verb} ${what}` : ""}
      onConfirm={run}
    />
  );
}

/** New license: off up front, with who to ask, for a member who cannot edit Licensing. */
export function NewLicenseButton({
  slug,
  onClick,
}: {
  slug: string;
  onClick: () => void;
}): React.ReactElement {
  const gate = useWriteGate("license", slug);
  return (
    <Button
      iconStart={<Plus />}
      disabledReason={gate.disabledReason}
      onClick={onClick}
    >
      New license
    </Button>
  );
}

/** Nothing yet: one primary, and the way to the rules that create licenses without a person. */
export function LicensesFirstRun({
  slug,
  onCreate,
}: {
  slug: string;
  onCreate: () => void;
}): React.ReactElement {
  return (
    <EmptyState
      kind="first-run"
      headingLevel={2}
      title="No licenses yet"
      description="Licenses appear when someone signs in under your Access rules, or when you create one."
      primaryAction={<NewLicenseButton slug={slug} onClick={onCreate} />}
      secondaryAction={
        <Button variant="outline" onClick={() => navigate(r.access(slug))}>
          Open Access
        </Button>
      }
    />
  );
}

// ── The list's cells (licenses.list) ────────────────────────────────────────────────────────

/** A two-line cell: a title over its sub line, one fixed height so no row grows (`.cell-stack`). */
export function CellStack({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "flex min-w-0 max-w-56 flex-col items-start gap-0.5 leading-5",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A cell's sub line: one line, truncated with the full text on hover. */
export const SubLine = ({
  children,
}: {
  children: string;
}): React.ReactElement => (
  <span
    className="block max-w-full truncate text-xs leading-4 text-fg-muted"
    title={children}
  >
    {children}
  </span>
);

const dayMonth = (epochSeconds: number): string =>
  formatShort(fromSeconds(epochSeconds));

/** First column: an avatar (tinted initials) over name and email, or a dashed floating key. */
export function LicenseCell({
  license: l,
}: {
  license: LicenseSummary;
}): React.ReactElement {
  const floatingKey = holderOf(l).kind === "floating" && !l.name;
  return (
    <span className="flex min-w-0 max-w-[16rem] items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          floatingKey
            ? "border border-dashed border-border-strong text-fg-muted"
            : "bg-accent-subtle text-accent-fg",
        )}
      >
        {floatingKey ? <KeyRound className="size-3.5" /> : licenseInitials(l)}
      </span>
      <span className="flex min-w-0 flex-col leading-5">
        {floatingKey ? (
          <span
            // The name flies into the record's title on a drill-down (S-23 §6.1 shared-element).
            data-vt-shared="pk-key"
            className="truncate font-mono text-sm"
            title={l.id}
          >
            {l.id}
          </span>
        ) : (
          <>
            <span
              data-vt-shared="pk-key"
              className="w-fit max-w-full truncate"
              title={l.name || undefined}
            >
              {l.name || l.email || "Unnamed license"}
            </span>
            {l.name && l.email ? <SubLine>{l.email}</SubLine> : null}
          </>
        )}
      </span>
    </span>
  );
}

/** Holder: muted text for In an account, one pill for Waiting or Floating, with its sub line. */
export function HolderPill({
  license: l,
}: {
  license: LicenseSummary;
}): React.ReactElement {
  const state = holderState(l);
  if (state === "inAccount")
    return (
      <span className="whitespace-nowrap text-fg-muted">In an account</span>
    );
  if (state === "waiting")
    return (
      <CellStack>
        <StatusPill tone="info" icon={Mail} size="sm">
          Waiting
        </StatusPill>
        {l.invitedAt ? (
          <SubLine>{`Invited ${dayMonth(l.invitedAt)}`}</SubLine>
        ) : l.activatedAt ? (
          <SubLine>{`Added ${dayMonth(l.activatedAt)}`}</SubLine>
        ) : null}
      </CellStack>
    );
  return (
    <CellStack>
      <StatusPill tone="neutral" icon={KeyRound} size="sm">
        Floating
      </StatusPill>
      {l.deviceCount === 0 ? <SubLine>Never used</SubLine> : null}
    </CellStack>
  );
}

/** Tier: a pill with the layers glyph; a license with no tier reads as the Default tier, muted (D12). */
export function TierPill({
  label,
  className,
}: {
  label: string | null;
  className?: string;
}): React.ReactElement {
  if (!label) return <span className="text-fg-muted">Default</span>;
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-[9rem] items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 text-xs text-fg",
        className,
      )}
      title={label}
    >
      <Layers aria-hidden className="size-3 shrink-0 text-accent-fg" />
      {/* Not `.truncate`: a card lets its names wrap, a pill keeps its one line and ellipsis. */}
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {label}
      </span>
    </span>
  );
}

/**
 * Duration, as far as the list's data goes: the term over what follows it. Only the expiry forms
 * exist until LX-41, so a line with no data behind it is not drawn.
 */
export function DurationCell({
  license: l,
  now,
}: {
  license: LicenseSummary;
  now: number;
}): React.ReactElement {
  const state: LicenseState = licenseState(l, now);
  const date =
    l.expiresAt == null ? null : formatDate(fromSeconds(l.expiresAt));
  if (state === "disabled")
    return (
      <CellStack>
        <StatusPill tone="neutral" icon={false} size="sm">
          Disabled
        </StatusPill>
        {date ? <SubLine>{`Ends ${date}`}</SubLine> : null}
      </CellStack>
    );
  if (date === null) return <span className="text-fg-muted">Lifetime</span>;
  if (state === "expired")
    return (
      <CellStack>
        <StatusPill tone="danger" size="sm">
          Expired
        </StatusPill>
        <SubLine>{`Ended ${date}`}</SubLine>
      </CellStack>
    );
  if (state === "expiring")
    return (
      <CellStack>
        <StatusPill tone="warning" icon={Clock} size="sm">
          {expiresInText(daysUntil(l.expiresAt!, now))}
        </StatusPill>
        <SubLine>{`Ends ${date}`}</SubLine>
      </CellStack>
    );
  return <span>Ends {date}</span>;
}

/** Origin: Automatic grant (sparkles), By hand, or Key batch over the batch's label. */
export function OriginCell({
  license: l,
  slug,
  batchLabel,
}: {
  license: LicenseSummary;
  slug: string;
  batchLabel: (id: string) => string;
}): React.ReactElement | null {
  if (l.batchId)
    return (
      <CellStack>
        <span>Key batch</span>
        <Link
          to={r.licenseBatch(slug, l.batchId)}
          title={batchLabel(l.batchId)}
          className="block max-w-full truncate text-xs leading-4 text-fg-muted hover:text-fg hover:underline"
        >
          {batchLabel(l.batchId)}
        </Link>
      </CellStack>
    );
  if (l.origin === "oidc" || l.origin === "enroll")
    return (
      <span className="inline-flex items-center gap-1.5 text-accent-fg">
        <Sparkles aria-hidden className="size-3.5" />
        Automatic grant
      </span>
    );
  if (l.origin === "admin") return <span>By hand</span>;
  return null;
}

/** The origin's words, for the facet and the CSV. */
export function originLabel(l: LicenseSummary): string {
  if (l.batchId) return "Key batch";
  if (l.origin === "oidc" || l.origin === "enroll") return "Automatic grant";
  // The Worker reads a missing origin as "admin" (deletion.ts).
  return "By hand";
}

/** The icons of the counted holder chips. */
export const HOLDER_CHIP_ICONS: Record<HolderState, React.ReactNode> = {
  inAccount: <UserRound aria-hidden />,
  waiting: <Mail aria-hidden />,
  floating: <KeyRound aria-hidden />,
};

/** "Create keys in bulk": the New license drawer on "Anyone with the key" (licenses.bulk-keys). */
export function BulkKeysButton({
  slug,
  onClick,
}: {
  slug: string;
  onClick: () => void;
}): React.ReactElement {
  const gate = useWriteGate("license", slug);
  return (
    <Button
      variant="outline"
      iconStart={<KeySquare />}
      disabledReason={gate.disabledReason}
      onClick={onClick}
    >
      Create keys in bulk
    </Button>
  );
}

/** Loading rows at the real row height: the cells' shapes under the real column heads. */
export const SKELETON = {
  license: (
    <span className="flex items-center gap-3">
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <span className="flex w-40 max-w-full flex-col gap-1.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-full" />
      </span>
    </span>
  ),
  capsule: <Skeleton className="h-5 w-20 rounded-full" />,
  short: <Skeleton className="h-4 w-12" />,
  duration: <Skeleton className="h-4 w-28" />,
  devices: (
    <span className="flex w-24 flex-col gap-1.5">
      <Skeleton className="h-3.5 w-12" />
      <Skeleton className="h-1 w-full rounded-full" />
    </span>
  ),
};

/**
 * A phone's card, three lines: the name with the device count at the end, the email (both the
 * license cell), then the tier and at most one state. "In an account" and "Lifetime" are not
 * drawn; the record has the rest.
 */
export function LicenseCard({
  license: l,
  primary,
  now,
  seats,
  tierLabel,
}: {
  license: LicenseSummary;
  primary: React.ReactNode;
  now: number;
  seats: { limit: number | null };
  tierLabel: string | null;
}): React.ReactElement {
  const holder = holderState(l);
  const state: React.ReactNode =
    holder !== "inAccount" ? (
      <StatusPill
        tone={holder === "waiting" ? "info" : "neutral"}
        icon={holder === "waiting" ? Mail : KeyRound}
        size="sm"
      >
        {holder === "waiting" ? "Waiting" : "Floating"}
      </StatusPill>
    ) : l.expiresAt != null || licenseState(l, now) === "disabled" ? (
      <DurationCell license={l} now={now} />
    ) : null;
  const full = seats.limit !== null && l.deviceCount >= seats.limit;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-[min(11rem,100%)] flex-1 [&_.truncate]:whitespace-normal [&_.truncate]:[overflow-wrap:anywhere]">
          {primary}
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 tabular-nums",
            full ? "text-warning" : "text-fg",
          )}
        >
          <MonitorSmartphone aria-hidden className="size-4" />
          {seats.limit === null
            ? l.deviceCount
            : `${l.deviceCount} of ${seats.limit}`}
          <span className="sr-only"> devices</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 @xs:ps-10">
        <TierPill label={tierLabel} className="max-w-full" />
        {state}
      </div>
    </div>
  );
}
