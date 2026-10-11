/**
 * I-11: the state a D1 Time Travel restore leaves behind for an erased account, as a test sets it
 * up. The account is erased through the real state machine (`deleteAccount`: the write-ahead
 * ledger record first, then the closing batch and the stores' deletes), and D1 is then rewound to
 * the moment before, while R2 (the ledger), KV and every other binding keep what they hold. D1 says
 * `active` again and holds the account's sessions, sign-in methods, subjects and registry tokens;
 * the ledger holds its id. No replay has run, which is the window the request-time fence closes
 * (`core/accounts/erasureFence.ts`).
 *
 * `ctx.env.BLOBS` must be bound (`makeEnv` binds an empty bucket). Arrange everything first; the
 * snapshot is taken here, immediately before the erasure, and returned so a test can restore it
 * again later or compare against it.
 */
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import { restoreDb, snapshotDb, type DbSnapshot } from "./d1Restore.js";
import { R2Mock } from "./r2Mock.js";

export async function eraseAndRestore(
  ctx: AccountContext,
  accountId: string,
): Promise<DbSnapshot> {
  const bookmark = await snapshotDb(ctx.db);
  const erased = await deleteAccount(ctx, accountId);
  if (!erased.ok) throw new Error(`erasing ${accountId} did not complete`);
  await restoreDb(ctx.db, bookmark);
  return bookmark;
}

/**
 * A bucket the fence reads through: it records every key it was asked to `head`, and fails them
 * all like an R2 5xx while `down` is set. Bind it with `env.BLOBS = asR2(bucket)`.
 */
export class LedgerBucket extends R2Mock {
  /** Every key `head` was called with, in order. */
  readonly heads: string[] = [];
  /** While set, `head` throws as R2 does on a server error. */
  down = false;

  override async head(key: string) {
    this.heads.push(key);
    if (this.down) throw new Error("R2 5xx");
    return super.head(key);
  }
}
