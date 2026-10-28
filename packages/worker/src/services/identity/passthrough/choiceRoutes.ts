/// <reference types="@cloudflare/workers-types" />

/**
 * The pending sign-in grant's four routes (WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §G.5, §G.6):
 *
 *   POST /<p>/identity/choice/licenses   {grant}                  -> LicenseChoiceView
 *   POST /<p>/identity/choice/devices    {grant, licenseId}       -> ReplaceView
 *   POST /<p>/identity/choice/complete   {grant, choice}          -> the `token` response
 *   POST /<p>/identity/choice/cancel     {grant}                  -> 204, nothing bound
 *
 * JSON bodies, `no-store`, `X-PKey-Device` required, Identity on only (a disabled service is the
 * registry's unknown-service 404). Errors are the nested Polaris body. The grant answers only the
 * device that redeemed the code (`invalid_grant` otherwise, and the grant is not burned), and
 * `licenses`/`devices` spend its 30 reads. `complete` takes the grant first, so two calls cannot
 * both bind; a refusal the person can retry (`device_limit`, a lost mint, a wrong key, a budget)
 * puts it back for the time it has left, and anything that ends the sign-in leaves it consumed.
 */

import type {
  ChoiceCompleteRequest,
  ChoiceDevicesRequest,
  ChoiceLicensesRequest,
  LicenseChoiceInput,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  wireError,
} from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import { bearer } from "../../../platform/http.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import {
  deviceMetadata,
  isValidClientDeviceId,
  licenseUsable,
  NO_LICENSE_ID,
  validateDeviceToken,
} from "../../../core/devices.js";
import { getAccountRow } from "../accounts/repo.js";
import { licenseChoiceView, replaceView } from "./choice.js";
import {
  peekGrant,
  restoreGrant,
  spendRead,
  takeGrant,
  type GrantRecord,
} from "./grant.js";
import { bindChoice, type BindRefusal } from "./bind.js";
import { bindWithoutChoice, tokenBody } from "./token.js";
import { markFresh } from "./fresh.js";
import {
  DeviceKeysConflictError,
  DeviceKeysInvalidError,
  agreeKeyHeldElsewhere,
  deviceSignKey,
  upsertDeviceKeys,
} from "../../../core/devices/keys.js";

/** The grant routes: 60 a minute per client network (a guess at a grant or a key is not free). */
export const CHOICE_RATE = {
  bucket: "identityChoice",
  limit: 60,
  windowSec: 60,
};

type Action = "licenses" | "devices" | "complete" | "cancel";

const noStore = (res: Response): Response => {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
};
const fail = (
  status: number,
  code: string,
  extra?: Record<string, unknown>,
): Response => noStore(wireError(status, code, extra));
const invalidGrant = (): Response => fail(400, ErrorCode.InvalidGrant);

/** A bind refusal as the grant routes answer it: nested, with the retry data beside the code. */
function nestedRefusal(
  r: BindRefusal,
  extra: Record<string, unknown>,
): Response {
  switch (r.reason) {
    case "device_limit":
      return fail(403, "device_limit", {
        limit: r.limit,
        deviceCount: r.deviceCount,
        ...(r.manageUrl !== undefined ? { manageUrl: r.manageUrl } : {}),
        ...(r.racedAfterFree ? { racedAfterFree: true } : {}),
        ...extra,
      });
    case "rate_limited":
      return fail(429, "rate_limited", { retryAfter: r.retryAfter });
    case "license_choice_required":
      return fail(409, ErrorCode.LicenseChoiceRequired, extra);
    case "not_found":
      return fail(404, ErrorCode.NotFound);
    case "unauthorized":
      return fail(401, ErrorCode.Unauthorized);
    case "fingerprint_required":
      return fail(403, "fingerprint_required");
    case "hardware_mismatch":
      return fail(409, "hardware_mismatch");
    case "license_owned":
      return fail(403, "license_owned", { signInUrl: r.signInUrl });
    case "key_entry_limit":
      return fail(403, "key_entry_limit", {
        keyEntries: r.keyEntries,
        ...(r.manageUrl !== undefined ? { manageUrl: r.manageUrl } : {}),
      });
    case "not_entitled":
      return fail(403, "not_entitled");
    case "unavailable":
      return fail(503, "unavailable");
  }
}

/** Refusals after which the sign-in is still open: the person fixes the cause and tries again. */
const RETRYABLE: ReadonlySet<BindRefusal["reason"]> = new Set([
  "device_limit",
  "rate_limited",
  "license_choice_required",
  "not_found",
  "unauthorized",
  "license_owned",
  "key_entry_limit",
  "unavailable",
]);

function parseChoice(raw: unknown): LicenseChoiceInput | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case "keep":
    case "create":
      return { kind: c.kind };
    case "key":
      return typeof c.key === "string" &&
        c.key.length > 0 &&
        c.key.length <= 512
        ? { kind: "key", key: c.key }
        : null;
    case "license":
      if (typeof c.licenseId !== "string") return null;
      if (
        c.replaceDeviceId !== undefined &&
        typeof c.replaceDeviceId !== "string"
      )
        return null;
      return {
        kind: "license",
        licenseId: c.licenseId,
        ...(typeof c.replaceDeviceId === "string"
          ? { replaceDeviceId: c.replaceDeviceId }
          : {}),
      };
    default:
      return null;
  }
}

export async function handleChoice(
  action: Action,
  ctx: {
    req: Request;
    env: Env;
    db: Db;
    product: Product;
    now: number;
    settings?: SettingsRegistry;
    body: Record<string, unknown>;
  },
): Promise<Response> {
  const { req, env, db, product, now, body } = ctx;
  if (req.method !== "POST") return methodNotAllowed();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...CHOICE_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return fail(429, "rate_limited", { retryAfter: CHOICE_RATE.windowSec });
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !isValidClientDeviceId(deviceId))
    return fail(400, ErrorCode.BadRequest);
  const grant = (body as Partial<ChoiceLicensesRequest>).grant;

  // ── cancel: the grant ends and nothing is bound ──────────────────────────────────────────────
  if (action === "cancel") {
    const taken = await takeGrant(env, product.slug, grant, deviceId);
    if (!taken) return invalidGrant();
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: taken.subject,
      actor_name: null,
      actor_email: null,
      action: "signin.choice.cancel",
      target_kind: "device",
      target_id: deviceId,
      parent_id: null,
      summary: "Cancelled a sign-in before choosing a license",
    });
    return noStore(new Response(null, { status: 204 }));
  }

  // ── the reads: licences and a licence's devices ───────────────────────────────────────────────
  if (action === "licenses" || action === "devices") {
    const spent = await spendRead(env, product.slug, grant as string, deviceId);
    if (!spent.ok)
      return spent.reason === "reads_exhausted"
        ? fail(429, "rate_limited")
        : invalidGrant();
    const cx = { env, db, product, now };
    if (action === "licenses")
      return noStore(
        json(
          await licenseChoiceView(cx, req, spent.record.accountId, {
            deviceId,
          }),
        ),
      );
    const licenseId = (body as Partial<ChoiceDevicesRequest>).licenseId;
    // One 404 for a licence that is unknown, another account's, not full, or not replaceable.
    const view =
      typeof licenseId === "string"
        ? await replaceView(cx, spent.record.accountId, licenseId, { deviceId })
        : null;
    return view ? noStore(json(view)) : fail(404, ErrorCode.NotFound);
  }

  // ── complete ──────────────────────────────────────────────────────────────────────────────────
  const raw = (body as Partial<ChoiceCompleteRequest>).choice;
  const choice = raw === undefined ? null : parseChoice(raw);
  // A grant issued with `confirm` needs the person's consent (§12.11.3 rule 2): its absence or a
  // malformed one is 400 with the grant left open. Nothing is taken or burned here.
  const early = await peekGrant(env, product.slug, grant, deviceId);
  if (!early.ok) return invalidGrant();
  const rawConsent = (body as Partial<ChoiceCompleteRequest>).consent;
  let granted: string[] | null = null;
  if (early.record.consent) {
    const claims = (rawConsent as { claims?: unknown } | undefined)?.claims;
    if (
      !Array.isArray(claims) ||
      !claims.every(
        (c) => typeof c === "string" && early.record.scope.includes(c),
      )
    )
      return fail(400, ErrorCode.BadRequest);
    granted = early.record.scope.filter((s) => claims.includes(s));
  }
  // On a confirm grant an absent choice means none was due; bind will say if one still is.
  if (!choice && !(early.record.consent && raw === undefined)) {
    // No choice is a choice still owed (409); a malformed one is the caller's mistake (400).
    // Neither burns the grant.
    const peek = await peekGrant(env, product.slug, grant, deviceId);
    if (!peek.ok) return invalidGrant();
    return raw === undefined
      ? fail(409, ErrorCode.LicenseChoiceRequired)
      : fail(400, ErrorCode.BadRequest);
  }
  // A key is an online oracle for licence keys: each attempt is a read of the grant's budget.
  if (choice?.kind === "key") {
    const spent = await spendRead(env, product.slug, grant as string, deviceId);
    if (!spent.ok)
      return spent.reason === "reads_exhausted"
        ? fail(429, "rate_limited")
        : invalidGrant();
  }
  const taken = await takeGrant(env, product.slug, grant, deviceId);
  if (!taken) return invalidGrant();
  const putBack = (): Promise<void> =>
    restoreGrant(env, grant as string, taken, now);

  const account = await getAccountRow(db, taken.accountId);
  if (
    !account ||
    account.status !== "active" ||
    (await erasureVerdict(env, now, account.id)) !== "clear"
  )
    return invalidGrant();

  const metadata = deviceMetadata(req);
  const label = normalizeDeviceLabel(
    typeof body.deviceName === "string" ? body.deviceName : undefined,
  );
  // The device's own token, when it presents one: the proof `keep` needs.
  const presented = bearer(req);
  const heldRes = presented
    ? await validateDeviceToken(env, db, product, presented, now, { deviceId })
    : null;
  const held =
    heldRes &&
    !("error" in heldRes) &&
    heldRes.device.license_id !== NO_LICENSE_ID &&
    heldRes.license !== null &&
    licenseUsable(heldRes.license, now) &&
    presented
      ? { token: presented, row: heldRes.device }
      : null;

  // Never trust the keys the grant carries: it lived up to 300 s. Re-run the held-key rule and the
  // agree-key check against the store now; any failure is the one `invalid_grant`.
  let heldSignKey: string | null = null;
  if (taken.keys) {
    heldSignKey = await deviceSignKey(db, product.slug, deviceId);
    if (
      (heldSignKey !== null && heldSignKey !== taken.keys.signKey) ||
      (await agreeKeyHeldElsewhere(
        db,
        product.slug,
        taken.keys.agreeKey,
        deviceId,
      ))
    )
      return invalidGrant();
  }

  const bcx = {
    req,
    env,
    db,
    product,
    now,
    ...(ctx.settings ? { settings: ctx.settings } : {}),
  };
  const who = {
    accountId: account.id,
    subject: taken.subject,
    email: account.primary_email,
  };
  const device = { id: deviceId, metadata, label, held };
  const bound = choice
    ? await bindChoice(bcx, who, device, choice)
    : await bindWithoutChoice(
        bcx,
        who,
        device,
        held !== null,
        heldRes !== null && !("error" in heldRes),
      );
  if (!bound.ok) {
    const r = bound.refusal;
    if (RETRYABLE.has(r.reason)) await putBack();
    // The person chooses again from a fresh view.
    const extra =
      r.reason === "device_limit" || r.reason === "license_choice_required"
        ? {
            view: await licenseChoiceView(
              { env, db, product, now },
              req,
              account.id,
              { deviceId },
            ),
          }
        : {};
    return nestedRefusal(r, extra);
  }

  if (taken.keys) {
    try {
      await upsertDeviceKeys(
        db,
        product.slug,
        deviceId,
        taken.keys,
        now,
        undefined,
        heldSignKey,
      );
    } catch (e) {
      // A key another device registered inside the grant window, or a malformed one.
      if (
        e instanceof DeviceKeysInvalidError ||
        e instanceof DeviceKeysConflictError
      )
        return invalidGrant();
      throw e;
    }
  }
  if (taken.consent && granted) {
    await db.batch([
      {
        sql: `INSERT INTO account_product_grants
                (account_id, product, claims_json, granted_at, modified_at, scope_hash)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (account_id, product) DO UPDATE SET
                claims_json = excluded.claims_json,
                modified_at = excluded.modified_at,
                scope_hash = excluded.scope_hash`,
        params: [
          account.id,
          product.slug,
          JSON.stringify(granted),
          now,
          now,
          taken.consent.scopeHash,
        ],
      },
    ]);
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: taken.subject,
      actor_name: null,
      actor_email: null,
      action: "signin.consent.granted",
      target_kind: "product",
      target_id: product.slug,
      parent_id: null,
      summary: `Granted ${granted.join(", ") || "no claims"} to the app (scope ${taken.consent.scopeHash})`,
    });
  }
  if (taken.fresh) await markFresh(env, product.slug, deviceId, taken.subject);
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: taken.subject,
    actor_name: null,
    actor_email: null,
    action: "signin.choice.complete",
    target_kind: "device",
    target_id: deviceId,
    parent_id: bound.licenseId === NO_LICENSE_ID ? null : bound.licenseId,
    summary: choice
      ? `Chose a license in the app (${choice.kind})`
      : "Confirmed consent",
  });
  return noStore(
    json(
      await tokenBody(
        db,
        product,
        deviceId,
        granted ?? taken.scope,
        taken.subject,
        bound,
      ),
    ),
  );
}

export type { GrantRecord };
