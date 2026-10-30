/// <reference types="@cloudflare/workers-types" />

/**
 * The app-mode settle: what a sign-in that found its account does when the APP runs the licence
 * choice (`licenseChoice: "app"`; WIRE-CONTRACT-V5 §12.5.1, §12.10.1).
 *
 * `token` (the web redirect and the token exchange) and the device-code poll end here, so they
 * cannot differ on when a choice is due:
 *
 *   due     the account holds a candidate, the device runs on a licence outside the list (`keep`),
 *           or it holds none, the policy grants none and the product accepts keys.
 *   silent  the exchange found the person's consent standing and exactly one licence has a free
 *           seat: that licence binds with no tap.
 *   grant   a choice is due: the pending sign-in grant (`sg_…`, 300 s) and the view the app renders.
 *   none    nothing is due: the device binds as `token` binds with no choice (`bindWithoutChoice`).
 *
 * Nothing here writes a response, mints a licence or touches the flow: the callers render the
 * outcome in their own shape. A grant is the only thing written, and only when a choice is due.
 */

import {
  CHOICE_GRANT_TTL_SECONDS,
  type PendingSignIn,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { DeviceRow } from "../../../core/repo.js";
import {
  NO_LICENSE_ID,
  registerDeviceBinding,
  type PresentedDeviceMetadata,
} from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import { rankAnchorCandidates } from "../../../core/licensing/anchor.js";
import type { DeviceKeyPair } from "../../../core/devices/keys.js";
import { acceptsKeys, licenseChoiceView, offerFor } from "./choice.js";
import { issueGrant } from "./grant.js";
import { bindChoice, type BindResult } from "./bind.js";

export interface SettleCx {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
}

export interface SettleWho {
  accountId: string;
  subject: string;
  email: string | null;
}

export interface SettleDevice {
  id: string;
  metadata: PresentedDeviceMetadata;
  label: string | null;
  held: { token: string; row: DeviceRow } | null;
}

/** The facts a settle needs beyond who and what device. */
export interface SettleFacts {
  scope: string[];
  /** The device keys a token exchange proved possession of, carried by the grant. */
  keys?: DeviceKeyPair;
  /** A same-device grant: the grant carries `fresh`, and `choice/complete` marks the step-up. */
  fresh?: true;
  /** The grant is earned by a device code: it cannot list devices or Replace (§12.5.1 rule 5). */
  via?: "device";
  /** The exchange found the person's consent standing: one free licence binds with no tap. */
  silentSingle?: boolean;
  /** Whether the device's own live token proved it (the rule `bindWithoutChoice` reads). */
  keepable: boolean;
  proven: boolean;
}

export type Settled =
  | { kind: "choose"; pending: PendingSignIn }
  | { kind: "bound"; bound: BindResult };

/**
 * Decide and act for an app-mode sign-in with an account: bind silently, hand over the pending
 * grant, or bind with no choice. The caller has already checked the product runs License.
 */
export async function settleAppMode(
  cx: SettleCx,
  who: SettleWho,
  device: SettleDevice,
  facts: SettleFacts,
): Promise<Settled> {
  const { req, env, db, product, now } = cx;
  const choiceCx = { env, db, product, now };
  const offer = await offerFor(choiceCx, who.accountId, device.id);
  const due =
    offer.candidates.length > 0 ||
    offer.keep ||
    (!offer.granted && acceptsKeys(product));
  const only = offer.candidates[0];
  const silent =
    facts.silentSingle === true &&
    offer.candidates.length === 1 &&
    !offer.keep &&
    only !== undefined &&
    only.state === "free";
  if (silent && only)
    return {
      kind: "bound",
      bound: await bindChoice(cx, who, device, {
        kind: "license",
        licenseId: only.licenseId,
      }),
    };
  if (due) {
    const grant = await issueGrant(
      env,
      {
        product: product.slug,
        accountId: who.accountId,
        subject: who.subject,
        deviceId: device.id,
        scope: facts.scope,
        ...(facts.keys ? { keys: facts.keys } : {}),
        ...(facts.fresh ? { fresh: true as const } : {}),
        ...(facts.via ? { via: facts.via } : {}),
      },
      now,
    );
    return {
      kind: "choose",
      pending: {
        status: "choose",
        grant,
        expiresIn: CHOICE_GRANT_TTL_SECONDS,
        choices: await licenseChoiceView(choiceCx, req, who.accountId, {
          deviceId: device.id,
          ...(facts.via === "device" ? { withholdReplace: true } : {}),
        }),
      },
    };
  }
  return {
    kind: "bound",
    bound: await bindWithoutChoice(
      cx,
      who,
      device,
      facts.keepable,
      facts.proven,
    ),
  };
}

/**
 * The cases where no choice rides on the code. In card mode Continue refused the press if a choice
 * was owed, so one still owed here means the offer changed since (a licence appeared): never
 * silent. The device's own proof keeps its licence; with none to choose, the device is bound
 * licence-less.
 */
export async function bindWithoutChoice(
  cx: SettleCx,
  who: SettleWho,
  device: SettleDevice,
  keepable: boolean,
  proven: boolean,
): Promise<BindResult> {
  const { env, db, product, now } = cx;
  if (keepable && device.held)
    return bindChoice(cx, who, device, { kind: "keep" });
  if (product.services.license.enabled) {
    const offer = await rankAnchorCandidates(db, product, who.accountId, now, {
      deviceId: device.id,
    });
    if (offer.candidates.length > 0 || offer.keep)
      return { ok: false, refusal: { reason: "license_choice_required" } };
  }
  const existing = await getDevice(db, product.slug, device.id);
  if (existing && existing.license_id !== NO_LICENSE_ID)
    return { ok: false, refusal: { reason: "license_choice_required" } };
  // A licence-less device id that already holds a credential is taken over only by the device
  // that presents it: registering rotates the token, so without the proof a person with any
  // account could bind someone else's device id to theirs.
  if (existing?.token_hash && !proven)
    return { ok: false, refusal: { reason: "not_entitled" } };
  const registered = await registerDeviceBinding(
    env,
    db,
    product,
    device.id,
    now,
    {
      existing,
      presented: null,
      metadata: { ...device.metadata, label: device.label },
      boundBy: "signin",
      subject: who.subject,
    },
  );
  return {
    ok: true,
    token: registered.token,
    device: registered.device,
    licenseId: NO_LICENSE_ID,
  };
}
