import * as React from "react";
import { AlertCircle, CircleMinus } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import { useRemoveLibraryEntry } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import { focusPageHeading } from "../router.js";

/**
 * **Remove from library** for an open product's entry (PS-04, notes/S-21 §6.4, Q15), confirmed
 * inline where it was asked for: on the Library tile and on the product page. Entries only: a
 * licence leaves the library through its own removal (`RemoveLicenseDialog`).
 *
 * Focus (PORTAL.md §9): the confirmation takes focus on **Keep it**, the least destructive
 * choice; Escape or Keep it puts focus back on the menu button that asked. After the removal,
 * focus moves before the tile or page goes (`onRemoved`, else the page's `h1`), so it is never
 * left on a control that no longer exists. Nothing animates: the same end state under any motion
 * setting.
 */
export function RemoveEntryConfirm({
  slug,
  name,
  ask = 0,
  onCancel,
  onRemoved,
  className,
}: {
  slug: string;
  name: string;
  /**
   * How many times Remove was chosen: choosing it again while the confirmation is open puts focus
   * back on **Keep it**.
   */
  ask?: number;
  /** Keep it (or Escape): close the confirmation and hand focus back to its opener. */
  onCancel: () => void;
  /** After the Worker removed the entry; default: focus the page's `h1`. */
  onRemoved?: () => void;
  className?: string;
}): React.ReactElement {
  const remove = useRemoveLibraryEntry();
  const keep = React.useRef<HTMLButtonElement>(null);
  const group = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    keep.current?.focus();
    // The menu that asked hands focus back as it closes, a task after it unmounts (Radix): take
    // it again then, unless the person has moved on.
    const t = window.setTimeout(() => {
      const at = document.activeElement;
      if (!at || at === document.body) keep.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [ask]);
  const id = `remove-entry-${slug}`;
  const confirm = (): void => {
    setError(null);
    // Both buttons are disabled while the request runs: focus waits on the confirmation itself,
    // never on the page's body.
    group.current?.focus();
    remove.mutate(slug, {
      onSuccess: () => {
        toast.success(`${name} was removed from your library`);
        if (onRemoved) onRemoved();
        else focusPageHeading();
      },
      onError: (err) => {
        const copy = portalErrorCopy(err);
        setError(`${copy.title}. ${copy.description}`);
      },
    });
  };
  return (
    <div
      ref={group}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-h`}
      aria-describedby={`${id}-d`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !remove.isPending) {
          e.stopPropagation();
          onCancel();
        }
      }}
      className={cn(
        "relative space-y-3 rounded-lg border border-danger-border bg-surface-sunken p-4 outline-none",
        className,
      )}
    >
      <p id={`${id}-h`} className="font-bold text-fg-strong">
        Remove {name} from your library?
      </p>
      <p id={`${id}-d`} className="text-sm text-fg-muted">
        You can add it again from Discover while its developer offers it.
      </p>
      {error ? (
        <p role="alert" className="flex gap-2 text-sm text-danger">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={keep}
          variant="outline"
          onClick={onCancel}
          disabled={remove.isPending}
        >
          Keep it
        </Button>
        <Button
          variant="danger"
          iconStart={<CircleMinus aria-hidden />}
          loading={remove.isPending}
          onClick={confirm}
        >
          Remove from library
        </Button>
      </div>
    </div>
  );
}
