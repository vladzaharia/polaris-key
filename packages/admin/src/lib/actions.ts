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
  /** L3: the operator types a value (the slug, the kid, "reseal", "delete") to confirm. */
  typedConfirmation: boolean;
  /** What is typed, for L3 actions. */
  typed?: "slug" | "kid" | "reseal" | "delete";
}

/** Every action named in §5.2, by stable id. */
export const ACTION_LEVELS = {
  // L0 · reversible, local
  "attention.dismiss": 0,
  "preferences.save": 0,
  "filters.clear": 0,

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

  // L2 · irreversible or broad
  "key.revoke": 2,
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

  // L3 · catastrophic (typed confirmation)
  "product.delete": 3,
  "signing.revoke": 3,
  "signing.breakGlassActivate": 3,
  "kek.reseal": 3,
  "portalAccount.delete": 3,

  // Release · channels and yanks (ADMIN.md §6.3), levelled by §5.2's definitions: an unyank and a
  // pack floor change what devices are offered and can be undone (L1); lowering or clearing a
  // rollback floor re-opens a downgrade the floor exists to stop (L2).
  "release.unyank": 1,
  "channel.setPackFloor": 1,
  "channel.lowerFloor": 2,
  "channel.clearFloor": 2,
} as const satisfies Record<string, ActionLevel>;

export type ActionId = keyof typeof ACTION_LEVELS;

/** What an L3 action asks the operator to type. */
const TYPED: Partial<Record<ActionId, ActionPolicy["typed"]>> = {
  "product.delete": "slug",
  "signing.revoke": "kid",
  "signing.breakGlassActivate": "kid",
  "kek.reseal": "reseal",
  "portalAccount.delete": "delete",
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
