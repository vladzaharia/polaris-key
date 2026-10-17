import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { Drawer } from "../Drawer.js";
import { Stepper } from "./Stepper.js";
import type { WizardStep } from "./model.js";

export interface WizardFooter {
  /** "Do this later": a ghost link or button that leaves the wizard (progress is kept). */
  later?: React.ReactNode;
  /** "Skip this step": only on a step that may be skipped; the page records it in `core.setup`. */
  onSkip?: () => void;
  /** Back one step. Absent on the first step. */
  onBack?: () => void;
  /** The one filled primary of the step; its label names the action, not "Next". */
  primary: React.ReactNode;
  /** Why the primary is off ("Choose a storefront to continue"). Linked from the footer. */
  reason?: string;
}

export interface WizardProps {
  /** `page`: the subject has its own page. `drawer`: the setup configures the page under it. */
  host?: "page" | "drawer";
  /** Names the stepper and the region ("Add to storefronts"). */
  label: string;
  steps: readonly WizardStep[];
  current: string;
  done?: readonly string[];
  skipped?: readonly string[];
  onStep?: (id: string) => void;
  /** The current step's question, as its h2. Focus lands here when the step changes. */
  title: string;
  /** At most one sentence of why. Long explanation goes in `aside`. */
  why?: string;
  /** The back link of a page host, above the stepper. */
  eyebrow?: React.ReactNode;
  /** Page host, 1024 px and wider: what this step sets up. Hidden in a drawer. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  footer: WizardFooter;
  /** Centre the page host in a 960 px column (default). */
  centered?: boolean;
  /** The drawer host's open state and title. */
  drawer?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    unsaved?: boolean;
  };
  className?: string;
}

/**
 * The wizard shell (SETUP.md §1.1): a header with "Step n of m", the stepper, one question per
 * step, an optional aside, and a footer of Do this later, Back and the primary. Host-agnostic: the
 * page host sits in the console's page, the drawer host in a routed `Drawer`. The page owns the step
 * (a search param, so a refresh resumes) and passes it in; a step change is a route change, so
 * focus moves to the step's heading.
 */
export function Wizard({
  host = "page",
  label,
  steps,
  current,
  done,
  skipped,
  onStep,
  title,
  why,
  eyebrow,
  aside,
  children,
  footer,
  centered = true,
  drawer,
  className,
}: WizardProps): React.ReactElement {
  const uid = React.useId();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [current]);

  const index = Math.max(
    0,
    steps.findIndex((s) => s.id === current),
  );
  const isDrawer = host === "drawer";
  const reasonId = `${uid}-reason`;

  const body = (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h2
          ref={headingRef}
          id={`${uid}-title`}
          tabIndex={-1}
          className="text-lg font-semibold text-fg-strong outline-none focus-visible:underline"
        >
          {isDrawer ? (
            <span className="font-normal text-fg-muted">
              Step {index + 1} of {steps.length} ·{" "}
            </span>
          ) : null}
          {title}
        </h2>
        {why ? <p className="text-sm text-fg-muted">{why}</p> : null}
      </div>
      {children}
    </div>
  );

  const foot = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4">
      {footer.later}
      {footer.onSkip ? (
        <Button variant="ghost" onClick={footer.onSkip}>
          Skip this step
        </Button>
      ) : null}
      {footer.reason ? (
        <span id={reasonId} className="text-sm text-fg-muted">
          {footer.reason}
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {footer.onBack ? (
          <Button variant="outline" onClick={footer.onBack}>
            <ArrowLeft aria-hidden />
            Back
          </Button>
        ) : null}
        <span aria-describedby={footer.reason ? reasonId : undefined}>
          {footer.primary}
        </span>
      </div>
    </div>
  );

  if (isDrawer && drawer) {
    return (
      <Drawer
        open={drawer.open}
        onOpenChange={drawer.onOpenChange}
        title={drawer.title}
        size="lg"
        unsaved={drawer.unsaved}
      >
        <div className={cn("space-y-4", className)} data-wizard="drawer">
          <Stepper
            variant="segments"
            label={label}
            steps={steps}
            current={current}
            done={done}
            skipped={skipped}
            onStep={onStep}
          />
          {body}
          {foot}
        </div>
      </Drawer>
    );
  }

  return (
    <section
      aria-labelledby={`${uid}-title`}
      data-wizard="page"
      className={cn(
        "space-y-6",
        centered && "mx-auto w-full max-w-[60rem]",
        className,
      )}
    >
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">{eyebrow}</div>
          <p className="text-sm text-fg-muted">
            Step {index + 1} of {steps.length}
          </p>
        </div>
        <Stepper
          label={label}
          steps={steps}
          current={current}
          done={done}
          skipped={skipped}
          onStep={onStep}
        />
      </header>
      <div
        className={cn(
          "grid gap-6",
          aside ? "lg:grid-cols-[minmax(0,1fr)_18rem]" : null,
        )}
      >
        {body}
        {aside ? (
          <aside className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg max-lg:hidden">
            {aside}
          </aside>
        ) : null}
      </div>
      {foot}
    </section>
  );
}
