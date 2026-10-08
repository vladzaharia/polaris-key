# Audit: Identity, accounts, sign-in, SSO, profile, consent and access tokens

> DX consolidation audit, 2026-10-07. Domain: `services/identity/*` (accounts, links, providers,
> portal SSO, card and email gate, device login, passkeys, email codes, product OIDC sign-in, the
> platform migration), [SIGN-IN.md](../../../design/SIGN-IN.md),
> [S-16](../../2026-09-29-godot-omniplatform/notes/S-16-identity-service.md), profile, consent,
> terms, device replacement, multi-SSO with email-domain routing, app-custom SSO, store account
> systems, sign-in across experiences, and per-user access tokens. Read against the tree at
> `pk-wt/dx-plan` (v0.8.31 plus batch 5, head `38d3acc68`) and the in-flight branches LX-08, HA-12,
> UK-13 and UK-14. Paths are repo-relative. `W/` = `packages/worker/src/`, `I/` =
> `W/services/identity/`, `M/` = `packages/worker/migrations/`, `P/` =
> `docs/research/2026-09-29-godot-omniplatform/program/`. Nothing was changed except this file.

## Summary

The account layer is in good shape. One global account, `signIn(verifiedIdentity)` as the only
door, links keyed `(issuer_key, tenant_scope, subject)`, stored pairwise subjects, merge with proof
of both, passkeys, the email gate, profile import and a well-specified sign-in experience are all
built (I-05, I-06, I-07, I-16, I-17, PX-W12–W17). The trouble is the configuration around it.
Identity is configured in **seven stores, four console pages, about 30 deployment variables and two
manifest blocks**. The legacy per-product OIDC engine (`I/oidc.ts`, 3,258 lines) still mints
`sub`-keyed licences beside the account model. The console signs operators in through a separate
identity system with one group check. The CLI's only admin credential is a browser cookie copied
out of devtools. Access tokens are per product and per licence, never per person.

The owner's brief asks for four things the current design does not have:

- multiple SSO providers routed by email domain;
- app-custom SSO folded into the same system;
- console operators on the same accounts;
- per-user access tokens.

All four fall out of **one new concept, the connection**: an upstream identity provider configured
once, scoped to the platform or to one product, routed by verified email domains and carrying
group claims. Polaris Key's own Pocket ID becomes one platform connection. A product's custom
issuer becomes a product connection. Google, Apple and Steam become built-in connections. Groups,
which today only exist for Pocket ID users and vanish when I-17's sunset ends that sign-in, then
come from whichever connection the person used.

**The single most important change:** before I-08 is built, amend its plan (IX-00) so that the
passthrough `authorize` and `token` endpoints are OAuth 2.1/OIDC-shaped. I-21's issuer then
extends those endpoints instead of adding a second authorization server. Put connections (IX-03)
under the card's identifier-first step. This one decision lets the following converge on one model
with no second wire change:

- web sign-in, native sign-in and "Sign in with <Product>";
- app-custom SSO (`oidc.provider: custom` and I-22's bring-your-own-auth);
- console sign-in;
- the CLI.

Everything else in this audit is reduction: retiring per-product toggles for platform-level
methods, merging steps and pages, and deriving store sign-in from distribution channels instead of
re-declaring it.

## Current state (with file references)

### 1. Layers as built

| Layer                                           | What exists                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account (platform)                              | `accounts`, `account_links`, `account_product_subjects` (+ aliases), `account_tombstones`, `subject_events`, `account_sessions`, `account_product_grants` (app consent, + `scope_hash`), `account_passkeys`, `account_avatars`, `account_terms_acceptances`, `account_merges`, `account_overrides`                                            | `M/0068_a_accounts.sql`, `0079`, `0081`, `0087`, `0091`, `0093`, `0094_*`, `0098`, `0103`                                                         |
| One door                                        | `signIn(verifiedIdentity)`: known link → account; unknown identity whose verified email another account uses → **join offer**, writes nothing ("never by email match"); else new account. Tenant-scoped links are recognised only inside products of that scope                                                                               | `I/accounts/signIn.ts:1-23`                                                                                                                       |
| Front doors (card, `key.plrs.im`)               | Email code + magic link (`/api/signin/email/*`, `/magic/verify`), Turnstile; passkeys (`/api/signin/passkey/*`); Google/Apple/Steam (`/login/<provider>/…`); platform SSO "Continue with single sign-on" (`/login` → `/callback`, Pocket ID); sign in with another device (`/api/device-login/*`); email gate (`/api/signin/confirm-email/*`) | `I/card/index.ts:1-18`, `I/portal/index.ts:115-131`, `I/portal/auth.ts`, `I/providers/flow.ts`, `I/passkeys/routes.ts`, `I/portal/deviceLogin.ts` |
| Product sign-in, legacy                         | Per-product OIDC: `oidc_config` row with `provider: platform\|custom`, PKCE browser flow, device code (`/<p>/identity/auth/device/*`), group → tier map, provisioning hooks, `oidcDefault` auto-issue, **licences keyed by `licenses.sub`**, I-26's server-rendered licence chooser                                                           | `I/oidc.ts` (3,258 lines), `I/routes.ts`, `I/licenseChoice.ts`                                                                                    |
| Product sign-in, planned ("passthrough")        | Pushed request + client record + consent view (PX-W13, done); `authorize` + `redirect/token` web redirect, device code on the card, licence choice and Replace (I-08, todo); exchange (I-13), game verifiers (I-14), native redirect (I-15)                                                                                                   | `I/passthrough/*`, `P/plans/I-04.md` §2.4–2.6, §G                                                                                                 |
| Product browser session (cookie mode)           | `pkey_<slug>_session` cookie bound to a `browser:<licenseId>` device, serving the **fused v2** document                                                                                                                                                                                                                                       | `I/browserSession.ts:1-21`                                                                                                                        |
| Console operators                               | Separate OIDC RP (`ADMIN_OIDC_*`, falls back to `PLATFORM_OIDC_*`), **one privilege**: a member of `PLATFORM_ADMIN_GROUP`; HMAC cookie `__Host-pkey_admin`, 8 h, CSRF double-submit; no link to `accounts`                                                                                                                                    | `W/admin/authz.ts:1-44`, `W/admin/session.ts:1-80`, `W/admin/auth.ts:236-340`, `W/platformOidc.ts:28-52`                                          |
| Legacy portal tables (expand phase, still live) | `portal_accounts`, `portal_account_emails`, `portal_account_identities`, `portal_license_links` kept; `catchUpLegacyAccounts` copies late rows from the scheduled job and on any cookie naming an unknown account                                                                                                                             | `I/accounts/legacy.ts:1-15`, `M/0068_a_accounts.sql:8-12` ("dropped by a contract-phase migration after I-17")                                    |

### 2. Configuration surfaces today

**Seven stores hold identity configuration for one product.**

| Store                                 | Holds                                                                                                                                                                                                       | Written by                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `oidc_config` row                     | `provider`, `issuer`, `client_id`, sealed `client_secret_secret`, `redirect_uris_json`, `group_role_map_json`                                                                                               | manifest `oidc:` (manifest-only, `I/settings.ts:110`)                                    |
| `provisioning_config` rows            | claim → entitlement / templated secret                                                                                                                                                                      | manifest `provisioning:` (`I/settings.ts:139`)                                           |
| `product_settings` rows               | `identity.oidc.syncTierOnSignIn`                                                                                                                                                                            | manifest `oidc.syncTierOnSignIn` or console (`I/settings.ts:46`)                         |
| `products.auto_issue_json`            | `{enabled, tierId, mode: anonymous\|oidcDefault\|both}`: "everyone gets a licence at sign-in" lives here                                                                                                    | manifest `autoIssue:` (`M/0011_auto_issue.sql`)                                          |
| `portal_product_settings` columns     | `portal_enabled`, `oidc_enabled`, `magic_enabled`, `license_key_claim_enabled`, `releases_enabled`, `auto_link_enabled` (tri-state), `key_reissue_enabled`, `claim_by_key`, `branding_json.passthroughName` | console Identity → Portal and Identity → Sign-in (`I/portal/repo.ts:56-66`)              |
| `products.admin_group`                | a group name, **read by no authorization check**                                                                                                                                                            | manifest `product.adminGroup` (`W/core/settings/core.ts:65-84`; `W/admin/authz.ts:6-11`) |
| `identity_product_settings` (planned) | `keyEntryLimit`, `requireTerms`, `native` (I-09)                                                                                                                                                            | manifest `identity:` (not built; `I/signInSettings.ts:20-24`)                            |

**Deployment variables.** About 30 identity variables live in the deployment environment
(`W/platformInventory.generated.ts`):

- the `PLATFORM_OIDC_*` trio plus `_MIGRATION` and `_SUNSET`;
- the `ADMIN_OIDC_*` trio and `PLATFORM_ADMIN_GROUP`;
- seven `SIGNIN_*` names (Google, Apple and Steam);
- `OIDC_ISSUER_ALLOWLIST`, `TURNSTILE_*` and the `EMAIL_*`/`PORTAL_EMAIL_FROM` set;
- three session secrets and `KEY_HASH_PEPPER`.

Platform sign-in providers have no console surface. To add Google you run `wrangler secret put`
plus `pnpm signin:seal` (`I/providers/config.ts:7-27`).

**Console pages.**

| Page                         | What it does                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product → Identity → Portal  | Nine toggles in one form (`packages/admin/src/console/pages/identity/Portal.tsx:43-53, 108-110`). It includes **"OIDC access"** and **"Email magic links"** per product, although the account and its methods are platform-level. It also has the "Automatic license linking" tri-state, which only explains itself in terms of the OIDC issuer. |
| Product → Identity → Sign-in | Read-only. It shows the OIDC provider (platform or custom), the issuer, the client and a group → role → tier table (`SignIn.tsx:69-112`). Editable: "App name" for the passthrough header and `claimByKey`, which also sits on the Portal page (`SignIn.tsx:420-495`). It also carries the App Review 4.8 warning.                               |
| Product → Core → Users       | Per-product pairwise users (I-12, `pages/core/Users.tsx`). Good, keep.                                                                                                                                                                                                                                                                           |
| Platform                     | No identity area. Platform settings, operations, store connections, feeds and override migration are present, but no sign-in providers, SSO, operators, email delivery or policies.                                                                                                                                                              |

**Portal pages.**

- Account → Profile, Sign-in methods, Where you're signed in, Appearance and Your data
  (`packages/admin/src/portal/pages/AccountPage.tsx:37-43`).
- There is no Connected apps section and no Access tokens section.
- A per-licence registry token dialog sits on the product page (`PackageAccessCard`, PX-11).

### 3. Profile, consent and terms

- **Profile** has one name (`accounts.display_name`, labelled "Your name"), a picture and a locale.
  Sources follow until the person chooses, and explicit choices stick. Pictures are re-encoded and
  served same-origin (`I/portal/profile.ts`, `I/card/profile.ts`, `I/card/avatars.ts`). There is
  no screen-name concept by that name and no birth date.
- **Consent** (`GET /api/signin/requests/:handle/consent`, `P/plans/PX-W13.md` §2.3) lists items:
  licence, Cloud Sync (when on), and profile claims `name`, `picture` and `email`. It is all or
  nothing: Continue or Cancel. `scope_hash` re-asks when the set changes (`M/0087`).
- **Terms**: product terms acceptances per version (`I/accounts/terms.ts`, `M/0091`). The product
  terms requirement is planned as `identity.requireTerms {url, version}` (I-09). Polaris Key's own
  terms are a clickwrap line and are **not recorded**. The storefront listing already holds
  `privacyUrl` and `eulaUrl` (`W/core/storefront/listingModel.ts:131-133`).

### 4. Credentials and access tokens

| Prefix              | What                                          | Bound to                                                                                                   | Minted in                     |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `pkey_`             | licence key                                   | licence                                                                                                    | console, commerce             |
| `pkeyt_`            | device token                                  | device                                                                                                     | activation, sign-in           |
| `pkeyci_`           | CI token                                      | product                                                                                                    | GitHub OIDC exchange, console |
| `pkeyr_`            | registry token (`M/0067_registry_tokens.sql`) | **one product**: `binding owner` (console) or `license` (portal, PX-11). Primary key `(product, token_id)` | console, portal product page  |
| `__Host-pkey_admin` | console session                               | Pocket ID subject + groups                                                                                 | `/manage/login`               |

There is no personal or account-wide token of any kind. `plans/F-20.md` Q2 already records the
consequence: docker, SwiftPM and netrc accept **one credential per host**, so a customer with two
products on `pkg.plrs.im` cannot use per-product tokens there.

The CLI's admin commands authenticate with a console cookie copied out of browser devtools
(`packages/cli/src/bundle.ts:10-30`, `PKEY_ADMIN_COOKIE`). That recipe appears in six docs pages,
including `build/onboarding.md:306` and `agents/recipes.md:117-124`.

### 5. SDKs and experiences

- Today the SDKs do device-code sign-in against the legacy routes: Node `beginSignIn`, `pollSignIn`,
  `waitForSignIn`, `signInWithBrowser`, `current`, `signOut`
  (`packages/sdk-node/src/identity/client.ts:216-460`). Python, Kotlin, Godot and Swift do the
  same.
- The v2 surface is designed but not built: SIGN-IN.md §2.4 (`signIn.start`, `exchange`, `choice.*`,
  `attach`, `subject`, `signOut`, `openAccount`), shipped by I-10a and I-10b.
- Terminals (UK-13 and UK-14 in flight) open the card through device code, using the browser
  presentation only.

### 6. Specs and backlog state

**The spec stack.** SIGN-IN.md (2,147 lines, 94 delegated decisions D-01–D-94) is "the single
source of truth" but is itself "amended by S-24". S-16 carries five stacked owner-decision headers
plus an old-id map. The briefs are amendment stacks too:

| Brief | Size  | Precedence sections |
| ----- | ----- | ------------------- |
| I-08  | 22 KB | 5                   |
| PX-14 | 13 KB | 5                   |
| I-09  | 18 KB | 4                   |
| I-10a | 15 KB | 4                   |
| I-13  | 11 KB | 4                   |

Each brief says that its later sections win over the earlier ones.

**Open scope.** 49 identity, portal and account work packages are not done, about 45–65
engineer-weeks. The critical path is I-09 → I-08 → I-10a and I-10b. U-05 (Cloud Sync), I-15, PX-14
and I-24a all wait on I-08.

**Missing work.** The I-17 contract phase has **no work package**. The docs say it "drops the
portal tables after I-17"; I-17 is done.

### 7. In-flight branches that touch the domain

| Branch          | What it does here                                                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LX-08           | Changes `I/oidc.ts` (+231 −64): provisioned entitlement keys become the licence's `oidc` grant, the highest-rank group wins, and `syncTierOnSignIn: upgradeOnly`. It deepens the legacy engine that the target retires, so keep its rules and move them into the access policy (below). |
| HA-12           | `core.presentation` in discovery and `resolvePresentation()`: name, developer, accent, icon. That is a second resolver for what the passthrough header calls `passthroughName` (`I/signInSettings.ts:62-80`).                                                                           |
| UK-13 and UK-14 | Terminal kits use device code and the browser presentation. They are fine as they are and benefit from `pkey login` sharing the same flow.                                                                                                                                              |

## Problems (ranked)

1. **There is no connection concept, so the brief's SSO requirements have nowhere to live (high).**
   - The platform has exactly one OIDC "SSO" (Pocket ID through the `PLATFORM_OIDC_*` env trio).
     The console has a second env trio. Each product may have one custom issuer, which mints
     `sub`-keyed licences outside the account model.
   - Nothing routes an email domain to a provider. The portal shows one "Continue with single
     sign-on" button (`portal/pages/SignInPage.tsx:298-300`).
   - The `groups` claim exists only on Pocket ID links (`account_links.groups_json`,
     `I/portal/repo.ts:294-304`). Once `PLATFORM_OIDC_SUNSET` ends end-user Pocket ID sign-in,
     group-based licensing for djdl (`products/djdl/product.json:35-47`, members → standard)
     **silently stops working**: Google, Apple, Steam and email links carry no groups.
2. **Four OIDC relying-party implementations (high).**
   - `W/admin/auth.ts:185`, `I/portal/auth.ts:453` and `I/oidc.ts:2047` each call
     `createRemoteJWKSet` against an operator-configured issuer.
   - `I/providers/discovery.ts` is the only one with the SSRF gate, host allowlist, RFC 9207 and
     strict audience checks.
   - Three copies of PKCE, state, nonce and verification logic will each need the same fixes.
3. **The legacy product-OIDC engine is a second licensing path that keeps growing (high).**
   - `I/oidc.ts` (3,258 lines) still mints and locates licences by `licenses.sub`, with its own
     group map, provisioning hooks and chooser page.
   - I-08 retires the `provider: platform` half. Nothing retires `provider: custom`, and I-22
     (bring-your-own-auth) plans a **third** product-IdP path.
   - LX-08 is adding grant logic to it right now.
4. **Per-product toggles for platform-level methods contradict the account model and the brief
   (high).**
   - `oidc_enabled` and `magic_enabled` are per-product columns on a platform login. The unscoped
     `/api/capabilities` therefore answers "is it on for any product"
     (`I/portal/repo.ts:958-1003`), and a product can switch email sign-in "off" while the owner
     says "Magic Email sign in is always available".
   - `auto_link_enabled` is a tri-state that is explained only in OIDC-issuer terms.
   - `claimByKey` is edited on two pages.
   - ST-14 plans to copy all of these into the settings registry unchanged.
5. **Console operators are outside the account system, and the CLI has no credential (high).**
   - One privilege level (`W/admin/authz.ts:1-12`), a separate IdP and a separate subject space.
   - `products.admin_group` is a "critical, security-widening" setting that nothing enforces.
   - CLI admin commands require copying `__Host-pkey_admin` from devtools.
   - The brief asks for console accounts on the same account system with RBAC.
6. **Access tokens are per product and per licence, not per person (high).**
   - `registry_tokens` requires a product (`M/0067:23-43`). A customer with five products mints
     five tokens and still cannot use them with one-credential-per-host clients.
   - Developers have no way to see SDK packages "in addition to" their customer packages.
   - The brief asks for per-user tokens for both admins and customers.
7. **Three overlapping "who gets a licence on sign-in" knobs, configured in three places (medium,
   cross-domain).**
   - `autoIssue.mode: oidcDefault` means "everyone".
   - `oidc.groupRoleMap` means "by group". Its `role` field is read by nothing
     (`I/oidc.ts:782-830`).
   - `oidc.syncTierOnSignIn` and `provisioning[]` add tier sync and claim mapping, and PS-09 plans
     a fourth: `autoIssue.emailDomains`.
   - The owner's model is three modes: everyone, by group, or reject.
8. **Store identity is declared twice (medium).**
   - I-14 plans `identity.native.{steam.appId, gamecenter.teamId/bundleIds, apple.teamId/bundleIds}`
     and its own setup checklists.
   - Distribution and commerce already hold the Steam app id and publisher key
     (`W/services/distribution/commerce/steam.ts:6-28`, `steam-publisher-key`), the ASC team and
     bundle ids (A-17b) and the Play package.
   - The brief says store account systems must be "ALWAYS available if the product is distributed
     through it": that is derivable, not declarable.
9. **Consent is all or nothing (medium).** The person cannot share some data and withhold the rest
   (`P/plans/PX-W13.md` §2.3). There is no Connected apps page to change or revoke a grant later.
   It was planned in I-11 and PX-13 but not built.
10. **Profile gaps (medium).** There is no screen-name concept by that name and no birth date.
    Polaris Key's own terms and privacy acceptance is not recorded. New-account completion is two
    different steps with overlapping content: RegisterStep after an email code, and EmailGateStep
    after a provider. Both are still unbuilt (PX-12, PX-21), so merging them now is cheap.
11. **Two authorization endpoints are planned per product (medium, wire).**
    - I-08's `GET /<p>/identity/authorize` plus `POST /<p>/identity/redirect/token` return a
      device token.
    - I-21 then adds a full OP under `/<p>/identity/oauth/*` (`P/plans/I-04.md` §2.8).
    - The brief's "semi-federated OIDC IdP" wants one.
12. **Two names for the app in the sign-in header (medium).** `passthroughName` in
    `portal_product_settings.branding_json` (`I/signInSettings.ts:1-30`) versus HA-12's
    `resolvePresentation()` (listing name, else product name). There are also two reserved-name
    switches, PX-W13b and LX-05.
13. **Identity configuration lives only in the deployment environment (medium).** About 30 env
    variables. Turning on Google sign-in requires a shell, `wrangler` and a seal script. There is no
    status page, no setup wizard and no "is it working" check.
14. **The expand phase never ended (medium).** `portal_*` tables, the copy-on-read catch-up
    (`I/accounts/legacy.ts`), `accounts.terms_json` and the `rekeyLegacy*` helpers are dead weight
    in every merge and deletion path (`I/accounts/merge.ts`, `deletion.ts`). No work package owns
    their removal.
15. **Cookie-mode browser sessions are a second web principal (low/medium, wire).**
    `I/browserSession.ts` serves the fused v2 document on a per-product licence cookie. SP-10 plans
    a new **signed** document type (wire item W10, an all-SDK event) to keep it, while I-08's web
    redirect gives web apps a bearer device token anyway.
16. **The spec and brief layering makes work packages slow to start (low/medium, process).**
    Precedence chains run brief < plan < amendment < SIGN-IN.md < S-24. I-08's brief has five
    sections that each "win" over the text above them, and the S-16 header stack runs to 166
    lines.
17. **Ten `__Host-` flow cookies (low, code quality).** `pk_lcb`, `pk_req`, `pkey_device_login`,
    `pkey_gate`, `pkey_link`, `pkey_passkey`, `pkey_portal`, `pkey_signin`, `pkey_sso` and
    `pkey_admin`. Each flow has its own binder. One flow-binder cookie keyed by flow kind would do,
    but this is internal and low priority.
18. **Stale public docs (low).** `packages/docs/src/content/docs/services/identity/index.md:15-25`
    and the `I/index.ts` header still describe D-14's "narrow carve, no centralized identity
    capability".

## Owner brief: item-by-item stance

| #   | Owner item                                                                                                  | Stance                   | Rationale and landing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multiple SSO providers, one or more email domains each mapping to a specific OIDC provider                  | **adopt**                | **Connections** (IX-03) with DNS-verified domains. Routing happens at the card's identifier-first step: `POST /api/signin/email/start` answers `{next: "sso"}` for a routed domain. Routing depends on the domain only, never on account existence, so it stays enumeration-safe. Per-domain `enforce` makes SSO the only way in for that domain.                                                                                                                                                     |
| 2   | Applications can set their own custom SSO provider                                                          | **adapt**                | A **product connection** (IX-05) replaces both `oidc.provider: custom` and I-22. Its links are tenant-scoped to the product, the mechanism Game Center already uses. A tenant's `email_verified` never vouches: the email gate sends a code, and a join needs proof of both (D18 safety kept). The person still ends up with a real account, so the product's users get the Library and Cloud Sync. Token exchange for apps that already hold a session is the same connection with `exchange: true`. |
| 3   | Sign in with OIDC providers, magic email link, another device, passkeys                                     | **adopt**                | All built (I-06, I-07, I-16, PX-W14). Connections add enterprise OIDC.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | Accounts tied to email addresses; auto-link licences associated with that email                             | **adopt / adapt**        | Licences already associate by verified email (LX-26 `onAccountEmailVerified`). Identities still never auto-join another account by email match (owner 2026-10-04, a takeover risk), **except** links from a domain-verified connection for addresses in its own domains (IX-03). An enterprise IdP that proved its domain is authoritative for it, which is standard for WorkOS- and Okta-style SSO.                                                                                                  |
| 5   | On OIDC sign-in, pull what profile information we can and pre-fill, but require the rest                    | **adopt**                | Merge RegisterStep and EmailGateStep into one **FinishStep** for every new account (IX-08, PX-21): email (verified or code), screen name (chips per source), picture, birth date only when required, terms.                                                                                                                                                                                                                                                                                           |
| 6   | Magic email sign-in is always available                                                                     | **adopt**                | Delete the per-product `magic_enabled` and `oidc_enabled` toggles (IX-02). Degrade gracefully while email delivery is down (`email_unavailable`, I-18): the card says so and offers the other methods. An `enforce`d SSO domain is the one deliberate exception.                                                                                                                                                                                                                                      |
| 7   | Users can add more methods and passkeys through the portal                                                  | **adopt**                | Built (PX-W12; PX-13 in review; PX-25 todo). Connections appear as methods.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | A storefront's own account system is always available when the product ships through it                     | **adopt**                | Derive it: a Steam channel gives Steam on the card plus the Steam ticket exchange; an App Store channel gives Sign in with Apple plus Game Center; a Play channel gives Google plus Play Games. Read through a Core hook from distribution and commerce (I-14 edit). No `identity.native` block. EOS and the console platforms (I-25) wait until those storefronts are real.                                                                                                                          |
| 9   | Otherwise apps choose which sign-in methods their users get                                                 | **adapt**                | An app chooses **which shortcuts its card shows** (`identity.methods`, defaulting to the derived set) and may add product connections or require one. It cannot remove email or restrict account-level methods: the account is shared, so its methods stay the person's. This is flexibility within limits.                                                                                                                                                                                           |
| 10  | On sign-in, link an existing licence or have one minted                                                     | **adopt**                | LicenseChoiceStep with **Use a license key instead** and New/Create (SIGN-IN.md §3.6). Adapt one rule: when the account has **no** licence and the access policy grants one, mint and bind with no choice step; the result shows on Consent or Return. This matches the brief's "device attachment should be automatic" and needs the owner to amend O-1 rule 4 (IX-00). With one or more licences the step stays (O-1, O-3).                                                                         |
| 11  | Replace devices when there are no free slots                                                                | **adopt**                | Designed (SIGN-IN.md §3.7) and built behind `freeAccountDevice()`. I-08 wires it into the card.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12  | Consent to data sharing, with the ability to provide only some                                              | **adapt**                | Granular consent (IX-09). The product declares `claims.required` and `claims.optional`; ConsentStep shows toggles for the optional ones; the grant stores the subset. Cloud Sync is optional unless the app requires it. Account → **Connected apps** changes or revokes later. No device-wire change (D19 already limits claims to consented ones).                                                                                                                                                  |
| 13  | Accounts are not required; floating licences stay valid                                                     | **adopt**                | Done (S-24, LX-26, UK-42 and UK-43 in progress).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14  | Sign in across portal, web, games, phone/tablet/TV, CLI, TUI                                                | **adopt**                | Channels are designed: web redirect (I-08), native redirect (I-15), device code (TV, CLI and TUI; built, moving to the card in I-08), exchange (I-13, I-14). Consolidate the SDK surface on SIGN-IN.md §2.4's `signIn.start` and `exchange`. Add `pkey login` (IX-07) so Polaris Key's own CLI uses the same flow.                                                                                                                                                                                    |
| 15  | All profile fields including the photo can be overwritten                                                   | **adopt**                | Built (PX-W16, PX-22).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 16  | Suggestions from linked accounts, with the user choosing                                                    | **adopt**                | Built: name chips and picture tiles per method.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 17  | Screen name as a concept, pulled from providers, switchable or user-set                                     | **adapt**                | The account already has exactly this for its one name: per-source suggestions, follow until chosen. Rename it **Screen name** in the UI and copy keys. Keep one public name, not a second "real name" field; buyer names live on commerce records. Not unique (Steam personas aren't). Apps receive it as `name` (and `nickname` in I-21).                                                                                                                                                            |
| 18  | Birth date, pulled from OIDC where available, for future mature-content restrictions                        | **adapt / defer**        | Add `accounts.birthdate` with its source, imported from the standard `birthdate` claim where a connection sends one (Google and Apple don't by default). Ask for it **only** when a product declares `identity.minimumAge`. Apps get `age_over_<n>` booleans, never the date (data minimisation, and COPPA exposure if under-13s are discovered). The gating feature itself waits for a product that needs it.                                                                                        |
| 19  | Confirm and accept terms and privacy before continuing                                                      | **adopt**                | Record **Polaris Key's** terms and privacy acceptance (a platform version) in `account_terms_acceptances` at account creation, and again when the version changes. Product terms reuse the listing's `eulaUrl` and `privacyUrl`. `identity.terms` declares only a version (IX-08, IX-10).                                                                                                                                                                                                             |
| 20  | Console accounts use the same account system; permissions on the account; non-developers kept out           | **adopt**                | IX-06. `/manage/login` is the card in console context; an operator is an account holding at least one role. A bootstrap maps the platform connection's group (today's `PLATFORM_ADMIN_GROUP`) to Superadmin, so the switch locks no one out. Console sign-in requires a phishing-resistant method (a passkey, or SSO through a connection that asserts MFA). The admin cookie keeps its strict properties. The RBAC model itself is the Administration domain's.                                      |
| 21  | A semi-federated OIDC IdP that abstracts every source away                                                  | **adopt (sequence)**     | Make I-08's `authorize` and token endpoints OAuth 2.1-shaped now (plan amendment in IX-00). I-21 then adds discovery, JWKS, `id_token` and userinfo on the **same** endpoints. `sub` stays the pairwise subject, so every upstream source (email, passkey, providers, connections, stores) is invisible to the app.                                                                                                                                                                                   |
| 22  | Access tokens per user (admin or customer) for their feeds and packages; developers also see SDKs           | **adopt**                | IX-07 adds `pkeyp_` personal tokens bound to the **account**. They resolve at use time to the account's Library (usable licences) plus the products its roles grant, including the system product's SDK feeds for developer roles. One token works for every product on `pkg.plrs.im`, which removes F-20's one-credential-per-host limit. An `admin` scope covers the CLI, and `pkey login` replaces `PKEY_ADMIN_COOKIE`.                                                                            |
| 23  | (Licenses) automatic minting: everyone, by OIDC groups, or reject; configurable defaults and group mappings | **adopt (cross-domain)** | One **sign-in access policy** (`licensing.signIn`: `grant: everyone\|rules\|nobody`, a default tier, rules on `group`, `emailDomain` or `claim`, each giving a tier and entitlements). It replaces `autoIssue.mode: oidcDefault`, `oidc.groupRoleMap`, `provisioning[]` (entitlement half), `syncTierOnSignIn` and PS-09's `emailDomains`. Identity supplies the inputs (the connection's groups, the verified email domain); licensing owns the outputs.                                             |
| 24  | (Licenses) a licence minted at login attaches the device automatically, with no key generated               | **adopt**                | Already true: `activateFromIdentity` creates no key (`I/oidc.ts:1091-1140`), and an operator or the person can add one later (PX-W5). The first-licence auto-bind rule is item 10.                                                                                                                                                                                                                                                                                                                    |
| 25  | (General) consolidate, reduce configuration, onboarding wizards, automate, degrade gracefully               | **adopt**                | See the surface-reduction and automation sections. Wizards: platform providers and connections (IX-04), product Identity integration with test sign-in (IX-11). Graceful degradation: email down hides email; a connection down falls back to email unless `enforce`; Identity off still attaches licences to accounts; License off still signs in (`requires-identity`).                                                                                                                             |

## Target design

### Five concepts, no more

1. **Account.** One person, platform-level, with no per-product toggle. It holds:
   - sign-in methods;
   - a profile: screen name, picture, locale, optional birth date;
   - a Library of licences;
   - per-app consents;
   - personal tokens;
   - roles, for operators and developers.

   This is unchanged from S-16, plus roles and tokens.

2. **Sign-in method (link).** One verified `(issuer, tenant scope, subject)`. The kinds:
   - email, always present;
   - passkey;
   - a built-in connection (Apple, Google, Steam);
   - a platform SSO connection;
   - a store identity (Game Center, Play Games, a native Apple ID, a Steam ticket);
   - a product connection.

   Store identities and product connections are tenant-scoped.

3. **Connection.** An upstream IdP configured once:
   - **kind:** `oidc` (redirect sign-in and/or token exchange);
   - **scope:** `platform` or `product:<slug>`;
   - **issuer, client and sealed secret**, plus an optional JWKS override for token-only issuers
     (Firebase publishes a JWKS; to confirm in IX-00);
   - **domains:** DNS-TXT verified for platform connections, with `enforce` per domain;
   - **audience:** customers, operators or both;
   - **claim map:** groups, name, picture, birthdate.

   Google, Apple and Steam are built-in platform connections with fixed endpoints, kept behind the
   existing allowlist gates (`I/providers/net.ts`, `discovery.ts`). Pocket ID becomes a platform
   connection with audience "both" and its domains. Groups are stored per link
   (`account_links.groups_json`, already present) and evaluated from the link used.

4. **App access.** The per-product Identity service, slug `identity`, shown in the UI as
   **App sign-in**. It covers:
   - channels: web redirect, native redirect, device code, exchange;
   - which shortcuts the card shows: derived from distribution channels, overridable;
   - product connections;
   - consent claims, required and optional;
   - product terms version and minimum age;
   - key-entry rules (limit, refusals, `claimByKey`).

   Who receives a licence at sign-in is the **sign-in access policy**, owned jointly with licensing.

5. **Credentials.** Five kinds:

   | Credential                     | What it is                                                                                                                                        |
   | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Account browser session        | `account_sessions`, the portal and card.                                                                                                          |
   | Console session                | The same account, minted only when role and method-strength checks pass; strict 8 h cookie.                                                       |
   | Device token `pkeyt_`          | Unchanged.                                                                                                                                        |
   | Personal access token `pkeyp_` | New: account-bound, scoped `packages:read` (default) or `admin` (role-bounded, step-up to mint, at most 30 days; at most 12 h from `pkey login`). |
   | Robot tokens                   | `pkeyci_` and product- or licence-bound `pkeyr_`, kept for CI and for floating-licence customers.                                                 |

### One authorization server per product

`/<p>/identity` serves:

- **`authorize`** (OAuth 2.1 authorization code with PKCE S256). Parameters: `client_id` (the
  client record, PX-W13), `redirect_uri`, `state`, `scope`, optional `nonce`, `login_hint` (PX-W18).
- **`token`.** It returns the Polaris activation (device token, `subject`, the licence choice
  grant). With `openid` in scope (I-21), it also returns an `id_token`.
- **`request`** (the pushed request, already built in PX-W13).
- **Device code** (RFC 8628, existing routes, moving to the card in I-08).
- **The exchange `token` grant** for native platform tokens and product connections (I-13). It
  uses RFC 8693 token-exchange shape where practical.

I-21 adds `/.well-known/openid-configuration`, JWKS, userinfo, refresh, revocation and
end-session. **There is no second `oauth/*` tree.** Web apps, native apps, games, TVs, CLIs and
partners' backends all use one server. "Sign in with <Product>" becomes the same flow with
`openid` scope.

### The card, end to end

1. Identifier, then routing. If the email's domain has a connection, go to the connection; else
   use the passkey (conditional UI) or the usual-method hint; else send an email code. Shortcut row
   (Apple, Google, Steam, product connections): derived for the product, platform-wide on the
   portal.
2. **FinishStep**, for a new account only. Confirm the email (no code when the provider or a
   domain-verified connection vouches); screen name with source chips; picture; birth date only
   when required; Polaris Key terms and privacy, plus product terms when due; optional "add a
   passkey".
3. For apps only: LicenseChoice. It is skipped on a first auto-mint (item 10), with Replace a
   device inline.
4. For apps only: Consent, granular, on first use or when the requested scope changes.
5. Return.

### Console

1. `/manage/login` renders the same card in console context (ConsoleMethodsStep).
2. Operator SSO domains route to their connection (Pocket ID today).
3. Method-strength policy, then roles (from account grants and connection group mappings, through
   the RBAC domain's model), then the admin session.
4. With no role, the person sees "Ask an administrator for access" (the same page as a forbidden
   route).

**Console IA.** Platform → **Identity** holds:

- Sign-in methods: Google, Apple and Steam status and setup, Turnstile;
- SSO connections;
- Email delivery;
- Policies: console method strength, session lengths, reserved display terms.

Product → **App sign-in** is one page replacing Identity → Portal and Identity → Sign-in. It holds
Integrate (checklist and test sign-in), Methods and connections, Consent and terms, Key entry, and
a link to the access policy. Product → Core → Users stays.

### Portal

Account sections:

- Profile;
- Sign-in methods;
- **Connected apps:** per app, what it gets, Change, Disconnect;
- **Access tokens;**
- Where you're signed in;
- Appearance;
- Your data.

The per-licence token card on the product page becomes a pointer to Access tokens. The licence
token stays for floating licences only.

### The manifest after consolidation

The manifest becomes one `identity:` block, deprecating `oidc:` and `provisioning:` through
ST-19's spelling mechanism:

```yaml
identity:
  methods: [apple, google, steam] # optional; default derived from distribution; email always on
  connections: # app-custom SSO (replaces oidc.provider: custom and I-22's kinds)
    - id: studio
      issuer: https://auth.example.com
      clientId: polaris-key
      clientSecretSecret: STUDIO_IDP_SECRET # redirect sign-in only
      exchange: true # accept its ID tokens at /identity/token
      groupsClaim: groups
  claims: { required: [], optional: [name, picture, email] }
  terms: { version: "2026-10" } # URLs from the listing's eulaUrl/privacyUrl
  minimumAge: 16 # optional; asks the birth date once
  keyEntry: { limit: 10, refusals: true, claimByKey: false }
  redirectPaths: ["/auth/callback"]
licensing:
  signIn: # with the licensing domain: who gets a licence on first sign-in
    grant: rules # everyone | rules | nobody
    tier: standard # the tier for `everyone`, and for rules that name none
    rules:
      - { group: studio-pro, tier: pro, entitlements: { polarisVpn: true } }
      - { emailDomain: example.com }
    syncTier: off # off | upgradeOnly
```

`provisioning[].secretUrlTemplate` (templated secrets) moves to the Config domain's account
overrides (U-03 already reroutes them). `autoIssue.mode: anonymous` stays a licensing enrolment
setting.

### Graceful degradation

| Condition                  | Behaviour                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Email delivery down        | The email row says so; other methods stay.                                                 |
| A connection's issuer down | The email code for that domain, unless `enforce`.                                          |
| A built-in provider unset  | Its button is hidden (fail closed, as today).                                              |
| Identity off               | Licences still attach through the portal and Discover; key entry is unlimited.             |
| License off                | Sign-in still yields a subject and a device token.                                         |
| Cloud Sync off             | The consent item is absent.                                                                |
| Commerce off               | No effect on identity. Store sign-in follows the distribution channel, not the storefront. |

## Surface-area reduction

| Removed or merged                                                                                                                                                                    | Replaced by                                                                                     | WP                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------- |
| `portal_product_settings.oidc_enabled`, `magic_enabled`, `license_key_claim_enabled`, `auto_link_enabled` (4 per-product toggles) and the cross-tenant `/api/capabilities` aggregate | Always on (account-level); connection trust rules decide auto-linking                           | IX-02               |
| Console Identity → Portal and Identity → Sign-in (two pages, `claimByKey` on both)                                                                                                   | One Product → App sign-in page                                                                  | IX-02               |
| `branding_json.passthroughName` and its "App name" field                                                                                                                             | Core presentation (`resolvePresentation`, HA-12)                                                | IX-02, PX-W13b      |
| `oidc_config` (provider/issuer/client/redirect URIs), `oidc.provider: platform\|custom`                                                                                              | Connections (platform and product scope)                                                        | IX-03, IX-05        |
| `PLATFORM_OIDC_*`, `ADMIN_OIDC_*`, `PLATFORM_OIDC_MIGRATION`, `PLATFORM_OIDC_SUNSET`, `PLATFORM_ADMIN_GROUP`, 7 × `SIGNIN_*` env as the primary configuration                        | Console-managed connections with sealed secrets; env kept as a one-release break-glass override | IX-03, IX-04, IX-06 |
| Four OIDC RP implementations (`admin/auth.ts`, `portal/auth.ts`, `oidc.ts`, `providers/discovery.ts`)                                                                                | One RP module with the gated fetch                                                              | IX-03               |
| `oidc.groupRoleMap` (and its unused `role`), `autoIssue.mode: oidcDefault`, `oidc.syncTierOnSignIn`, `provisioning[]` entitlements, PS-09 `autoIssue.emailDomains`                   | One `licensing.signIn` access policy                                                            | IX-10 + licensing   |
| `identity.native.*` (planned, I-14)                                                                                                                                                  | Derived from distribution channels and store connections                                        | I-14 edit           |
| `identity.requireTerms.url` (planned)                                                                                                                                                | The listing's `eulaUrl` and `privacyUrl`; only `terms.version` declared                         | IX-10               |
| I-22's `oidc` and `firebase` exchange kinds, a separate product-only principal                                                                                                       | Product connection with `exchange: true`                                                        | IX-05               |
| I-23 app-specific profiles (new table and API)                                                                                                                                       | Dropped: per-app user data is a Cloud Sync record class; sharing is consent                     | drop                |
| I-21's separate `/<p>/identity/oauth/*` tree                                                                                                                                         | I-08's endpoints, OAuth-shaped                                                                  | IX-00, I-21         |
| RegisterStep and EmailGateStep                                                                                                                                                       | One FinishStep                                                                                  | IX-08, PX-21        |
| `portal_accounts`, `portal_account_emails`, `portal_account_identities`, `portal_license_links` (+ `_v` views), `accounts.terms_json`, `I/accounts/legacy.ts` catch-up               | Contract-phase migration                                                                        | IX-01               |
| Later: `licenses.sub`, `idx_licenses_sub`, `/<p>/identity/auth/{start,callback,choose}`, most of `I/oidc.ts`                                                                         | Account-bound licences after the custom-issuer claim window                                     | IX-05               |
| `PKEY_ADMIN_COOKIE` and the devtools recipe in 6 docs pages                                                                                                                          | `pkey login`                                                                                    | IX-07               |
| Portal-minted licence-bound `pkeyr_` (one per product per licence)                                                                                                                   | One account `pkeyp_` token                                                                      | IX-07               |
| `products.admin_group` (unenforced, critical-flagged)                                                                                                                                | RBAC role mapping, or dropped                                                                   | RBAC domain         |
| SP-10's planned signed browser-session document (wire item W10)                                                                                                                      | Deferred; first-party web apps use the web redirect or the account session                      | SP-10 reorder       |

**Net effect.**

| Surface                                 | Today                                           | Target                                                                                                        |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Identity config stores per product      | 7                                               | 2: `identity_*` rows through the registry, and connections                                                    |
| Product console pages                   | 2 (Portal, Sign-in)                             | 1 (App sign-in)                                                                                               |
| Portal toggles                          | 9                                               | 2: `portal.enabled` and `keyReissue`. The rest become rules, licensing settings or storefront listing (PS-02) |
| OIDC RP code paths                      | 4                                               | 1                                                                                                             |
| Product-IdP paths                       | 3 (legacy custom, I-22 `oidc`, I-22 `firebase`) | 1                                                                                                             |
| Planned authorization trees per product | 2                                               | 1                                                                                                             |
| Env names in the normal setup path      | about 30                                        | about 8: the session secrets and pepper; everything else is a console record with an env override             |

## Automation and onboarding

1. **Derive store sign-in.** Turning on a Steam, App Store or Play distribution channel turns on
   that store's sign-in method and exchange kind for the product, with no identity configuration.
   - The Steam publisher key, app id, ASC team, bundle ids and Play package come from the store
     connections (A-16, A-17b, A-18g).
   - Play Games needs one extra credential: the PGS web client secret. It goes in the Play store
     connection's "Play Games sign-in" sub-section, not an identity block.
   - The App Review 4.8 warning becomes an automated check: an App Store channel without native
     Apple sign-in in the SDK config.
2. **Product App sign-in "Integrate" checklist** (IX-11), one card per experience:
   - **Web app:** enter the origin; one action writes `core.web.origins` and the default
     `identity.redirectPaths: ["/auth/callback"]` and shows a ready-to-paste React and Node
     snippet with the slug filled in.
   - **iOS and Android:** derived; shows what is auto-on.
   - **Desktop, TV, CLI and TUI:** device code and loopback need nothing configured; shows the
     snippet.
   - **Test sign-in:** the operator walks the real card with their own account, mint suppressed
     ("a dry run that mints nothing", S-16 §5.2).
   - **Handshake detection:** the first real passthrough sign-in on each channel ticks that card.
     This is the identity input to the Products domain's dismissable Integration section.
3. **Connection wizard** (IX-04):
   - Paste the issuer. Discovery is fetched through the gated fetch.
   - The page shows the exact redirect URI to register at the IdP, with copy buttons, plus
     step-by-step notes for Pocket ID, Okta, Entra ID, Google Workspace, Authentik and Keycloak.
   - Enter the client id and secret (sealed at once).
   - Run a test sign-in. It shows the claims received and suggests the groups claim.
   - Add domains. The wizard shows the TXT record and polls verification.
   - Choose the audience (customers, operators, both) and map groups to roles (with the RBAC
     domain) and to licence rules (link to the access policy).
4. **Built-in provider setup** (IX-04): Google, Apple and Steam get console forms with
   step-by-step instructions (the Google Cloud OAuth client, the Apple Services ID, `.p8` and
   return URL, the Steam Web API key) and secrets sealed in-console. This retires
   `signin:seal` from the normal path. Each provider shows status: configured, last success, last
   error.
5. **Pocket ID automatic migration** (IX-03): on first deploy the `PLATFORM_OIDC_*` and
   `ADMIN_OIDC_*` values become a platform connection record. The groups mapping (including
   `PLATFORM_ADMIN_GROUP` → Superadmin) is created for the operator to confirm.
6. **CLI** (IX-07): `pkey login` opens the card through device code (with the QR and the
   loopback where available), stores a short-lived `pkeyp_` in the OS keychain, and
   `pkey whoami` and `pkey logout` complete it. Every admin-API command uses it. The publish
   Action keeps `pkeyci_`.
7. **Registry instructions** (IX-07): Account → Access tokens shows per-ecosystem setup lines
   (`.npmrc`, `pip.conf`/uv, `~/.netrc`, `docker login`, Gradle, SwiftPM) that cover every product
   the token reaches, generated from the token's resolution.
8. **First-run automation for people.** A first licence auto-mints and binds at sign-in (item
   10). Licences waiting on a verified email attach on verification (LX-26, built). Profile values
   pre-fill from every linked source (built).

## Migration, data and risk

### The portal contract (IX-01)

- **What changes.** Drop the `portal_*` tables and their `_v` views, `accounts.terms_json` and the
  catch-up job.
- **Precondition.** Run `platformMigrationReport` and a row-count reconciliation: every
  `portal_accounts.id` in `accounts` or `account_tombstones`, every link copied.
- **Rollback.** None to a pre-I-05 Worker after this step. Take a D1 Time Travel bookmark first.
- **Risk.** Low. The catch-up has run since I-05, and I-17 is done.

### Retiring the per-product toggles (IX-02)

- **Report first.** List the products that set `magic_enabled = 0`, `oidc_enabled = 0`,
  `license_key_claim_enabled = 0` or a non-null `auto_link_enabled`.
- **Notify.** Turning a product's email sign-in back on is a behaviour change for its customers.
- **`auto_link_enabled = 0`.** Becomes a licensing-side `licensing.autoAttach: off` only if any
  product set it (likely none).

### Connections (IX-03)

- **Data.** New tables `identity_connections` and `identity_connection_domains`. Pocket ID's link
  issuer key `oidc:https://id.plrs.im` stays, so existing links keep matching. Env stays as an
  override for one release.
- **Re-decide I-17's sunset (owner).** I-17 planned to end end-user Pocket ID sign-in after a
  date. With domain routing, Pocket ID users in the operators' domains can keep SSO, and the
  `operators-only` env mode becomes the connection's audience setting.
- **Without the re-decision.** djdl's group mapping must move to licence rules on another
  connection before the sunset, or its members lose auto-issue.
- **Security.**
  - Domain verification is the trust anchor for auto-linking and `email_verified` vouching.
  - A domain removed from DNS must stop vouching: re-check on a schedule and fail closed.
  - Routing reveals only "this domain uses SSO", which is not account enumeration. Rate-limit it
    anyway.
  - New THREAT-MODEL rows: a rogue connection; a domain takeover; group claim injection (only
    configured claims, from verified ID tokens); the SSRF gate on discovery and token endpoints
    for every connection.

### Product connections (IX-05)

- **Migration.** Products on `oidc.provider: custom` move to a product connection with the same
  issuer and client. Existing `sub`-keyed licences are claimed into accounts at each person's next
  sign-in, using I-17's pattern.
- **Retirement.** `licenses.sub` and the legacy routes go only after an email-less count and a
  sunset date the owner sets.
- **Operator action.** The redirect URI changes from `/<p>/identity/auth/callback` to the card's
  connection callback, so operators must re-register it. The wizard shows the new URI, and the old
  path redirects during the window.

### Console on accounts (IX-06)

- **Risk.** The highest in this audit: operator lockout, or privilege on a weaker method.
- **Mitigations.**
  - Bootstrap role mapping from `PLATFORM_ADMIN_GROUP`.
  - The `ADMIN_OIDC_*` break-glass path stays for at least one release.
  - Method strength is enforced: an email code alone never opens the console.
  - Step-up (`authAt`) moves to the account session's authentication time.
  - The admin cookie format keeps HMAC, `__Host-`, `SameSite=Strict` and CSRF.
- **Audit.** The actor becomes the account id, with a mapping row from the old Pocket ID `sub` so
  history stays attributable.
- **Gate.** Security review before merge, as ST-22 already requires.

### Personal access tokens (IX-07)

- **What it is.** A new credential: AGENTS.md rule 8 gains `pkeyp_`, plus THREAT-MODEL rows.
- **Admin scope controls.** At most 30 days, step-up to mint, RBAC-bounded at **use** time (not
  mint time), listed and revocable in the console by Superadmins.
- **Registry resolution.** Account-bound tokens resolve through the library on every request, so
  F-20's 30-second revocation and licence-suspension window applies unchanged.
- **Existing tokens.** Licence-bound portal tokens keep working until they expire (at most 365
  days). No migration.

### Granular consent (IX-09)

- **Re-ask.** `scope_hash` semantics change from "requested set" to "granted subset of the
  requested set". Every existing grant is re-asked once, at the person's next sign-in to that app.
- **Wire.** None. Device-code and exchange answers already carry only consented claims (D19).

### Profile and terms (IX-08)

- **Columns.** Additive: `accounts.birthdate` and `birthdate_source`.
- **Platform terms.** A new platform version needs a `_platform` row in the acceptances table.
  Everyone accepts once at next sign-in.

### The OAuth-shaped I-08 (IX-00)

- **Plan-mode, all-SDK.** Discovery endpoints and transcripts change before I-08 builds. I-08 is
  not built yet, so nothing deployed migrates.
- **Saving.** One authorization server instead of two (I-21 would otherwise add a second tree and
  its conformance surface).
- **Named in the plan.** The corpus is unaffected: no signed shape changes. Transcripts are
  re-recorded (`redirect-web-*`). Node, React, Python, Swift, Kotlin and Godot follow in I-10a and
  I-10b, which are already scheduled.

### What the target avoids on the wire

- **SP-10 deferral.** Avoids wire item W10, a signed browser-session document across all SDKs.
- **Derived store sign-in.** Uses I-04 §2.8's already-reserved `exchange.kinds[]`, with no new
  discovery shape.
- **Personal tokens.** Touch only the registry host and the admin API. Device tokens and documents
  are untouched.

### LX-08 overlap

LX-08 is in review and writes the `oidc` grant from provisioning and group rank inside `I/oidc.ts`.
Keep its behaviour, but move it into the access-policy evaluator when IX-10 and the licensing
consolidation land, so that the rules have one evaluator for sign-in, Discover and the storefront's
identity paths (`previewIdentityIssue`, `obtain.ts`).

## Backlog changes

| id      | action  | target | note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-08    | edit    | IX-00  | Rewrite the brief as one consolidated spec (fold its five amendment sections into the body; delete what lost). Apply IX-00's plan amendment: OAuth 2.1-shaped `authorize` and `token` (`client_id`, `scope`, optional `nonce`, `login_hint`), reused by I-21. The header name comes from `resolvePresentation` (HA-12), not `passthroughName`. Methods row from the derived set. First auto-mint skips LicenseChoice (if the owner amends O-1 rule 4). Still the critical path: dispatch first. |
| I-09    | edit    | IX-10  | The `identity:` block takes IX-10's shape: `keyEntry {limit, refusals, claimByKey}`, `terms.version` (URLs from the listing), no `native`, `redirectPaths`. `claimByKey` moves here from `portal_product_settings`. Refusal semantics unchanged.                                                                                                                                                                                                                                                |
| I-10a   | edit    |        | SDK surface exactly SIGN-IN.md §2.4 (`signIn.start`, `exchange`, `choice.*`, `subject`, `signOut`, `openAccount`) on the OAuth-shaped endpoints. One `signIn` facade replaces `beginSignIn`/`pollSignIn`/`waitForSignIn`/`signInWithBrowser` (deprecated aliases for one minor).                                                                                                                                                                                                                |
| I-10b   | edit    |        | As I-10a for Swift, Kotlin and Godot.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| I-11    | split   | IX-09  | Library, Discover, Activate and product pages are done (PX-01–PX-17, PX-22). Keep in I-11: per-product export and removal (D25), the support code, full export and soft deletion, and the one Core revocation hook. Connected apps (with consent editing) moves to IX-09.                                                                                                                                                                                                                       |
| I-13    | edit    |        | Exchange kinds come from the derived store set and from product connections (`exchange: true`). `interstitial_required` unchanged. Uses IX-03's one RP and verification module.                                                                                                                                                                                                                                                                                                                 |
| I-14    | edit    |        | Drop the `identity.native` manifest fields and their checklists. Read the Steam app id and publisher key, ASC team and bundle ids, and the Play package and PGS client from store connections through a Core hook (rule 6). Auto-enable per distribution channel. Defer EOS until an Epic storefront exists (mark optional).                                                                                                                                                                    |
| I-15    | keep    |        | Native redirect on the same `authorize` and `token` (now OAuth-shaped).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| I-18    | keep    |        | Email delivery: `email_unavailable` is the graceful-degradation signal the card needs.                                                                                                                                                                                                                                                                                                                                                                                                          |
| I-19    | edit    |        | Absorb PX-19. Rewrite the stale `services/identity/index.md` (D-14 "narrow carve"). Add pages for connections and domain routing, product connections, `pkey login` and personal tokens, consent and Connected apps, store sign-in derived from distribution. Replace every `PKEY_ADMIN_COOKIE` recipe.                                                                                                                                                                                         |
| PX-19   | merge   | I-19   | One identity and portal docs package.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| I-20    | edit    | IX-00  | Re-scope the layer 2 plan: the issuer extends I-08's endpoints (no `oauth/*` tree); product connections replace product-IdP kinds (IX-05); app-specific profiles dropped; clients extend PX-W13's client record. Smaller plan (0.4–0.6 weeks).                                                                                                                                                                                                                                                  |
| I-21    | edit    |        | Builds on I-08's OAuth-shaped endpoints. Adds discovery, JWKS (separate RS256 keyring), `id_token`, userinfo, refresh, revocation, end-session and OIDF conformance. Estimate drops by roughly a third because authorize, token and consent already exist.                                                                                                                                                                                                                                      |
| I-22    | merge   | IX-05  | Bring-your-own-auth becomes a product connection with `exchange: true`. `firebase` is an `oidc` connection with a JWKS override. Linking under step-up becomes the email gate's proof-of-both join.                                                                                                                                                                                                                                                                                             |
| I-23    | drop    |        | App-specific profiles duplicate Cloud Sync account × product data and add a table, an API and consent items nobody asked for. Per-app user data uses a Cloud Sync record class (`ownerRead`). Profile sharing is granular consent (IX-09).                                                                                                                                                                                                                                                      |
| I-24a   | keep    |        | Named-user seats (licensing-led, approved plan). No identity change beyond reusing `devices.subject`.                                                                                                                                                                                                                                                                                                                                                                                           |
| I-24b   | keep    |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| I-25    | reorder |        | Defer to optional, after I-21. Console-platform (PSN, Xbox, Nintendo) sign-in waits until such a storefront is real, by the same logic as "Microsoft/Xbox only if that storefront becomes real".                                                                                                                                                                                                                                                                                                |
| PX-12   | edit    | IX-03  | Login card v2 adds domain routing on the identifier step (`{next: "sso"}`), connection buttons and the `enforce` state. The new-account path ends in FinishStep (with PX-21).                                                                                                                                                                                                                                                                                                                   |
| PX-21   | edit    | IX-08  | Becomes **FinishStep**: the email gate plus RegisterStep merged for every new account. Screen name chips, picture, conditional birth date, Polaris Key terms and privacy, product terms.                                                                                                                                                                                                                                                                                                        |
| PX-13   | keep    |        | In review. Its "connected products" half is superseded by IX-09's Connected apps when that lands.                                                                                                                                                                                                                                                                                                                                                                                               |
| PX-14   | edit    |        | The header reads Core presentation (HA-12). The ConsentStep variant carries IX-09's toggles.                                                                                                                                                                                                                                                                                                                                                                                                    |
| PX-15   | keep    |        | Linking and device approval after sign-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PX-25   | keep    |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PX-W19  | keep    |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PX-W18  | keep    |        | Sign-in hints become `login_hint` on the OAuth-shaped `authorize` (already planned).                                                                                                                                                                                                                                                                                                                                                                                                            |
| UK-44   | keep    |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PX-W13b | edit    |        | `identity.displayNameApproved` and `identity.reservedDisplayTerms` apply to the presentation name (HA-12 resolver), not `passthroughName`. Align with LX-05's `licensing.reservedNames` as one reserved-names list (cross-domain).                                                                                                                                                                                                                                                              |
| ST-14   | edit    | IX-02  | Copy only `portal.enabled`, `keyReissue` (to licensing) and `claimByKey` (to `identity.keyEntry.claimByKey`). **Do not** register `oidc_enabled`, `magic_enabled`, `license_key_claim_enabled` or `auto_link_enabled`; IX-02 retires them first.                                                                                                                                                                                                                                                |
| ST-15   | keep    |        | `identity.browserSessionDays` and the session policies; host them on Platform → Identity → Policies (IX-04).                                                                                                                                                                                                                                                                                                                                                                                    |
| ST-21   | edit    | IX-06  | `can()` reads roles from the **account** session (IX-06), not Pocket ID groups.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ST-22   | merge   | IX-06  | Per-product operator roles join the RBAC program (Administration domain). IX-06 supplies the account-based principal. The security review stays.                                                                                                                                                                                                                                                                                                                                                |
| SP-10   | reorder |        | Defer and re-plan after I-08. First-party cookie mode should ride the account session or the web redirect's bearer token, not a per-product licence cookie with a new signed document (avoids wire item W10). This reverses part of a 2026-10-05 owner decision, so the owner confirms.                                                                                                                                                                                                         |
| PS-09   | merge   | IX-10  | `email_domain` obtain path: an `emailDomain` rule in `licensing.signIn.rules` (verified emails only), evaluated identically at sign-in, Discover and the storefront.                                                                                                                                                                                                                                                                                                                            |
| PS-07   | keep    |        | Steam ownership through the linked Steam sign-in: uses the derived Steam method.                                                                                                                                                                                                                                                                                                                                                                                                                |
| U-05    | keep    |        | Its principal is `devices.subject` (unchanged). Only its dependency on I-08 matters, which stays on the critical path.                                                                                                                                                                                                                                                                                                                                                                          |
| LX-30   | keep    |        | Holder moves through I-12's relink tool. No change.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| I-26    | keep    |        | Done. Its legacy chooser page is deleted by I-08 as already planned.                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Recommended order.** IX-00 (plan) and IX-01 start now, in parallel with I-09. Then:

1. I-08 (amended).
2. I-10a and I-10b; IX-02.
3. IX-03, then IX-04 and IX-06 (with RBAC), then IX-07.
4. I-13, then I-14 (edited) and I-15.
5. IX-08 and IX-09 with PX-12, PX-14 and PX-21.
6. IX-10, IX-05, then IX-11.
7. Last: I-20 (re-scoped) and I-21.

## New work packages

| Proposed id | Title                                                                                                                        | Plan mode | Deps                      | Size (eng-wk) |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------- | ------------- |
| IX-00       | Plan the identity consolidation                                                                                              | yes       | none                      | 0.8–1.2       |
| IX-01       | Accounts contract phase                                                                                                      | no        | I-17                      | 0.4–0.6       |
| IX-02       | Retire per-product account toggles; one App sign-in page                                                                     | no        | HA-12; before ST-14       | 0.5–0.8       |
| IX-03       | Connections: one OIDC relying party, platform SSO with verified domains, identifier-first routing, Pocket ID as a connection | yes       | IX-00                     | 1.4–2.0       |
| IX-04       | Platform → Identity console area and setup wizards                                                                           | no        | IX-03, ST-09              | 1.0–1.4       |
| IX-05       | Product connections: app-custom SSO and token exchange, replacing `oidc.provider: custom` and I-22                           | yes       | IX-03, I-08, I-13, IX-10  | 1.4–2.0       |
| IX-06       | Console sign-in on Polaris Key accounts                                                                                      | yes       | IX-03, RBAC plan          | 1.2–1.8       |
| IX-07       | Personal access tokens and `pkey login`                                                                                      | yes       | IX-06, F-21               | 1.2–1.6       |
| IX-08       | Profile v2 and FinishStep, Worker half                                                                                       | no        | IX-00, PX-W15, PX-W16     | 0.8–1.2       |
| IX-09       | Granular consent and Connected apps                                                                                          | no        | PX-W13, I-08, I-11, IX-10 | 0.8–1.2       |
| IX-10       | One `identity:` manifest block and the sign-in access policy                                                                 | no        | IX-00, I-09, LX-08        | 0.8–1.2       |
| IX-11       | App sign-in Integrate checklist, test sign-in and handshake detection                                                        | no        | I-08, IX-02, IX-10        | 0.6–1.0       |

### IX-00 Plan the identity consolidation

**Plan mode:** yes (it amends approved plans `I-04` §2.5, §2.8, §3.6 rule 4 and `I-09` §3).

A decision record and amendments covering:

- the connection model: scope, audience, domains, `enforce`, the trust rules for `email_verified`
  and auto-linking, and tenant scoping for product connections;
- the OAuth 2.1 shape of I-08's `authorize` and `token`, and I-21's reuse of them, naming the
  corpus impact (none: no signed shape changes), the transcripts re-recorded and every SDK that
  follows (I-10a, I-10b);
- the first-mint skip of LicenseChoice (owner confirmation of an O-1 rule 4 change);
- granular consent;
- the profile fields (screen name, birth date, age booleans);
- the `pkeyp_` credential: rule 8, scopes, lifetimes, registry and admin-API resolution;
- console-on-accounts, jointly with the RBAC domain;
- the `identity:` manifest block and `licensing.signIn`, jointly with licensing;
- the retirement list and its sunset rules.

Also the spec hygiene: rewrite SIGN-IN.md's precedence notes so the result is one current spec,
not another amendment layer.

### IX-01 Accounts contract phase

**Plan mode:** no.

**Do:**

- A D1 contract migration (the number assigned by the lead): drop `portal_accounts`,
  `portal_account_emails`, `portal_account_identities` and `portal_license_links` with their `_v`
  views, and `accounts.terms_json`.
- Delete `I/accounts/legacy.ts` and its scheduled catch-up, the `rekeyLegacy*` helpers and every
  `portal_*` reference in `merge.ts`, `deletion.ts`, `portal/repo.ts`, `admin/repo.ts` and the
  Identity descriptor's `licenseDelete`.
- Update the `TABLE_OWNERS` and generated data-model docs.

**Precondition:** a reconciliation query recorded in the RUNBOOK.

**Keep:** `licenses.sub` until IX-05.

**Gates:** D1 migration (reversible down script up to the drop), THREAT-MODEL note, rule 10 docs
regeneration.

### IX-02 Retire per-product account toggles; one App sign-in page

**Plan mode:** no.

**Worker:** stop reading `oidc_enabled`, `magic_enabled`, `license_key_claim_enabled` and
`auto_link_enabled`. Email and passkey are always on; platform SSO appears when a connection
exists; key claim is always on. `/api/capabilities` no longer aggregates across tenants.

**Console:** merge Identity → Portal and Identity → Sign-in into **Product → App sign-in**, with
sections:

- Status (Identity on or off, with the toggle);
- Methods shown on the card (derived, read-only until IX-10);
- Key entry (`claimByKey`, the limit);
- Consent and terms (read-only until IX-08);
- Customer portal (`portal.enabled`, key reissue);
- Presentation, read-only from Core → Presentation (HA-12), replacing "App name".

**Data:** an operator report of products whose toggles were off, and a notice.

### IX-03 Connections

**Plan mode:** yes (security model).

**Do:**

- Tables `identity_connections` and `identity_connection_domains`.
- One RP module (discovery, JWKS, PKCE, state, nonce, ID-token verify; SSRF gate and host checks
  for every issuer) replacing `admin/auth.ts`, `portal/auth.ts` and `oidc.ts`'s copies, and wrapping
  `providers/discovery.ts`.
- Domain verification by DNS TXT, re-checked daily; fail closed.
- Identifier-first routing in `POST /api/signin/email/start`, enumeration-safe and rate-limited.
- Per-domain `enforce`.
- Connection links store the groups claim (`account_links.groups_json`).
- A domain-verified connection vouches `email_verified` only for addresses in its domains, and may
  link to an existing account with that address.
- Pocket ID's env trio becomes a seeded platform connection on first deploy; env stays an override
  for one release; I-17's migration modes become connection settings.

**Gates:** THREAT-MODEL section, errors.json only if a new code is needed (prefer existing),
rule 10 for routes.

### IX-04 Platform → Identity console area and setup wizards

**Plan mode:** no.

**Do:**

- Sign-in methods: Google, Apple and Steam status, step-by-step setup, secrets entered in the
  console and sealed under the platform KEK (the outlet-credential custody pattern, P5-01). The env
  `SIGNIN_*` names become overrides.
- Turnstile.
- SSO connections: list, the add wizard (discovery, redirect URI, client, test sign-in with claims
  preview, domains with the TXT record and live verification, audience, group mappings), and
  per-connection status (last success and error).
- Email delivery status (I-18).
- Policies: console method strength, session lengths (ST-15), reserved display terms (PX-W13b).

All settings go through ST-04's registry and ST-07's SettingsRow.

### IX-05 Product connections

**Plan mode:** yes.

**Do:**

- A product-scoped connection used:
  - on that product's card, as a button and for domain routing inside product context;
  - at `/<p>/identity/token` when `exchange: true` (a JWKS-verified ID token, `firebase` as an
    `oidc` connection with a JWKS override; replaces I-22).
- Links are tenant-scoped (`product:<slug>`). A tenant `email_verified` never vouches: the email
  gate's code and the proof-of-both join apply.
- Migration of `oidc.provider: custom` products: config into a connection, `sub`-keyed licences
  claimed at next sign-in (the I-17 pattern), an email-less count, then an owner-set sunset that
  retires `/<p>/identity/auth/{start,callback,choose}`, `licenses.sub` and most of `I/oidc.ts`.
- Old redirect URIs 302 during the window.

**Gates:** plan mode (exchange kinds are discovery-advertised; transcripts), THREAT-MODEL
(tenant-minted identities).

### IX-06 Console sign-in on Polaris Key accounts

**Plan mode:** yes (security review before merge).

**Do:**

- `/manage/login` renders the card in console context. Operators route to their SSO connection.
- Method-strength policy: a passkey, or a connection asserting MFA through `amr`/`acr`. An email
  code alone is refused.
- Roles come from the RBAC domain's grants plus connection group mappings. The bootstrap maps
  `PLATFORM_ADMIN_GROUP` to Superadmin.
- The admin session cookie (unchanged security properties) carries the account id, roles and
  `authAt`, and step-up follows it.
- The no-access page.
- The audit actor becomes the account id, with a mapping from the Pocket ID `sub`.
- `ADMIN_OIDC_*` stays as break-glass for one release.

### IX-07 Personal access tokens and `pkey login`

**Plan mode:** yes (new credential).

**Do:**

- `pkeyp_` account tokens (table, HMAC under the pepper, shown once, expiry, last used).
- Scopes: `packages:read` (default) and `admin`. Admin requires an operator role, step-up to mint,
  at most 30 days, and is bounded by roles at use time.
- The registry host resolves `pkeyp_` across products: the Library's usable licences under each
  feed's access mode, plus role-granted products, plus system-product SDK feeds for developer
  roles. Shared-cache rules follow F-20 §6.
- The admin API accepts `Authorization: Bearer pkeyp_` with the admin scope. Bearer only, never a
  cookie, so no CSRF is needed.
- Portal Account → Access tokens with ecosystem setup snippets.
- `pkey login`, `whoami` and `logout`, with device code in console context and an OS-keychain
  store. `bundle.ts` and the other admin commands move to it; `PKEY_ADMIN_COOKIE` is removed after
  one minor.
- Portal licence-bound `pkeyr_` minting is retired; existing tokens are honoured.

**Gates:** AGENTS.md rule 8, THREAT-MODEL, rule 10.

### IX-08 Profile v2 and FinishStep, Worker half

**Plan mode:** no.

**Do:**

- `accounts.birthdate` and `birthdate_source`, imported from a connection's `birthdate` claim.
- `minimumAge` evaluation exposed only as `age_over_<n>`.
- Screen-name copy keys: `signin.register.*` and `portal.profile.*`, from "Your name" to "Screen
  name".
- One finish API serving both new-account paths (email-code registration and the first provider
  sign-in): the confirm-email, profile and terms state machine of `I/card/gate.ts`, extended.
- Polaris Key terms and privacy acceptance recorded as `_platform` rows with a platform version
  setting.
- Product terms URLs read from the listing's `eulaUrl` and `privacyUrl`.

**Gates:** D1 migration (additive), PRIVACY.md (birth date minimisation), THREAT-MODEL row.

### IX-09 Granular consent and Connected apps

**Plan mode:** no (the portal and card API only; the device wire is unchanged).

**Do:**

- `identity.claims {required, optional}`.
- `AppConsentView` items gain `required` and `granted`. Continue posts the granted subset, and
  `scope_hash` covers it.
- Cloud Sync is optional unless the app lists it as required. Declining leaves sync off for that
  app.
- Portal Account → Connected apps: rows per app with the identity it uses, what it gets, **Change
  what <App> gets** (re-runs consent) and **Disconnect** (revokes the grant and signs the app out
  through I-11's Core revocation hook).

### IX-10 One `identity:` manifest block and the sign-in access policy

**Plan mode:** no. It executes IX-00's amendments to plans/I-09.md §3. Rule 9 drift gates:
`test/schema-parity.test.ts`, `pnpm --filter @polaris-key/manifest` tests, `bundle:action -- --check`.

**Do:**

- The `identity.{methods, connections, claims, terms, minimumAge, keyEntry, redirectPaths}` block
  with validator rules and schema.
- Deprecated spellings through ST-19's mechanism: `oidc.*` maps to `identity.connections[]` (or to
  nothing, for `provider: platform`); `groupRoleMap` to `licensing.signIn.rules`;
  `autoIssue.mode: oidcDefault` to `licensing.signIn.grant: everyone`; `provisioning[]` entitlements
  to rule entitlements; a warning for `groupRoleMap.role`.
- `licensing.signIn` jointly with licensing: one evaluator used by sign-in, Discover
  (`previewIdentityIssue`) and the storefront's identity paths.
- Settings registry entries.
- Regenerate the settings docs.

### IX-11 App sign-in Integrate checklist, test sign-in and handshake detection

**Plan mode:** no.

**Do:**

- The Integrate checklist on App sign-in (the web card writes `core.web.origins` and
  `redirectPaths` in one confirmed action; native cards are derived; device code needs nothing),
  with per-SDK snippets filled with the slug and URLs.
- **Test sign-in:** the operator's own account through the real card, mint suppressed, consent not
  recorded, nothing bound.
- Handshake detection: the first real passthrough sign-in per channel, from the `account.signin`
  audit with product. It ticks the card and feeds the Products domain's Integration section.

## Quick wins

1. **Rewrite I-08's brief as one document** before dispatch. Fold its five amendment sections;
   keep only what wins. The same for PX-14 and I-09. This is process only and saves every builder
   an hour of reconciliation.
2. **Hide "OIDC access" and "Email magic links"** from Identity → Portal now (`Portal.tsx:108-109`).
   Treat them as on in `portalAuthCapabilities`, after a one-query report of products that set
   them off.
3. **Show `claimByKey` on one page only.** Remove the copy from `SignIn.tsx:495`.
4. **Rewrite the stale intro** of `packages/docs/src/content/docs/services/identity/index.md` and
   the `I/index.ts` header. D-14's "no centralized identity capability" is false now.
5. **Validator warning for `oidc.groupRoleMap.<group>.role`.** Nothing reads it
   (`I/oidc.ts:782-830`); djdl's `admins: {role: admin}` grants nothing, and operators should know.
6. **Label `core.adminGroup` "not enforced"** in the console (or hide it) until RBAC uses it. It is
   flagged critical and security-widening but gates nothing (`W/admin/authz.ts:6-11`).
7. **Record Polaris Key terms acceptance** at account creation as a `_platform` row in
   `account_terms_acceptances`. A tiny change to `I/card/gate.ts` and RegisterStep. It closes the
   "accept terms before continuing" item for the platform.
8. **Copy:** "Your name" becomes **Screen name** in Profile and RegisterStep.
9. **Point the passthrough header at Core presentation** when HA-12 merges (`passthroughDisplayName`
   → `resolvePresentation`), keeping `passthroughName` as a fallback for one release.
10. **File IX-01** (the contract phase) now. It is unowned, has been unblocked since I-17, and
    shrinks every merge and deletion path.
11. **Add `pkey login` to the docs backlog** and mark `PKEY_ADMIN_COOKIE` recipes as temporary in
    `build/onboarding.md:306` and `agents/recipes.md:117`.

## Cross-domain dependencies

- **Licensing.**
  - The sign-in access policy (`licensing.signIn`: everyone, rules or nobody, a default tier,
    group, email-domain and claim rules) replaces `autoIssue.mode: oidcDefault`, `groupRoleMap`,
    `syncTierOnSignIn` and provisioning entitlements, and absorbs PS-09.
  - LX-08 (in review) writes the `oidc` grant inside `I/oidc.ts`. Its rules move into the shared
    evaluator.
  - First-licence auto-bind at sign-in (O-1 rule 4 amendment).
  - `claimByKey` and key reissue become licensing or key-entry settings.
  - LX-05's reserved names and PX-W13b's reserved display terms merge into one list.
- **Administration and RBAC.**
  - IX-06 makes operators accounts. The RBAC domain owns the role model (Superadmin, Platform
    Admin, `{Product} Admin`, Console Access), the grants storage and `can()` (ST-21 and ST-22).
  - Connections supply group claims for OIDC role mappings.
  - `core.adminGroup` is either the product-admin mapping or dropped.
  - Console sign-in policy (method strength) lives on Platform → Identity.
- **Release, distribution and feeds.**
  - Personal tokens resolve feed access per account (Library plus roles).
  - System-product SDK feeds need a "developers" audience (hidden from customers, visible to
    developer roles).
  - Store sign-in derives from distribution channels and store connections (the Steam app id and
    publisher key, ASC team and bundle ids, the Play package and a new PGS client secret on the
    Play connection).
  - `releases_enabled` belongs with the Polaris Key direct-download channel, not portal toggles.
- **Commerce and storefront.**
  - PS-02 already moved Discover listing to `storefront.polarisKey.*`; `discover_enabled` retires
    with PS-11.
  - Store-purchase grants need the account's store links (Steam): PS-07 and LX-11.
  - Commerce off never affects sign-in.
- **Config and Cloud Sync.**
  - Templated secrets from `provisioning[]` go to account overrides (U-03 already does this).
  - Cloud Sync stays `requires: [config, identity]` with the principal `devices.subject`.
  - Its consent item becomes optional or required per app (IX-09).
  - Per-app user data (the dropped I-23) uses a Cloud Sync record class.
- **Products and onboarding.** IX-11's handshake detection and Integrate checklist plug into the
  Products domain's Integration section and its dismissal.
- **Hosted assets and presentation.** HA-12's `resolvePresentation` is the app name and icon for
  the sign-in header, consent, emails ("<App> via Polaris Key") and Connected apps.
- **SDKs, UI kits and wire.**
  - IX-00 amends I-04's web redirect (plan mode, transcripts, all six SDKs through I-10a and
    I-10b).
  - SP-10 deferral removes wire item W10.
  - UI kits (UK-42, UK-43, UK-44; terminals UK-13 and UK-14) adopt FinishStep and granular consent
    copy keys.
  - The SDK `signIn` facade replaces four device-code calls.
- **Settings (ST).**
  - ST-14 must not register the retired toggles.
  - ST-09 hosts Platform → Identity.
  - ST-15 holds session lengths.
  - ST-04 and ST-07 back every new identity setting.
- **Security.** New THREAT-MODEL sections for connections (domain trust, rogue issuer, group
  injection), product connections (tenant-minted identities), console-on-accounts (method strength,
  lockout and break-glass) and `pkeyp_` tokens. PRIVACY.md covers birth date and granular consent.
