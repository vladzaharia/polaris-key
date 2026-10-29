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

import { identityManifest } from "./ingest.js";
import type {
  DiscoveryContext,
  RegistrationAuthContext,
  ServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { AdminSession } from "../../core/console/session.js";
import { IDENTITY_ROUTES } from "./routes.js";
import { handleIdentityAdmin } from "./admin.js";
import { authorizeRegistration } from "./registration.js";
import { IDENTITY_SETTINGS_SLICE } from "./settings.js";
import type {
  ExchangeKind,
  IdentityDiscovery,
} from "@polaris-key/protocol/identity";
import { launchGateOn } from "../../core/settings/platformRead.js";
import { getProduct } from "../../core/products/store.js";
import { readPlatformSignIn } from "./platformSignIn.js";
import { keyEntryLimit } from "../../core/licensing/keyEntries.js";
import { accountPortalUrl } from "../../core/licensing/manageUrl.js";
import { licenseHolderHooks } from "./accounts/holders.js";
import {
  STOREFRONT_ACTIVATIONS_LISTENER,
  recordFirstActivation,
} from "./portal/store/analytics.js";
import { identityIntegration } from "./integration.js";
import { discoverVisibility } from "./portal/store/visibility.js";
import { identityMaintenance } from "./maintenance.js";
import { platformConnectionSeedJob } from "./connections/seed.js";

import { identityProductDeletion } from "./productDeletion.js";

export const identityService: ServiceDescriptor = {
  slug: "identity",
  /** ST-03: this service's settings registry slice (`settings.ts`). */
  settings: IDENTITY_SETTINGS_SLICE,
  handle: IDENTITY_ROUTES.handle,
  contributes: {
    manifest: identityManifest,
    productDeletion: identityProductDeletion,
    // LX-26: the licence-holder hooks, so License's creation path and every account-email
    // verification reach them (`core/licensing/licenseHolders.ts`).
    licenseHolders: licenseHolderHooks,
    // PS-04: the storefront counts first activations of licences added from Discover.
    onAuthorization: {
      [STOREFRONT_ACTIVATIONS_LISTENER]: recordFirstActivation,
    },
    maintenance: identityMaintenance,
    // P0-49: run by an operator through the migration runner, never by a tick.
    migrations: [platformConnectionSeedJob],
    integration: identityIntegration,
  },
  /**
   * The canonical surface `routes.ts` dispatches; what `routeCoverage` pins. The root portal
   * paths are not here: they are platform routes, not this service's namespace.
   */
  surface: IDENTITY_ROUTES.surface,
  /** LK-12b: Discover visibility for a new account (`core/hooks.ts`), read by Distribution's page. */
  discoverVisibility,
  adminHandle: (ctx: ServiceContext & { session: AdminSession }) =>
    handleIdentityAdmin(ctx),
  authorizeRegistration: (ctx: RegistrationAuthContext) =>
    authorizeRegistration(ctx),
  /**
   * Licence deletion (`core/licensing/licenseDelete.ts`): the portal's links to the deleted licence go, so
   * no account's library keeps a card for a licence that no longer exists, and so do its I-12
   * relink rows (nothing is left to undo; the `audit` rows keep the history).
   */
  licenseDelete: {
    statements: ({ product, licenseId }) => [
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
   * the key-entry routes enforce it with (`core/licensing/keyEntries.ts`), so the value published is the
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
    portalOn,
  }: DiscoveryContext) => {
    // `portalOn` is the document's one read of `portal.enabled` (DISC-01): this and `core.portal`
    // cannot disagree.
    const accountPortal = portalOn
      ? await accountPortalUrl(env, db, base, product)
      : null;
    // I-13.7 (§12.11.6): the exchange rung is named only while the launch gate serves it and
    // the product declares a kind; an SDK uses a rung only when its endpoint is present.
    const exchangeOn = await launchGateOn(env, db, "launch.identityExchange");
    const row = exchangeOn ? await getProduct(db, product.slug) : null;
    const audiences = row ? await readPlatformSignIn(db, row) : null;
    const kinds: ExchangeKind[] = [];
    if (audiences?.google.serverClientId) kinds.push("google");
    if (audiences?.apple.teamId && audiences.apple.bundleIds.length > 0)
      kinds.push("apple");
    // I-40.8 (§12.11.6): nearby approval is named only while the operator gate, the product row
    // and `identity.nearby` all serve it: the same test the three routes answer 404 with.
    const nearbyRow = (await launchGateOn(env, db, "launch.identityNearby"))
      ? await getProduct(db, product.slug)
      : null;
    const nearbyOn =
      nearbyRow !== null && (await readPlatformSignIn(db, nearbyRow)).nearby;
    const fragment: IdentityDiscovery = {
      enabled: true,
      // I-08: the platform sign-in (`authorize`, `token`) needs no per-product IdP row, so a
      // product with Identity on is always configured. The legacy `auth/*` routes still need
      // an `oidc_config` row and answer for themselves.
      configured: true,
      issuer: `${base}/identity`,
      account: true,
      keyEntryLimit: await keyEntryLimit(
        { env, db, ...(settings ? { registry: settings } : {}) },
        product.slug,
      ),
      ...(kinds.length > 0
        ? {
            exchange: {
              kinds,
              ...(audiences?.google.serverClientId
                ? {
                    google: { serverClientId: audiences.google.serverClientId },
                  }
                : {}),
            },
          }
        : {}),
      ...(nearbyOn ? { nearby: true as const } : {}),
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
        authorize: `${base}/identity/authorize`,
        token: `${base}/identity/token`,
        choiceLicenses: `${base}/identity/choice/licenses`,
        choiceDevices: `${base}/identity/choice/devices`,
        choiceComplete: `${base}/identity/choice/complete`,
        choiceCancel: `${base}/identity/choice/cancel`,
        attach: `${base}/identity/attach`,
        subject: `${base}/identity/subject`,
        signout: `${base}/identity/signout`,
        ...(exchangeOn
          ? {
              nonce: `${base}/identity/nonce`,
              link: `${base}/identity/link`,
            }
          : {}),
        ...(nearbyOn
          ? {
              nearbyStart: `${base}/identity/nearby/start`,
              nearbyApprove: `${base}/identity/nearby/approve`,
              nearbyPoll: `${base}/identity/nearby/poll`,
            }
          : {}),
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
// The customer host's device approval page has no product in its URL: the dispatcher asks which
// product the binder belongs to, then serves that product's approval handler on the customer host.
export { customerApproveTarget } from "./productOidc/deviceApproval.js";
