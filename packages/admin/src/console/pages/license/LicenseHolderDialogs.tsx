/**
 * The licence record's holder actions (LX-30; notes/S-24 §5.2, §5.5, §8.8, D4, D5, D20; ADMIN.md
 * §6.5.2):
 *
 *   - **Assign…** on a floating licence: a name and an email (the Worker's PATCH, S-24 D3). The
 *     licence then waits for that email, or joins the account that already verified it. The copy
 *     never says which (D4).
 *   - **Reassign…** and **Make floating…** on an assigned licence: I-12's relink tool keyed by the
 *     licence, so each needs a fresh sign-in (step-up), a reason, the typed licence name (else its
 *     id; the Worker compares), notices to the old and the new address before the change, and
 *     offers a 72-hour undo. Make floating can also sign the licence's devices out (off by
 *     default).
 *   - **Undo…** of the newest move while its 72 hours run (L1, a reason and the step-up again).
 *
 * The step-up is checked from `me` before the confirm is enabled, and the server checks it again
 * (403 `step_up_required` turns the dialog's callout back on).
 */

import * as React from "react";
import {
  ApiError,
  type LicenseDetail,
  type LicenseHolderMove,
} from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatDateTime, fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  useDismissGuard,
} from "../../../ui/Dialog.js";
import { Form, FormField, useAdminForm } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { intentOf } from "../core/confirmGate.js";
import { ReasonField, StepUpCallout, useStepUp } from "../core/UserRelink.js";
import { holderConfirmValue, holderOf } from "./holders.js";
import { EMAIL_RE } from "./shared.js";

/** "When ada@example.com signs in with that email, it's in their library." (S-24 D4) */
export function libraryLine(email: string): string {
  const e = email.trim();
  return e && EMAIL_RE.test(e)
    ? `When ${e} signs in with that email, it's in their library.`
    : "When they sign in with that email, it's in their library.";
}

/** The step-up note for the licence record: the operator lands back on it afterwards. */
function RecordStepUp({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  return (
    <StepUpCallout hash={r.license(slug, id)}>
      Changing who holds a license needs a sign-in from the last five minutes.
      You come back to this license afterwards.
    </StepUpCallout>
  );
}

/** Mark the step-up stale on a 403 `step_up_required`, then rethrow for the dialog's message. */
function stepUpAware(markStale: () => void) {
  return (e: unknown): never => {
    if (e instanceof ApiError && e.code === "step_up_required") markStale();
    throw e;
  };
}

// ── Assign… ─────────────────────────────────────────────────────────────────────────────────

interface AssignValues {
  [key: string]: unknown;
  email: string;
  name: string;
}

export function AssignDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Assign license"
      description="Name who this license is for. It keeps its key, devices and terms."
    >
      {open ? (
        <AssignForm
          slug={slug}
          license={license}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function AssignForm({
  slug,
  license,
  onDone,
}: {
  slug: string;
  license: LicenseDetail;
  onDone: () => void;
}): React.ReactElement {
  const form = useAdminForm<AssignValues>({
    values: { email: "", name: license.name ?? "" },
    validate: (v) => {
      const e: Record<string, string> = {};
      if (!v.email.trim()) e.email = "Enter their email.";
      else if (!EMAIL_RE.test(v.email.trim()))
        e.email = "Enter a valid email address.";
      return e;
    },
    onSubmit: async (draft) => {
      const name = draft.name.trim();
      await mutate("patchLicense", slug, license.id, {
        email: draft.email.trim(),
        ...(name && name !== license.name ? { name } : {}),
      });
      toast.success("License assigned");
      onDone();
    },
  });
  useDismissGuard(form.isDirty && !form.isSubmitting);
  const email = String(form.rhf.watch("email") ?? "");
  return (
    <Form form={form} aria-label="Assign" className="contents">
      <DialogBody className="space-y-4">
        <FormField
          name="email"
          label="Email"
          required
          help={libraryLine(email)}
        >
          {(f) => <Input {...f} type="email" autoFocus />}
        </FormField>
        <FormField name="name" label="Name" help="Optional.">
          {(f) => <Input {...f} />}
        </FormField>
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The license wasn't assigned" live>
            {errorCopy(form.submitError, { thing: "License" }).description}
          </Callout>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Assign license
        </Button>
      </DialogFooter>
    </Form>
  );
}

// ── Reassign… ───────────────────────────────────────────────────────────────────────────────

export function ReassignDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const { fresh, markStale } = useStepUp(open);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setReason("");
      setTouched(false);
    }
  }, [open]);
  const holder = holderOf(license);
  const current = holder.kind === "assigned" ? (holder.email ?? "") : "";
  const emailOk = EMAIL_RE.test(email.trim());
  const same =
    emailOk && email.trim().toLowerCase() === current.trim().toLowerCase();
  const reasonOk = reason.trim().length > 0;
  const confirm = holderConfirmValue(license);
  const inAccount = holder.kind === "assigned" && holder.inAccount;
  const emailError = !touched
    ? undefined
    : !email.trim()
      ? "Enter the new email."
      : !emailOk
        ? "Enter a valid email address."
        : same
          ? "That is the email it already has."
          : undefined;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={intentOf("license.reassign")}
      title={`Reassign ${license.name || "this license"}?`}
      description="Give this license to someone else. It keeps its key, devices and terms."
      consequences={[
        inAccount
          ? "It leaves the Polaris Key account it is in. Devices signed in through that account lose the sign-in; devices that entered the key keep working."
          : `It stops waiting for ${current}.`,
        "The current holder and the new address are emailed before it moves.",
        "You can undo it for 72 hours.",
      ]}
      confirmLabel="Reassign license"
      confirmDisabled={!fresh || !emailOk || same || !reasonOk}
      typedConfirmation={
        confirmFor("license.reassign").typedConfirmation
          ? {
              value: confirm.value,
              label: `Type the license ${confirm.what} to confirm:`,
            }
          : undefined
      }
      describeError={(e) => errorCopy(e, { thing: "License" })}
      onConfirm={async () => {
        await mutate("reassignLicenseHolder", slug, license.id, {
          email: email.trim(),
          name: name.trim() || null,
          reason: reason.trim(),
          confirm: confirm.value,
        }).catch(stepUpAware(markStale));
        toast.success("License reassigned", {
          description: `${libraryLine(email)} You can undo it for 72 hours.`,
        });
      }}
    >
      <div className="space-y-4">
        {fresh ? null : <RecordStepUp slug={slug} id={license.id} />}
        <div className="space-y-1">
          <label
            htmlFor="reassign-email"
            className="text-sm font-bold text-fg-strong"
          >
            New email
          </label>
          <Input
            id="reassign-email"
            type="email"
            value={email}
            autoComplete="off"
            aria-invalid={emailError ? true : undefined}
            aria-describedby="reassign-email-help"
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <p
            id="reassign-email-help"
            className={
              emailError ? "text-xs text-danger" : "text-xs text-fg-muted"
            }
          >
            {emailError ?? libraryLine(email)}
          </p>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="reassign-name"
            className="text-sm font-bold text-fg-strong"
          >
            Name <span className="font-normal text-fg-muted">(optional)</span>
          </label>
          <Input
            id="reassign-name"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <ReasonField id="reassign-reason" value={reason} onChange={setReason} />
      </div>
    </ConfirmDialog>
  );
}

// ── Make floating… ──────────────────────────────────────────────────────────────────────────

export function MakeFloatingDialog({
  slug,
  license,
  open,
  onOpenChange,
}: {
  slug: string;
  license: LicenseDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const { fresh, markStale } = useStepUp(open);
  const [reason, setReason] = React.useState("");
  const [signOut, setSignOut] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setReason("");
      setSignOut(false);
    }
  }, [open]);
  const holder = holderOf(license);
  const inAccount = holder.kind === "assigned" && holder.inAccount;
  const email = holder.kind === "assigned" ? (holder.email ?? "") : "";
  const confirm = holderConfirmValue(license);
  const devices = license.deviceCount;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      intent={intentOf("license.makeFloating")}
      title={`Make ${license.name || "this license"} floating?`}
      description="Floating · anyone with the key. It keeps its key, devices and terms."
      consequences={[
        "Its name and email are removed, so anyone with the key can use it.",
        inAccount
          ? "It leaves the Polaris Key account it is in and is not added back to it automatically."
          : `It stops waiting for ${email}.`,
        inAccount
          ? "The account is emailed before it changes."
          : `${email} is emailed before it changes.`,
        signOut
          ? `${devices === 1 ? "Its device is" : `All ${devices} of its devices are`} signed out now.`
          : "Its devices keep working.",
        "You can undo it for 72 hours.",
      ]}
      confirmLabel="Make floating"
      confirmDisabled={!fresh || reason.trim().length === 0}
      typedConfirmation={
        confirmFor("license.makeFloating").typedConfirmation
          ? {
              value: confirm.value,
              label: `Type the license ${confirm.what} to confirm:`,
            }
          : undefined
      }
      describeError={(e) => errorCopy(e, { thing: "License" })}
      onConfirm={async () => {
        const res = await mutate("makeLicenseFloating", slug, license.id, {
          reason: reason.trim(),
          confirm: confirm.value,
          ...(signOut ? { signOutDevices: true } : {}),
        }).catch(stepUpAware(markStale));
        const out = res.devicesSignedOut ?? 0;
        toast.success("License made floating", {
          description: `${out > 0 ? `${out} ${out === 1 ? "device" : "devices"} signed out. ` : ""}You can undo it for 72 hours.`,
        });
      }}
    >
      <div className="space-y-4">
        {fresh ? null : <RecordStepUp slug={slug} id={license.id} />}
        <ReasonField id="floating-reason" value={reason} onChange={setReason} />
        <Checkbox
          checked={signOut}
          onCheckedChange={setSignOut}
          label="Also sign out its devices"
          description="Every device on this license has to enter the key again. The undo does not sign them back in."
        />
      </div>
    </ConfirmDialog>
  );
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────

/** "Ada Lovelace · ada@example.com", or what a side of a move was. */
function sideText(side: LicenseHolderMove["from"]): string | null {
  if (!side) return null;
  const parts = [side.name, side.email].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function UndoHolderMoveDialog({
  slug,
  licenseId,
  move,
  onClose,
}: {
  slug: string;
  licenseId: string;
  move: LicenseHolderMove | null;
  onClose: () => void;
}): React.ReactElement {
  const open = move !== null;
  const { fresh, markStale } = useStepUp(open);
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const back = sideText(move?.from ?? null);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      intent={intentOf("user.undoRelink")}
      title="Undo this change?"
      consequences={[
        move?.kind === "relink" || !back
          ? "The license goes back to where it was before."
          : `The license goes back to ${back}, and to their account if it was in one.`,
        "Both sides are emailed.",
      ]}
      confirmLabel="Undo"
      confirmDisabled={!fresh || reason.trim().length === 0}
      describeError={(e) => errorCopy(e, { thing: "License" })}
      onConfirm={async () => {
        await mutate("undoRelink", slug, move!.id, {
          reason: reason.trim(),
        }).catch(stepUpAware(markStale));
        toast.success("Change undone");
      }}
    >
      <div className="space-y-4">
        {fresh ? null : <RecordStepUp slug={slug} id={licenseId} />}
        <ReasonField
          id="undo-move-reason"
          value={reason}
          onChange={setReason}
        />
      </div>
    </ConfirmDialog>
  );
}

/** The record's note about the newest move while it can be undone. */
export function UndoableMoveCallout({
  move,
  onUndo,
}: {
  move: LicenseHolderMove;
  onUndo: () => void;
}): React.ReactElement {
  const before = sideText(move.from);
  const what =
    move.kind === "floating"
      ? "This license was made floating"
      : move.kind === "reassign"
        ? "This license was reassigned"
        : "This license was moved to another user";
  return (
    <Callout
      tone="info"
      title={`${what}${move.actorName ? ` by ${move.actorName}` : ""}`}
      action={
        <Button variant="outline" size="sm" onClick={onUndo}>
          Undo…
        </Button>
      }
    >
      {before ? `Before, it was ${before}. ` : ""}
      You can undo it until {formatDateTime(fromSeconds(move.undoUntil))}.
      Reason: “{move.reason}”
    </Callout>
  );
}
