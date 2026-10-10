/**
 * A product's sign-in settings (I-12; S-16 §5.2 "Sign-in settings" and "Branding"), shown in the
 * console only while the product's Identity toggle is on.
 *
 * What lives here today, and where each value is stored:
 *
 *   - `claimByKey`: an email-bound licence may attach by its key without the verified email
 *     (`portal_product_settings.claim_by_key`, the column the claim rules already read). Since
 *     I-09 it is the registry setting `identity.keyEntry.claimByKey`, which the manifest's
 *     `identity:` block may declare; the console writes it through `writeSetting()`;
 *   - the passthrough header's app name ("<App> wants you to sign in"), which is also the <App>
 *     of the "<App> via Polaris Key" sender of passthrough mail (I-18). It reuses
 *     `portal_product_settings.branding_json` (S-16 §5.2), under the key `passthroughName`, and
 *     passes the same reserved-name validator as the sender (`checkSenderAppName`: a length cap, no
 *     control characters, quotes or angle brackets, no reserved name). Unset, the product's
 *     display name is used. The login card itself stays Polaris-branded; the header's icon is the
 *     product's icon;
 *   - the App Review 4.8 warning: an iOS device has used this product and the product declares no
 *     native Sign in with Apple. Native platform config arrives with I-13/I-14, so until then any
 *     product with iOS devices carries the warning.
 *
 * The rest of the manifest's `identity:` block (`identity.keyEntry.limit`, `identity.terms`,
 * `identity.redirectPaths`) is claimable `product_settings` rows (I-09, `settings.ts`); there is no
 * `identity_product_settings` table and no `identity.native`. The per-kind setup checklist and the
 * "test sign-in" dry run belong with the native verifiers (I-13, I-14).
 */

import type { Db } from "../../core/platform.js";
import {
  checkSenderAppName,
  type SenderNameRefusal,
} from "../../core/emailSender.js";
import {
  getPortalProductSettings,
  type PortalSettingsPatch,
} from "./portal/repo.js";

export interface SignInSettingsView {
  claimByKey: boolean;
  /** The stored header name, or `null` when the product's display name is used. */
  passthroughName: string | null;
  /** The name the header and the passthrough sender actually use. */
  effectiveName: string;
  /** App Review 4.8: an iOS device has used the product and no native Apple sign-in is set. */
  appReview48Warning: boolean;
}

function brandingObject(
  json: string | null | undefined,
): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The stored passthrough header name, when it still passes the validator. */
function storedPassthroughName(json: string | null | undefined): string | null {
  const raw = brandingObject(json).passthroughName;
  const check = checkSenderAppName(raw);
  return check.ok ? check.name : null;
}

/**
 * The <App> of "<App> wants you to sign in" and of "<App> via Polaris Key": the stored header name,
 * else the product's display name. The passthrough flows (I-07, I-08) and their mail (I-18's
 * `deliverEmail` sender `displayName`) read it here.
 */
export async function passthroughDisplayName(
  db: Db,
  product: { slug: string; name: string },
): Promise<string> {
  const settings = await getPortalProductSettings(db, product.slug);
  return storedPassthroughName(settings?.branding_json) ?? product.name;
}

async function iosDevicesSeen(db: Db, product: string): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM devices WHERE product = ? AND platform = 'ios' LIMIT 1",
    product,
  );
  return row !== null;
}

export async function signInSettingsView(
  db: Db,
  product: { slug: string; name: string },
): Promise<SignInSettingsView> {
  const settings = await getPortalProductSettings(db, product.slug);
  const stored = storedPassthroughName(settings?.branding_json);
  return {
    claimByKey: settings?.claim_by_key === 1,
    passthroughName: stored,
    effectiveName: stored ?? product.name,
    appReview48Warning: await iosDevicesSeen(db, product.slug),
  };
}

export type SignInSettingsPatchPlan =
  | {
      ok: true;
      /** The portal-row part (the passthrough name in `branding_json`); empty when unchanged. */
      patch: PortalSettingsPatch;
      /** The requested `identity.keyEntry.claimByKey`, which the caller writes through
       *  `writeSetting()` (it is a registry setting since I-09). */
      claimByKey?: boolean;
    }
  | {
      ok: false;
      fields: Array<{ field: string; reason: SenderNameRefusal | "type" }>;
    };

/**
 * Check a console edit, writing nothing: `claimByKey` (boolean) and `passthroughName` (string, or
 * null to unset). The caller writes the plan in one batch, so a refused value saves nothing.
 */
export async function planSignInSettingsPatch(
  db: Db,
  product: { slug: string; name: string },
  body: Record<string, unknown>,
): Promise<SignInSettingsPatchPlan> {
  const fields: Array<{ field: string; reason: SenderNameRefusal | "type" }> =
    [];
  const patch: PortalSettingsPatch = {};
  let claimByKey: boolean | undefined;
  if (body.claimByKey !== undefined) {
    if (typeof body.claimByKey !== "boolean")
      fields.push({ field: "claimByKey", reason: "type" });
    else claimByKey = body.claimByKey;
  }
  if (body.passthroughName !== undefined) {
    const current = await getPortalProductSettings(db, product.slug);
    const branding = brandingObject(current?.branding_json);
    if (body.passthroughName === null || body.passthroughName === "") {
      delete branding.passthroughName;
      patch.branding = Object.keys(branding).length ? branding : null;
    } else {
      const check = checkSenderAppName(body.passthroughName);
      if (!check.ok)
        fields.push({ field: "passthroughName", reason: check.reason });
      else patch.branding = { ...branding, passthroughName: check.name };
    }
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    patch,
    ...(claimByKey !== undefined ? { claimByKey } : {}),
  };
}
