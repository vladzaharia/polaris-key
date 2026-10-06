/**
 * The relink tool (I-12; S-16 §5.4 item 9): move one licence of this product to another user of
 * this product, and undo it within 72 hours. Relink is the recovery path Polaris offers instead of
 * a recovery desk, so every control the threat model lists is here or on the server:
 *
 *   - the target is named ONLY by its pairwise subject for this product, never by an email (no
 *     cross-tenant oracle). The person gets one by signing in to the product, or with "Get a
 *     support code" on the product's page in their Polaris Key account;
 *   - a step-up: the operator's last interactive sign-in no older than five minutes. The console
 *     checks it from `me` before the form and the server checks it again (403 `step_up_required`);
 *   - a mandatory reason, up to 500 characters;
 *   - both accounts are emailed before the move, which is audited with before and after;
 *   - a 72-hour undo, with the same step-up and a reason.
 */

import * as React from "react";
import {
  ApiError,
  type Me,
  type ProductUserLicense,
  type ProductUserRelink,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { Callout } from "../../../ui/Callout.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { Input } from "../../../ui/Input.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { useMe } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { r } from "../../routes.js";
import { intentOf } from "./confirmGate.js";

/** `ps_` and 22 base64url characters (plans/I-04.md §2). */
export const SUBJECT_PATTERN = /^ps_[A-Za-z0-9_-]{22}$/;
export const REASON_MAX = 500;
/** A margin under the server's window, so a form opened at 4:59 does not fail on submit. */
const STEP_UP_MARGIN_SECONDS = 30;

/** True when the operator's last interactive sign-in is recent enough for a relink. */
export function isSteppedUp(
  me: Pick<Me, "authAt" | "stepUpMaxAgeSeconds"> | undefined,
  nowSeconds: number,
): boolean {
  const at = me?.authAt;
  if (typeof at !== "number") return false;
  const max = (me?.stepUpMaxAgeSeconds ?? 300) - STEP_UP_MARGIN_SECONDS;
  return nowSeconds - at <= max;
}

/** The step-up sign-in, landing back on `hash` (a console route). */
export function stepUpHref(hash: string): string {
  return `/manage/login?stepUp=1&returnTo=${encodeURIComponent(`/manage/${hash}`)}`;
}

function StepUpCallout({ hash }: { hash: string }): React.ReactElement {
  return (
    <Callout
      tone="warning"
      title="Sign in again to continue"
      action={
        <a
          href={stepUpHref(hash)}
          className="whitespace-nowrap font-bold text-accent-fg underline underline-offset-2"
        >
          Sign in again
        </a>
      }
    >
      Moving a license needs a sign-in from the last five minutes. You come back
      to this user afterwards.
    </Callout>
  );
}

function useStepUp(open: boolean): {
  fresh: boolean;
  markStale: () => void;
} {
  const me = useMe().data;
  const [stale, setStale] = React.useState(false);
  React.useEffect(() => {
    if (open) setStale(false);
  }, [open]);
  const fresh = !stale && isSteppedUp(me, Math.floor(Date.now() / 1000));
  return { fresh, markStale: () => setStale(true) };
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-bold text-fg-strong">
        Reason
      </label>
      <Textarea
        id={id}
        value={value}
        maxLength={REASON_MAX}
        required
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-help`} className="text-xs text-fg-muted">
        Recorded in the audit log. Up to {REASON_MAX} characters.
      </p>
    </div>
  );
}

export function RelinkDialog({
  slug,
  subject,
  license,
  onClose,
}: {
  slug: string;
  subject: string;
  license: ProductUserLicense | null;
  onClose: () => void;
}): React.ReactElement {
  const open = license !== null;
  const { fresh, markStale } = useStepUp(open);
  const [target, setTarget] = React.useState("");
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setTarget("");
      setReason("");
    }
  }, [open]);
  const targetOk = SUBJECT_PATTERN.test(target.trim());
  const reasonOk = reason.trim().length > 0;
  const hash = r.user(slug, subject, "licenses");

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      intent={intentOf("user.relink")}
      title={`Relink ${license?.name || license?.id || "license"}?`}
      description="Move this license to another user of this product."
      consequences={[
        "The license moves to the other user's Polaris Key account.",
        "Both accounts are emailed before it moves.",
        "You can undo it for 72 hours.",
      ]}
      confirmLabel="Relink license"
      confirmDisabled={!fresh || !targetOk || !reasonOk}
      describeError={(e) => errorCopy(e, { thing: "License" })}
      onConfirm={async () => {
        try {
          const res = await mutate(
            "relinkProductUserLicense",
            slug,
            subject,
            license!.id,
            { target: target.trim(), reason: reason.trim() },
          );
          toast.success("License relinked", {
            description: `It now belongs to ${res.subject}. Undo is open for 72 hours.`,
          });
        } catch (e) {
          if (e instanceof ApiError && e.code === "step_up_required")
            markStale();
          throw e;
        }
      }}
    >
      <div className="space-y-4">
        {fresh ? null : <StepUpCallout hash={hash} />}
        <div className="space-y-1">
          <label
            htmlFor="relink-target"
            className="text-sm font-bold text-fg-strong"
          >
            Move to user
          </label>
          <Input
            id="relink-target"
            mono
            value={target}
            placeholder="ps_…"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="relink-target-help"
            aria-invalid={target.trim() !== "" && !targetOk}
            onChange={(e) => setTarget(e.target.value)}
          />
          <p id="relink-target-help" className="text-xs text-fg-muted">
            Their user id for this product. They get it by signing in to the
            product, or with Get a support code on the product's page in their
            Polaris Key account.
          </p>
        </div>
        <ReasonField id="relink-reason" value={reason} onChange={setReason} />
      </div>
    </ConfirmDialog>
  );
}

export function UndoRelinkDialog({
  slug,
  subject,
  relink,
  onClose,
}: {
  slug: string;
  subject: string;
  relink: ProductUserRelink | null;
  onClose: () => void;
}): React.ReactElement {
  const open = relink !== null;
  const { fresh, markStale } = useStepUp(open);
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const hash = r.user(slug, subject, "licenses");

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      intent={intentOf("user.undoRelink")}
      title="Undo this relink?"
      consequences={[
        "The license goes back to the account it was moved from.",
        "Both accounts are emailed.",
      ]}
      confirmLabel="Undo relink"
      confirmDisabled={!fresh || reason.trim().length === 0}
      describeError={(e) => errorCopy(e, { thing: "Relink" })}
      onConfirm={async () => {
        try {
          await mutate("undoRelink", slug, relink!.id, {
            reason: reason.trim(),
          });
          toast.success("Relink undone");
        } catch (e) {
          if (e instanceof ApiError && e.code === "step_up_required")
            markStale();
          throw e;
        }
      }}
    >
      <div className="space-y-4">
        {fresh ? null : <StepUpCallout hash={hash} />}
        <ReasonField id="undo-reason" value={reason} onChange={setReason} />
      </div>
    </ConfirmDialog>
  );
}
