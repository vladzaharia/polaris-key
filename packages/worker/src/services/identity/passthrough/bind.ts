/// <reference types="@cloudflare/workers-types" />

/**
 * Binding a signing-in device to the person's explicit choice, and answering for it
 * (WIRE-CONTRACT-V4 §12.5, §12.5.1; plans/I-04.md §A, §B, §F.3, §G.5).
 *
 * `token` (the choice came from Continue and rides on the code) and `choice/complete` (the choice
 * comes from the app, in a pending sign-in grant) end here, so they cannot differ on the rules:
 *
 *   license   a candidate of the account's own offer, seat-checked (`bindSignedInDevice`). With
 *             `replaceDeviceId` the licence must be FULL; the removal (`planFreeAccountDevice`:
 *             ownership, the portal's shared budget, audit, notice) commits in the same D1 batch
 *             as this device's seat claim, so a lost race rolls both back. Only if the claim
 *             cannot join the batch does the freed device stay freed (`racedAfterFree`).
 *   keep      only the binding, on the licence the device already runs on; needs the device's own
 *             token (`Authorization: Bearer`), the proof that it holds the device.
 *   create    the explicit "Create a new license": minted under the `license-mint` claim, then
 *             bound. Offered only when the policy grants and every candidate is full.
 *   key       a licence key entered in the app: PX-W9's key entry on the `app` surface, counted
 *             exactly once with the seat claim, refusing with `license_owned` and `key_entry_limit`
 *             as `license/activate` does. The device is then also signed in to the account.
 *
 * Nothing here writes a response: the callers render the refusals in their own shape (flat at
 * `token`, nested at the grant routes).
 */

import type { LicenseChoiceInput } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { DeviceRow, LicenseRow } from "../../../core/repo.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { hashKey } from "../../../platform/crypto.js";
import {
  deviceMetadata,
  type PresentedDeviceMetadata,
} from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import { getKey, getLicense, touchKey } from "../../../core/licensing/store.js";
import { authorizeDevice } from "../../../core/licensing/authz.js";
import {
  bindSignedInDevice,
  type BindSignedInDeviceResult,
} from "../../../core/licensing/anchor.js";
import {
  buildManageUrl,
  buildSignInUrl,
} from "../../../core/licensing/manageUrl.js";
import {
  countKeyEntries,
  keyEntryGate,
} from "../../../core/licensing/keyEntries.js";
import { logRefusal } from "../../../core/licensing/refusals.js";
import { setDeviceSubject } from "../../../core/accounts/accountSubjects.js";
import {
  planFreeAccountDevice,
  type PlannedFree,
} from "../portal/freeDevice.js";
import { grantFor, offerFor } from "./choice.js";
import { mintAccountLicense } from "./mint.js";

export type BindChoice =
  | Exclude<LicenseChoiceInput, { kind: "key" }>
  | { kind: "key"; key: string };

export interface BindCx {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  settings?: SettingsRegistry;
}

export interface BindWho {
  accountId: string;
  /** The account's pairwise subject for the product. */
  subject: string;
  /** For the security notice of a Replace. */
  email: string | null;
}

export type BindRefusal =
  | { reason: "license_choice_required" }
  | { reason: "not_found" }
  | { reason: "not_entitled" }
  | { reason: "unauthorized" }
  /** A store or write the bind needs is unavailable; nothing the person did is wrong. Retry. */
  | { reason: "unavailable" }
  | { reason: "rate_limited"; retryAfter: number }
  | {
      reason: "device_limit";
      limit: number;
      deviceCount: number;
      manageUrl?: string;
      racedAfterFree?: true;
    }
  | { reason: "fingerprint_required" }
  | { reason: "hardware_mismatch" }
  | { reason: "license_owned"; signInUrl: string }
  | {
      reason: "key_entry_limit";
      keyEntries: { used: number; limit: number };
      manageUrl?: string;
    };

export type BindResult =
  | {
      ok: true;
      token: string;
      device: DeviceRow;
      licenseId: string;
      keyEntries?: { used: number; limit: number };
    }
  | { ok: false; refusal: BindRefusal };

const refuse = (refusal: BindRefusal): BindResult => ({ ok: false, refusal });

/** The `authorizeDevice` refusal as a bind refusal (with the refusal link on `device_limit`). */
async function authzRefusal(
  cx: BindCx,
  license: LicenseRow | null,
  error: Extract<BindSignedInDeviceResult, { reason: "authz" }>["error"],
): Promise<BindRefusal> {
  switch (error.error) {
    case "device_limit": {
      const manageUrl = license
        ? await buildManageUrl(cx.env, cx.db, cx.req, cx.product, {
            kind: "device_limit",
            license,
          })
        : undefined;
      return {
        reason: "device_limit",
        limit: error.limit,
        deviceCount: error.deviceCount,
        ...(manageUrl !== undefined ? { manageUrl } : {}),
        ...(error.racedAfterFree ? { racedAfterFree: true as const } : {}),
      };
    }
    case "fingerprint_required":
      return { reason: "fingerprint_required" };
    case "hardware_mismatch":
      return { reason: "hardware_mismatch" };
    default:
      return { reason: "not_entitled" };
  }
}

/** Bind `deviceId` to `choice` for the account in `who`. */
export async function bindChoice(
  cx: BindCx,
  who: BindWho,
  device: {
    id: string;
    metadata: PresentedDeviceMetadata;
    label: string | null;
    /** The device's own live token and row, when it presented them (the proof `keep` needs). */
    held?: { token: string; row: DeviceRow } | null;
  },
  choice: BindChoice,
): Promise<BindResult> {
  const { env, db, product, now } = cx;
  const authorize = { ...device.metadata, label: device.label };

  if (choice.kind === "key") return bindKey(cx, who, device, choice.key);

  if (choice.kind === "keep") {
    if (!device.held) return refuse({ reason: "license_choice_required" });
    const kept = await bindSignedInDevice(env, db, product, {
      accountId: who.accountId,
      subject: who.subject,
      deviceId: device.id,
      choice: { kind: "keep" },
      now,
    });
    if (!kept.ok)
      return refuse({
        reason:
          kept.reason === "not_found" ? "not_found" : "license_choice_required",
      });
    return {
      ok: true,
      token: device.held.token,
      device: device.held.row,
      licenseId: kept.licenseId,
    };
  }

  let plan: PlannedFree | null = null;
  let bound: BindSignedInDeviceResult;
  let boundLicense: LicenseRow | null = null;

  if (choice.kind === "create") {
    const grant = await grantFor(cx, who.accountId);
    if (!grant) return refuse({ reason: "license_choice_required" });
    let mintRefused = false;
    let mintDown = false;
    bound = await bindSignedInDevice(env, db, product, {
      accountId: who.accountId,
      subject: who.subject,
      deviceId: device.id,
      choice: { kind: "create" },
      now,
      rank: { grantTierId: grant.tierId ?? "" },
      authorize,
      mint: async () => {
        let out: Awaited<ReturnType<typeof mintAccountLicense>>;
        try {
          out = await mintAccountLicense(
            cx,
            who.accountId,
            "create",
            device.id,
          );
        } catch {
          // The claim store is unreachable: fail closed, mint nothing, let the person retry.
          mintDown = true;
          return null;
        }
        if (out.kind !== "minted") {
          mintRefused = true;
          return null;
        }
        boundLicense = out.license;
        return out.license;
      },
    });
    if (!bound.ok && mintDown) return refuse({ reason: "unavailable" });
    if (!bound.ok && mintRefused)
      return refuse({ reason: "license_choice_required" });
  } else {
    // A candidate of the account's own offer, and for Replace a FULL one.
    const offer = await offerFor(cx, who.accountId, device.id);
    const row = offer.candidates.find((c) => c.licenseId === choice.licenseId);
    if (!row) return refuse({ reason: "not_found" });
    boundLicense = await getLicense(db, product.slug, choice.licenseId);
    if (choice.replaceDeviceId !== undefined) {
      if (row.state !== "full" || choice.replaceDeviceId === device.id)
        return refuse({ reason: "not_found" });
      plan = await planFreeAccountDevice(
        cx.req,
        env,
        db,
        { accountId: who.accountId, email: who.email },
        product.slug,
        choice.licenseId,
        choice.replaceDeviceId,
        now,
        { forLabel: device.label },
      );
      if (!plan.ok)
        return refuse(
          plan.reason === "rate_limited"
            ? { reason: "rate_limited", retryAfter: plan.retryAfter }
            : { reason: "not_found" },
        );
    }
    bound = await bindSignedInDevice(env, db, product, {
      accountId: who.accountId,
      subject: who.subject,
      deviceId: device.id,
      choice: { kind: "license", licenseId: choice.licenseId },
      now,
      authorize: {
        ...authorize,
        ...(plan?.ok
          ? {
              replace: {
                freedDeviceId: choice.replaceDeviceId!,
                statements: plan.statements,
              },
            }
          : {}),
      },
    });
  }

  if (!bound.ok) {
    if (bound.reason === "authz") {
      // The removal committed but the claim could not join: the freed device stays freed, audited
      // and emailed, and the person chooses again.
      if (
        plan?.ok &&
        bound.error.error === "device_limit" &&
        bound.error.racedAfterFree
      )
        await plan.finish();
      return refuse(await authzRefusal(cx, boundLicense, bound.error));
    }
    if (bound.reason === "not_found") return refuse({ reason: "not_found" });
    if (bound.reason === "not_bindable")
      return refuse({ reason: "not_entitled" });
    return refuse({ reason: "license_choice_required" });
  }
  if (plan?.ok && bound.replaced) await plan.finish();
  if (!bound.token || !bound.device)
    return refuse({ reason: "license_choice_required" });
  return {
    ok: true,
    token: bound.token,
    device: bound.device,
    licenseId: bound.licenseId,
  };
}

/** A key entered in the app (PX-W9 on the `app` surface), then the account on the device. */
async function bindKey(
  cx: BindCx,
  who: BindWho,
  device: {
    id: string;
    metadata: PresentedDeviceMetadata;
    label: string | null;
  },
  key: string,
): Promise<BindResult> {
  const { env, db, product, now, req } = cx;
  if (!product.services.license.enabled) return refuse({ reason: "not_found" });
  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active")
    return refuse({ reason: "unauthorized" });
  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!license) return refuse({ reason: "unauthorized" });

  const gate = await keyEntryGate(
    { env, db, ...(cx.settings ? { registry: cx.settings } : {}) },
    product,
    license,
    device.id,
    now,
  );
  if (gate.kind === "refuse" || gate.kind === "owned") {
    await logRefusal(db, {
      product: product.slug,
      licenseId: license.id,
      deviceId: device.id,
      reason: gate.kind === "owned" ? "license_owned" : "key_entry_limit",
      at: now,
      platform: device.metadata.platform,
      arch: device.metadata.arch,
      userAgent: device.metadata.userAgent,
    });
    if (gate.kind === "owned")
      return refuse({
        reason: "license_owned",
        signInUrl: await buildSignInUrl(env, db, req, product),
      });
    const manageUrl = await buildManageUrl(env, db, req, product, {
      kind: "key_entry_limit",
    });
    return refuse({
      reason: "key_entry_limit",
      keyEntries: gate.keyEntries,
      ...(manageUrl !== undefined ? { manageUrl } : {}),
    });
  }

  const authorized = await authorizeDevice(
    env,
    db,
    product,
    license,
    device.id,
    now,
    {
      ...device.metadata,
      label: device.label,
      // A key binds by key: signing the account in on top must not let a sign-out release it.
      boundBy: "key",
      ...(gate.kind === "admit"
        ? { keyEntry: { surface: "app" as const } }
        : {}),
    },
  );
  if ("error" in authorized)
    return refuse(await authzRefusal(cx, license, authorized));
  await touchKey(db, product.slug, keyHash, now);
  // The seat and its counted entry are committed. If the account cannot be written onto the
  // device now, answer a retryable 503 and let the caller put the grant back: the retry finds the
  // device enrolled (never counted twice) and writes the subject.
  if (!(await setDeviceSubject(env, db, product.slug, device.id, who.subject)))
    return refuse({ reason: "unavailable" });
  const row =
    (await getDevice(db, product.slug, device.id)) ?? authorized.device;
  return {
    ok: true,
    token: authorized.token,
    device: row,
    licenseId: license.id,
    ...(gate.kind === "admit"
      ? {
          keyEntries: {
            used: await countKeyEntries(db, product.slug, license.id),
            limit: gate.keyEntries.limit,
          },
        }
      : {}),
  };
}

export { deviceMetadata };
