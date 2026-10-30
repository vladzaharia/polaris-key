/**
 * Platform → Members, the writes that stay dialogs: Remove from console and Revoke invite. Each is
 * a `ConfirmDialog` (L1 caution or L2 danger). Invite and Edit roles are the drawer
 * (`access/InviteDrawer.tsx`, ST-31.12). The Worker enforces every rule; the console only declines
 * to offer what it would refuse, and says why (`cannotTake`).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HttpError,
  type Me,
  type Member,
  type MemberInvite,
} from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { roleLabel } from "../../../access/can.js";
import type { ProductName } from "../../../access/InviteDrawerParts.js";
import { mutate } from "../../../data/mutations.js";
import { platformReads } from "../data.js";
import {
  cannotTake,
  describeMembersError,
  isSuperadmin,
} from "../../../access/membersModel.js";

// ── Sign out everywhere ─────────────────────────────────────────────────────────────────────

/**
 * Why the signed-in member cannot sign this one out, else `undefined`: the Worker's own rules
 * (`memberSignOut.ts`), read off the roster the page already has. A root holder needs a
 * Superadmin; every stored grant must be one the caller may revoke.
 */
export function cannotSignOut(
  me: Me | undefined,
  member: Member,
  productName: ProductName,
): string | undefined {
  if (member.roles.some((r) => r.bindingId === null) && !isSuperadmin(me))
    return "Only a Superadmin can sign out someone in the root rule.";
  for (const r of member.roles) {
    if (r.bindingId === null) continue;
    const why = cannotTake(me, r, productName, "sign out");
    if (why) return why;
  }
  return undefined;
}

const SIGN_OUT_REASONS: Record<string, { title: string; description: string }> =
  {
    grant_refused: {
      title: "You can't sign this member out",
      description: "Ask a Superadmin.",
    },
    self_sign_out: {
      title: "That's you",
      description: "Use Sign out to end your own sessions.",
    },
    no_such_member: {
      title: "They're no longer a member",
      description: "Reload the list.",
    },
  };

const describeSignOutError = (e: unknown) =>
  (e instanceof HttpError && e.reason && SIGN_OUT_REASONS[e.reason]) ||
  describeMembersError(e);

export function SignOutMemberDialog({
  member,
  onClose,
}: {
  member: Member | null;
  onClose: () => void;
}): React.ReactElement {
  // Keep the last member on screen while the dialog closes.
  const last = React.useRef<Member | null>(null);
  if (member) last.current = member;
  const who = member ?? last.current;
  const id = member?.memberId ?? null;
  const preview = useQuery({
    ...platformReads.memberSignOutPreview(id ?? ""),
    enabled: id !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const tokens = preview.data?.tokens ?? [];
  return (
    <ConfirmDialog
      open={member !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="danger"
      title={`Sign ${who?.name || who?.email || "this person"} out everywhere?`}
      lead={
        preview.isPending ? (
          <p className="text-sm text-fg-muted">Loading their admin tokens…</p>
        ) : preview.data ? (
          tokens.length > 0 ? (
            <div className="text-sm">
              <p className="font-medium text-fg-strong">
                Admin tokens that stop now
              </p>
              <ul className="mt-1 flex flex-col gap-1" data-testid="so-tokens">
                {tokens.map((t, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap justify-between gap-x-3 text-fg-muted"
                  >
                    <span className="min-w-0 break-words text-fg">
                      {t.label}
                    </span>
                    <span>
                      {t.lastUsedAt ? (
                        <>
                          Used <Timestamp at={fromSeconds(t.lastUsedAt)} />
                        </>
                      ) : (
                        "Never used"
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-fg-muted">They have no admin tokens.</p>
          )
        ) : null
      }
      consequences={[
        "Their console sessions end within 30 seconds.",
        "Package tokens keep working.",
        "They get an email.",
      ]}
      confirmLabel="Sign out everywhere"
      confirmDisabled={!preview.data}
      confirmDisabledReason={
        preview.isError ? "Couldn't load their tokens." : "Loading their tokens"
      }
      error={preview.isError ? preview.error : null}
      describeError={describeSignOutError}
      onConfirm={async () => {
        const r = await mutate("signOutMember", id!);
        toast.success(`Signed out ${who?.name || who?.email}`, {
          description: [
            `${r.sessions} ${r.sessions === 1 ? "session" : "sessions"}, ${r.tokens} ${r.tokens === 1 ? "token" : "tokens"} ended.`,
            r.notified ? "" : "They couldn't be emailed.",
          ]
            .filter(Boolean)
            .join(" "),
        });
      }}
    />
  );
}

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
              if (!(e instanceof HttpError && e.status === 404)) throw e;
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
