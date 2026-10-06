// Every transcript scenario. Adding a scenario here is all it takes for `pnpm gen:transcripts`
// to write it and for the drift check to guard it.

import type { Scenario } from "../world.js";
import {
  bootColdRegister,
  registerOpen,
  registerReregister401,
  telemetryReport,
  telemetryReportUpdates,
} from "./devices.js";
import { discoveryCapabilities, discoveryFailure } from "./discovery.js";
import { distributionDownloadModel } from "./distribution.js";
import {
  devicecodeDefault,
  devicecodeExpired,
  devicecodeHappy,
  devicecodeLabel,
  identityDisabled,
} from "./identity.js";
import {
  activateEnrollDeactivate,
  activateRefusals,
  licenseDeviceLimit,
} from "./license.js";
import { configSchemaFetch } from "./catalog.js";
import {
  releaseChangelog,
  releaseChangelogEntitled,
  releaseFetchGated,
} from "./release.js";
import { edgeMint } from "./mint.js";
import { syncConfigLicenseUnusable, syncErrors, syncEtag304 } from "./sync.js";
import { updateFeedRollback, updateRecordByHash } from "./update.js";
import { commerceClaim } from "./commerce.js";
import { packsChunkRange } from "./packs.js";

export const SCENARIOS: Scenario[] = [
  discoveryCapabilities,
  discoveryFailure,
  syncEtag304,
  syncErrors,
  syncConfigLicenseUnusable,
  activateEnrollDeactivate,
  licenseDeviceLimit,
  registerOpen,
  registerReregister401,
  telemetryReport,
  configSchemaFetch,
  releaseChangelog,
  releaseChangelogEntitled,
  devicecodeHappy,
  devicecodeExpired,
  identityDisabled,
  devicecodeLabel,
  devicecodeDefault,
  edgeMint,
  updateFeedRollback,
  updateRecordByHash,
  commerceClaim,
  packsChunkRange,
  activateRefusals,
  bootColdRegister,
  telemetryReportUpdates,
  releaseFetchGated,
  distributionDownloadModel,
];
