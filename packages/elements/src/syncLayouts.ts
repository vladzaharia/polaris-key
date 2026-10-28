import type { SyncScreenName } from "@polaris-key/ui-core";

import type { Layout } from "./layout.js";

/**
 * The Cloud Sync screens (U-42.2). Each draws its own fields, code and actions in `content`, so
 * the destructive Start over confirm takes the danger fill and the recovery code, its copy button
 * and "No one will ever ask" sit where the screen needs them (U-sync clients plan §8, S13).
 */
export const SYNC_LAYOUTS: Readonly<Record<SyncScreenName, Layout>> = {
  UnlockSync: {
    kind: "screen",
    header: "compact",
    controls: [],
    content: [
      "unlockSync.field",
      "unlockSync.invalid",
      "unlockSync.failed",
      "unlockSync.startOverWarning",
      "recoveryCode.noAsk",
      "unlockSync.unlock",
      "unlockSync.startOver",
      "unlockSync.startOverConfirm",
      "common.tryAgain",
      "common.cancel",
    ],
  },
  RecoveryCode: {
    kind: "screen",
    header: "compact",
    controls: [],
    content: [
      "recoveryCode.copy",
      "recoveryCode.saved",
      "recoveryCode.noAsk",
      "common.done",
    ],
  },
  RingChange: {
    kind: "screen",
    header: "compact",
    controls: [],
    content: [
      "ringChange.failed",
      "ringChange.accept",
      "ringChange.useCode",
      "common.cancel",
    ],
  },
};
