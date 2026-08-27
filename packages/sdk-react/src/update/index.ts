// @plrs/react/update — the Update service's UI surface: the headless version-check hook and
// the slotted prompt built on it.

export {
  useLatestVersion,
  type UseLatestVersion,
  type UseLatestVersionOptions,
} from "./useLatestVersion.js";
export {
  UpdatePrompt,
  type UpdatePromptProps,
  type UpdatePromptSlots,
} from "../components/UpdatePrompt.js";
export type { VersionCheck } from "../core/index.js";
