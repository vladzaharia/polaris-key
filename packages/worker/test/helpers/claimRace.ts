/**
 * CORE-SEAT-GUARD: a deterministic stand-in for the owned-licence race. `claimRace` wraps a Db so
 * that the FIRST seat-claim read (`claimDeviceSeat`'s `SELECT seat_no FROM devices ... 'authorized'`,
 * which runs after the caller read the licence and decided it was in no account, and before the
 * seat batch) first puts the licence into an account, as an owner's claim committing in that
 * window would. Every other call passes straight through.
 */

import type { Db } from "../../src/db/types.js";

export interface ClaimRace<T extends Db> {
  /** The Db to hand to the Worker. */
  db: T;
  /** How many times the claim landed (0 or 1). */
  fired(): number;
}

export function claimRace<T extends Db>(
  db: T,
  licenseId: string,
  accountId = "acct_race",
): ClaimRace<T> {
  let fired = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === "first") {
        return async (sql: string, ...params: never[]) => {
          if (
            fired === 0 &&
            /FROM devices/.test(sql) &&
            /seat_no FROM devices/.test(sql) &&
            /authorized/.test(sql)
          ) {
            fired++;
            await target.run(
              "UPDATE licenses SET account_id = ? WHERE id = ?",
              accountId,
              licenseId,
            );
          }
          return (target.first as (s: string, ...p: never[]) => unknown).call(
            target,
            sql,
            ...params,
          );
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { db: wrapped, fired: () => fired };
}
