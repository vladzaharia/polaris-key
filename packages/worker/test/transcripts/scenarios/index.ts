// Every transcript scenario. Adding a scenario here is all it takes for `pnpm gen:transcripts`
// to write it and for the drift check to guard it.

import type { Scenario } from "../world.js";
import {
  registerOpen,
  registerReregister401,
  telemetryReport,
} from "./devices.js";
import { discoveryCapabilities, discoveryFailure } from "./discovery.js";
import {
  devicecodeExpired,
  devicecodeHappy,
  identityDisabled,
} from "./identity.js";
import { activateEnrollDeactivate } from "./license.js";
import { configSchemaFetch } from "./catalog.js";
import { releaseChangelog, releaseChangelogEntitled } from "./release.js";
import { edgeMint } from "./mint.js";
import { syncErrors, syncEtag304 } from "./sync.js";
import { updateFeedRollback, updateRecordByHash } from "./update.js";
import { commerceClaim } from "./commerce.js";
import { packsChunkRange } from "./packs.js";

export const SCENARIOS: Scenario[] = [
  discoveryCapabilities,
  discoveryFailure,
  syncEtag304,
  syncErrors,
  activateEnrollDeactivate,
  registerOpen,
  registerReregister401,
  telemetryReport,
  configSchemaFetch,
  releaseChangelog,
  releaseChangelogEntitled,
  devicecodeHappy,
  devicecodeExpired,
  identityDisabled,
  edgeMint,
  updateFeedRollback,
  updateRecordByHash,
  commerceClaim,
  packsChunkRange,
];
