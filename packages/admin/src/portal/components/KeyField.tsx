import * as React from "react";
import { AlertCircle, Check, ClipboardPaste } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { keyParts, normaliseKey } from "../model/key.js";

/**
 * The license-key field (PORTAL.md §4.17): monospace and paste-first (a Paste button while
 * empty), wrapping at any character so a 38-character key stays visible on a phone, never
 * rewritten (no grouping, no case change; trimming is the only normalisation). The parts are
 * coloured: `pkey_` and the separator subtle, the slug in `accent-fg`, the secret strong.
 *
 * The colouring is a mirror behind a transparent `<textarea>` (one control, one accessible
 * name); Enter submits the form instead of adding a line.
 */
export function KeyField({
  id,
  value,
  onChange,
  valid,
  error,
  hint,
  help,
  autoFocus,
  onBlur,
}: {
  id: string;
  value: string;
  onChange: (value: string, how: "type" | "paste") => void;
  valid: boolean;
  /** The inline error (§4.19), with `aria-invalid`. */
  error?: React.ReactNode;
  /** "Key for Mossgarden · Little Fern", under the field. */
  hint?: React.ReactNode;
  help: React.ReactNode;
  autoFocus?: boolean;
  onBlur?: () => void;
}): React.ReactElement {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [pasteHint, setPasteHint] = React.useState(false);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const okId = `${id}-ok`;
  const parts = keyParts(value);

  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(normaliseKey(text), "paste");
      ref.current?.focus();
    } catch {
      // The browser refused to read the clipboard: say how to paste by hand.
      setPasteHint(true);
      ref.current?.focus();
    }
  };

  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.userAgent);
  const describedBy = [error ? errorId : null, valid ? okId : null, helpId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-bold text-fg-strong">
        License key
      </label>
      <div
        className={cn(
          "relative rounded-md border bg-surface-sunken focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 focus-within:ring-offset-surface-overlay",
          error
            ? "border-danger"
            : valid
              ? "border-success"
              : "border-border-strong",
        )}
      >
        <div
          aria-hidden
          className="min-h-[3.25rem] whitespace-pre-wrap py-3.5 pl-4 pr-24 font-mono text-[0.9375rem] leading-6 [overflow-wrap:anywhere] [word-break:break-all]"
        >
          {value ? (
            parts ? (
              <>
                <span className="text-fg-subtle">{parts.prefix}</span>
                <span className="font-bold text-accent-fg">{parts.slug}</span>
                <span className="text-fg-subtle">{parts.sep}</span>
                <span className="text-fg-strong">{parts.rest}</span>
              </>
            ) : (
              <span className="text-fg-strong">{value}</span>
            )
          ) : (
            <span className="text-fg-subtle">pkey_product_…</span>
          )}
          {"\u200b"}
        </div>
        <textarea
          ref={ref}
          id={id}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onBlur={onBlur}
          onPaste={(e) => {
            e.preventDefault();
            onChange(normaliseKey(e.clipboardData.getData("text")), "paste");
          }}
          onChange={(e) => onChange(normaliseKey(e.target.value), "type")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className="absolute inset-0 size-full resize-none overflow-hidden bg-transparent py-3.5 pl-4 pr-24 font-mono text-[0.9375rem] leading-6 text-transparent caret-fg-strong outline-none [overflow-wrap:anywhere] [word-break:break-all] focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <div className="absolute right-2 top-2.5 flex items-center">
          {value === "" ? (
            <button
              type="button"
              onClick={() => void paste()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm font-bold text-fg-strong hover:bg-hover"
            >
              <ClipboardPaste aria-hidden className="size-4 text-accent-fg" />
              Paste
            </button>
          ) : valid ? (
            <Check aria-hidden className="mr-2 size-5 text-success" />
          ) : null}
        </div>
      </div>
      {valid ? (
        <p id={okId} className="flex items-center gap-1.5 text-sm text-success">
          <Check aria-hidden className="size-4" />
          Key format is valid
        </p>
      ) : null}
      {hint}
      {error ? (
        <p id={errorId} role="alert" className="flex gap-2 text-sm text-fg">
          <AlertCircle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-danger"
          />
          <span>{error}</span>
        </p>
      ) : null}
      <p id={helpId} className="text-sm text-fg-muted">
        {pasteHint ? `Press ${mac ? "⌘V" : "Ctrl V"} to paste the key. ` : null}
        {help}
      </p>
    </div>
  );
}
