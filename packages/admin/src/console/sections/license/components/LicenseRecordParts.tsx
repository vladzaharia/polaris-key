/**
 * Parts of the license record (split from `pages/LicenseRecord.tsx`): the dialog ids, the Status
 * tab and the focus hand-off after an undo.
 */

import * as React from "react";
import { confirmFor } from "../../../../lib/actions.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import {
  type LicenseBatch,
  type LicenseDetail,
  type TierSummary,
} from "../../../../api.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import { holderOf } from "./holders.js";
import { LimitsTable } from "./LimitsTable.js";
import {
  AnyoneWithKeyCard,
  DevicesCard,
  DurationCard,
  InvitationCard,
  OriginCard,
} from "./LicenseRail.js";
import { useInvitations, type seatLimitOf } from "./shared.js";

/**
 * ADMIN.md §5.6: an undo removes the callout whose button opened it; once it has gone, focus
 * moves to the page's heading rather than dropping to <body>. Set the returned ref's `current`
 * to arm it.
 */
export function useFocusTitleAfterUndo(
  undoableId: string | null,
  undoOpen: boolean,
): React.MutableRefObject<boolean> {
  const focusAfterUndo = React.useRef(false);
  React.useEffect(() => {
    // Wait for both: the note gone (the refetch) and the dialog closed (its focus scope released).
    if (!focusAfterUndo.current || undoableId !== null || undoOpen) return;
    focusAfterUndo.current = false;
    let tries = 0;
    let frame = 0;
    const attempt = (): void => {
      const title = document.querySelector<HTMLElement>("h1[data-page-title]");
      const active = document.activeElement;
      // Only where focus was lost: never steal it from something that took it on purpose.
      if (title && (!active || active === document.body)) {
        if (!title.hasAttribute("tabindex"))
          title.setAttribute("tabindex", "-1");
        title.focus({ preventScroll: true });
      }
      if (document.activeElement !== title && ++tries < 10)
        frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [undoableId, undoOpen]);
  return focusAfterUndo;
}

/** Closing the invite dialog from a button that has unmounted must not drop focus to <body>. */
export function useFocusTitleAfterInvite(dialog: RecordDialog): void {
  const prev = React.useRef<RecordDialog>(null);
  React.useEffect(() => {
    const was = prev.current;
    prev.current = dialog;
    if (was !== "invite" || dialog !== null) return;
    const t = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body) return;
      document.querySelector<HTMLElement>("h1[data-page-title]")?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, [dialog]);
}

export type RecordDialog =
  | "holder"
  | "assign"
  | "reassign"
  | "floating"
  | "bundle"
  | "mint"
  | "deviceLimit"
  | "tier"
  | "expiry"
  | "profiles"
  | "send"
  | "invite"
  | "disable"
  | "enable"
  | "delete"
  | null;

/**
 * The Status tab (licenses.detail): the main column is Limits and the Devices summary, led for a
 * waiting or floating license by its holder card; the rail is Duration and Origin, first below
 * 1280 px (two cards side by side) and sticky beside the main column from there.
 */
export function StatusTab({
  slug,
  license,
  tiers,
  product,
  seats,
  batch,
  me,
  onDialog,
}: {
  slug: string;
  license: LicenseDetail;
  tiers: TierSummary[];
  product: ReturnType<typeof useProduct>["data"];
  seats: ReturnType<typeof seatLimitOf>;
  batch: LicenseBatch | null;
  me: ReturnType<typeof useMe>["data"];
  onDialog: (d: RecordDialog) => void;
}): React.ReactElement {
  const holder = holderOf(license);
  const floating = holder.kind === "floating";
  const waiting = holder.kind === "assigned" && !holder.inAccount;
  const canInvite = useInvitations(slug).invitations;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
        {waiting ? (
          <InvitationCard
            email={license.email?.trim() ?? ""}
            invitedAt={license.invitedAt ?? null}
            canInvite={canInvite}
            onChangeEmail={() => onDialog("reassign")}
          />
        ) : null}
        {floating ? <AnyoneWithKeyCard devices={license.devices} /> : null}
        <LimitsTable
          slug={slug}
          license={license}
          tiers={tiers}
          product={product}
          onDeviceLimit={() => onDialog("deviceLimit")}
        />
        <DevicesCard slug={slug} license={license} seats={seats} />
      </div>
      <div
        className={
          "grid gap-6 sm:grid-cols-2 xl:sticky xl:top-[88px] xl:col-start-2 xl:row-start-1 xl:grid-cols-1" +
          (waiting || floating
            ? " order-last xl:order-none"
            : " order-first xl:order-none")
        }
      >
        <DurationCard license={license} onChange={() => onDialog("expiry")} />
        <OriginCard slug={slug} license={license} batch={batch} me={me} />
      </div>
    </div>
  );
}

/** Disable and Enable: the two confirms of the record's status toggle. */
export function ToggleLicenseDialogs({
  license,
  dialog,
  onClose,
  onToggle,
}: {
  license: LicenseDetail;
  dialog: RecordDialog;
  onClose: () => void;
  onToggle: (enable: boolean) => Promise<void>;
}): React.ReactElement {
  const name = license.name || "this license";
  return (
    <>
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && onClose()}
        intent={confirmFor("license.disable").intent as "caution"}
        title={`Disable ${name}?`}
        consequences={[
          "Its devices stop authenticating right away: their cached tokens are purged.",
          "Keys, devices and terms are kept. Enabling the license restores access.",
        ]}
        confirmLabel="Disable license"
        onConfirm={() => onToggle(false)}
      />
      <ConfirmDialog
        open={dialog === "enable"}
        onOpenChange={(o) => !o && onClose()}
        intent={confirmFor("license.enable").intent as "caution"}
        title={`Enable ${name}?`}
        consequences={["Its devices regain access at their next check-in."]}
        confirmLabel="Enable license"
        onConfirm={() => onToggle(true)}
      />
    </>
  );
}
