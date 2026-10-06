import * as React from "react";
import { Download, TriangleAlert } from "lucide-react";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import { Dialog, DialogBody, DialogFooter, type DialogSize } from "./Dialog.js";

/**
 * One-time material: license keys, CI tokens, outlet-generated secrets, minted bundles
 * (components.md §4.4). The value is shown once; the panel will not let it be lost by accident:
 *
 * - The panel owns the one "Shown once." line (EXPERIENCE.md §2, FLOWS.md C-7, C-9, C-17): callers
 *   do not repeat it in their titles or descriptions.
 * - Done stays disabled (with its reason) until Copy or Download succeeded or "I've stored it" is
 *   ticked.
 * - Through `OneTimeSecretDialog`, Escape, the close button and an outside click ask "Close without
 *   copying? It can't be shown again." instead of closing (fixes LIC-2).
 * - `download` offers the value as a file (an object URL, falling back to a data URL); a failure
 *   says so visibly rather than doing nothing (fixes LDT-13).
 */
export interface OneTimeSecretPanelProps {
  /** What the value is: "License key", "CI token". */
  label: string;
  value: string;
  /** Default: "Shown once. Polaris Key stores only its hash." */
  hint?: React.ReactNode;
  onDone: () => void;
  download?: { filename: string; mime?: string };
  /** Controlled acknowledgement (copied or ticked), for a parent that guards its own closing. */
  acknowledged?: boolean;
  onAcknowledgedChange?: (acknowledged: boolean) => void;
  /** Shown above the actions when the parent asked to close before acknowledgement. */
  closeRequested?: boolean;
  onCancelClose?: () => void;
  onConfirmClose?: () => void;
  /** More ways out beside Done ("Open license", "Create another"); gate them on `acknowledged`. */
  actions?: React.ReactNode;
  /** Content shown under the value while it is on screen (a registry token's setup snippets). */
  details?: React.ReactNode;
}

/** Save `value` as a file. Resolves false when the browser refused every method. */
export function saveAsFile(
  value: string,
  filename: string,
  mime = "application/octet-stream",
): boolean {
  let href: string | null = null;
  let revoke = false;
  try {
    if (typeof URL.createObjectURL === "function") {
      href = URL.createObjectURL(new Blob([value], { type: mime }));
      revoke = true;
    }
  } catch {
    href = null;
  }
  if (!href) href = `data:${mime};charset=utf-8,${encodeURIComponent(value)}`;
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href!), 0);
    return true;
  } catch {
    return false;
  }
}

export function OneTimeSecretPanel({
  label,
  value,
  hint = "Shown once. Polaris Key stores only its hash.",
  onDone,
  download,
  acknowledged: ackProp,
  onAcknowledgedChange,
  closeRequested = false,
  onCancelClose,
  onConfirmClose,
  actions,
  details,
}: OneTimeSecretPanelProps): React.ReactElement {
  const [ackState, setAckState] = React.useState(false);
  const acknowledged = ackProp ?? ackState;
  const setAck = (v: boolean): void => {
    setAckState(v);
    onAcknowledgedChange?.(v);
  };
  const [downloadFailed, setDownloadFailed] = React.useState(false);
  const valueId = React.useId();
  const ackId = React.useId();

  return (
    <>
      <DialogBody className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <p id={valueId} className="font-bold text-fg-strong">
            {label}
          </p>
          <div className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken p-3">
            <code
              aria-describedby={valueId}
              className="min-w-0 flex-1 select-all break-all font-mono text-sm text-fg-strong"
            >
              {value}
            </code>
            <CopyButton
              value={value}
              label={`Copy ${label.toLowerCase()}`}
              onCopy={(ok) => {
                if (ok) setAck(true);
              }}
            />
          </div>
          <p className="text-xs text-fg-muted">{hint}</p>
        </div>
        <label
          htmlFor={ackId}
          className="flex items-center gap-2 text-sm text-fg"
        >
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAck(e.target.checked)}
            className="size-4 accent-(--pk-accent)"
          />
          I&apos;ve stored it
        </label>
        {details}
        {download ? (
          <div className="space-y-1">
            <Button
              variant="outline"
              size="sm"
              iconStart={<Download />}
              onClick={() => {
                const saved = saveAsFile(
                  value,
                  download.filename,
                  download.mime,
                );
                setDownloadFailed(!saved);
                // A saved file is as good as a copy.
                if (saved) setAck(true);
              }}
            >
              Download {download.filename}
            </Button>
            {downloadFailed ? (
              <p role="alert" className="text-xs text-danger">
                The download didn&apos;t start. Copy the value instead.
              </p>
            ) : null}
          </div>
        ) : null}
        {closeRequested ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-warning-border bg-warning-subtle p-3"
          >
            <p className="flex items-center gap-2 font-bold text-fg-strong">
              <TriangleAlert aria-hidden className="size-4 text-warning" />
              Close without copying? It can&apos;t be shown again.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                autoFocus
                onClick={onCancelClose}
              >
                Keep it open
              </Button>
              <Button size="sm" variant="danger" onClick={onConfirmClose}>
                Close without copying
              </Button>
            </div>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {actions}
        <Button
          disabledReason={
            acknowledged ? undefined : "Copy it or tick “I've stored it” first"
          }
          onClick={onDone}
        >
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

export interface OneTimeSecretDialogProps extends Omit<
  OneTimeSecretPanelProps,
  | "acknowledged"
  | "onAcknowledgedChange"
  | "closeRequested"
  | "onCancelClose"
  | "onConfirmClose"
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: DialogSize;
}

/**
 * The panel in a dialog that guards its own closing until the value is copied or acknowledged.
 * Done calls `onDone` and then closes.
 */
export function OneTimeSecretDialog({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  onDone,
  ...panel
}: OneTimeSecretDialogProps): React.ReactElement {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  // First focus on the title: the result is the news, not the acknowledgement box.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setAsking(false);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      size={size}
      title={title}
      description={description}
      titleRef={titleRef}
      initialFocusRef={titleRef}
      onOpenChange={(next) => {
        if (next) return onOpenChange(true);
        if (acknowledged) return onOpenChange(false);
        setAsking(true);
      }}
    >
      <OneTimeSecretPanel
        {...panel}
        acknowledged={acknowledged}
        onAcknowledgedChange={(v) => {
          setAcknowledged(v);
          if (v) setAsking(false);
        }}
        closeRequested={asking}
        onCancelClose={() => setAsking(false)}
        onConfirmClose={() => {
          setAsking(false);
          onOpenChange(false);
        }}
        onDone={() => {
          onDone();
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
