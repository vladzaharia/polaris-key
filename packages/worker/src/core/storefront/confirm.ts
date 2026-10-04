/**
 * Typed confirmation, shared by every store (A-18a; notes/S-15 §6.4, generalised from A-17a's
 * `checkTypedConfirmation`).
 *
 * The owner's rule: submit for review, release and any price change are confirmed by TYPING the
 * app's name, on every store. Two halves enforce it:
 *
 *   1. the handler reads the app's name as the store reports it NOW (the adapter's confirmation
 *      phrase) and compares it with what the operator typed, through `typedConfirmationRefusal`;
 *   2. only then does it assert `typedConfirmation: true` to the gate, which refuses a `typed`
 *      rule without it (`gate.ts`), so a handler that skips step 1 still cannot send.
 *
 * The comparison trims surrounding whitespace and is otherwise exact (case included): the point is
 * that the operator looked at which app they are acting on.
 */

/** What an adapter asks the operator to type. */
export interface ConfirmationPhrase {
  /** Always the app's name as the store reports it (Apple's app name, Play's default title…). */
  readonly phrase: "app-name";
  /** How the store is named in a refusal: "the app's name in <label>". */
  readonly label: string;
}

/** Why a typed confirmation was refused (the handler maps it onto its own answer shape). */
export interface ConfirmationRefusal {
  readonly status: 422;
  readonly reason: "confirmation_required" | "confirmation_mismatch";
  readonly message: string;
  readonly fields: readonly ["confirm"];
}

/** The refusal for a missing or blank `confirm`, or null when something was typed. */
export function confirmationMissing(
  typed: unknown,
  action: string,
): ConfirmationRefusal | null {
  return typeof typed === "string" && typed.trim() !== ""
    ? null
    : {
        status: 422,
        reason: "confirmation_required",
        message: `type the app's name in confirm to ${action}`,
        fields: ["confirm"],
      };
}

/**
 * Compare what the operator typed with the store's current name for the app. `storeName` is null
 * when the store did not report one: that refuses, never passes.
 */
export function typedConfirmationRefusal(
  typed: unknown,
  storeName: string | null,
  action: string,
  phrase: ConfirmationPhrase,
): ConfirmationRefusal | null {
  const missing = confirmationMissing(typed, action);
  if (missing) return missing;
  if (!storeName || (typed as string).trim() !== storeName.trim())
    return {
      status: 422,
      reason: "confirmation_mismatch",
      message: `confirm does not match the app's name in ${phrase.label}`,
      fields: ["confirm"],
    };
  return null;
}
