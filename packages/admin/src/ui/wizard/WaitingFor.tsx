import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "../Button.js";
import { announce } from "../LiveRegion.js";
import { Spinner } from "../Spinner.js";

/**
 * A live row for a fact that has not happened yet (SETUP.md §1.2): "Waiting for the first release
 * from CI…" that becomes the event ("0.1.0 arrived 12 s ago"). The page polls (a query with a
 * refetch interval) and passes `found` once the fact is seen; this component owns only the words,
 * the live announcement (once) and the timeout.
 *
 * Progress is real: there is no percentage. After `timeoutMs` the spinner stops and the row offers
 * "Check again" rather than looping forever.
 */
export function WaitingFor({
  waiting,
  found,
  onCheck,
  checking = false,
  timeoutMs = 5 * 60_000,
  timedOutText = "Nothing yet",
}: {
  /** "Waiting for the first release from CI". */
  waiting: string;
  /** The event, once seen; `null` while waiting. */
  found: string | null;
  /** Check now. Offered once the wait has timed out. */
  onCheck?: () => void;
  checking?: boolean;
  timeoutMs?: number;
  timedOutText?: string;
}): React.ReactElement {
  const [timedOut, setTimedOut] = React.useState(false);
  React.useEffect(() => {
    if (found !== null) return;
    setTimedOut(false);
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [found, timeoutMs]);
  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (found !== null && announced.current !== found) {
      announced.current = found;
      announce(found);
    }
  }, [found]);

  return (
    <div
      data-waiting={found === null || undefined}
      className="flex min-h-11 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm"
    >
      {found !== null ? (
        <>
          <Check aria-hidden className="size-4 shrink-0 text-success" />
          <span className="text-fg-strong">{found}</span>
        </>
      ) : timedOut ? (
        <>
          <span className="text-fg">
            {timedOutText}. {waiting}.
          </span>
          {onCheck ? (
            <Button
              size="sm"
              variant="outline"
              loading={checking}
              onClick={onCheck}
              className="ml-auto"
            >
              Check again
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Spinner label="" className="text-fg-muted" />
          <span className="text-fg">{waiting}…</span>
        </>
      )}
    </div>
  );
}
