import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import type { DiscardWords } from "../Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../Drawer.js";
import { Stepper } from "./Stepper.js";
import type { WizardStep } from "./model.js";

export interface WizardFooter {
  /** "Do this later": a ghost link or button that leaves the wizard (progress is kept). */
  later?: React.ReactNode;
  /** "Skip this step": only on a step that may be skipped; the page records it in `core.setup`. */
  onSkip?: () => void;
  /** Why Skip is off ("Ask Ada for Core access."): it stays visible, `aria-disabled`, with this as its description. */
  skipDisabledReason?: string;
  /** A skip is being saved: Skip shows as loading and ignores clicks. */
  skipLoading?: boolean;
  /** Back one step. Absent on the first step. */
  onBack?: () => void;
  /** `start`: Back sits at the footer's left, before everything else. Default: beside the primary. */
  backAt?: "start" | "end";
  /** Back stays in place but does nothing (a request is running). */
  backDisabled?: boolean;
  /**
   * The one filled primary of the step; its label names the action, not "Next". Absent when the
   * step's own typed action is the action (Submit): the footer then has Do this later and Back only.
   */
  primary?: React.ReactNode;
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
  /** Steps whose facts are not met (warning marker), steps visited but not finished (neutral), and Undo for a skip. */
  unmet?: readonly string[];
  visited?: readonly string[];
  onUndoSkip?: (id: string) => void;
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
  /** Focus the step's heading on first render too (the page just routed into the flow). */
  focusOnMount?: boolean;
  /**
   * The wizard's result: the last step is the answer, not a step. The heading drops "Step n of m",
   * the stepper shows every step done, and `titleIcon` leads the heading.
   */
  result?: boolean;
  titleIcon?: React.ReactNode;
  /** Centre the page host in a 960 px column (default). */
  centered?: boolean;
  /** The drawer host's open state and title. */
  drawer?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    unsaved?: boolean;
    /** The words of the guarded close ("Discard this license?"). */
    discard?: DiscardWords;
    /** False while busy, or while a one-time value must be kept first. */
    dismissible?: boolean;
    /** A line above the drawer's title ("DJDL · Licenses"). */
    eyebrow?: React.ReactNode;
  };
  className?: string;
}

/**
 * The wizard shell (SETUP.md §1.1): the stepper (which numbers the steps; the live line announces "step n of m"), one question per
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
  unmet,
  visited,
  onUndoSkip,
  onStep,
  title,
  why,
  eyebrow,
  aside,
  children,
  footer,
  centered = true,
  focusOnMount = false,
  result = false,
  titleIcon,
  drawer,
  className,
}: WizardProps): React.ReactElement {
  const uid = React.useId();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const first = React.useRef(true);
  const [announced, setAnnounced] = React.useState("");
  const index = Math.max(
    0,
    steps.findIndex((s) => s.id === current),
  );
  React.useEffect(() => {
    const skipFocus = first.current && !focusOnMount;
    first.current = false;
    // The live line says where the operator is: "Add to storefronts, step 2 of 7, Check the prerequisites".
    setAnnounced(
      result
        ? `${label}, ${title}`
        : `${label}, step ${index + 1} of ${steps.length}, ${title}`,
    );
    if (!skipFocus) headingRef.current?.focus();
    // Only a change of step moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const isDrawer = host === "drawer";
  const reasonId = `${uid}-reason`;

  const body = (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h2
          ref={headingRef}
          id={`${uid}-title`}
          tabIndex={-1}
          className="text-lg font-semibold text-fg-strong outline-none"
        >
          {titleIcon ? (
            <span className="mr-2 inline-flex align-text-bottom">
              {titleIcon}
            </span>
          ) : null}
          {isDrawer && !result ? (
            <span className="font-normal text-fg-muted max-sm:sr-only">
              Step {index + 1} of {steps.length} ·{" "}
            </span>
          ) : null}
          {title}
        </h2>
        {why ? <p className="text-sm text-fg-muted">{why}</p> : null}
      </div>
      {children}
      <p role="status" className="sr-only">
        {announced}
      </p>
    </div>
  );

  const footRef = React.useRef<HTMLDivElement>(null);
  // Tell the scroller how much of its bottom the pinned footer covers (styles.css reads it), or
  // nothing while the footer is in the flow.
  React.useEffect(() => {
    const el = footRef.current;
    if (isDrawer || !el) return;
    const root = document.documentElement;
    const measure = () => {
      const pinned = getComputedStyle(el).position === "sticky";
      if (pinned)
        root.style.setProperty("--pk-wizard-foot", `${el.offsetHeight}px`);
      else root.style.removeProperty("--pk-wizard-foot");
    };
    measure();
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--pk-wizard-foot");
    };
  }, [isDrawer]);

  const back = footer.onBack ? (
    <Button
      variant="outline"
      className={cn(isDrawer && "max-sm:order-2 max-sm:ml-auto")}
      disabled={footer.backDisabled}
      onClick={footer.onBack}
    >
      <ArrowLeft aria-hidden />
      Back
    </Button>
  ) : null;
  const footRow = (
    <>
      {footer.backAt === "start" && (back || footer.later) ? (
        // Back and "do this later" stay together when the footer wraps.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {back}
          {footer.later}
        </div>
      ) : footer.later ? (
        <div className={cn(isDrawer && "max-sm:order-1")}>{footer.later}</div>
      ) : null}
      {footer.onSkip ? (
        <Button
          variant="ghost"
          onClick={footer.onSkip}
          loading={footer.skipLoading}
          disabledReason={footer.skipDisabledReason}
        >
          Skip this step
        </Button>
      ) : null}
      {footer.reason ? (
        <span id={reasonId} className="text-sm text-fg-muted">
          {footer.reason}
        </span>
      ) : null}
      <div
        className={cn(
          "ml-auto flex flex-wrap items-center gap-2",
          isDrawer && "max-sm:contents",
        )}
      >
        {footer.backAt !== "start" ? back : null}
        {React.isValidElement<{ "aria-describedby"?: string }>(footer.primary)
          ? React.cloneElement(
              footer.primary as React.ReactElement<Record<string, unknown>>,
              {
                className: cn(
                  (footer.primary.props as { className?: string }).className,
                  isDrawer &&
                    "max-sm:order-3 max-sm:w-full min-w-0 max-w-full whitespace-normal",
                ),
                "aria-describedby":
                  [footer.primary.props["aria-describedby"], reasonId]
                    .filter((x) => x && footer.reason)
                    .join(" ") || undefined,
              },
            )
          : footer.primary}
      </div>
    </>
  );
  const foot = (
    // Sticky: on a long step the primary stays on screen (the page scrolls inside `main`).
    <div
      ref={footRef}
      data-wizard-foot=""
      className="pinfoot:sticky pinfoot:bottom-0 pinfoot:z-10 pinfoot:-mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface-page pb-4 pt-4"
    >
      {footRow}
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
        discard={drawer.discard}
        dismissible={drawer.dismissible}
        eyebrow={drawer.eyebrow}
        closeStyle="close"
      >
        <DrawerBody className={className} data-wizard="drawer">
          <div className="space-y-4">
            <Stepper
              variant="segments"
              label={label}
              steps={steps}
              current={result ? "" : current}
              done={result ? steps.map((s) => s.id) : done}
              skipped={skipped}
              unmet={unmet}
              visited={visited}
              onUndoSkip={onUndoSkip}
              onStep={onStep}
            />
            {body}
          </div>
        </DrawerBody>
        <DrawerFooter className="flex-row flex-wrap items-center gap-x-3 gap-y-2 sm:justify-start">
          {footRow}
        </DrawerFooter>
      </Drawer>
    );
  }

  return (
    <section
      aria-labelledby={`${uid}-title`}
      data-wizard="page"
      className={cn(
        // A container, so the rail follows the room the wizard has, not the viewport: at 200%
        // text the rem-sized rail would otherwise squeeze the column.
        "@container space-y-6",
        centered && "mx-auto w-full max-w-[60rem]",
        className,
      )}
    >
      <header className="space-y-3">
        {eyebrow ? <div className="min-w-0">{eyebrow}</div> : null}
        <Stepper
          label={label}
          steps={steps}
          current={current}
          done={done}
          skipped={skipped}
          unmet={unmet}
          visited={visited}
          onUndoSkip={onUndoSkip}
          onStep={onStep}
        />
      </header>
      <div
        className={cn(
          "grid gap-6",
          aside ? "@4xl:grid-cols-[minmax(0,1fr)_18rem]" : null,
        )}
      >
        {body}
        {aside ? (
          <aside className="space-y-2 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg self-start hidden @4xl:block @4xl:sticky @4xl:top-4">
            {aside}
          </aside>
        ) : null}
      </div>
      {foot}
    </section>
  );
}
