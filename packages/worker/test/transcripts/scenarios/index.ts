// Every transcript scenario. Adding a scenario here is all it takes for `pnpm gen transcripts`
// to write it and for the drift check to guard it.

import type { Scenario } from "../world.js";
import {
  bootColdRegister,
  registerOpen,
  registerReregister401,
  telemetryReport,
  telemetryReportUpdates,
} from "./devices.js";
import {
  discoveryCapabilities,
  discoveryFailure,
  discoveryPortal,
  discoveryPresentation,
} from "./discovery.js";
import { distributionDownloadModel } from "./distribution.js";
import {
  devicecodeDefault,
  devicecodeDenied,
  devicecodeExpired,
  devicecodeFailed,
  devicecodeHappy,
  devicecodeLabel,
  devicecodeMintRetry,
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
import {
  syncConfigLicenseUnusable,
  syncErrors,
  syncEtag304,
  trustSignerRetry,
} from "./sync.js";
import { updateFeedRollback, updateRecordByHash } from "./update.js";
import { commerceClaim } from "./commerce.js";
import { packsChunkRange } from "./packs.js";
import {
  keyentryIdentityOff,
  keyentryLimit,
  keyentryOwned,
  keyentryRefusalsOff,
} from "./keyEntry.js";
import {
  discoveryIdentity,
  identityAttach,
  identityAttachErrors,
  identitySubjectSignout,
} from "./account.js";

import {
  identityRequestHints,
  redirectWebErrors,
  redirectWebHappy,
} from "./redirect.js";

import { CHOICE_SCENARIOS } from "./choice.js";
import { CLOUD_SYNC_SCENARIOS } from "./cloudSync.js";
import { CLOUD_SYNC_RECORDS_SCENARIOS } from "./cloudSyncRecords.js";
import { CONNECT_SCENARIOS } from "./connect.js";
import { KEYRING_SCENARIOS } from "./keyring.js";
import { LOCKER_SCENARIOS } from "./locker.js";
import { EXCHANGE_SCENARIOS } from "./exchange.js";
import { HOLDERS_SCENARIOS } from "./holders.js";
import { LINK_SCENARIOS } from "./link.js";

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
  devicecodeDenied,
  devicecodeExpired,
  devicecodeFailed,
  devicecodeMintRetry,
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
  keyentryLimit,
  keyentryRefusalsOff,
  keyentryIdentityOff,
  discoveryPresentation,
  discoveryPortal,
  trustSignerRetry,
  keyentryOwned,
  discoveryIdentity,
  identityAttach,
  identityAttachErrors,
  identitySubjectSignout,
  redirectWebHappy,
  redirectWebErrors,
  identityRequestHints,
  ...CHOICE_SCENARIOS,
  ...LOCKER_SCENARIOS,
  ...EXCHANGE_SCENARIOS,
  ...LINK_SCENARIOS,
  ...CLOUD_SYNC_SCENARIOS,
  ...CLOUD_SYNC_RECORDS_SCENARIOS,
  ...KEYRING_SCENARIOS,
  ...CONNECT_SCENARIOS,
  ...HOLDERS_SCENARIOS,
];
