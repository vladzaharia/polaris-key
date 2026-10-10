/// <reference types="@cloudflare/workers-types" />

/**
 * The Identity service descriptor — who a HUMAN is, to one product (design spec §5.1, D-14).
 *
 * Identity owns product OIDC, the browser session it establishes, and the customer portal.
 * D-14 is deliberately a boundary decision and not a feature one: the centralized identity
 * capability is out of scope, so what lands here is the code that already existed
 * (`src/oidc.ts`, `src/browserSession.ts`, `src/portal/`) with a directory, a descriptor, and a
 * namespace around it — nothing more.
 *
 * ── WHAT ENABLEMENT NOW MEANS ───────────────────────────────────────────────────────────────
 *
 * Until this carve, identity's routes answered for any product with an `oidc_config` row, and
 * discovery reported the row rather than the flag. Both are now `services_json`, like every
 * other service: a product with `identity` off has no `/identity/*` surface at all — it 404s
 * exactly as an unknown product does — and `/.well-known/polaris.json` says `{"enabled":false}`
 * and nothing else. That is the whole point of spec §2.2, and it is why the manifest mapping
 * matters: `modules.oidc` (and `modules.identity`) map to this slug in `normalizeModules`, so a
 * product that declares an OIDC block and links its repo gets the service turned on by the same
 * ingest that writes the `oidc_config` row.
 *
 * ── WHY THE PORTAL IS NOT IN `handle` ───────────────────────────────────────────────────────
 *
 * `/login`, `/callback`, `/api/*`, `/download/<token>` are ROOT paths — one account spans every
 * tenant, so there is no product to scope them under. They stay platform routes dispatched from
 * `index.ts`; only their implementation lives here (`portal/`). See `portal/index.ts`.
 *
 * For the same reason the `identity` flag does NOT gate the portal (S-16 G10, owner decision D7):
 * the portal is a platform concern that runs for every product, governed by
 * `portal_product_settings`, never by `services_json`. "No `/identity/*` surface" above means
 * the product-scoped routes only.
 */

import type {
  DiscoveryContext,
  RegistrationAuthContext,
  ServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { handleIdentityRoutes } from "./routes.js";
import { handleIdentityAdmin } from "./admin.js";
import { authorizeRegistration } from "./registration.js";
import {
  identityManifestIngest,
  IDENTITY_SETTINGS_SLICE,
  manifestClaimByKeyStatements,
} from "./settings.js";
import type { IdentityDiscovery } from "@polaris-key/protocol/identity";
import { keyEntryLimit } from "../../core/keyEntries.js";
import { accountPortalUrl, portalEnabled } from "../../core/manageUrl.js";
// LX-26: registers Identity's licence-holder hooks with Core (`core/licenseHolders.ts`) at load,
// so License's creation path and every account-email verification reach them.
import "./accounts/holders.js";

export const identityService: ServiceDescriptor = {
  slug: "identity",
  /** ST-03: this service's settings registry slice (`settings.ts`). */
  settings: IDENTITY_SETTINGS_SLICE,
  /**
   * LX-06: `oidc.syncTierOnSignIn` → the claimable `identity.oidc.syncTierOnSignIn` row, on every
   * link and resync whatever Identity's enablement, so it is already right when Identity is
   * turned on (it does nothing while Identity is off). A console claim is never overwritten.
   * I-09: the `identity:` block's settings ride along (`settings.ts` `identityManifestIngest`).
   */
  manifestIngestAlways: (parsed, product, now) =>
    identityManifestIngest(parsed, product, now),
  /** I-09: `identity.keyEntry.claimByKey` from the `identity:` block, into its column. */
  manifestIngest: (parsed, product, now) =>
    manifestClaimByKeyStatements(product, parsed, now),
  handle: handleIdentityRoutes,
  adminHandle: (ctx: ServiceContext & { session: AdminSession }) =>
    handleIdentityAdmin(ctx),
  authorizeRegistration: (ctx: RegistrationAuthContext) =>
    authorizeRegistration(ctx),
  /**
   * Licence deletion (`core/licenseDelete.ts`): the portal's links to the deleted licence go, so
   * no account's library keeps a card for a licence that no longer exists, and so do its I-12
   * relink rows (nothing is left to undo; the `audit` rows keep the history).
   */
  licenseDelete: {
    statements: ({ product, licenseId }) => [
      {
        sql: "DELETE FROM portal_license_links WHERE product = ? AND license_id = ?",
        params: [product, licenseId],
      },
      {
        sql: "DELETE FROM license_relinks WHERE product = ? AND license_id = ?",
        params: [product, licenseId],
      },
    ],
  },
  /**
   * Identity's slice of `/.well-known/polaris.json` (design spec §4.3): the sign-in URLs and the
   * session surface a client needs, at their canonical `/identity/…` spellings.
   *
   * `configured` is separate from `enabled` for the same reason it is on Release: a product can
   * consent to the service before anybody has pointed it at an IdP, and a client that cannot
   * tell "on but not set up" from "on and serving" will retry a 500 forever. The row is the only
   * honest source for that — it is what `resolveOidcConfig` looks for — but it is NOT what
   * decides `enabled`, which is the flag and only the flag.
   *
   * `/auth/login` is not advertised, and no longer exists: §R1 removes it as a redundant alias
   * of `/auth/start`.
   *
   * `/auth/poll` is not advertised either (I-01, S-16 §5.3), and no longer exists: no SDK read
   * it, and it could complete only device-bound flows that nothing starts any more.
   *
   * I-09 (WIRE-CONTRACT-V4 §12.6): `account: true` says the account routes are served, and
   * `keyEntryLimit` is the product's `identity.keyEntry.limit` read through the same resolver
   * the key-entry routes enforce it with (`core/keyEntries.ts`), so the value published is the
   * value enforced (discovery's 300 s cache may lag; the refusal carries the live value).
   * `accountPortal` is the product's page in the customer portal, for `openAccount()`, present
   * while the product's portal is on. A client uses each endpoint only when it is present.
   */
  discoveryFragment: async ({
    db,
    env,
    product,
    base,
    settings,
  }: DiscoveryContext) => {
    const row = await db.first<{ product: string }>(
      "SELECT product FROM oidc_config WHERE product = ?",
      product.slug,
    );
    const accountPortal = (await portalEnabled(db, product.slug))
      ? accountPortalUrl(env, base, product)
      : null;
    const fragment: IdentityDiscovery = {
      enabled: true,
      configured: Boolean(row),
      account: true,
      keyEntryLimit: await keyEntryLimit(
        { env, db, ...(settings ? { registry: settings } : {}) },
        product.slug,
      ),
      endpoints: {
        session: `${base}/identity/session`,
        sessionLicense: `${base}/identity/session/license`,
        authStart: `${base}/identity/auth/start`,
        authCallback: `${base}/identity/auth/callback`,
        authLogout: `${base}/identity/auth/logout`,
        authDeviceStart: `${base}/identity/auth/device/start`,
        authDeviceEntry: `${base}/identity/auth/device`,
        authDeviceVerify: `${base}/identity/auth/device/verify`,
        authDevicePoll: `${base}/identity/auth/device/poll`,
        attach: `${base}/identity/attach`,
        subject: `${base}/identity/subject`,
        signout: `${base}/identity/signout`,
        ...(accountPortal ? { accountPortal } : {}),
      },
    };
    return { ...fragment };
  },
};

// ── The service's public face ────────────────────────────────────────────────
//
// Two symbols, for two callers that are not routes. `handlePortal` is the composition root's:
// `index.ts` mounts the ROOT portal paths, which stay platform-level (see the header).
// `createBrowserSession` is the credential the `requires-identity` registration policy is
// defined in terms of, so the registration-matrix suite has to be able to mint one.
//
// Everything else stays behind the descriptor. A service's surface is its routes; a growing
// list of exports here is how the next module starts reaching around them.
export { handlePortal } from "./portal/index.js";
export { createBrowserSession } from "./browserSession.js";
