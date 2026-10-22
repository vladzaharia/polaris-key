/**
 * LX-26 N1 / LX-27c.3: the "<Product> is in your Polaris Locker library, from <developer>" notice a
 * person gets when a license waiting on their address joins their account at that address's
 * verification (the account-email hook's callers and the sign-in's link sweep).
 *
 * Who gets it: only the address that was just verified on the account, which is also the
 * license's own address. Never an unverified address and never another of the account's.
 * One per product however many licenses of it joined; none for a license an invitation already
 * went out for (`invited_at`: the invitation said what would happen). A send that does not go out
 * (no mail binding, suppressed, a provider error) is swallowed: the join already committed and the
 * worker has no logging; nothing here is audited, as the join is (`account.license.attach`).
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { JoinedLicense } from "../../../core/licensing/licenseHolders.js";
import { sendNotice } from "../../../core/notify/send.js";
import { licenseFromDeveloperNotice } from "../../../core/notify/templates.js";

/** Resolves a product's developer name (the listing's), or null. Optional: the product name stands in. */
export type DeveloperNameOf = (product: string) => Promise<string | null>;

export async function sendLibraryNotices(
  env: Env,
  db: Db,
  args: {
    /** The address that was verified; the notice goes to it alone. */
    to: string;
    joined: readonly JoinedLicense[];
    origin: string;
    now: number;
    developerNameOf?: DeveloperNameOf;
  },
): Promise<number> {
  const products = [
    ...new Set(
      args.joined.filter((j) => j.invitedAt === null).map((j) => j.product),
    ),
  ];
  let sent = 0;
  for (const slug of products) {
    try {
      const row = await db.first<{ name: string }>(
        "SELECT name FROM products WHERE slug = ?",
        slug,
      );
      if (!row) continue;
      let developerName: string | null = null;
      try {
        developerName = (await args.developerNameOf?.(slug)) ?? null;
      } catch {
        // Display data only: the product name stands in.
      }
      const message = licenseFromDeveloperNotice({
        productName: row.name,
        productSlug: slug,
        developerName,
        origin: args.origin,
      });
      if (await sendNotice(env, db, args.to, message, args.now)) sent += 1;
    } catch {
      // The join committed; a notice that fails never undoes or reports it.
    }
  }
  return sent;
}
