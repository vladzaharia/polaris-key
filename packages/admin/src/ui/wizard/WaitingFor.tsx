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
 * Progress is real: there is no percentage. After `timeoutMs` (15 minutes, SETUP §1.7) the spinner stops and
 * the row says "Still waiting" and offers "Keep waiting" and "Check again" rather than looping forever.
 */
export function WaitingFor({
  waiting,
  found,
  onCheck,
  checking = false,
  timeoutMs = 15 * 60_000,
  timedOutText = "Still waiting",
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
  // Keep waiting restarts the clock for another round (SETUP §1.7).
  const [round, setRound] = React.useState(0);
  React.useEffect(() => {
    if (found !== null) return;
    setTimedOut(false);
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [found, timeoutMs, round]);
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
          <span className="min-w-0 flex-1 text-fg">
            {timedOutText === "Still waiting" && /^Waiting /.test(waiting)
              ? `Still waiting ${waiting.slice("Waiting ".length)}.`
              : `${timedOutText}. ${waiting}.`}
          </span>
          <span className="ms-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRound((r) => r + 1)}
            >
              Keep waiting
            </Button>
            {onCheck ? (
              <Button
                size="sm"
                variant="outline"
                loading={checking}
                onClick={onCheck}
              >
                Check again
              </Button>
            ) : null}
          </span>
        </>
      ) : (
        <>
          <Spinner label="" className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 text-fg">{waiting}…</span>
        </>
      )}
    </div>
  );
}
