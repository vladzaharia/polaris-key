// The signing-key state machine in one place.
//
//   staged  -> active   (activate; retires the outgoing active key in the same batch)
//   staged  -> retired  (retire)
//   staged  -> revoked  (revoke)
//   retired -> revoked  (revoke)
//   active  -> (nothing: activate a replacement first)
//   revoked -> (nothing: terminal)
//
// Every write is a conditional UPDATE, so a lost race changes 0 rows and the caller answers 409.
import type { DbStatement } from "./db/types.js";

export type KeyStatus = "active" | "staged" | "retired" | "revoked";
export type KeyAction = "activate" | "retire" | "revoke";

export const KEY_TRANSITIONS: Record<KeyAction, readonly KeyStatus[]> = {
  activate: ["staged"],
  retire: ["staged"],
  revoke: ["staged", "retired"],
};

export function keyTransitionAllowed(action: KeyAction, from: string): boolean {
  return (KEY_TRANSITIONS[action] as readonly string[]).includes(from);
}

/**
 * Activation as one atomic batch. The outgoing active key is retired only while the target is
 * still staged, and the target is promoted only while staged, so a concurrent revoke/retire of
 * the target leaves BOTH statements at 0 rows: never zero active keys, never a revoked active key.
 * Returns the statements; the target promotion is the LAST one (its change count is the verdict).
 */
export function stmtsActivateKey(
  product: string,
  kid: string,
  at: number,
): DbStatement[] {
  return [
    {
      sql: `UPDATE product_keys SET status = 'retired', rotated_at = ?
            WHERE product = ? AND status = 'active'
              AND EXISTS (SELECT 1 FROM product_keys WHERE product = ? AND kid = ? AND status = 'staged')`,
      params: [at, product, product, kid],
    },
    {
      sql: `UPDATE product_keys SET status = 'active', rotated_at = ?
            WHERE product = ? AND kid = ? AND status = 'staged'`,
      params: [at, product, kid],
    },
  ];
}

/** Retire or revoke, guarded by the transition table; `revoked_at` is only ever set here. */
export function stmtRetireOrRevokeKey(
  action: "retire" | "revoke",
  product: string,
  kid: string,
  at: number,
): DbStatement {
  const from = KEY_TRANSITIONS[action];
  const list = from.map((s) => `'${s}'`).join(", ");
  return {
    sql: `UPDATE product_keys SET status = ?, rotated_at = ?, revoked_at = ?
          WHERE product = ? AND kid = ? AND status IN (${list})`,
    params: [
      action === "retire" ? "retired" : "revoked",
      at,
      action === "revoke" ? at : null,
      product,
      kid,
    ],
  };
}
