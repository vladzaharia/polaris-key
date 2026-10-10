import * as React from "react";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { Textarea } from "../../ui/Textarea.js";
import { intentOf } from "../sections/core/pages/confirmGate.js";

/** The Worker's limit (`core/settingsClaims.ts` `BREAK_GLASS_REASON_MAX`). */
export const BREAK_GLASS_REASON_MAX = 500;

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A break-glass claim (ST-20, notes/S-18 §4.5 item 7; L2). On a manifest-authoritative product
 * a console edit to a setting `.pkey/` declares is refused unless it is a break-glass claim: the
 * operator gives a reason (1–500 characters, recorded in the audit log), and the claim expires
 * after 7 days or at the first resync or deploy that changes the field, whichever comes first.
 * `onConfirm` receives the trimmed reason; the caller sends it as `breakGlass: { reason }`.
 */
export function BreakGlassDialog({
  open,
  settings,
  system,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** The settings this save claims, by label. */
  settings: readonly string[];
  /** The system product: its writer is the deploy hook, not a repository push. */
  system: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const trimmed = reason.trim();
  const id = React.useId();
  const apply = system ? "deploy" : "resync";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      intent={intentOf("setting.breakGlass")}
      title="Make a break-glass claim?"
      description={`${system ? "The system product" : "This product"} is manifest-authoritative: .pkey/ is the only writer of ${listOf(settings)}. A break-glass claim overrides it for a short time.`}
      consequences={[
        `The claim ends after 7 days, or at the first ${apply} that changes the value in .pkey/, whichever comes first. The manifest's value then applies.`,
        `A ${apply} that leaves the value alone keeps the claim, and every ${apply} summary lists it.`,
        "Commit the value to .pkey/ to keep it.",
      ]}
      confirmLabel="Make break-glass claim"
      confirmDisabled={
        trimmed.length === 0 || trimmed.length > BREAK_GLASS_REASON_MAX
      }
      onConfirm={() => onConfirm(trimmed)}
    >
      <div className="space-y-1">
        <label htmlFor={id} className="text-sm font-medium text-fg-strong">
          Reason
        </label>
        <Textarea
          id={id}
          value={reason}
          maxLength={BREAK_GLASS_REASON_MAX}
          required
          aria-describedby={`${id}-help`}
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={`${id}-help`} className="text-xs text-fg-muted">
          Recorded in the audit log. Up to {BREAK_GLASS_REASON_MAX} characters.
        </p>
      </div>
    </ConfirmDialog>
  );
}
