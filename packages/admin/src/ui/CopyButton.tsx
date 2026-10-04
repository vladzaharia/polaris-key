import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button, type ButtonSize } from "./Button.js";
import { IconButton } from "./IconButton.js";
import { announce } from "./LiveRegion.js";

export type CopyState = "idle" | "copied" | "failed";

/** The platform's copy chord, for the fallback hint ("⌘C" on Apple platforms, else "Ctrl+C"). */
export function copyChord(): string {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const platform = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘C" : "Ctrl+C";
}

/**
 * Copy to the clipboard (components.md §2.4). Success announces "Copied" through the shared live
 * region; a failure (no clipboard API, no permission) announces "Press ⌘C to copy" so the caller
 * can select the text instead of failing silently (fixes RBD-2). `state` returns to `idle` after
 * two seconds.
 */
export function useCopy(): {
  copy: (value: string) => Promise<boolean>;
  state: CopyState;
  reset: () => void;
} {
  const [state, setState] = React.useState<CopyState>("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = React.useCallback(async (value: string): Promise<boolean> => {
    clearTimeout(timer.current);
    try {
      const clipboard =
        typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("clipboard unavailable");
      await clipboard.writeText(value);
      setState("copied");
      announce("Copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
      return true;
    } catch {
      setState("failed");
      announce(`Press ${copyChord()} to copy`);
      return false;
    }
  }, []);
  const reset = React.useCallback(() => setState("idle"), []);
  return { copy, state, reset };
}

export interface CopyButtonProps {
  value: string;
  /** The accessible name and tooltip: "Copy public key". */
  label: string;
  size?: ButtonSize;
  /** Render a labelled outline button ("Copy") instead of an icon button. */
  showLabel?: boolean;
  /** Called after each attempt with whether the clipboard accepted the value. */
  onCopy?: (ok: boolean) => void;
  className?: string;
}

/**
 * A copy control. On failure it reveals the value in a read-only field, selected, with the copy
 * chord as visible text, so the operator can copy it by hand.
 */
export function CopyButton({
  value,
  label,
  size = "sm",
  showLabel = false,
  onCopy,
  className,
}: CopyButtonProps): React.ReactElement {
  const { copy, state } = useCopy();
  const fallback = React.useRef<HTMLInputElement>(null);
  const fallbackId = React.useId();

  React.useEffect(() => {
    if (state === "failed") {
      fallback.current?.focus();
      fallback.current?.select();
    }
  }, [state]);

  const run = async (): Promise<void> => {
    const ok = await copy(value);
    onCopy?.(ok);
  };

  const icon = state === "copied" ? <Check /> : <Copy />;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {showLabel ? (
        <Button
          variant="outline"
          size={size}
          iconStart={icon}
          aria-label={label}
          onClick={() => void run()}
        >
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      ) : (
        <IconButton
          label={state === "copied" ? `${label}: copied` : label}
          icon={icon}
          size={size}
          onClick={() => void run()}
        />
      )}
      {state === "failed" ? (
        <span className="inline-flex items-center gap-2">
          <label htmlFor={fallbackId} className="text-xs text-fg-muted">
            Press {copyChord()} to copy
          </label>
          <input
            id={fallbackId}
            ref={fallback}
            readOnly
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            className="h-7 w-48 rounded-md border border-border-strong bg-surface-sunken px-2 font-mono text-xs text-fg"
          />
        </span>
      ) : null}
    </span>
  );
}
