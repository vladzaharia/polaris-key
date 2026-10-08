/// <reference types="@cloudflare/workers-types" />

/**
 * The `requires-identity` arm of `POST /<p>/devices/register` (wire v3 §6, spec §2.3).
 *
 * ── WHAT THIS COMPLETES ─────────────────────────────────────────────────────────────────────
 *
 * Registration is a CORE route — the device principal is substrate, available under every
 * policy — but one of its three policies is a question only Identity can answer: "has a human
 * signed in to this product?". Core refused `requires-identity` outright until now, which was
 * the safe answer while there was no session to inspect and the wrong one once there is.
 *
 * ── WHY IT IS A DESCRIPTOR HOOK AND NOT AN IMPORT ───────────────────────────────────────────
 *
 * `core/register.ts` may not import a service (`test/boundaries.test.ts`, and the substrate
 * knowing a service's module path is the coupling the suite exists to remove). So Core declares
 * `ServiceDescriptor.authorizeRegistration` — one narrow predicate, `RegistrationAuthContext`
 * in, boolean out — and asks the registry for it under the slug the POLICY already names. Core
 * learns nothing about how the answer is computed; Identity decides nothing about what happens
 * next.
 *
 * ── THE CREDENTIAL ──────────────────────────────────────────────────────────────────────────
 *
 * The product browser session (`browserSession.ts`): the `pkey_<slug>_session` cookie, resolved
 * through the peppered hash to a KV record scoped to THIS product, whose device token must
 * still validate as a live device. All three matter:
 *
 *   - the cookie alone proves nothing — a record can outlive the device it was minted for
 *     (logout deauthorizes the device row and deletes the token record, and an operator can
 *     deauthorize it from the console), so a stale cookie must not keep minting credentials;
 *   - a session a `provider: platform` sign-in opened ends with its account: once the account
 *     is disabled or erased, `loadBrowserSession` answers no session, so it registers nothing
 *     (the N9 residual), while the browser device's licence seat is left as it is;
 *   - `validateDeviceToken` and not `requireLicensedDevice`, because `requires-identity` is
 *     precisely the policy a product picks when it does NOT run License (D-08). Demanding a
 *     usable licence here would make the policy unsatisfiable for its own audience.
 *
 * There is no CSRF check and none is needed: this predicate authorizes minting a NEW credential
 * that is returned in the response body, so a cross-site caller that forced the request could
 * not read what it produced. (The session-mutating surfaces — `/identity/auth/logout` — do
 * check, because their effect is visible without reading the response.)
 */

import type { RegistrationAuthContext } from "../../core/registry.js";
import { validateDeviceToken } from "../../core/devices.js";
import { loadBrowserSession } from "./browserSession.js";

export async function authorizeRegistration(
  ctx: RegistrationAuthContext,
): Promise<boolean> {
  const { req, env, db, product, now } = ctx;
  const session = await loadBrowserSession(req, env, db, product, now);
  if (!session) return false;
  const valid = await validateDeviceToken(
    env,
    db,
    product,
    session.record.token,
    now,
    { deviceId: session.record.deviceId },
  );
  return !("error" in valid);
}
