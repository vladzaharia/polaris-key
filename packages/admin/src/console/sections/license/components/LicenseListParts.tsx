/** The Licenses page's smaller parts: the server-side filter, the bulk confirm and the 403 state. */

import * as React from "react";
import { Plus } from "lucide-react";
import { r } from "../../../routes.js";
import { navigate } from "../../../router.js";
import { Button } from "../../../../ui/Button.js";
import { ApiError, type LicenseSummary } from "../../../../api.js";
import { mutateEach } from "../../../data/mutations.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { toast } from "../../../../ui/toast.js";
import { HOLDER_STATES, type HolderState } from "./holders.js";

/** The facet value for "no tier" and "not in a batch": only the client can filter on them. */
export const NO_TIER = "__none__";
export const NO_BATCH = "__none__";

/**
 * What the Worker can narrow before it pages: one holder state, one batch, one tier, as the URL
 * (a deep link) or a single chip says. Everything else filters the loaded rows.
 */
export function useServerFilter(filters: Record<string, string[]>): {
  holder?: string;
  batch?: string;
  tier?: string;
} {
  return React.useMemo(() => {
    const one = (id: string, not?: string): string | undefined => {
      const v = filters[id] ?? [];
      return v.length === 1 && v[0] !== not ? v[0] : undefined;
    };
    const holder = one("holder");
    const batch = one("batch", NO_BATCH);
    const tier = one("tier", NO_TIER);
    return {
      ...(holder && HOLDER_STATES.includes(holder as HolderState)
        ? { holder }
        : {}),
      ...(batch ? { batch } : {}),
      ...(tier ? { tier } : {}),
    };
  }, [filters]);
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** Permission refused: the list, its toolbar and its write actions stay away. */
export function LicensesForbidden({
  name,
}: {
  name: string;
}): React.ReactElement {
  return (
    <div className="space-y-6" data-template="collection">
      <PageHeader title="Licenses" />
      <EmptyState
        kind="not-found"
        headingLevel={2}
        title={`You don't have access to licenses on ${name}`}
        description="Ask a platform admin for access."
      />
    </div>
  );
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
      primaryAction={
        <Button iconStart={<Plus />} onClick={onCreate}>
          Create license
        </Button>
      }
      secondaryAction={
        <Button variant="outline" onClick={() => navigate(r.access(slug))}>
          Open Access
        </Button>
      }
    />
  );
}
