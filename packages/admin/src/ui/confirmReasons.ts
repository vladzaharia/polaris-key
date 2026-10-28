/**
 * Why a confirm button is off, in the reader's words (ConfirmDialog's `confirmDisabledReason`).
 * Each reason names the missing step once; it never repeats a label drawn beside the button.
 * `test/ui/confirmDisabledReasons.test.ts` fails when a `confirmDisabled` caller has none.
 */
export const NEEDS_REASON = "Add a reason to continue";
export const NEEDS_SIGN_IN = "Sign in again to continue";
export const NEEDS_APP_NAME = "Type the app name to continue";

/**
 * The first gate that blocks, as its reason: `blocker([!fresh, NEEDS_SIGN_IN], [!reason, NEEDS_REASON])`.
 * Order the gates the way the dialog reads, top to bottom. `undefined` when nothing blocks.
 */
export function blocker(
  ...gates: ReadonlyArray<readonly [blocked: boolean, reason: string]>
): string | undefined {
  return gates.find(([blocked]) => blocked)?.[1];
}

/** The two props a gated confirm takes, so one list of gates sets both and they cannot disagree. */
export interface ConfirmBlock {
  confirmDisabled: boolean;
  confirmDisabledReason?: string;
}

/** `<ConfirmDialog {...confirmBlocked([!fresh, NEEDS_SIGN_IN], [!why, NEEDS_REASON])} />`. */
export function confirmBlocked(
  ...gates: ReadonlyArray<readonly [blocked: boolean, reason: string]>
): ConfirmBlock {
  const reason = blocker(...gates);
  return {
    confirmDisabled: reason !== undefined,
    confirmDisabledReason: reason,
  };
}
