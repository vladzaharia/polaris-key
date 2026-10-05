/**
 * The destructive-action policy (docs/design/ADMIN.md §5.2): every action in the console has one
 * of four levels, and the level decides its confirmation.
 *
 * | Level | Meaning                       | Confirmation                                         |
 * | ----- | ----------------------------- | ---------------------------------------------------- |
 * | L0    | reversible, local             | none; a toast with Undo where an inverse exists       |
 * | L1    | reversible, impactful         | `ConfirmDialog intent="caution"` with consequences    |
 * | L2    | irreversible or broad         | `ConfirmDialog intent="danger"`, the verb on confirm |
 * | L3    | catastrophic                  | `intent="danger"` plus `typedConfirmation`           |
 *
 * A view asks `confirmFor("license.disable")` rather than choosing a dialog by taste; the test
 * asserts every action in §5.2 has a level.
 */

export type ActionLevel = 0 | 1 | 2 | 3;
export type ConfirmIntent = "none" | "neutral" | "caution" | "danger";

export interface ActionPolicy {
  level: ActionLevel;
  /** The confirm dialog's intent (`none` for L0: no dialog). */
  intent: ConfirmIntent;
  /**
   * L3: the operator types a value (the slug, the kid, "reseal", "delete", the store app's name)
   * to confirm.
   */
  typedConfirmation: boolean;
  /**
   * What is typed, for L3 actions. `appName` is the app's name as App Store Connect shows it; the
   * console does not know it, so the dialog supplies its own input and the Worker compares it.
   */
  typed?: "slug" | "kid" | "reseal" | "delete" | "appName";
}

/** Every action named in §5.2, by stable id. */
export const ACTION_LEVELS = {
  // L0 · reversible, local
  "attention.dismiss": 0,
  "preferences.save": 0,
  "filters.clear": 0,
  // Chunk 9: recomputes the server's own answer; no operator choice to confirm.
  "readiness.refresh": 0,

  // L1 · reversible, impactful
  "signing.prepare": 1,
  "signing.activate": 1,
  "license.disable": 1,
  "license.enable": 1,
  "device.resetBinding": 1,
  "rollout.pause": 1,
  "rollout.resume": 1,
  "channel.unpin": 1,
  "channel.markCritical": 1,
  "channel.clearCritical": 1,
  "channel.setMinSupported": 1,
  "channel.promote": 1,
  "channel.pin": 1,
  "manifest.revert": 1,
  "service.disable": 1,
  "repo.resync": 1,
  "sentry.dismiss": 1,
  "rollout.setPercentage": 1,
  // Chunk 9 (Distribution and Update)
  "rollout.start": 1,
  "readiness.clearOverride": 1,
  "outlet.narrowCapabilities": 1,
  "distributionKey.remove": 1,
  "distributionKey.dismiss": 1,
  "outletCredential.rotate": 1,
  "outletCredential.pin": 1,
  "connector.phasedPause": 1,
  "connector.phasedResume": 1,
  "connector.storeFraction": 1,
  "connector.storeResume": 1,
  "connector.publicLink": 1,
  "connector.webhook": 1,
  "connector.priority": 1,
  "connector.settings": 1,
  // App Store Distribute and App Store products (A-17g; notes/S-14 §7.1: "everything else uses a
  // plain confirm"). Each is reversible in App Store Connect or by a later step.
  "connector.betaNotes": 1,
  "connector.testflightGroups": 1,
  "connector.betaReview": 1,
  "connector.versionCreate": 1,
  "connector.versionBuild": 1,
  "connector.versionNotes": 1,
  "connector.releaseType": 1,
  "connector.phasedReleaseCreate": 1,
  "connector.cancelSubmission": 1,
  "connector.iapCreate": 1,
  "connector.iapLocalization": 1,
  // The first price of a new In-App Purchase (the Worker's `initial`); a change is L3 below.
  "connector.iapPrice": 1,
  // Store connections (A-16)
  "storeApp.assign": 1,
  "storeApp.release": 1,
  // Users (I-12): an undo puts a licence back on the subject it was relinked from.
  "user.undoRelink": 1,

  // L2 · irreversible or broad
  "key.revoke": 2,
  // Users (I-12): a detach leaves the licence floating and out of the person's library; a relink
  // moves it to another person of this product (step-up, reason, notices, 72-hour undo).
  "user.detachLicense": 2,
  "user.relink": 2,
  "device.deauthorize": 2,
  "sentry.confirm": 2,
  "release.yank": 2,
  "rollout.halt": 2,
  "rollout.complete": 2,
  "edgeMint.revoke": 2,
  "tier.delete": 2,
  "profile.delete": 2,
  "outletCredential.delete": 2,
  "ciToken.revoke": 2,
  "signing.retire": 2,
  "readiness.override": 2,
  "catalog.publishRemovingKeys": 2,
  // Chunk 9: store-side verbs that cannot be taken back, and a weakened feed check. (An App Store
  // phased release's complete moved to L3 below.)
  "connector.storeHalt": 2,
  "connector.storeComplete": 2,
  // A-17g: a build's export compliance answer cannot be changed through the API once given.
  "connector.exportCompliance": 2,
  "update.signatureOff": 2,

  // L3 · catastrophic (typed confirmation)
  "product.delete": 3,
  "signing.revoke": 3,
  "signing.breakGlassActivate": 3,
  "kek.reseal": 3,
  "portalAccount.delete": 3,
  // Users (I-12): the subject's data of this product (config overrides, Cloud Sync) is gone for
  // good. The subject, its licences and the account stay.
  "user.deleteData": 3,
  // A-17a (owner decision, 2026-10-04): releasing a held App Store version is typed. The Worker
  // compares `confirm` with the app's name in App Store Connect.
  "connector.releaseVersion": 3,
  // Owner decisions (b) and (c), 2026-10-04: completing a phased release releases the version to
  // every user, so it is a release; and every In-App Purchase availability change decides where it
  // is sold (an empty list takes it off sale). Both are typed like a release; the Worker compares.
  "connector.phasedComplete": 3,
  "connector.iapAvailability": 3,
  // A-17d/A-17e (notes/S-14 §7.1): submitting a version for App Review and changing an existing
  // In-App Purchase price are typed with the app's name too; the Worker compares.
  "connector.submitReview": 3,
  "connector.iapPriceChange": 3,

  // Release · channels and yanks (ADMIN.md §6.3), levelled by §5.2's definitions: an unyank and a
  // pack floor change what devices are offered and can be undone (L1); lowering or clearing a
  // rollback floor re-opens a downgrade the floor exists to stop (L2).
  "release.unyank": 1,
  "channel.setPackFloor": 1,
  "channel.lowerFloor": 2,
  "channel.clearFloor": 2,

  // Package feeds (F-11). A rebuild re-renders what is already true (L0). Turning a feed, a
  // product's package feeds or the platform's feeds on or off changes what clients can install
  // and can be undone (L1); so do an unyank and a deprecation. A yank is §5.2's yank (L2), and so
  // is the platform kill switch: it stops every owner's feed of that ecosystem at once.
  "feed.rebuild": 0,
  "feed.disable": 1,
  "feed.bootstrap": 1,
  "packageFeeds.disable": 1,
  "package.unyank": 1,
  "package.deprecate": 1,
  "package.undeprecate": 1,
  "package.yank": 2,
  "feed.policyOff": 2,
  // F-21: leaving `public` refuses every anonymous client within 30 seconds and can be undone
  // (L1); a registry token revocation cannot be undone, and revoking all is broad (both L2).
  "feed.tighten": 1,
  "registryToken.revoke": 2,
  "registryToken.revokeAll": 2,
} as const satisfies Record<string, ActionLevel>;

export type ActionId = keyof typeof ACTION_LEVELS;

/** What an L3 action asks the operator to type. */
const TYPED: Partial<Record<ActionId, ActionPolicy["typed"]>> = {
  "product.delete": "slug",
  "signing.revoke": "kid",
  "signing.breakGlassActivate": "kid",
  "kek.reseal": "reseal",
  "portalAccount.delete": "delete",
  "user.deleteData": "delete",
  "connector.releaseVersion": "appName",
  "connector.phasedComplete": "appName",
  "connector.iapAvailability": "appName",
  "connector.submitReview": "appName",
  "connector.iapPriceChange": "appName",
};

const INTENT: Record<ActionLevel, ConfirmIntent> = {
  0: "none",
  1: "caution",
  2: "danger",
  3: "danger",
};

/** An action's level. */
export function levelOf(action: ActionId): ActionLevel {
  return ACTION_LEVELS[action];
}

/** An action's confirmation policy. */
export function confirmFor(action: ActionId): ActionPolicy {
  const level = levelOf(action);
  return {
    level,
    intent: INTENT[level],
    typedConfirmation: level === 3,
    ...(level === 3 ? { typed: TYPED[action] } : {}),
  };
}

/** Visual weight follows severity (§5.2): the button variant for an action's trigger. */
export function triggerVariant(action: ActionId): "outline" | "danger" {
  return levelOf(action) >= 2 ? "danger" : "outline";
}
