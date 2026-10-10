import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useChangedSinceMount } from "./motion/changed.js";
import { setMeter } from "./motion/index.js";

export interface Step {
  id: string;
  label: string;
}

/**
 * The line between two steps (notes/S-23 §6.1 "meter"; MO-09): an accent fill over the track that
 * grows from the start (`pk-meter-fill`, transform only) when the step before it is done, and
 * drains when the wizard goes back. Set before the first paint, so a wizard opens at rest.
 */
function Connector({ filled }: { filled: boolean }): React.ReactElement {
  const fill = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => setMeter(fill.current, filled ? 1 : 0), [filled]);
  return (
    <span
      aria-hidden
      data-filled={filled || undefined}
      className="relative h-px w-6 overflow-hidden bg-border-strong"
    >
      <span ref={fill} className="pk-meter-fill absolute inset-0 bg-accent" />
    </span>
  );
}

/**
 * The wizard's step list (components.md §6.15, ADMIN.md T6). An `ol`; the current step has
 * `aria-current="step"`. Completed steps are buttons that go back to them (`onStep`); future steps
 * are disabled, with the reason ("Complete Basics first") in their accessible description.
 *
 * Motion (MO-09): the connectors fill as steps complete, and the new current step's marker pops
 * (`pk-pop-in`) when the step changes, never on first render. Under reduced motion both are
 * instant swaps.
 */
export function Stepper({
  steps,
  current,
  completed,
  onStep,
  label = "Steps",
  className,
}: {
  steps: Step[];
  current: string;
  /** Steps done. Default: every step before `current`. */
  completed?: string[];
  onStep?: (id: string) => void;
  label?: string;
  className?: string;
}): React.ReactElement {
  const uid = React.useId();
  const currentIndex = steps.findIndex((s) => s.id === current);
  const done = new Set(
    completed ?? steps.slice(0, Math.max(0, currentIndex)).map((s) => s.id),
  );
  const moved = useChangedSinceMount(current);
  return (
    <nav aria-label={label} className={className}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {steps.map((step, i) => {
          const isCurrent = step.id === current;
          const isDone = done.has(step.id) && !isCurrent;
          const blocker = steps
            .slice(0, i)
            .find((s) => !done.has(s.id) && s.id !== current);
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
                !isCurrent && !isDone && "border-border-strong text-fg-muted",
              )}
            >
              {isDone ? <Check className="size-3.5" /> : i + 1}
            </span>
          );
          return (
            <li key={step.id} className="flex items-center gap-2">
              {i > 0 ? (
                <Connector
                  filled={
                    i <= currentIndex ||
                    (done.has(steps[i - 1]!.id) && steps[i - 1]!.id !== current)
                  }
                />
              ) : null}
              {isCurrent ? (
                <span
                  aria-current="step"
                  className="inline-flex items-center gap-2 text-sm font-medium text-fg-strong"
                >
                  {marker}
                  {step.label}
                </span>
              ) : isDone && onStep ? (
                <button
                  type="button"
                  onClick={() => onStep(step.id)}
                  className="inline-flex items-center gap-2 rounded-md text-sm text-fg hover:text-fg-strong hover:underline"
                >
                  {marker}
                  {step.label}
                  <span className="sr-only"> (completed)</span>
                </button>
              ) : isDone ? (
                <span className="inline-flex items-center gap-2 text-sm text-fg">
                  {marker}
                  {step.label}
                  <span className="sr-only"> (completed)</span>
                </span>
              ) : (
                <button
                  type="button"
                  disabled
                  aria-describedby={reasonId}
                  className="inline-flex cursor-not-allowed items-center gap-2 text-sm text-fg-muted"
                >
                  {marker}
                  {step.label}
                  <span id={reasonId} className="sr-only">
                    {`Complete ${(blocker ?? steps[Math.max(0, currentIndex)])?.label ?? "the previous step"} first`}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
