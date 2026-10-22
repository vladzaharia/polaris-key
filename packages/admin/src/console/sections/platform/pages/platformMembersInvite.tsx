/**
 * Invite people (ST-31.11): addresses and one role, one `ConfirmDialog` (L1, or L2 with a typed
 * word for a Superadmin, Platform admin or All products admin). The result is a toast with Undo, or
 * with email off the list of sign-in links. The full drawer is ST-31.12's.
 */

import * as React from "react";
import type { AreaId, InviteResult, Me, Member } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import {
  draftLabel,
  draftReady,
  RoleForm,
  WORD,
  type ProductName,
} from "./platformMembersRoleForm.js";
import {
  areaWords,
  describeMembersError,
  EMPTY_DRAFT,
  grantOf,
  isL2,
  type RoleChoice,
  type RoleDraft,
} from "./platformMembersModel.js";

// ── Invite people ───────────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const MAX_INVITES = 20;

export function parseEmails(text: string): {
  valid: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL.test(e) ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

const people = (n: number): string => `${n} ${n === 1 ? "person" : "people"}`;

export function InviteDialog({
  open,
  onOpenChange,
  me,
  members,
  products,
  productName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: Me | undefined;
  members: readonly Member[];
  products: readonly { slug: string; name: string }[];
  productName: ProductName;
}): React.ReactElement {
  const [text, setText] = React.useState("");
  const [draft, setDraft] = React.useState<RoleDraft>(EMPTY_DRAFT);
  const [links, setLinks] = React.useState<InviteResult | null>(null);
  const emailsId = React.useId();
  const hintId = React.useId();

  const { valid, invalid } = React.useMemo(() => parseEmails(text), [text]);
  const known = new Set(members.map((m) => m.email.toLowerCase()));
  const updating = valid.filter((e) => known.has(e.toLowerCase())).length;
  const inviting = valid.length - updating;
  const tooMany = valid.length > MAX_INVITES;
  const grant = grantOf(draft);
  const ready =
    valid.length > 0 &&
    invalid.length === 0 &&
    !tooMany &&
    draftReady(draft, me);
  const l2 = isL2(draft.choice);
  const confirmLabel =
    updating === 0
      ? `Invite ${people(valid.length || 0)}`
      : inviting === 0
        ? `Add the role to ${people(updating)}`
        : `Invite ${people(inviting)} and update ${updating}`;
  const problem = tooMany
    ? `Invite up to ${MAX_INVITES} people at a time.`
    : invalid.length > 0
      ? `Not an email address: ${invalid.join(", ")}`
      : undefined;

  const reset = (): void => {
    setText("");
    setDraft(EMPTY_DRAFT);
  };

  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          onOpenChange(o);
          if (!o) reset();
        }}
        intent={l2 ? "danger" : "caution"}
        title="Invite people"
        description="They get an email with a link to sign in. The invite lasts 7 days."
        lead={
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor={emailsId}
                className="block text-sm font-medium text-fg-strong"
              >
                Email addresses
              </label>
              <Textarea
                id={emailsId}
                value={text}
                onValueChange={setText}
                placeholder="ana@example.com, ben@example.com"
                aria-invalid={problem ? true : undefined}
                aria-describedby={hintId}
                autoComplete="off"
                spellCheck={false}
              />
              <p
                id={hintId}
                role={problem ? "alert" : undefined}
                className={
                  problem ? "text-sm text-danger" : "text-sm text-fg-muted"
                }
              >
                {problem ??
                  "Separate addresses with commas, spaces or new lines."}
              </p>
            </div>
            <RoleForm
              draft={draft}
              onChange={setDraft}
              me={me}
              products={products}
            />
          </div>
        }
        consequences={
          ready
            ? [
                `${people(valid.length)} will have ${draftLabel(draft, productName)}${
                  grant?.areas ? ` for ${areaWords(grant.areas)}` : ""
                }.`,
                "Every Superadmin is told.",
              ]
            : undefined
        }
        confirmLabel={confirmLabel}
        confirmDisabled={!ready}
        typedConfirmation={
          l2
            ? {
                value: WORD[draft.choice],
                label: "Type the role to confirm",
                ignoreCase: true,
              }
            : undefined
        }
        describeError={describeMembersError}
        signedInAt={me?.authAt ?? null}
        stepUpKey="members:invite"
        stepUpState={{
          text,
          choice: draft.choice,
          product: draft.product,
          areaMode: draft.areaMode,
          areas: draft.areas.join(","),
        }}
        onRestore={(s) => {
          setText(s.text ?? "");
          setDraft({
            choice: (s.choice as RoleChoice) || "console_access",
            product: s.product ?? "",
            areaMode: s.areaMode === "some" ? "some" : "all",
            areas: (s.areas ?? "").split(",").filter(Boolean) as AreaId[],
          });
        }}
        onConfirm={async () => {
          const body = { ...grant!, emails: valid };
          const result = await mutate("inviteMembers", body);
          const done = result.results.filter(
            (r) => r.status === "invited" || r.status === "updated",
          );
          const ids = done.flatMap((r) => (r.bindingId ? [r.bindingId] : []));
          const skipped = result.counts.exists;
          const unsent = result.emailOff
            ? []
            : result.results.filter((r) => r.link);
          toast.success(
            done.length === 0
              ? "Nobody new to invite"
              : `Invited ${people(done.length)}`,
            {
              description:
                [
                  skipped > 0 ? `${skipped} already had this role.` : "",
                  unsent.length > 0
                    ? `${unsent.length === 1 ? "1 email" : `${unsent.length} emails`} didn't go out.`
                    : "",
                  !result.emailOff && result.notified.nobodyNotified
                    ? "Nobody was notified."
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined,
              ...(ids.length > 0
                ? {
                    action: {
                      label: "Undo",
                      onClick: () => {
                        void (async () => {
                          try {
                            for (const id of ids)
                              await mutate("revokeBinding", id);
                            toast.success("Invitations withdrawn");
                          } catch (e) {
                            toast.error("Couldn't withdraw every invitation", {
                              context: { thing: "the invitations" },
                            });
                            void e;
                          }
                        })();
                      },
                    },
                  }
                : {}),
            },
          );
          if (result.results.some((r) => r.link)) setLinks(result);
        }}
      />
      <InviteLinksDialog result={links} onClose={() => setLinks(null)} />
    </>
  );
}

/**
 * The Worker returns a sign-in link for an address it did not email: every address with email
 * off, or the ones whose send failed.
 */
function InviteLinksDialog({
  result,
  onClose,
}: {
  result: InviteResult | null;
  onClose: () => void;
}): React.ReactElement {
  const rows = (result?.results ?? []).filter((r) => r.link);
  const off = result?.emailOff ?? false;
  const unsent = rows.length;
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={
        off
          ? "Send these links"
          : `${unsent === 1 ? "1 email" : `${unsent} emails`} didn't go out. Send ${unsent === 1 ? "this link" : "these links"}`
      }
      description={
        off
          ? "Email is off, so nobody was emailed. Each link opens the console sign-in for that address."
          : `No email reached ${rows.map((r) => r.email).join(", ")}. Each link opens the console sign-in for that address.`
      }
    >
      <DialogBody className="space-y-3 text-sm">
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.email} className="space-y-1">
              <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                {r.email}
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xs bg-surface-sunken px-2 py-1 font-mono text-xs">
                  {r.link}
                </code>
                <CopyButton
                  value={r.link!}
                  label={`Copy link for ${r.email}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
