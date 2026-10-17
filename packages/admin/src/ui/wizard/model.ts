/**
 * The wizard kit's vocabulary (ST-39; SETUP.md §1). A flow is DATA: its steps, in order, and the
 * kind of each. `lintFlow` (./lint.ts) holds every flow to SETUP.md §1's rules.
 *
 * A step's state is computed from facts by the page (`done`), never stored. The operator's explicit
 * choices (skipped steps, "not using this channel", runner consent, Integration hidden) are the
 * one `core.setup` product setting, read and written by `console/wizard/useSetup.ts`.
 */

/** The step kinds of SETUP.md §1.2 that exist in the kit today. */
export type StepKind =
  | "choice"
  | "prereq"
  | "form"
  | "snippet"
  | "wait"
  | "confirm"
  | "custom"
  | "done";

export interface FlowStep {
  id: string;
  /** What the operator does, as a short noun phrase or verb ("Choose the cask"), never "Step 3". */
  label: string;
  kind: StepKind;
}

/** A wizard, as data. */
export interface FlowDef {
  id: string;
  title: string;
  steps: readonly FlowStep[];
}

/** The part of a step the stepper shows. */
export interface WizardStep {
  id: string;
  label: string;
  /** Under a done step: what was decided ("Kestrel Labs · Keycloak"). One short phrase. */
  decided?: string;
}

/** The longest a flow may be before its Done step (SETUP.md §1.1). */
export const MAX_FLOW_STEPS = 5;

/** The words of a step's state. Colour is never the only cue. */
export const STEP_WORDS = {
  done: "completed",
  skipped: "skipped",
  unmet: "needs attention",
} as const;
