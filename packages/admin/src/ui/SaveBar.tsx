import * as React from "react";
import { AlertCircle } from "lucide-react";
import type { FieldValues } from "react-hook-form";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";
import type { AdminForm } from "./form.js";

export interface SaveBarProps<T extends FieldValues> {
  form: AdminForm<T>;
  saveLabel?: string;
  discardLabel?: string;
  /** Overrides the change summary ("+2 −1 ~3 · 1 error"). */
  summary?: React.ReactNode;
  /** The save scope's name on a page with several (T4): "2 changes in General". */
  section?: string;
  /** Editor templates: "Review" opens the diff drawer. */
  onReview?: () => void;
  reviewLabel?: string;
  className?: string;
}

/** The bars on screen, so ⌘S saves the one the operator is working in (T4 has one per scope). */
interface Registered {
  form: AdminForm<FieldValues>;
  bar: HTMLElement | null;
}
const bars = new Set<{ current: Registered }>();

function onKeyDown(e: KeyboardEvent): void {
  if (
    !(e.key === "s" || e.key === "S") ||
    !(e.metaKey || e.ctrlKey) ||
    e.altKey
  )
    return;
  const dirty = [...bars].map((b) => b.current).filter((b) => b.form.isDirty);
  if (dirty.length === 0) return;
  e.preventDefault();
  const active = document.activeElement;
  const target =
    dirty.find(
      (b) =>
        active &&
        (b.form.element.current?.contains(active) || b.bar?.contains(active)),
    ) ?? (dirty.length === 1 ? dirty[0] : undefined);
  if (target && !target.form.isSubmitting) void target.form.submit();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sticky save bar (components.md §3.4) for T4 settings and T7 editors. It appears only while
 * the form is dirty, sticks to the bottom of the content column (safe-area padded, fixes MPE-5),
 * and holds the change summary, Discard and Save.
 *
 * - ⌘S / Ctrl+S saves the bar whose form holds focus (or the only dirty one).
 * - Esc from the bar asks before discarding (inline, no modal).
 * - While saving, Save shows `loading` and the fields are read-only (FormField).
 * - On error the bar stays, the summary links to each invalid field ("Fix 2 fields"), and focus
 *   has already moved to the first one (useAdminForm).
 */
export function SaveBar<T extends FieldValues>({
  form,
  saveLabel = "Save changes",
  discardLabel = "Discard",
  summary,
  section,
  onReview,
  reviewLabel = "Review",
  className,
}: SaveBarProps<T>): React.ReactElement | null {
  const barRef = React.useRef<HTMLDivElement>(null);
  const reg = React.useRef<Registered>({
    form: form as unknown as AdminForm<FieldValues>,
    bar: null,
  });
  reg.current = {
    form: form as unknown as AdminForm<FieldValues>,
    bar: barRef.current,
  };
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    const entry = reg;
    if (bars.size === 0) window.addEventListener("keydown", onKeyDown);
    bars.add(entry);
    return () => {
      bars.delete(entry);
      if (bars.size === 0) window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  React.useEffect(() => {
    if (!form.isDirty) setConfirming(false);
  }, [form.isDirty]);

  const errorNames = Object.keys(form.errors);
  const show = form.isDirty || errorNames.length > 0 || form.isSubmitting;
  if (!show) return null;

  const labels = form.labels.current;
  const changes = plural(form.dirtyCount, "change", "changes");
  const text = summary ?? (section ? `${changes} in ${section}` : changes);

  return (
    <div
      ref={barRef}
      role="region"
      aria-label={section ? `Unsaved changes in ${section}` : "Unsaved changes"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && form.isDirty && !form.isSubmitting) {
          e.preventDefault();
          setConfirming(true);
        }
      }}
      className={cn(
        "sticky bottom-0 z-30 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-overlay px-4 pt-3 shadow-elevation-3",
        "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-sm">
        {confirming ? (
          <p role="alert" className="text-fg-strong">
            Discard {changes}
            {section ? ` in ${section}` : ""}?
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-x-2 text-fg">
            <span>{text}</span>
            {onReview ? (
              <Button variant="link" size="sm" onClick={onReview}>
                {reviewLabel}
              </Button>
            ) : null}
          </p>
        )}
        {!confirming && errorNames.length > 0 ? (
          <div
            role="alert"
            className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-danger"
          >
            <AlertCircle aria-hidden className="size-3.5" />
            <span>Fix {plural(errorNames.length, "field", "fields")}:</span>
            {errorNames.map((name) => (
              <button
                key={name}
                type="button"
                className="underline underline-offset-2 hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                onClick={() => form.focus(name)}
              >
                {labels.get(name) ?? name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              autoFocus
            >
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                form.discard();
              }}
            >
              {discardLabel}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={form.isSubmitting || !form.isDirty}
              onClick={() => form.discard()}
            >
              {discardLabel}
            </Button>
            <Button
              loading={form.isSubmitting}
              disabled={!form.isDirty}
              onClick={() => void form.submit()}
              aria-keyshortcuts="Meta+S Control+S"
            >
              {saveLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
