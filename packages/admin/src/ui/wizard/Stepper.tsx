import * as React from "react";
import { Check, ChevronDown, Minus, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { useChangedSinceMount } from "../motion/changed.js";
import { setMeter } from "../motion/index.js";
import { STEP_WORDS, type WizardStep } from "./model.js";

/**
 * The line between two steps (MO-09): an accent fill over the track that grows from the start
 * (`pk-meter-fill`, transform only) when the step before it is done, and drains when the wizard
 * goes back. Set before the first paint, so a wizard opens at rest.
 */
function Connector({ filled }: { filled: boolean }): React.ReactElement {
  const fill = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => setMeter(fill.current, filled ? 1 : 0), [filled]);
  return (
    <span
      aria-hidden
      data-filled={filled || undefined}
      className="relative h-px w-6 min-w-2 shrink overflow-hidden bg-border-strong"
    >
      <span ref={fill} className="pk-meter-fill absolute inset-0 bg-accent" />
    </span>
  );
}

export interface StepperProps {
  steps: readonly WizardStep[];
  current: string;
  /** Steps done. Default: every step before `current`. */
  done?: readonly string[];
  /** Steps the operator skipped: they read "Skipped" and stay reachable. */
  skipped?: readonly string[];
  /**
   * Steps whose facts are not met although the operator got past them: a warning marker, and they
   * stay reachable. Additive (ST-39 fix round).
   */
  unmet?: readonly string[];
  /** Steps the operator has been to without finishing them: neutral, and reachable. */
  visited?: readonly string[];
  /** Undo a skip: shown beside a skipped step ("Skipped · Undo"). */
  onUndoSkip?: (id: string) => void;
  /** Go back to a done or skipped step. Without it those steps are plain text. */
  onStep?: (id: string) => void;
  label?: string;
  /**
   * `list`: one row on wide screens, the current step with "Step n of m" and a list on phones.
   * `segments` (a drawer): a row of segments under the title.
   */
  variant?: "list" | "segments";
  /**
   * The step heading the page shows under the stepper. When the current step's label is the same
   * words, the phone toggle says only "Step n of m" rather than repeating it.
   */
  headingLabel?: string;
  className?: string;
}

/**
 * The wizard's step list (SETUP.md §1.1). An `ol`; the current step has `aria-current="step"`.
 * Done steps are buttons that go back to them and say what was decided; future steps are disabled,
 * with the reason ("Complete Basics first") in their accessible description. Below 640 px the list
 * collapses to the current step ("Step 2 of 5 · Basics") and opens on tap.
 *
 * Motion (MO-09): the connectors fill as steps complete, and the new current step's marker pops
 * (`pk-pop-in`) when the step changes, never on first render. Under reduced motion both are
 * instant swaps.
 */
export function Stepper({
  steps,
  current,
  done: doneProp,
  skipped: skippedProp,
  unmet: unmetProp,
  visited: visitedProp,
  onUndoSkip,
  onStep,
  label = "Steps",
  variant = "list",
  headingLabel,
  className,
}: StepperProps): React.ReactElement {
  const uid = React.useId();
  const [open, setOpen] = React.useState(false);
  const currentIndex = steps.findIndex((s) => s.id === current);
  const skipped = new Set(skippedProp ?? []);
  const done = new Set(
    doneProp ?? steps.slice(0, Math.max(0, currentIndex)).map((s) => s.id),
  );
  const unmet = new Set(unmetProp ?? []);
  const visited = new Set(visitedProp ?? []);
  const moved = useChangedSinceMount(current);
  const segments = variant === "segments";
  const here = steps[currentIndex];
  const reached = (id: string) =>
    done.has(id) || skipped.has(id) || unmet.has(id) || visited.has(id);

  // The collapse follows the room the stepper has, in rem: at 200 % text the list gives way to
  // "Step n of m" instead of squeezing every label to a glyph.
  return (
    <nav aria-label={label} className={cn("@container", className)}>
      {segments ? null : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-list`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-border px-3 text-sm font-medium text-fg-strong @3xl:hidden"
        >
          <span>
            Step {currentIndex + 1} of {steps.length}
            {here && here.label !== headingLabel ? ` · ${here.label}` : ""}
          </span>
          <ChevronDown
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      )}
      {segments && here ? (
        // In a narrow drawer (or at 200 % text) five labels cannot sit under five segments:
        // the current step's name goes on one line above them, and the others read to assistive tech.
        <p
          aria-hidden
          className="mb-1 text-xs font-medium text-fg-strong @md:hidden"
        >
          Step {currentIndex + 1} of {steps.length} · {here.label}
        </p>
      ) : null}
      <ol
        id={`${uid}-list`}
        className={cn(
          segments
            ? "flex items-stretch gap-1"
            : cn(
                "mt-2 flex-col gap-y-1 @3xl:mt-0 @3xl:flex @3xl:flex-row @3xl:flex-nowrap @3xl:items-center @3xl:gap-x-2 @3xl:gap-y-2",
                open ? "flex" : "hidden",
              ),
        )}
      >
        {steps.map((step, i) => {
          const isCurrent = step.id === current;
          const isSkipped = skipped.has(step.id) && !isCurrent;
          const isUnmet =
            unmet.has(step.id) &&
            !isCurrent &&
            !isSkipped &&
            !done.has(step.id);
          const isDone = done.has(step.id) && !isCurrent && !isSkipped;
          const isVisited =
            visited.has(step.id) &&
            !isCurrent &&
            !isSkipped &&
            !isDone &&
            !isUnmet;
          const isOpen = isDone || isSkipped || isUnmet || isVisited;
          const word = isSkipped
            ? STEP_WORDS.skipped
            : isUnmet
              ? STEP_WORDS.unmet
              : isDone
                ? STEP_WORDS.done
                : "";
          const blocker = steps
            .slice(0, i)
            .find((s) => !reached(s.id) && s.id !== current);
          const reasonId = `${uid}-reason-${step.id}`;
          const marker = (
            <span
              // A step that becomes current remounts its marker, so the pop runs once per change.
              key={isCurrent ? "current" : "step"}
              aria-hidden
              className={cn(
                "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                isCurrent && "border-accent bg-accent text-accent-on",
                isCurrent && moved && "pk-pop-in",
                isDone && "border-accent text-accent-fg",
                isSkipped && "border-border-strong text-fg-muted",
                isUnmet && "border-warning text-warning",
                !isCurrent &&
                  !isDone &&
                  !isSkipped &&
                  !isUnmet &&
                  "border-border-strong text-fg-muted",
              )}
            >
              {isDone ? (
                <Check className="size-3.5" />
              ) : isSkipped ? (
                <Minus className="size-3.5" />
              ) : isUnmet ? (
                <TriangleAlert className="size-3.5" />
              ) : (
                i + 1
              )}
            </span>
          );
          const text = (
            <span className="flex min-w-0 flex-col text-left">
              <span title={step.label} className="truncate">
                {step.label}
              </span>
              {isDone && step.decided ? (
                <small
                  title={step.decided}
                  className="max-w-[16rem] truncate text-xs font-normal text-fg-muted"
                >
                  {step.decided}
                </small>
              ) : isSkipped ? (
                <small className="text-xs font-normal text-fg-muted">
                  Skipped
                </small>
              ) : isUnmet && step.decided ? (
                <small
                  title={step.decided}
                  className="max-w-[16rem] truncate text-xs font-normal text-warning"
                >
                  {step.decided}
                </small>
              ) : null}
            </span>
          );
          if (segments) {
            return (
              <li key={step.id} className="min-w-0 flex-1">
                <span
                  aria-current={isCurrent ? "step" : undefined}
                  className="flex flex-col gap-1"
                >
                  <span
                    aria-hidden
                    data-filled={reached(step.id) || isCurrent || undefined}
                    className={cn(
                      "h-1 rounded-full forced-color-adjust-none",
                      reached(step.id) || isCurrent
                        ? "bg-accent forced-colors:bg-[Highlight]"
                        : "bg-border-strong forced-colors:h-0.5 forced-colors:bg-[GrayText]",
                    )}
                  />
                  <span
                    className={cn(
                      "break-words text-xs @max-md:sr-only",
                      isCurrent
                        ? "font-medium text-fg-strong"
                        : "text-fg-muted",
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="sr-only">{word ? ` (${word})` : ""}</span>
                </span>
              </li>
            );
          }
          return (
            <li
              key={step.id}
              className={cn(
                "flex items-center gap-2",
                isCurrent ? "shrink-0" : "min-w-0",
              )}
            >
              {i > 0 ? (
                <span className="hidden min-w-2 shrink @3xl:inline-flex">
                  <Connector
                    filled={
                      i <= currentIndex ||
                      (reached(steps[i - 1]!.id) &&
                        steps[i - 1]!.id !== current)
                    }
                  />
                </span>
              ) : null}
              {isCurrent ? (
                <span
                  aria-current="step"
                  className="inline-flex min-h-8 min-w-0 items-center gap-2 text-sm font-medium text-fg-strong"
                >
                  {marker}
                  {text}
                </span>
              ) : isOpen && onStep ? (
                <button
                  type="button"
                  onClick={() => onStep(step.id)}
                  className="inline-flex min-h-8 min-w-0 items-center gap-2 rounded-md text-sm text-fg hover:text-fg-strong hover:underline"
                >
                  {marker}
                  {text}
                  {word ? (
                    <span className="sr-only">{` (${word})`}</span>
                  ) : null}
                </button>
              ) : isOpen ? (
                <span className="inline-flex min-h-8 min-w-0 items-center gap-2 text-sm text-fg">
                  {marker}
                  {text}
                  {word ? (
                    <span className="sr-only">{` (${word})`}</span>
                  ) : null}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-describedby={reasonId}
                    className="inline-flex min-h-8 min-w-0 cursor-not-allowed items-center gap-2 text-sm text-fg-muted"
                  >
                    {marker}
                    {text}
                  </button>
                  <span id={reasonId} className="sr-only">
                    {`Complete ${(blocker ?? steps[Math.max(0, currentIndex)])?.label ?? "the previous step"} first`}
                  </span>
                </>
              )}
              {isSkipped && onUndoSkip ? (
                <button
                  type="button"
                  onClick={() => onUndoSkip(step.id)}
                  className="rounded-md text-xs text-accent-fg underline-offset-4 hover:underline"
                >
                  Undo
                  <span className="sr-only">{` skipping ${step.label}`}</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
