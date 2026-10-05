/**
 * Licence claim and transfer (I-05; S-16 §5.1, safety defaults owner-confirmed; THREAT-MODEL
 * items 3 and 5).
 *
 *   - First attach only: a FLOATING licence attaches by its key, by the device's enrolled licence
 *     after a confirm screen (P1-07), or automatically when its email is one the account verified.
 *   - An owned licence is refused with `license_owned` on attach and on portal Activate License;
 *     it never moves by key. It moves only when its owner detaches it or a developer relinks it
 *     (`reassignLicense`, called by I-12's relink tool).
 *   - A licence that carries an email attaches by key only to an account that verified that email,
 *     unless the product sets `claimByKey`.
 *   - Each attach notifies the licence's email, if any, when it is not the account's own.
 *   - A licence's `sub` alone never attaches it; it joins an account only through an existing
 *     link (plans/I-04.md §6.1). Legacy `sub`-only licences of custom-issuer products stay
 *     floating until I-17 or layer 2 (§8 Q6).
 *
 * Every attach creates the (account, product) pairwise subject: first contact.
 */

import {
  attachLicenseAccount,
  licenseAccountId,
  moveLicenseAccount,
  subjectFor,
} from "../../../core/accountSubjects.js";
import { getLicense, type LicenseRow } from "../../../core/data.js";
import type { Db } from "../../../core/platform.js";
import {
  clearDeviceSubjects,
  onLicenseOwnershipEnded,
} from "../../../core/subjectHooks.js";
import { getProduct } from "../../../core/data.js";
import { sendNotice } from "../portal/email.js";
import { licenseAttachedNotice } from "../portal/notices.js";
import { getPortalProductSettings, portalAudit } from "../portal/repo.js";
import { endLicenseLinks } from "./legacy.js";
import type { AccountContext } from "./links.js";
import { normalizeEmail, verifiedAccountEmails } from "./repo.js";

/** How a licence reaches an account. */
export type AttachVia =
  /** A licence key, typed in the portal's Activate License or entered in an app. */
  | "key"
  /** The licence the device is enrolled on, after the confirm screen (I-09's attach). */
  | "device"
  /** The licence's email is one this account verified (portal sync, auto-link products only). */
  | "email"
  /** The licence's platform `sub` matches one of this account's OIDC links (portal sync). */
  | "oidc";

export type AttachVerdict =
  | { kind: "attachable" }
  | { kind: "already_yours" }
  | { kind: "license_owned" }
  | { kind: "license_email_bound"; email: string }
  | { kind: "not_found" };

/**
 * The claim rules, read-only. The portal's preview and its claim share this, so the preview can
 * never promise what the claim then refuses. Never says WHICH account owns a licence.
 */
export async function evaluateAttach(
  db: Db,
  accountId: string,
  license: LicenseRow | null,
  via: AttachVia,
): Promise<AttachVerdict> {
  if (!license) return { kind: "not_found" };
  const owner = license.account_id ?? null;
  if (owner === accountId) return { kind: "already_yours" };
  if (owner !== null) return { kind: "license_owned" };
  const email = license.email?.trim();
  if (email && (via === "key" || via === "device")) {
    const settings = await getPortalProductSettings(db, license.product);
    if (settings.claim_by_key !== 1) {
      const verified = await verifiedAccountEmails(db, accountId);
      if (!verified.includes(normalizeEmail(email))) {
        return { kind: "license_email_bound", email };
      }
    }
  }
  return { kind: "attachable" };
}

export type AttachResult =
  | { ok: true; subject: string; attached: boolean }
  | {
      ok: false;
      reason: "license_owned" | "license_email_bound" | "not_found";
      email?: string;
    };

/**
 * Attach a licence to an account under the claim rules. Idempotent for the owner (`attached:
 * false`). The write is conditional on the licence still being floating, so of two concurrent
 * claims exactly one wins and the other reads `license_owned`.
 */
export async function attachLicense(
  ctx: AccountContext,
  args: {
    accountId: string;
    product: string;
    licenseId: string;
    via: AttachVia;
  },
): Promise<AttachResult> {
  const { db, now } = ctx;
  const license = await getLicense(db, args.product, args.licenseId);
  const verdict = await evaluateAttach(db, args.accountId, license, args.via);
  switch (verdict.kind) {
    case "not_found":
      return { ok: false, reason: "not_found" };
    case "license_owned":
      return { ok: false, reason: "license_owned" };
    case "license_email_bound":
      return { ok: false, reason: "license_email_bound", email: verdict.email };
    case "already_yours":
      return {
        ok: true,
        attached: false,
        subject: await subjectFor(db, args.accountId, args.product, now),
      };
    case "attachable":
      break;
  }
  if (
    !(await attachLicenseAccount(
      db,
      args.product,
      args.licenseId,
      args.accountId,
      now,
    ))
  ) {
    // Someone else's attach landed between the read and the write.
    return (await licenseAccountId(db, args.product, args.licenseId)) ===
      args.accountId
      ? {
          ok: true,
          attached: false,
          subject: await subjectFor(db, args.accountId, args.product, now),
        }
      : { ok: false, reason: "license_owned" };
  }
  const subject = await subjectFor(db, args.accountId, args.product, now);
  await portalAudit(db, {
    accountId: args.accountId,
    action: "account.license.attach",
    product: args.product,
    targetKind: "license",
    targetId: args.licenseId,
    summary: `Attached a license (${args.via})`,
    now,
  });
  await notifyLicenseEmail(ctx, args.accountId, license!);
  return { ok: true, subject, attached: true };
}

/** S-16: each attach notifies the licence's own email, unless it is one the account verified. */
async function notifyLicenseEmail(
  ctx: AccountContext,
  accountId: string,
  license: LicenseRow,
): Promise<void> {
  const email = license.email?.trim();
  if (!email) return;
  const verified = await verifiedAccountEmails(ctx.db, accountId);
  if (verified.includes(normalizeEmail(email))) return;
  const product = await getProduct(ctx.db, license.product);
  await sendNotice(
    ctx.env,
    ctx.db,
    email,
    licenseAttachedNotice({
      productName: product?.name ?? null,
      origin: ctx.origin,
    }),
    ctx.now,
  ).catch(() => false);
}

/**
 * The owner detaches a licence: it becomes floating, the developer keeps its record, and every
 * registry token the account minted for it is revoked. Devices keep their binding: a plain detach
 * does not sign anyone out (S-17 §5.8 item 2).
 */
export async function detachLicense(
  ctx: AccountContext,
  args: {
    accountId: string;
    product: string;
    licenseId: string;
    /** The developer detached it from the console (I-12), not the person from the portal. */
    byDeveloper?: boolean;
  },
): Promise<{ ok: boolean }> {
  const { db, env, now } = ctx;
  if (
    (await licenseAccountId(db, args.product, args.licenseId)) !==
    args.accountId
  )
    return { ok: false };
  // Every portal link to the licence ends BEFORE the pointer clears, so the scheduled catch-up
  // can never re-point the floating licence at a not-yet-settled §8 Q1 loser.
  await endLicenseLinks(ctx, args.product, args.licenseId, [args.accountId]);
  const moved = await moveLicenseAccount(
    db,
    args.product,
    args.licenseId,
    args.accountId,
    null,
    now,
  );
  if (!moved) return { ok: false };
  await onLicenseOwnershipEnded(db, env, {
    product: args.product,
    licenseId: args.licenseId,
    accountId: args.accountId,
    reason: "detached",
    now,
  });
  await portalAudit(db, {
    accountId: args.accountId,
    action: "account.license.detach",
    product: args.product,
    targetKind: "license",
    targetId: args.licenseId,
    summary: args.byDeveloper
      ? "The developer removed a license from the library"
      : "Removed a license from the library",
    now,
  });
  return { ok: true };
}

/**
 * The reversible reassign primitive behind I-12's developer relink tool (S-16 §5.4 item 9): move a
 * licence to `toAccountId` (or make it floating), whoever holds it now. The previous owner is
 * returned and audited, so passing it back as `toAccountId` undoes the move. Devices bound by the
 * previous owner's sign-in lose the binding (`relinked`); the previous owner's registry tokens for
 * the licence are revoked. I-12 owns the step-up, the reason, the notice and the 72-hour undo.
 */
export async function reassignLicense(
  ctx: AccountContext,
  args: {
    product: string;
    licenseId: string;
    toAccountId: string | null;
    /** Who did it (`admin:<sub>`); recorded, never shown to the person. */
    actor: string;
  },
): Promise<
  | { ok: true; previousAccountId: string | null }
  | { ok: false; reason: "not_found" | "conflict" }
> {
  const { db, env, now } = ctx;
  const license = await getLicense(db, args.product, args.licenseId);
  if (!license) return { ok: false, reason: "not_found" };
  const previous = license.account_id ?? null;
  if (previous === args.toAccountId)
    return { ok: true, previousAccountId: previous };
  // As in detachLicense: no portal link to the licence survives the move (§8 Q1 losers settled).
  await endLicenseLinks(ctx, args.product, args.licenseId, [
    previous,
    args.toAccountId,
  ]);
  if (
    !(await moveLicenseAccount(
      db,
      args.product,
      args.licenseId,
      previous,
      args.toAccountId,
      now,
    ))
  ) {
    return { ok: false, reason: "conflict" };
  }
  if (previous) {
    await clearDeviceSubjects(
      db,
      env,
      { kind: "license", product: args.product, licenseId: args.licenseId },
      "relinked",
    );
    await onLicenseOwnershipEnded(db, env, {
      product: args.product,
      licenseId: args.licenseId,
      accountId: previous,
      reason: "relinked",
      now,
    });
  }
  if (args.toAccountId)
    await subjectFor(db, args.toAccountId, args.product, now);
  await portalAudit(db, {
    accountId: previous,
    action: "account.license.relink",
    product: args.product,
    targetKind: "license",
    targetId: args.licenseId,
    summary: JSON.stringify({
      from: previous,
      to: args.toAccountId,
      by: args.actor,
    }),
    now,
  });
  return { ok: true, previousAccountId: previous };
}
