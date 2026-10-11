// @polaris-key/react/update — the headless version-check and decision hooks. Render the shared
// update parts from `@polaris-key/react/kit`.
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
export type {
  StagedUpdate,
  UpdateCheck,
  UpdateDecideOptions,
  UpdateDecision,
  VersionCheck,
} from "../core/index.js";
// `update.packs` for the web transport (P4-06).
export * from "../packs/index.js";
