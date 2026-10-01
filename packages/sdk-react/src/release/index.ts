// @polaris-key/react/release — the Release service's UI surface: the headless changelog hook.
// The adapter's `installUrl()` / `downloadUrl()` build the install and artifact URLs.

export {
  useChangelog,
  type UseChangelog,
  type UseChangelogOptions,
} from "./useChangelog.js";
export type { ChangelogEntry, DownloadUrlOptions } from "../core/index.js";
