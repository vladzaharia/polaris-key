/**
 * The CI credential vocabulary (P2-02): the token prefix, the scope set and the principal shape.
 *
 * A leaf module on purpose. `core/ciScope.ts` (the route guard) and `core/publisher.ts` (the
 * store, whose `lookupCiToken` the CI-route suites mock) both need these, and keeping them here
 * means neither imports the other for a constant.
 */

/** Every CI token starts with this; anything else is not a CI credential. */
export const CI_TOKEN_PREFIX = "pkeyci_";

/**
 * The scope vocabulary so far (P2-02 design notes). Later packages add theirs here.
 * `distribution:rollout` (P2b-04) is opt-in like `release:yank`: it is not in
 * `DEFAULT_CI_SCOPES` (`core/publisher.ts`), so an operator grants it deliberately.
 * `distribution:feeds` (P2b-05) reads the F-Droid generator's inputs, registers the repository
 * files CI signed, and buys an upload ticket for them (P2-02's uploads route accepts it beside
 * `release:publish`); it is opt-in too. `distribution:listing` (A-18d) buys an upload ticket for
 * the listing assets `pkey listing assets` derived and registers them into `dist_listing_assets`;
 * opt-in as well. `distribution:pr` (A-32.7) exchanges the CI run for a GitHub token (contents and
 * pull requests write, one hour) narrowed to the outlet's own tap or bucket, so a tap or bucket PR
 * needs no personal token; opt-in too. `assets:write` (HA-06) buys an upload ticket for the files `pkey assets push`
 * and the publish Action's `assets` input send, and hosts them (`POST /<p>/assets`); opt-in too,
 * and it never replaces a slot an operator uploaded or a manifest declares.
 * `packages:read` (F-33b.2) is the service read token: it reads its own product's non-public
 * package feeds on the registry host and does nothing else. It is opt-in, passes no `/ci/*`
 * route guard, never publishes and never pushes.
 */
export const CI_SCOPES = [
  "release:publish",
  "release:promote",
  "release:yank",
  "distribution:report",
  "distribution:rollout",
  "distribution:feeds",
  "distribution:listing",
  "distribution:pr",
  "assets:write",
  "packages:read",
] as const;
export type CiScope = (typeof CI_SCOPES)[number];

/** The CI scope of the read-only service token (F-33b.2). */
export const PACKAGES_READ_CI_SCOPE = "packages:read";

/** Who a valid `pkeyci_` token belongs to. */
export interface CiPrincipal {
  /** The product the token was issued for. A token is never valid for another product. */
  readonly product: string;
  /** The audit actor's subject: `github:<sub>#run:<id>` for a minted token, `static:<id>` for an
   *  operator-issued one. */
  readonly subject: string;
  /** Granted scopes (`release:publish`, `release:promote`, `release:yank`, …). */
  readonly scopes: readonly string[];
}
