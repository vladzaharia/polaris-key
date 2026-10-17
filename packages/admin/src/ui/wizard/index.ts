/**
 * The wizard kit (ST-39). Every setup in the console is built from these pieces; nothing in a
 * wizard is bespoke per service except its step content. `test/wizardKit.test.ts` fails a stepper
 * or a `aria-current="step"` anywhere else.
 */
export { AutoList, type AutoItem, type AutoState } from "./AutoList.js";
export { lintFlow } from "./lint.js";
export {
  MAX_FLOW_STEPS,
  type FlowDef,
  type FlowStep,
  type StepKind,
  type WizardStep,
} from "./model.js";
export {
  PrereqList,
  prereqsMet,
  type Prereq,
  type PrereqState,
} from "./PrereqList.js";
export { Stepper, type StepperProps } from "./Stepper.js";
export {
  ChoiceStep,
  DoneStep,
  FormStep,
  SnippetStep,
  type Choice,
  type SnippetTab,
} from "./steps.js";
export { WaitingFor } from "./WaitingFor.js";
export { Wizard, type WizardFooter, type WizardProps } from "./Wizard.js";
