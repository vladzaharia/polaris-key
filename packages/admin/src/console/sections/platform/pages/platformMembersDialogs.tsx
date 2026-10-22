/**
 * Platform → Members, the writes that stay dialogs: Remove from console and Revoke invite. Each is
 * a `ConfirmDialog` (L1 caution or L2 danger). Invite and Edit roles are the drawer
 * (`access/InviteDrawer.tsx`, ST-31.12). The Worker enforces every rule; the console only declines
 * to offer what it would refuse, and says why (`cannotTake`).
 */

import * as React from "react";
import {
  ApiError,
  type Me,
  type Member,
  type MemberInvite,
} from "../../../../api.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { roleLabel } from "../../../access/can.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import { mutate } from "../../../data/mutations.js";
import {
  cannotTake,
  describeMembersError,
} from "../../../access/membersModel.js";

// ── Revoke an invite ────────────────────────────────────────────────────────────────────────

export function RevokeInviteDialog({
  invite,
  onClose,
  productName,
}: {
  invite: MemberInvite | null;
  onClose: () => void;
  productName: ProductName;
}): React.ReactElement {
  const label = invite
    ? roleLabel(
        {
          role: invite.role,
          scope: invite.scope,
          areas: invite.areas,
          source: "invite",
        },
        productName,
      ).label
    : "";
  return (
    <ConfirmDialog
      open={invite !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="caution"
      title={`Revoke the invite for ${invite?.email ?? ""}?`}
      consequences={[
        `The link stops working. ${label} is not given.`,
        "You can invite them again.",
      ]}
      confirmLabel="Revoke invite"
      describeError={describeMembersError}
      onConfirm={async () => {
        await mutate("revokeBinding", invite!.bindingId);
        toast.success("Invite revoked");
      }}
    />
  );
}

// ── Remove from console ─────────────────────────────────────────────────────────────────────

export function RemoveMemberDialog({
  memberId,
  members,
  me,
  onClose,
  productName,
}: {
  memberId: string | null;
  members: readonly Member[];
  me: Me | undefined;
  onClose: () => void;
  productName: ProductName;
}): React.ReactElement {
  // Read from the live roster, so a retry after a partial failure sees what is left. The last
  // member seen stays on screen while the roster refetches.
  const live = members.find((m) => m.memberId === memberId) ?? null;
  const last = React.useRef<Member | null>(null);
  if (live) last.current = live;
  const member = memberId === null ? null : (live ?? last.current);
  // Bindings this dialog already deleted (a refetch may not have landed yet).
  const gone = React.useRef(new Set<string>());
  // The partial-failure toast, dismissed once a retry succeeds.
  const partial = React.useRef<string | number | null>(null);
  React.useEffect(() => {
    if (memberId === null) {
      gone.current.clear();
      last.current = null;
    }
  }, [memberId]);
  const roles = (member?.roles ?? []).filter(
    (r) =>
      r.bindingId !== null &&
      !gone.current.has(r.bindingId) &&
      cannotTake(me, r, productName) === undefined,
  );
  return (
    <ConfirmDialog
      open={memberId !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="danger"
      title={`Remove ${member?.name || member?.email || "this person"} from the console?`}
      consequences={[
        roles.length > 0
          ? `They lose ${roles
              .map((r) => roleLabel({ ...r, source: "" }, productName).label)
              .join(", ")}.`
          : "They have no roles left to remove.",
        "They can't open the console until someone gives them a role again.",
        "Every Superadmin is told.",
      ]}
      confirmLabel="Remove from console"
      describeError={describeMembersError}
      onConfirm={async () => {
        const todo = roles.filter((r) => !gone.current.has(r.bindingId!));
        let done = 0;
        try {
          for (const r of todo) {
            try {
              await mutate("revokeBinding", r.bindingId!);
            } catch (e) {
              // Already removed (a retry, or someone else): that is the outcome we want.
              if (!(e instanceof ApiError && e.status === 404)) throw e;
            }
            gone.current.add(r.bindingId!);
            done += 1;
          }
        } catch (e) {
          if (done > 0)
            partial.current = toast.error(
              `Removed ${done} of ${todo.length} roles`,
              { description: "Try again to remove the rest." },
            );
          throw e;
        }
        if (partial.current !== null) toast.dismiss(partial.current);
        partial.current = null;
        toast.success(`Removed ${member!.name || member!.email}`);
      }}
    />
  );
}
