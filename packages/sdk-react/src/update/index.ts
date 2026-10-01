// @polaris-key/react/update — the Update service's UI surface: the headless version-check hook,
// wire v4's headless decision hook, and the slotted prompt built on either.

export {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "./useLatestVersion.js";
export {
  useUpdateDecision,
  type UseUpdateDecision,
  type UseUpdateDecisionOptions,
} from "./useUpdateDecision.js";
export {
  UpdatePrompt,
  type UpdatePromptProps,
  type UpdatePromptSlots,
} from "../components/UpdatePrompt.js";
export type {
  StagedUpdate,
  UpdateCheck,
  UpdateDecideOptions,
  UpdateDecision,
  VersionCheck,
} from "../core/index.js";
