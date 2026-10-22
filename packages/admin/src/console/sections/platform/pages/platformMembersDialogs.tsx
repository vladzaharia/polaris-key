/**
 * Platform → Members, the writes (ST-31.11): Invite people, Edit roles (add a role, change a
 * product admin's areas, remove a role), Remove from console and Revoke invite. Each is a
 * `ConfirmDialog`, so the level (L1 caution, L2 danger with a typed word) and the step-up state
 * (403 `step_up_required`: one "Sign in again" callout, the typed word and the fields kept across
 * the sign-in) are the console's own. The Worker enforces every rule; the console only declines to
 * offer what it would refuse, and says why (`cannotGive`, `cannotTake`).
 *
 * The full invite drawer (area picker with the product's enabled features, live preview sentence)
 * is ST-31.12's; this is the dialog that already does the job.
 */

import * as React from "react";
import {
  ApiError,
  type AreaId,
  type Me,
  type Member,
  type MemberInvite,
  type MemberRole,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";

import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";

import { toast } from "../../../../ui/toast.js";
import { AREA_NAMES, roleLabel } from "../../../access/can.js";
import { RoleSet } from "../../../access/RoleTag.js";
import { mutate } from "../../../data/mutations.js";
import {
  cannotGive,
  cannotTake,
  describeMembersError,
  EMPTY_DRAFT,
  grantOf,
  isL2,
  PRODUCT_AREAS,
  type RoleDraft,
} from "./platformMembersModel.js";
import {
  draftLabel,
  draftReady,
  RoleForm,
  WORD,
  type ProductName,
} from "./platformMembersRoleForm.js";

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
            toast.error(`Removed ${done} of ${todo.length} roles`, {
              description: "Try again to remove the rest.",
            });
          throw e;
        }
        toast.success(`Removed ${member!.name || member!.email}`);
      }}
    />
  );
}

// ── Edit roles ──────────────────────────────────────────────────────────────────────────────

function sourceText(r: MemberRole): string {
  if (r.source === "root") return "Root rule";
  if (r.source === "creator") return "Created the product";
  const by = r.grantedBy?.name;
  return `${r.source === "invite" ? "Invited" : "Added"}${by ? ` by ${by}` : ""}`;
}

export function EditRolesDialog({
  member,
  me,
  products,
  productName,
  onClose,
}: {
  member: Member | null;
  me: Me | undefined;
  products: readonly { slug: string; name: string }[];
  productName: ProductName;
  onClose: () => void;
}): React.ReactElement {
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<MemberRole | null>(null);
  const [areasOf, setAreasOf] = React.useState<MemberRole | null>(null);
  const [draft, setDraft] = React.useState<RoleDraft>(EMPTY_DRAFT);
  const name = member?.name || member?.email || "";
  const addGrant = grantOf(draft);
  const addL2 = isL2(draft.choice);

  return (
    <>
      <Dialog
        open={member !== null && !adding && !removing && !areasOf}
        onOpenChange={(o) => !o && onClose()}
        size="md"
        title={`Edit roles for ${name}`}
        description="Roles add up. Console access comes with every other role."
      >
        <DialogBody className="space-y-4 text-sm">
          <ul className="divide-y divide-border">
            {(member?.roles ?? []).map((r, i) => {
              const why = cannotTake(me, r, productName);
              const narrowable =
                r.role === "product_admin" &&
                r.scope.startsWith("product:") &&
                r.bindingId !== null;
              return (
                <li
                  key={r.bindingId ?? `root-${i}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                >
                  <div className="min-w-0 space-y-1">
                    <RoleSet role={r} productName={productName} />
                    <p className="text-xs text-fg-muted">{sourceText(r)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {narrowable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={why !== undefined}
                        disabledReason={why}
                        onClick={() => setAreasOf(r)}
                        aria-label={`Edit areas of ${roleLabel({ ...r, source: "" }, productName).label}`}
                      >
                        Edit areas
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={why !== undefined}
                      disabledReason={why}
                      onClick={() => setRemoving(r)}
                      aria-label={`Remove ${roleLabel({ ...r, source: "" }, productName).label}`}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setAdding(true);
            }}
          >
            Add a role
          </Button>
        </DialogFooter>
      </Dialog>

      <ConfirmDialog
        open={adding}
        onOpenChange={(o) => !o && setAdding(false)}
        intent={addL2 ? "danger" : "caution"}
        title={`Add a role for ${name}`}
        lead={
          <RoleForm
            draft={draft}
            onChange={setDraft}
            me={me}
            products={products}
          />
        }
        confirmLabel="Add role"
        confirmDisabled={!draftReady(draft, me)}
        typedConfirmation={
          addL2
            ? {
                value: WORD[draft.choice],
                label: "Type the role to confirm",
                ignoreCase: true,
              }
            : undefined
        }
        describeError={describeMembersError}
        signedInAt={me?.authAt ?? null}
        stepUpKey={`members:add:${member?.memberId ?? ""}`}
        onConfirm={async () => {
          await mutate("grantRole", { ...addGrant!, member: member!.memberId });
          toast.success(`Gave ${name} ${draftLabel(draft, productName)}`);
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        intent="caution"
        title={`Remove ${removing ? roleLabel({ ...removing, source: "" }, productName).label : "role"} from ${name}?`}
        consequences={[
          "The role stops applying within 30 seconds.",
          "Every Superadmin is told.",
        ]}
        confirmLabel="Remove role"
        describeError={describeMembersError}
        onConfirm={async () => {
          await mutate("revokeBinding", removing!.bindingId!);
          toast.success("Role removed");
        }}
      />

      <AreasDialog
        role={areasOf}
        name={name}
        me={me}
        productName={productName}
        onClose={() => setAreasOf(null)}
      />
    </>
  );
}

function AreasDialog({
  role,
  name,
  me,
  productName,
  onClose,
}: {
  role: MemberRole | null;
  name: string;
  me: Me | undefined;
  productName: ProductName;
  onClose: () => void;
}): React.ReactElement {
  const [areas, setAreas] = React.useState<AreaId[]>([]);
  React.useEffect(() => {
    if (role) setAreas(role.areas ?? [...PRODUCT_AREAS]);
  }, [role]);
  const all = areas.length === PRODUCT_AREAS.length;
  const slug = role?.scope.startsWith("product:")
    ? role.scope.slice("product:".length)
    : "";
  const why = role
    ? cannotGive(me, "product_admin", slug, all ? null : areas)
    : undefined;
  return (
    <ConfirmDialog
      open={role !== null}
      onOpenChange={(o) => !o && onClose()}
      intent="caution"
      title={`Areas of ${role ? roleLabel({ ...role, source: "" }, productName).label : ""} for ${name}`}
      description="Taking areas away is immediate. Giving more areas needs a recent sign-in."
      lead={
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Areas</legend>
          {PRODUCT_AREAS.map((a) => (
            <Checkbox
              key={a}
              label={AREA_NAMES[a]}
              checked={areas.includes(a)}
              onCheckedChange={(on) =>
                setAreas(on ? [...areas, a] : areas.filter((x) => x !== a))
              }
            />
          ))}
        </fieldset>
      }
      confirmLabel="Save areas"
      confirmDisabled={areas.length === 0 || why !== undefined}
      describeError={describeMembersError}
      signedInAt={me?.authAt ?? null}
      stepUpKey={`members:areas:${role?.bindingId ?? ""}`}
      stepUpState={{ areas: areas.join(",") }}
      onRestore={(s) =>
        setAreas((s.areas ?? "").split(",").filter(Boolean) as AreaId[])
      }
      onConfirm={async () => {
        await mutate("editBindingAreas", role!.bindingId!, {
          areas: all ? null : PRODUCT_AREAS.filter((a) => areas.includes(a)),
        });
        toast.success("Areas saved");
      }}
    />
  );
}
