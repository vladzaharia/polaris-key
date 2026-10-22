/**
 * LX-26 N1 / LX-27c.3: the "<Product> is in your Polaris Locker library, from <developer>" notice a
 * person gets when a license waiting on their address joins their account at that address's
 * verification (the account-email hook's callers and the sign-in's link sweep).
 *
 * Who gets it: only the address that was just verified on the account, which is also the
 * license's own address. Never an unverified address and never another of the account's.
 * One per product however many licenses of it joined; none for a license an invitation already
 * went out for (`invited_at`: the invitation said what would happen), and none for a license that is not active and
 * unexpired (the attach is unchanged; there is just nothing to announce). A send that does not go out
 * (no mail binding, suppressed, a provider error) is swallowed: the join already committed and the
 * worker has no logging; nothing here is audited, as the join is (`account.license.attach`).
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { JoinedLicense } from "../../../core/licensing/licenseHolders.js";
import { productDeveloperName } from "../../../core/presentation.js";
import { customerOrigin } from "../../../core/hosts.js";
import { syncAccountLicenseLinks } from "../portal/repo.js";
import { sendNotice } from "../../../core/notify/send.js";
import { licenseFromDeveloperNotice } from "../../../core/notify/templates.js";

export async function sendLibraryNotices(
  env: Env,
  db: Db,
  args: {
    /** The address that was verified; the notice goes to it alone. */
    to: string;
    joined: readonly JoinedLicense[];
    origin: string;
    now: number;
  },
): Promise<number> {
  const products = [
    ...new Set(
      args.joined
        .filter((j) => j.active && j.invitedAt === null)
        .map((j) => j.product),
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
      // Core's read of the presented developer name; the product name stands in when none.
      const developerName = await productDeveloperName(env, db, slug, args.now);
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

/** The origin a notice links to for a request: the customer site, else the origin it was reached on. */
export function noticeOrigin(env: Env, req: Request): string {
  return customerOrigin(env, req) ?? new URL(req.url).origin;
}

/**
 * The portal's link sweep for an account, with the library notice for every license that joined
 * by address (same rules as the hook: the verified address only, none for an invited license,
 * one per product). Without an `origin` the sweep still runs and no notice is sent.
 */
export async function syncLicenseLinksAndNotify(
  env: Env,
  db: Db,
  accountId: string,
  now: number,
  origin: string | null,
): Promise<void> {
  await syncAccountLicenseLinks(
    db,
    accountId,
    now,
    origin === null
      ? undefined
      : async (joined, email) => {
          await sendLibraryNotices(env, db, { to: email, joined, origin, now });
        },
  );
}
