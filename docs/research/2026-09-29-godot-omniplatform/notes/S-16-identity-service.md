> Research note for [Godot on Polaris Key](../README.md), 2026-10-04. Spike S-16, commissioned

> **Owner decisions (2026-10-04):** Option C approved. **Scope: everything, phases 0–3 including the per-product issuer** ("Sign in with <Product>", ~86 agent-days). Issuer: decide in I-16's plan, leaning in-house on jose (Ory Hydra stays the alternative). Safety defaults confirmed: a licence carrying an email attaches only to a user with that verified email (no attach-by-key unless the product sets `claimByKey`); a licence with an owner never moves by presenting its key; Polaris runs no recovery desk — beyond a user's remaining links, recovery is the developer's job via the console's audited relink tool (step-up, reason, notice, 72-hour undo); custom auth domains deferred, passkeys enrol on key.plrs.im only. Pocket ID facts (checked by the lead, 2026-10-04): separate OIDC clients per app are supported [V] (pocket-id.org/docs/introduction), so I-03 can give the console its own client; `email_verified` is in the discovery document's `claims_supported` [M] (id.plrs.im/.well-known/openid-configuration), so verified status is available per user at sign-in; a bulk export through the admin REST API needs an admin API key (the users endpoint answers 401 without one) [M] — I-09 therefore migrates by claim at each user's next sign-in, with a bulk export only if the owner issues an admin API key.
> by the lead on the owner's direction of 2026-10-04: define what a proper Identity service is,
> whether a proxy to a platform or product IdP, a Polaris-run OIDC/OAuth2 provider, or both. It
> has no program brief yet; §8 proposes an `I-` work-package namespace. Research and design only:
> no product code changed, nothing was deployed, and no account or credential was used. The only
> live calls were two anonymous `GET`s of the platform IdP's public discovery and JWKS documents
> (§3.1). File references are to the tree at `0c35758e` (`W/` = `packages/worker/src/`,
> `M/` = `packages/worker/migrations/`).

# S-16: the Identity service, defined

Evidence tags, as in the other notes:

- **[V]**: verified by reading this repo's code, config or docs, or a primary external source;
- **[M]**: measured here (a command run on this machine, 2026-10-04 14:34 UTC);
- **[I]**: inference or recommendation;
- **[U]**: unverified: needs an account, partner documentation or a staging deploy.

## 1. Summary and recommendation

**Question.** Identity is the least defined of the seven services. The owner asked whether it
should proxy to a platform or product identity provider (IdP), or run a lightweight OIDC/OAuth2
provider of its own based on the user's account (licence, email or upstream OIDC), and what the
feature as a whole should look like.

**What it is today.** Identity is not an identity service. It is three older pieces of code that
D-14 moved behind one service descriptor, and nothing more [V]
(`W/services/identity/index.ts:4-10`). Those pieces are product OIDC sign-in that ends in a
licence row and a device token, a first-party browser cookie, and the platform-global customer
portal. There is no user record: "the user" is four columns on `licenses` (`M/0001_init.sql:64-81`).
Nothing a developer's own backend can verify is issued. Native apps can only sign in with device
code. Only one IdP shape works, and that shape is our own platform IdP's. §3 lists fifteen gaps.

**What the platform IdP is.** `id.plrs.im` is a self-hosted **Pocket ID** instance [M]. It is a
passkey-first OIDC provider: RS256 only, `subject_types_supported: ["public"]`, and the
non-standard `/api/oidc/token` path that our code hard-codes. Platform operators, the portal and
every `provider: platform` product's end users all share it, through one client (§3.1). So "run
our own OP" partly exists already, but as a third-party server outside the Worker. It cannot
issue per-product (pairwise) subjects or carry licence claims, and it holds operator and customer
identities in one directory.

**Recommendation: Option C, "broker in, own accounts, thin issuer out" [I].** Identity becomes
the service that knows **who a person is to one product**. Everything else in the suite hangs off
that answer.

1. **A product-scoped `user`** is the principal. Licences, store bindings, devices (later as seat
   holders) and portal links attach to it. It replaces "the licence is the person".
2. **Many login methods per user**, all ending in one internal `signIn(verifiedIdentity)` step:
   - Polaris-run credentials: email one-time code or magic link, then passkeys;
   - federated upstream OIDC: the product's own IdP (Auth0, Clerk, Firebase, Supabase, Cognito,
     Keycloak, Entra), plus Google, Apple and Discord;
   - platform game identities verified natively: a Steam ticket, a Game Center signature, a Play
     Games code, an EOS ID token;
   - a licence key, as a low-assurance principal.
3. **One RFC 8693-shaped exchange endpoint** for apps that already hold a credential, which is
   every native and game case, plus a small **email-code API** for in-app email sign-in. The
   existing redirect broker and RFC 8628 device code (TV, console, Godot) stay as the
   browser-based front doors.
4. **The device keeps the signed licence document as its only gate.** Phases 1 and 2 return the
   existing activation response, so `PROTOCOL_VERSION` stays 4. They do add device-facing routes
   (email code in phase 1, exchange and native redirect in phase 2), so each goes through plan
   mode: contract, `errors.json`, transcripts, then all six SDKs (§5.3).
5. **Later, a thin per-product OIDC issuer**: "Sign in with <Product>", with ID and access tokens
   carrying entitlement claims, for the developer's web services and backend. It is signed by a
   separate RS256 keyring and never consumed by device SDKs.
6. **Operators stay on Pocket ID.** End users of `provider: platform` products move off it onto
   the Polaris-run login. That ends the shared-directory risk.

Option A (a pure broker) leaves developers with no IdP of their own, which is most indie and Godot
studios, with nothing to sign in with, and it still issues nothing. Option B (a full OP that owns
credentials) would still have to federate to reach Steam or Game Center, and it carries the most
liability. Option F (run a separate open-source IdP such as Zitadel, Keycloak or Ory, §4) buys a
certified OP but adds a second account store, a non-Workers host, and still no game-platform
verification. C is A's verifiers plus a deliberately small B, sequenced so each phase ships value
on its own.

**Cost, for a small team [I].** Phases 0 to 2 are about **72 agent-days** (about 9–11 calendar
weeks with three parallel lanes and review); phase 3 (the issuer) is about **14 more**. The
**minimum viable Identity** cut (I-01 to I-08, I-10, I-11, I-21 and I-22, with only the `oidc`
and `firebase` verifiers) is about **46 agent-days**, roughly what Option A costs (about 41) while also
giving developers with no IdP an email login. Figures and the cut line are in §7.1.

```mermaid
flowchart LR
  subgraph In["Login methods (per product, data in .pkey/product)"]
    E["Email code / magic link"]
    PK["Passkey (phase 2)"]
    UP["Upstream OIDC<br/>product IdP, Google, Apple, Discord"]
    GM["Game platforms<br/>Steam ticket, Game Center,<br/>Play Games, EOS"]
    LK["Licence key<br/>(low assurance)"]
    AS["Product backend assertion<br/>RFC 7523 (later: consoles)"]
  end
  subgraph Doors["Front doors"]
    RD["Redirect broker<br/>/identity/auth/*"]
    DC["Device code RFC 8628<br/>TV, console, Godot"]
    TX["Exchange<br/>POST /identity/token"]
    EC["Email-code API<br/>(in-app, gated, §5.4)"]
  end
  subgraph Id["Identity service"]
    SI["signIn(verifiedIdentity)"]
    U[("users + identity_links<br/>product-scoped")]
  end
  subgraph Out["What a sign-in yields"]
    DT["Device token + signed licence doc<br/>(unchanged wire, v4)"]
    BS["Browser session"]
    OT["OIDC ID / access tokens<br/>'Sign in with Product' (phase 3)"]
  end
  E & PK & UP & LK --> RD
  UP & E --> DC
  E --> EC
  UP & GM & AS --> TX
  RD & DC & TX & EC --> SI --> U
  U --> L["License: licences, seats"]
  U --> C["Commerce: store bindings"]
  U --> P["Portal account (global) links"]
  SI --> DT & BS & OT
  OPS["Console operators"] -.->|"stay on Pocket ID<br/>id.plrs.im"| CON["Console"]
```

The decisions this needs from the owner are in §10, each with a recommended default.

## 2. What Identity is for: the jobs

Each job is drawn from the landscape survey (licensing peers Keygen, Cryptlex, LicenseSpring,
Lemon Squeezy, Paddle and Gumroad; game backends EOS, PlayFab, Unity Authentication, Nakama, Talo
and Xsolla; Firebase, Supabase and RevenueCat; sources in §11). **Now** means phases 0 to 2 of
§7, **later** means phase 3 or beyond, and **never** means out of the service's charter.

| #   | Job                                                                                                                                                        | Scope                      | Why                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | A person signs in from an app or game and their licences and entitlements follow them to every device                                                      | **now**                    | Table stakes: every licensing peer with users (Keygen, Cryptlex, LicenseSpring) and every game backend has it [V]. Polaris half-has it: product OIDC mints a licence [V] (`W/services/identity/oidc.ts:697-845`)                                                                                  |
| J2  | **Hosted accounts for developers with no IdP**: email code or magic link, later passkeys                                                                   | **now**                    | Most indie and Godot studios have no IdP. Talo, Unity Authentication and Keygen all ship a built-in account [V]. Polaris already sends magic links, but only for the Polaris-branded portal [V] (`W/services/identity/portal/email.ts:21-27`)                                                     |
| J3  | **Bring your own auth**: an app that already signs users in (Clerk, Firebase, Auth0, Supabase, Cognito) exchanges that token                               | **now**                    | No user migration for the product. One generic JWKS verifier covers about 11 of 17 surveyed providers [I]. Today no mainstream IdP works as `custom` at all (§3.2)                                                                                                                                |
| J4  | **Silent sign-in with the platform identity**: Steam, Game Center, Play Games, EOS                                                                         | **now** (phase 2)          | The game-program differentiator. It avoids an extra-account wall (Steam labels third-party-account games on the store page [U]). Steam ticket verification and x509 chain verification already exist for commerce [V] (`W/services/distribution/commerce/steam.ts`, `apple.ts`, `W/core/x509.ts`) |
| J5  | Sign in on a TV, console, kiosk or headless Godot build with a phone                                                                                       | **now** (exists, keep)     | RFC 8628 is implemented and hardened, with QR codes in Godot and Kotlin [V]. Only Godot sends the P1-07 confirm-and-attach step [V] (`packages/sdk-node/src/identity/client.ts:16-19`)                                                                                                            |
| J6  | Link identities and merge accounts (bought on Steam, play on mobile; anonymous first, sign in later)                                                       | **now** (policy)           | Every game backend has link, unlink and merge with explicit rules (Nakama never removes the last identifier; RevenueCat's Transfer-or-Block restore policy) [V]. Polaris verifies store purchases but hangs them on licences, not people [V] (`M/0052_commerce.sql:13-27`)                        |
| J7  | The customer portal: find my licences, devices and downloads                                                                                               | **now** (exists, converge) | Lemon Squeezy's My Orders and Paddle's portal set the bar; ours is already global with magic links [V]. The gaps are the relation to product users, server-side sessions, GDPR export and a signed auto-login link API                                                                            |
| J8  | **"Sign in with <Product>"**: ID and access tokens with entitlement claims for the developer's forum, Discord bot, web companion, cloud saves or MCP tools | **later** (phase 3)        | No licensing peer offers it, so it is a real differentiator [V]. It is useless without J1's principal, and it makes Polaris a token issuer with ongoing key, consent and conformance duties                                                                                                       |
| J9  | Native redirect sign-in (loopback or claimed-HTTPS redirect) so desktop and mobile apps are not limited to device code                                     | **now** (phase 2)          | Swift's `PolarisLoginView(onSignIn:)` defaults to a no-op and four native SDK rows are planned and unowned [V] (`sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift:107-125`). Device code is a poor fit on a phone                                                                           |
| J10 | Named-user seats: N users per licence, M devices each                                                                                                      | **later**                  | Keygen `maxUsers` and Cryptlex named-user licences [V]. It needs the user principal first and probably a user claim in the signed licence document, which is a corpus and all-SDK event                                                                                                           |
| J11 | B2B organisations with per-customer SSO and admin seat assignment                                                                                          | **later** (enterprise)     | Enterprise-tier everywhere (LicenseSpring, Cryptlex SAML, Keygen) [V]. Only worth building once J1 and J10 exist                                                                                                                                                                                  |
| J12 | Console platforms (PSN, Xbox, Nintendo) through the product's backend or EOS                                                                               | **later**                  | Verification is under NDA and cannot ship in an open-source Worker or SDK [I]. An RFC 7523 assertion from the product's backend, or EOS Connect, covers it without NDA code                                                                                                                       |
| J13 | The console's own operator sign-in                                                                                                                         | **never** in Identity      | Every peer separates "your team signs in" from "your customers' identity" [V]. Operators stay on the platform IdP (`W/admin/authz.ts:1-13`). Folding them into the end-user principal would put console authority one OP bug away from any customer                                               |
| J14 | Passwords                                                                                                                                                  | **never**                  | Credential stuffing, breach monitoring and reset flows for no gain over email codes plus passkeys [I]                                                                                                                                                                                             |
| J15 | Dynamic client registration and an open third-party app ecosystem                                                                                          | **never** (for now)        | Clients belong to a product's developer, so they are registered in the console or manifest. DCR is a spam and abuse surface [I]                                                                                                                                                                   |
| J16 | Social features: friends, presence, leaderboards                                                                                                           | **never**                  | That is a game backend (Nakama, PlayFab, EOS), not identity [I]                                                                                                                                                                                                                                   |

## 3. Current state and gaps

### 3.1 The platform IdP is Pocket ID

| Fact                                                                                                                | Evidence                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id.plrs.im` is "PocketID", the production `PLATFORM_OIDC_ISSUER`                                                   | [V] `docs/DEPLOYMENT.md:20,87-95`, `docs/RUNBOOK.md:20`                                                           |
| Its discovery document names `service_documentation: https://pocket-id.org/docs`                                    | [M] `curl -s https://id.plrs.im/.well-known/openid-configuration`                                                 |
| `token_endpoint` is `/api/oidc/token`, the path `oidc.ts`, `portal/auth.ts` and `admin/auth.ts` hard-code           | [M] same; [V] `W/services/identity/oidc.ts:1466`, `W/services/identity/portal/auth.ts:284`, `W/admin/auth.ts:146` |
| Signing: `id_token_signing_alg_values_supported: ["RS256"]`; the JWKS holds one RSA key                             | [M] same, plus `curl -s https://id.plrs.im/.well-known/jwks.json`                                                 |
| Subjects: `subject_types_supported: ["public"]`, so one human has the same `sub` in every product that uses it      | [M]                                                                                                               |
| Supported: device grant, refresh, `client_credentials`, PAR, introspection, RFC 9207 `iss`, PKCE `plain` and `S256` | [M]                                                                                                               |
| One client serves console admin, the root portal and every `provider: platform` product                             | [V] `docs/DEPLOYMENT.md:94-95`; `W/platformOidc.ts:9-30`                                                          |
| Where Pocket ID runs, and how it is backed up and patched                                                           | [U] not on the Worker; not in this repo                                                                           |

Consequences [I]:

- The "hard-coded paths, no discovery" defect (G4) is an accident of having built against one
  Pocket ID instance. Discovery would make the platform and custom paths the same code.
- A Pocket ID user in the `admins` group is a platform operator, and a product's customer is a
  user in the same directory. A mistake in group assignment, or a compromise of the shared client
  secret, crosses from customer to operator. This is G5.
- Pocket ID issues public subjects only, so it cannot be the per-product issuer for J8 without
  leaking a cross-tenant correlator. It also cannot put licence claims in its tokens.

### 3.2 Gaps

All [V] unless marked. G1 to G15 are the current-state survey's numbering.

| #   | Gap                                                                                                                                                                                                            | Evidence                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | No token a developer's backend or web app can verify: no ID, access or refresh token, no userinfo, no per-product issuer or JWKS                                                                               | `W/services/identity/index.ts:61-82` (discovery fragment: endpoints only); `oidc.ts:848-861` (sign-in yields a device token or cookie)                                                                                                               |
| G2  | No sign-in for third-party web origins: `return_to` must be same-origin with `key.plrs.im`, the cookie is first-party and cookie routes never answer CORS                                                      | `oidc.ts:440-450`; `W/services/identity/browserSession.ts:94-96`; `W/core/cors.ts:89-92`                                                                                                                                                             |
| G3  | No native redirect sign-in (no loopback, custom scheme or claimed HTTPS redirect). `/auth/poll` is advertised but "currently completes no flow"                                                                | `oidc.ts:1871`; `packages/docs/src/content/docs/services/identity/oidc.md`                                                                                                                                                                           |
| G4  | One IdP per product, hard-coded paths, fixed scope `openid email profile groups` (Google rejects the unknown `groups` scope [U]), no social providers, no linking                                              | `oidc.ts:904-908,1466,1499`                                                                                                                                                                                                                          |
| G5  | The platform IdP and its one client are shared by operators, portal customers and product end users                                                                                                            | §3.1                                                                                                                                                                                                                                                 |
| G6  | No email, magic-link or passkey sign-in for products. Magic links exist only for the portal                                                                                                                    | `W/services/identity/portal/auth.ts`, `portal/email.ts:21-27`                                                                                                                                                                                        |
| G7  | Identity is welded to License: every sign-in writes a `licenses` row and needs a tier, yet the service declares `requires: []`                                                                                 | `oidc.ts:591-635,697-845`; `tools/services.json` (`identity`)                                                                                                                                                                                        |
| G8  | No user model or management: no users list, disable, delete or per-user audit; `groupRoleMap.role` and the product `admin_group` are inert                                                                     | `M/0001_init.sql:64-81`; `oidc.ts:612`; `W/admin/api.ts:26-28`                                                                                                                                                                                       |
| G9  | An operator-issued licence (matched by email) and the same person's OIDC licence are two licences; `activateFromIdentity` never matches by email; `portal_license_links.source='admin'` is never written       | `oidc.ts:697-845`; `W/services/license/admin/licenses.ts:148-155`                                                                                                                                                                                    |
| G10 | The portal ignores the Identity enable flag, contradicting the service summary and the docs index                                                                                                              | `W/services/identity/portal/repo.ts:329-416`; `packages/worker/test/portal.test.ts:81-98`                                                                                                                                                            |
| G11 | Weak sessions: the browser session's document is unsigned and still the legacy fused shape; portal sessions are stateless HMAC with no server-side logout and fall back to `ADMIN_SESSION_SECRET`              | `W/services/identity/doc.ts:7-12`; `W/services/identity/portal/session.ts:9-12,80-92`                                                                                                                                                                |
| G12 | No typed wire contract or conformance for Identity: no identity types in `shared-protocol`; parity tracks only `identity.oidc` and `identity.devicecode`; transcripts cover device code only                   | `conformance/parity/features.json:487-500`; `conformance/transcripts/devicecode-*.json`                                                                                                                                                              |
| G13 | Weak console surface: no OIDC editor (manifest only), the Sign-in page reads Identity through Config's edge-mint endpoint, and `OIDC_ISSUER_ALLOWLIST` is not applied when unset                               | `W/services/identity/admin.ts:16-18`; `packages/admin/src/console/pages/identity/SignIn.tsx:1-10`; `oidc.ts:200-231`                                                                                                                                 |
| G14 | Data hygiene: fresh OIDC licences are inserted without `origin`, so they default to `'admin'`; portal identities are keyed `provider: "oidc"`, not by issuer; THREAT-MODEL A6 and §5 are stale                 | `oidc.ts:823-830` vs `W/repo.ts:807-831`; `portal/auth.ts:327-330`; `docs/security/THREAT-MODEL.md:33` (lists the dropped `customers` table), `:3618-3619` (say the product flow skips the non-empty `sub` and `email_verified` checks it now makes) |
| G15 | Single-use artefacts (magic links, OIDC and device-flow records) are consumed with KV `get` then `delete`, which is not atomic across regions; the `_portal` rate-limit shard is a global chokepoint (R10-04a) | `portal/auth.ts` (magic verify); `W/rateLimitDo.ts`                                                                                                                                                                                                  |

**Incoming dependency.** F-20 is merged and approved (`program/plans/F-20.md:3`). It binds
licence-bound `pkeyr_` registry tokens to a portal account and has Identity revoke them when
`syncAccountLicenseLinks` drops a link or an account is deleted (`plans/F-20.md:105,121-146`).
F-21 builds that. Any change to portal accounts or links must keep those revocation hooks or
replace them one-for-one [V].

## 4. Options

Every option keeps RFC 8628 device code. It is the only browser-less path for Godot on a TV or
console, and it already exists.

### Option A: broker only

**Architecture.** Polaris stays a relying party and never holds a credential. Fix the existing
broker (discovery, configurable scopes and groups claim, RFC 9207 `iss`), allow many providers per
product (`identity.providers[]` in `.pkey/product`), and add an RFC 8693-shaped exchange endpoint
with per-kind verifiers: generic OIDC/JWKS, Firebase x509, Steam ticket, Game Center, Play Games,
EOS, and an RFC 7523 product-backend assertion. Developers with no IdP of their own use the
platform provider (Pocket ID).

**SDK and device impact.** A new `identity.exchange()` and per-platform helpers in all six SDKs.
Godot forwards bytes from GodotSteam (`getAuthTicketForWebApi`) or the EOS plugin; Game Center and
Play Games need thin iOS and Android shims. TV and console sign-in stays device code. The response
reuses the activation response, so the signed shape does not change.

**Security.** Audience confusion is the classic broker bug: `aud`, `azp` (Clerk), `token_use`
(Cognito) and the Steam `identity` string must be enforced and fail closed. Mix-up defence is
needed once a product has several providers. Every discovered URL needs SSRF checks. The broker
holds no passwords, codes or recovery flows.

**Ops cost on Workers.** Per exchange: one request, zero to two subrequests (JWKS on a cache miss,
Steam or Play Games calls), about 1 ms CPU, one to three D1 writes. At 1M exchanges a month it is
within the $5 Workers Paid plan's 10M requests, plus at most about $5 of KV writes for flow state
[V: pricing page; I: arithmetic]. Pocket ID's hosting stays a separate cost [U].

**DX.** Very good for developers who have auth ("Clerk in five lines"). Poor for those who do not:
their users see a Polaris-branded Pocket ID with passkeys only, no email sign-up, and no
product-branded consent.

**Effort.** About **41 agent-days** [I]: I-01, I-02, I-04, I-05, I-20, a links-only I-06 (about
4), I-10, an exchange-only SDK slice (about 6), I-12 and I-13. **Leaves open:** G1 (nothing issued), G5
(shared directory), G6 (no email sign-in), and only a thin principal.

### Option B: own lightweight OIDC/OAuth2 provider

**Architecture.** Polaris becomes the OP. Accounts are Polaris-held and authenticated by email
code or magic link, passkey, licence key, or upstream OIDC used only as a login method. A
per-product issuer at `/<p>/identity` publishes discovery and JWKS, and implements authorize
(code + PKCE S256), token, userinfo, refresh rotation, revocation and RP-initiated logout. Built
in-house on `jose` (already a dependency): `@cloudflare/workers-oauth-provider` issues no ID tokens
and stores everything in KV, OpenAuth is beta and has no OIDC discovery, and panva's certified
`oidc-provider` is Node-only [V] (sources in §11).

**SDK and device impact.** Off-the-shelf OIDC libraries cover most platforms (AppAuth on iOS and
Android, `oauth4webapi` in JS, Authlib in Python). Godot has none, so it stays on device code, now
as an OAuth device grant. Game identities need federation anyway: Steam's web sign-in is OpenID
2.0, and Game Center and Play Games are not OIDC at all.

**Security.** Polaris becomes the platform's highest-value target. It has to manage RS256 signing
keys separate from the Ed25519 document keys, pairwise subjects, atomic single-use codes (a
Durable Object, never KV), refresh-token reuse detection, email bombing, enumeration and
account recovery.

**Ops cost on Workers.** Compute is about the same as A. Email adds a shared-reputation
constraint: Cloudflare Email Service has conservative daily quotas that grow with reputation, and
every tenant shares the `plrs.im` sender [V]. Optional OpenID certification costs $700 per
deployment for members or $3,500 otherwise [V]; the conformance suite itself is free.

**DX.** Good for "Sign in with <Product>" and for developers with no IdP. For developers who
already have auth it is workable but clumsy: with their IdP configured as an upstream login method,
B supports bring-your-own-auth **by redirect** (the user passes through the product IdP's page,
usually silently on SSO). What B lacks is **token exchange**, so an app that already holds a Clerk
or Firebase token cannot trade it without a browser round trip.

**Effort.** About **45 agent-days** [I] (roughly 3–5k lines of Worker code plus tests): users,
email, passkeys, the OP, console, AppAuth-style SDK wiring. **Leaves open:** native game sign-in,
unless federation is added, which turns it into C.

### Option C: hybrid (recommended)

**Architecture.** B's account model and a deliberately small OP, with A's verifiers as login
methods. Three layers:

1. **Principal**: product-scoped `users` with `identity_links` (§5.1).
2. **Front doors** feed one `signIn(verifiedIdentity)` step: the redirect broker (fixed), device
   code (kept), the exchange endpoint (new), and Polaris-run email and passkey pages.
3. **Outputs**: the device token plus licence document (unchanged), a browser session (signed and
   revocable), and later Polaris-issued OIDC tokens.

**SDK and device impact.** As A for native and game sign-in. Email sign-in on a device goes through
a code typed into the app (an OTP works where switching apps breaks magic links) or through device
code. Phase 3 adds nothing to device SDKs, because issued tokens are for web and backend relying
parties.

**Security.** A's broker rules plus B's OP rules, but phased: email and passkeys arrive before any
token is issued outward, so the OP's riskiest surfaces (refresh tokens, consent, clients) come
last and get their own audit.

**Ops cost on Workers.** Same as B. Pocket ID shrinks to the operator directory.

**DX.** Best of both: "bring your own auth" in phase 2, "no auth? use ours" in phase 1, and "gate
your Discord role on owning the game" in phase 3.

**Effort.** About 72 agent-days for phases 0–2 and 14 for phase 3; the minimum viable cut is
about 46 (§7.1).

### Option F: run a separate open-source IdP for end users

**Architecture.** Keep the Worker as a relying party and stand up a second, end-user IdP outside
it: Zitadel (multi-tenant through instances and organisations), Keycloak (a realm per product),
Ory Kratos for identities plus Ory Hydra as the OAuth2/OIDC server, or a second Pocket ID (one
for all end users, or one per tenant). Licences, the exchange endpoint and game verifiers stay in
the Worker.

**What it buys.** A mature, conformance-tested OP (Keycloak, Hydra and Zitadel all advertise
OpenID certification [U: not re-checked]) with consent, refresh rotation, admin UIs and MFA
already written. That is the strongest argument against writing the OP half of B or C ourselves.

**What it costs** [I]:

- **Hosting off Workers.** A VM or container plus Postgres, backups, patching, uptime and a TLS
  edge; Keycloak is a JVM service with a real memory floor. About $20–100 a month in
  infrastructure [U], and an on-call surface the platform does not have today. Pocket ID
  already shows the pattern: where it runs and how it is backed up is not recorded in this repo
  (§3.1).
- **Multi-tenancy.** Zitadel and Keycloak model tenants natively; Kratos/Hydra and Pocket ID do
  not (one Pocket ID per tenant does not scale past a handful of products). Each product's login
  methods, branding and clients become IdP configuration kept in sync with `.pkey/product` (rule
  5 says products are data: a second source of truth).
- **No game-platform verification.** None verifies a Steam ticket, Game Center signature or Play
  Games code natively (Keycloak has community Steam OpenID 2.0 extensions [U]). J4 still needs
  the Worker's exchange endpoint, so the Worker's user model exists anyway.
- **Licence claims need a hook.** Entitlements in tokens means a Keycloak protocol-mapper SPI
  (Java), Zitadel Actions, or a Hydra token hook that calls back into the Worker on every token
  issue: a cross-system dependency on the hot path.
- **Two account stores.** The IdP's user directory and the Worker's users/licences must stay
  linked; GDPR export and deletion span both systems.

**Best variant: Hydra as the phase 3 issuer only.** Hydra is headless by design: it delegates
login and consent to an external app. The Worker would be that app (its users, email, passkeys
and game links stay where they are) and Hydra would only mint and manage tokens. That swaps
I-16's in-house OP code (about 10 agent-days plus conformance) for running a Go service and
Postgres. It is a real alternative for **phase 3**, not for phases 1–2, and I-16's plan should
weigh it (§10, D12).

**Effort.** Integration about 10–15 agent-days [I] for the IdP plus the Worker hooks, on top of
A's 41 for the broker and verifiers, plus permanent hosting.

### Option D: buy a CIAM (rejected)

Make a hosted CIAM (Auth0, Clerk, WorkOS or Stytch) the platform provider. It solves email,
passkeys and social login quickly, but it costs per monthly active user, it cannot verify Steam,
Game Center or Play Games natively, it cannot put licence claims in tokens without a callout, and
it adds an external dependency to a self-hosted Workers platform [I]. It is no better than A for
products that already have auth. Rejected.

### Option E: status quo plus fixes

Phase 0 of §7 alone: fix discovery, the `origin` bug, the docs and the stale threat-model rows.
Cheap and worth doing under any option, but it answers none of J1–J9.

### Comparison

| Criterion                                          | A broker       | B own OP                   | **C hybrid**          | F OSS IdP                     | D buy          | E fixes only |
| -------------------------------------------------- | -------------- | -------------------------- | --------------------- | ----------------------------- | -------------- | ------------ |
| J1 sign in, entitlements follow (with a principal) | partial        | yes                        | **yes**               | yes (with Worker users)       | yes            | no           |
| J2 developers with no IdP                          | Pocket ID only | yes                        | **yes**               | yes                           | yes            | no           |
| J3 bring your own auth                             | yes            | redirect only, no exchange | **yes**               | redirect only, unless A added | partial        | no           |
| J4 Steam, Game Center, Play Games, EOS             | yes            | via federation             | **yes**               | no (needs A's verifiers)      | no             | no           |
| J8 tokens for the developer's backend              | no             | yes                        | **yes (phase 3)**     | yes, via a claims hook        | yes            | no           |
| J9 native redirect                                 | yes            | yes                        | **yes**               | yes                           | yes            | no           |
| Closes G5 (operators separated)                    | no             | yes                        | **yes**               | yes                           | yes            | no           |
| Credential liability (recovery, email abuse)       | none           | high                       | medium, phased        | medium (shared with the IdP)  | vendor         | none         |
| Account stores                                     | 1              | 1                          | 1                     | 2 (IdP + Worker)              | 2              | 1            |
| `PROTOCOL_VERSION` bump                            | no             | no                         | **no** (until J10)    | no                            | no             | no           |
| Running cost at 1M sign-ins a month                | < $15          | < $15                      | < $15                 | < $15 + $20–100 hosting [U]   | vendor per MAU | —            |
| Effort, agent-days [I]                             | ~41            | ~45                        | **~46 MVI; ~72 + 14** | ~41 + 10–15, plus ops         | M + vendor     | ~5           |

## 5. The recommended service, defined

### 5.1 Concepts and data model

**Glossary (AGENTS rule 4).** The concepts page already uses "license" for "an account that holds
entitlements", "profile" for a managed-payload baseline, and "account" for the portal
(`packages/docs/src/content/docs/start/concepts.md:173-218`) [V]. Proposed new nouns [I]:

- **user**: a person known to one product. Product-scoped, and the principal Identity owns.
- **identity link** (or **login**): one verified `(issuer, subject)` attached to a user. Examples:
  `email:<hash>`, `oidc:<iss>`, `steam`, `gamecenter:<teamId>`, `pgs:<appId>`, `eos:<deploymentId>`,
  `assertion:<keyId>`.
- **login method**: a product's enabled way to create links (a provider instance in the manifest).
- **portal account**: unchanged; the platform-global customer record that links to users and
  licences across products.
- **client**: an application registered to a product's issuer (phase 3 only).

Proposed D1 tables [I] (names are placeholders for the plan WP):

| Table                    | Key                                     | Holds                                                                                                         |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `identity_users`         | `(product, id)`                         | status (`active`, `disabled`), display name, primary verified email, created and last-sign-in times           |
| `identity_links`         | UNIQUE `(product, issuer_key, subject)` | `user_id`, verified email (if the issuer is email-authoritative), first and last use, `amr`                   |
| `licenses.user_id`       | nullable FK                             | Replaces `licenses.sub` as the person pointer. Migration: each `sub` becomes a user plus an `oidc:<iss>` link |
| `dist_purchase_bindings` | unchanged                               | Still licence-keyed; reached through the licence's user (§5.6)                                                |
| `identity_sessions`      | `(product, id hash)` under the pepper   | Browser and OP sessions, revocable, listable ("sign out everywhere"); every lookup is by product and hash     |
| `identity_passkeys`      | credential id                           | COSE public key, sign count, transports, `rp_id`, per-product random user handle (phase 2)                    |
| `identity_clients`       | `(product, client_id)`                  | Type (web, SPA, native, device), exact redirect URIs, hashed secret (phase 3)                                 |
| `identity_grants`        | grant id                                | Consented scopes and refresh-token family (phase 3)                                                           |
| Single-use store         | Durable Object, sharded by hash         | Email codes, magic links, auth codes, device codes, WebAuthn challenges: atomic consume                       |

Rules [I], following the landscape:

- **A user is product-scoped.** That is the tenant-isolation boundary and matches rule 5. The
  portal account stays the only cross-product record.
- **One link belongs to exactly one user.** A link already attached elsewhere is refused
  (`link_conflict`) unless the product opts into Transfer, RevenueCat-style.
- **Never orphan.** Unlinking the last link is refused, as in Nakama.
- **Explicit linking** needs proof of both identities in one session.
- **Automatic linking by email** happens only when both sides are `email_verified` from issuers
  marked email-authoritative (the Polaris email method, Google for gmail.com). Never for Entra
  `email`, and off by default for custom IdPs, mirroring today's portal rule.
- **Anonymous first, sign in later**: today's enrolled licence plus claim and migrate is that
  bootstrap. It is generalised to "attach this device's licence to the signed-in user", and keeps
  the P1-07 show-then-confirm step.
- **Licence claim is first-attach only, never a silent transfer.** A licence whose `user_id` is
  null can be attached, by its key or by the device's enrolled licence, after a confirm screen.
  A licence that already has a `user_id` is refused (`license_owned`), whoever presents the key;
  it never moves away from its owner by key. It moves only when (a) its current owner detaches it
  from their own session, or (b) an operator reassigns it in the console under step-up and audit
  (§5.4 item 9), which is reversible because the previous owner is recorded. **A licence that
  carries an email** (operator-issued or bought) attaches only to a user with that verified
  email, not by key, unless the product sets `claimByKey: true`. That closes the "leaked key,
  attacker claims first" race for every licence sold to a known buyer. Each attach notifies the
  licence's email, if any.
- **Licence-key sign-in** yields a low-assurance principal (`amr: ["pkey_license"]`). It never
  creates an SSO session, never auto-links, and for an owned licence reaches only that licence,
  never the owner's other licences, links or profile.
- **Shared credentials are bounded, not prevented.** One email or Steam account used by many
  people is one user. What limits it is unchanged: the licence's device seats and dormant-seat
  reclaim. Per-user concurrent-session caps are optional; named-user seats (J10) are the real
  control and come later.
- **Recovery is through any remaining link, and beyond that it is the developer's job.** The
  service enforces two things and provides one tool:
  1. Passkeys can be registered only after an email is verified, so a lost passkey always falls
     back to email.
  2. A user whose only link is a platform identity (Steam, Game Center, Play Games) recovers by
     signing in on that platform again: the platform account is the recovery. The SDKs prompt
     such users to add an email after first sign-in (a product setting, on by default).
  3. A user with no working link (dead email and nothing else) has no self-service path. The
     developer's support decides, on their own evidence (licence key, receipt, purchase email),
     and uses the console's audited, step-up relink tool. Polaris supplies the tool and the audit
     trail, not the judgement. The docs say so plainly.
- **Identity no longer requires a licence.** An Identity-only product gets users and device tokens
  under `requires-identity` without minting licences. That fixes G7 and matches the registration
  policy docs.

### 5.2 Developer-facing surface

**Manifest (`.pkey/product`).** Provider kinds are code; instances are data [I]:

```yaml
identity:
  methods:
    - { id: email, kind: email } # code + magic link, Polaris-sent
    - {
        id: google,
        kind: oidc,
        issuer: https://accounts.google.com,
        clientId: "…",
        emailTrust: true,
      }
    - {
        id: clerk,
        kind: oidc,
        issuer: https://clerk.example.com,
        audience: ["…"],
        azp: ["…"],
      }
    - { id: steam, kind: steam, appId: 480, ticketIdentity: "pkey:diceroll" } # publisher key sealed
    - {
        id: gc,
        kind: gamecenter,
        teamId: ABCDE12345,
        bundleIds: ["com.example.game"],
      }
  linking: { emailAutoLink: false, conflict: block }
```

Every new field gets a validator rule and a mutation-table entry (rule 9). The issuer allowlist
applies to every discovered URL and becomes mandatory once a product declares any `oidc` method.

**Not every social provider is generic OIDC.** Google, Auth0, Clerk, Cognito, Keycloak and Entra
work through discovery under `kind: oidc`. Two common ones need their own kinds and code (I-20):

- **`kind: apple` (Sign in with Apple)** [V: research angle "proxy", from Apple's docs; U: not
  re-read here]:
  - The `client_secret` is an ES256-signed JWT the Worker mints from the product's sealed `.p8`
    key (team id, key id, Services ID as `sub`, at most 6 months' lifetime), so mint it per
    request or cache it briefly; the `.p8` is a sealed product secret.
  - Requesting `name` or `email` forces `response_mode=form_post`: the callback is a cross-site
    `POST` from `appleid.apple.com`, which does not carry `SameSite=Lax` cookies. Flow state must
    be found by the `state` parameter server-side (today's flow records already are), never by a
    Lax cookie, or that one cookie must be `SameSite=None; Secure`.
  - The user's name arrives only on the first authorisation, so it is stored then or lost.
  - Hidden "private relay" emails only receive mail from sender domains registered with Apple,
    which ties into I-21.
  - Apple's server-to-server notifications (consent revoked, account deleted) need an endpoint
    that unlinks or flags the user.
- **`kind: discord`**: OAuth2 with incomplete OIDC discovery, so it is a configured-endpoints
  kind: fixed authorize and token URLs, the profile from `/users/@me`, and the email trusted only
  when Discord's `verified` flag is true [U: confirm the current `openid` support in I-20].

**App Review 4.8 is a constraint, not an open question.** An iOS app that offers a third-party or
social login (Google, Discord, a Clerk-backed social button) to set up the user's primary account
must also offer an equivalent privacy-preserving option; Sign in with Apple satisfies it [V:
guidelines page, revised January 2024]. So the validator warns, and the console's Sign-in methods
page flags, any product with an iOS release target that enables a social method without
`kind: apple`. Whether Polaris email sign-in counts as the developer's own account (exempt) is
still unsettled (§9), so the safe default is to enable Apple alongside any social method on iOS.

**Console (Identity section).** Pages [I]:

- **Users**: list, search, profile, links, licences, devices, sessions, audit; disable, sign out
  everywhere, delete.
- **Sign-in methods**: replaces today's read-only Sign-in page, with a per-kind setup checklist
  (redirect URIs to register, secrets to seal) and a "test sign-in" dry run that mints nothing.
- **Branding**: the hosted login page and email, reusing `portal_product_settings.branding_json`.
- **Clients** (phase 3): register web, SPA, native and device clients; secrets shown once.

**Portal.** It keeps its global account. It gains "connected products" (its links to product
users), server-side sessions with sign-out, a GDPR export, and in phase 3 "connected apps" with
revoke [I].

**SDK API, all six languages** [I]. Names are illustrative; each language follows its idiom:

| Call                                                   | Node           | React          | Python         | Swift                            | Kotlin            | Godot                                                               | Notes                                                                                                        |
| ------------------------------------------------------ | -------------- | -------------- | -------------- | -------------------------------- | ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `identity.startDeviceCode()` / `poll()` (exists)       | yes            | yes            | yes            | yes                              | yes               | yes                                                                 | Add P1-07 confirm-and-attach everywhere, not only Godot                                                      |
| `identity.signInWithEmail(email)` + `verifyCode(code)` | yes            | yes            | yes            | yes                              | yes               | yes                                                                 | One-time code; magic link only on web. Gated: needs a device token, else opens the hosted page (§5.4 item 4) |
| `identity.exchange({kind, token, provider})`           | yes            | yes            | yes            | yes                              | yes               | yes                                                                 | Bring your own auth                                                                                          |
| `identity.signInWithSteam()`                           | —              | —              | —              | —                                | —                 | yes                                                                 | GodotSteam `getAuthTicketForWebApi("pkey:<product>")`; others pass the ticket to `exchange`                  |
| `identity.signInWithGameCenter()`                      | —              | —              | —              | yes                              | —                 | yes (iOS shim)                                                      |                                                                                                              |
| `identity.signInWithPlayGames()`                       | —              | —              | —              | —                                | yes               | yes (Android shim)                                                  |                                                                                                              |
| `identity.signIn({redirect})` (native PKCE)            | yes (loopback) | yes (redirect) | yes (loopback) | yes (ASWebAuthenticationSession) | yes (Custom Tabs) | desktop: OS browser + loopback [U]; mobile and console: device code | Closes G3; all six follow I-13                                                                               |
| `identity.link(...)` / `unlink(id)`                    | yes            | yes            | yes            | yes                              | yes               | yes                                                                 | Needs the current session                                                                                    |
| `identity.user()` / `signOut()` / `deleteUser()`       | yes            | yes            | yes            | yes                              | yes               | yes                                                                 | `deleteUser` meets App Store 5.1.1(v) in-app deletion [U]                                                    |

**"Sign in with <Product>" (phase 3).** A per-product issuer at `https://key.plrs.im/<p>/identity`,
with discovery, JWKS, authorize, token, userinfo, revocation and end-session. Scopes are `openid`,
`email`, `profile`, `offline_access`, `pkey:licenses` and `pkey:entitlements`. Subjects are
pairwise per product; that matters once a portal account links one person to several products.
Claims are namespaced (`https://key.plrs.im/claims/entitlements`) and carry entitlements, not
licence state, with access tokens living 5–15 minutes; this respects D-20's "state is never
carried" rule. A custom domain (`auth.<product>.com`, through Cloudflare for SaaS) would be a
separate issuer and is deferred.

### 5.3 Wire impact

| Change                                                                                         | Device wire?                                                                                               | `PROTOCOL_VERSION` / corpus                                                                                                                                            | Who follows                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 hygiene; removing dead `authPoll` from the discovery fragment                          | Discovery response only                                                                                    | Neither; `gen:transcripts` re-records `discovery-capabilities.json`                                                                                                    | No SDK reads `authPoll` [U: grep each SDK in the WP]                                                                                                                                                               |
| Users and links tables, console pages, manifest `identity.methods`                             | No                                                                                                         | Neither                                                                                                                                                                | Worker, admin, `shared-manifest` (rule 9)                                                                                                                                                                          |
| **Phase 1 (I-08 ⚑):** email-code routes `POST /<p>/identity/email/start` and `/verify`         | **Yes**: SDKs call them (`signInWithEmail`, `verifyCode`); new request and response shapes and error codes | No bump: additive, feature-detected from discovery, `verify` returns the activation response; **transcripts and parity, not signed corpus**                            | **Plan mode.** Contract (WIRE-CONTRACT-V4 identity section; first identity types in `shared-protocol`, written by I-04) → `errors.json` (rule 3) → transcripts → I-11 in Node, React, Python, Swift, Kotlin, Godot |
| **Phase 2 (I-10 ⚑, I-13 ⚑):** `POST /<p>/identity/token` exchange; native redirect token route | **Yes**: new device-facing routes, request and response shapes, error codes                                | Same: no bump, transcripts and parity                                                                                                                                  | **Plan mode**, same chain; all six SDKs                                                                                                                                                                            |
| Identity discovery fragment gains `methods[]` and `exchange` metadata                          | Yes (discovery)                                                                                            | No bump; transcripts                                                                                                                                                   | Same six SDKs, feature detection                                                                                                                                                                                   |
| Phase 3 OIDC issuer tokens                                                                     | No: web and backend relying parties only; no device SDK consumes them                                      | No bump; a new signed artefact outside the corpus, with OIDF conformance as its gate                                                                                   | Plan mode anyway (new signed artefact and keyring). SDKs add nothing; docs give stock-library recipes                                                                                                              |
| J10: a user claim in the licence document's `profile` (named-user seats)                       | **Yes**: signed shape                                                                                      | Additive optional member; P4-19 shows such additions can keep `PROTOCOL_VERSION` 4 [V] (`docs/security/WIRE-CONTRACT-V4.md:875`); corpus regeneration and all six SDKs | Deferred; its own plan                                                                                                                                                                                             |

Today's `DocProfile` has no subject (`packages/shared-protocol/src/license.ts:7-13`) [V]. Phases 0
to 3 leave it alone.

So **phase 1 is not wire-free.** Its tables, console pages, manifest block and the hosted email
page are HTTP-and-manifest work; its in-app email sign-in is device wire. The ordering is
therefore I-04 (contract) → I-08 (routes, `errors.json`, transcripts) → I-11 (SDKs). A product
that wants email sign-in before I-11 ships can use the hosted page through device code or the
browser, which needs no SDK change.

### 5.4 Threat-model deltas

New or changed sections for `docs/security/THREAT-MODEL.md` [I] unless marked.

1. **Operator and customer split (G5).** Once end users leave Pocket ID, a customer can no longer
   be placed in `admins` by mistake, and the console no longer shares a client with customers.
   Until then, give the console its own Pocket ID client (I-03).
2. **Broker confusion.** Per-provider audience enforcement (`aud`, `azp`, `token_use`, bundle id,
   Steam `identity`), fail closed when unset; RFC 9207 mix-up defence; SSRF checks on every
   discovered URL; the issuer allowlist made mandatory once `oidc` methods exist.
3. **Account takeover through linking.** Email trust per issuer; Entra `email` never links; no
   linking of email-less platform identities except explicitly; Block on conflict.
4. **Email sign-in abuse, send side and verify side.**
   - _Send side._ Per-recipient (hashed) limits of 5 an hour and 20 a day, per-IP and per-network
     limits, a per-product daily cap so one tenant cannot drain the shared sender quota, identical
     responses for known and unknown emails, and a landing-page `POST` so link prefetchers cannot
     burn magic links. On the hosted page, Turnstile.
   - _Verify side._ Codes are 6 digits, live 10 minutes, and die after 5 wrong attempts. A new code
     for the same recipient and flow invalidates the old one. After 10 wrong attempts across
     codes in an hour the recipient is locked out of new codes for 15 minutes, with the same
     response as success. With these numbers an attacker gets at most 5 guesses in a million per
     code and about 10 codes a day, about 5 in 100,000 a day per victim.
   - _Binding._ `start` returns an opaque `flow_id` bound to product, login method, and the
     requester (the device token's device, or a hash of the browser's flow cookie). `verify` needs
     `flow_id` plus code, and checks the same product, method and requester. A code issued for
     product B's flow, or for another device's flow, cannot be redeemed at A.
   - _Relay phishing (residual)._ An attacker who starts a flow with the victim's email and talks
     the victim into reading out the code still wins, because the attacker holds the flow. The
     email names the product and the requesting device and says "never share this code". New
     sign-ins by email do not link new identities to an existing user without that user's session.
     Passkeys (phase 2) are the phishing-resistant answer.
   - _Magic link opened on another device._ The link completes the flow that requested it, not the
     browser that opens it. The opening browser shows "Confirm sign-in to <Product> on <device>,
     requested at <time>" and a Confirm button (`POST`). It gets a session of its own only when it
     carries the requesting flow's cookie (same browser). Otherwise the requesting device's poll
     receives the result.
   - _No Turnstile in native or Godot SDKs._ Turnstile is a browser widget, so the in-SDK
     `signInWithEmail` path loses the main bot control exactly where §5.2 adds it. Replacements:
     `email/start` from an SDK requires a **registered device token** (so it costs a registration
     and is limited per device, 3 starts an hour, on top of per-recipient and per-network
     limits), and uses platform attestation (App Attest, Play Integrity) where the SDK has it [U:
     no attestation work package is assumed here]. A product can turn in-SDK email start off;
     then, and in any SDK without a device token, the SDK opens the hosted page in the system
     browser (Turnstile runs there) and completes through device code or loopback.
5. **Licence claim and transfer (new).** Threats: a leaked or shared key is claimed by an
   attacker's user; a claimed licence is pulled away from its owner; an operator is talked into
   moving it. Controls (§5.1): first attach only; an owned licence is never moved by key
   (`license_owned`); licences with an email attach only by verified email unless `claimByKey`;
   attach notifies the licence's email; operator reassign is step-up, audited and reversible.
   Residual: a key licence with no email, leaked before its buyer claims it, goes to whoever
   claims first; the buyer's remedy is support and an operator reassign. Credential sharing (one
   email or Steam account across many people) stays bounded by device seats, not prevented.
6. **Device-code phishing (RFC 8628 §5.4).** Today's residual is open: R1-07, rooted in R8-03.
   The flow's starter can forward the IdP sign-in to a victim and receive a device token on the
   victim's licence, and the victim never sees the confirmation page [V]
   (`docs/security/THREAT-MODEL.md:2148-2154`). This spike makes device code the front door for
   email and upstream sign-in on TVs and Godot, so the residual grows. Required with I-08:
   - bind the IdP or email callback to the browser that confirmed the user code (the fix the
     threat model already names);
   - the confirm screen names the product, the login method and the requesting device (its
     reported name and platform, labelled "reported by the device"), and requires an explicit
     Confirm `POST` after sign-in, never auto-completing;
   - the code lives at most 10 minutes (today `FLOW_TTL_SECONDS = 600`, `W/services/identity/oidc.ts:80`
     [V]);
   - a warning when the approving browser's network or country differs from the requester's, and
     the text "only continue if this code is on your own screen".

   P1-07's confirm-and-attach covers only licence attach; it does not close R1-07.

7. **Tenant isolation on the shared origin (rule 5).** Every product's hosted login, session
   cookie and passkeys live on `key.plrs.im`.
   - _Sessions._ Cookie `Path` is not a security boundary on one origin. Today the browser session
     cookie is `pkey_<slug>_session`, `Path=/<slug>`, and its KV record is keyed
     `p:<slug>:browser-session:<hash>` (`W/services/identity/browserSession.ts:76-99`) [V], so the
     product check is server-side already. `identity_sessions` keeps that: every lookup is
     `(product, hash)`, the cookie name carries the slug, and a test asserts that product A's
     cookie and OP session are rejected at product B. OP sessions are per product; there is no
     cross-product SSO.
   - _Branding._ `branding_json` (`M/0008_portal.sql:57`) is data, never markup: a display name,
     colours, a logo asset, rendered into Polaris templates under the existing strict CSP
     (`renderBrandPage`, `W/core/brandHtml.ts`). A fixed, non-customisable line on every hosted
     page reads "Sign-in for <Product>, operated by Polaris Key", with the product slug. The
     validator reserves names (Polaris, Polaris Key, plrs, portal, console, admin) and the
     portal and console use templates a tenant cannot select. Residual: a tenant can upload a
     logo that imitates another brand; operator removal is the remedy.
   - _Passkeys._ `rp_id = key.plrs.im` puts every product's passkeys in one browser picker and
     ties them to that host. Each product gets its own random WebAuthn `user.id` handle per user
     (never a global or cross-product id), and `user.name` shows "<email> · <Product>" so the
     picker is legible. Deferred custom auth domains (`auth.<product>.com`) cannot use these
     passkeys without WebAuthn Related Origin Requests (`/.well-known/webauthn` on
     `key.plrs.im`, with a small per-RP origin-label limit and uneven browser support [U]); in
     practice a custom domain means re-enrolment. Decide the domain story before passkeys ship
     (§10, D8).
8. **Single-use atomicity (G15).** Codes, links and device codes move to an atomic Durable Object
   consume. The same fix applies to today's portal magic links.
9. **Support-driven takeover (new).** The console's relink, reassign, disable and delete powers
   are the easiest takeover path: social-engineer the developer's support. Controls in I-07:
   - step-up before any of them: a fresh operator re-authentication (OIDC `max_age`, passkey) no
     older than 5 minutes;
   - a mandatory reason, and an `audit` row with before and after (old and new user, link and
     licence ids);
   - a notification to every verified email on the affected user(s), sent before the change takes
     effect for relinks, with a 72-hour undo for reassign and relink;
   - operator deletes are soft for 14 days (restorable), then hard;
   - an alert when one operator performs more than a set number in a day.
10. **Issuer keys (phase 3).** A separate RS256 keyring sealed under the `PLATFORM_KEK` keyring
    with its own AAD kind, rotated about every 90 days (`next`, `active`, `retired`), never mixed
    with the Ed25519 document keys pinned by device trust. Refresh-token rotation with family
    revocation on reuse. Exact redirect-URI matching, no non-http(s) schemes except per-client
    registered native schemes.
11. **Stale rows to fix now.** A6 (drop `customers`), §5 `sub` and `email` rows (the product flow
    now requires both), T5 extended to "a product's upstream IdP is malicious".

### 5.5 Privacy

- **Roles** [I]: Polaris is the controller for portal accounts (global and Polaris-branded) and
  the processor for product users, licences and links, which are the developer's records. Hosting
  product users needs a DPA and a sub-processor list (Cloudflare) [U: legal review].
- **Export (Art. 15 and 20).** Missing today. Add a portal `GET /api/me/export` (I-15) and a
  console per-user export, JSON, for the developer to answer requests (I-07).
- **Deletion (Art. 17).** Deleting a user:
  - cascades to links, sessions, passkeys, grants and pairwise mappings;
  - **detaches licences and scrubs their personal columns.** `licenses` still carries `sub`,
    `name`, `email` and `groups_json` (`M/0001_init.sql:64-81`) [V], so "detach, not delete"
    alone would leave personal data behind. Deletion sets those columns to null and keeps the
    licence's commercial fields (tier, entitlements, dates), which are the developer's records;
  - scrubs audit: `audit.summary` and `target_id` rows naming the user, and `portal_audit` rows,
    are rewritten to a tombstone id (`M/0001_init.sql:181-193`, `M/0008_portal.sql:62`) [V];
  - revokes F-20 licence-bound tokens whose link disappears;
  - in phase 3, sends back-channel logout to relying parties.
- **Backups.** D1 Time Travel keeps any database state restorable for its retention window
  (Cloudflare documents 30 days on Workers Paid [U: not re-read here]), so a deleted user is
  recoverable for that long. The privacy notice says so, and a tombstone list (deleted user ids
  and hashed emails) is re-applied after any restore so deletions survive it.
- **Retention.** No user row is created until an email or other credential is verified, so
  abandoned sign-ups leave only a short-lived Durable Object record. Inactive users (no sign-in
  and no licence for a product-set period; default 24 months) are flagged in the console, and the
  developer, as controller, chooses whether to purge them automatically.
- **Hashing is not anonymisation.** An `email:<hash>` link (peppered hash) is pseudonymous
  personal data under GDPR, not anonymous: whoever holds the pepper and a candidate email can
  re-identify it. It is in scope for export and deletion like a plain email.
- **Minimisation.** Upstream ID tokens are consumed once and never stored; no upstream access or
  refresh tokens are kept; emails are stored only when verified.
- **Correlation.** Users are product-scoped and issued subjects are pairwise, so two products
  cannot correlate one person through Polaris. The portal account is the only place the join is
  visible, and only to that person.

### 5.6 How it composes

- **License.** A licence gains a `user_id`. Sign-in finds the user's licence or, under the
  product's auto-issue policy, mints one, as `activateFromIdentity` does today but keyed by user,
  not `sub`. Operator-issued licences carrying an email attach to the user whose verified email
  matches, when the product allows it, which closes G9. Seat limits stay device-based until J10.
- **Commerce claims.** Store bindings stay licence-keyed (`dist_purchase_bindings`), so a user
  reaches them through their licences. Signing in with Steam can optionally run the existing
  `CheckAppOwnership` and apply store grants at first sign-in, through a Core descriptor hook
  (rule 6), so Identity never imports Distribution.
- **Registry tokens (F-20, F-21).** Unchanged contract. Licence-bound `pkeyr_` tokens stay bound to
  a licence and minted from the portal. The revocation trigger "a portal link removed" gains an
  equivalent: "a licence detached from its user, or a user deleted". The F-21 implementer should
  route both through one Core hook.
- **Portal.** Stays global and Polaris-branded. It links to product users by verified email or
  explicit claim, as it links to licences today. Decide G10 explicitly (§10, D7).
- **Console operator sign-in.** Out of the service: Pocket ID, `PLATFORM_ADMIN_GROUP`, one admin
  level. Recommend a dedicated Pocket ID client for the console now.

## 6. What changes for the existing pieces

| Piece                              | Fate                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `oidc.ts` redirect flow            | Kept, generalised to discovery and many providers; calls `signIn`                                                                    |
| Device code (`/auth/device/*`)     | Kept; provider choice moves to the phone page                                                                                        |
| `/auth/poll`                       | Retired from discovery in phase 0; replaced by the native redirect token route in phase 2                                            |
| Browser session and fused document | Replaced by a signed, revocable session; the fused shape is deleted as already planned (`doc.ts:7-12`)                               |
| `POST /identity/session/license`   | Kept as the licence-key login method                                                                                                 |
| Portal                             | Kept global; server-side sessions, export, links to users                                                                            |
| `provider: platform` for end users | Becomes the Polaris-run login (email, passkey) in phase 1; Pocket ID kept for operators; Pocket ID passkeys do not carry over (I-09) |
| `groupRoleMap`, provisioning hooks | Kept; evaluated over any verifier's normalised claims, not only ID-token claims                                                      |

## 7. Phases

| Phase                         | Outcome a developer sees                                                                                                                                                                                        | Wire                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **0. Hygiene and groundwork** | Correct `origin`, true docs, fixed threat model, atomic single-use store, sharded rate limits; console gets its own Pocket ID client; the plan WP lands                                                         | discovery transcript only                                                                                  |
| **1. Users and email**        | A Users page; operator and OIDC licences merge; Google and the product's own IdP (generic OIDC), Apple and Discord (own kinds) work as methods; email sign-in hosted and in-app; Identity works without License | **plan mode for I-08 and I-11**: additive email-code routes, `errors.json`, transcripts, six SDKs; no bump |
| **2. Native and games**       | `exchange()` for bring-your-own-auth; Steam, Game Center, Play Games and EOS sign-in; native redirect sign-in; passkeys; link and unlink in all six SDKs                                                        | plan mode, additive, transcripts                                                                           |
| **3. Issuer**                 | "Sign in with <Product>": OIDC tokens with entitlement claims for the developer's web services; connected apps in the portal                                                                                    | plan mode, new signed artefact, no device change                                                           |
| **4. Later**                  | Named-user seats; product-backend assertion for consoles; custom auth domains; B2B organisations                                                                                                                | J10 touches the signed licence document                                                                    |

### 7.1 Effort and the minimum viable cut

Agent-day estimates per WP are in §8 [I]. Calendar time assumes three parallel lanes and about
1.4× the critical path for review, gates and owner approvals [I].

| Slice                                | WPs                                                                      | Agent-days | Calendar        |
| ------------------------------------ | ------------------------------------------------------------------------ | ---------- | --------------- |
| Phase 0                              | I-01, I-02, I-03, I-04                                                   | 8          | ~2 weeks        |
| Phase 1                              | I-05, I-06, I-07, I-08, I-09, I-11, I-20, I-21, docs                     | 35         | ~4–5 weeks      |
| Phase 2                              | I-10, I-12, I-13, I-14, I-15, I-22, docs                                 | 29         | ~3–4 weeks      |
| **Phases 0–2**                       |                                                                          | **72**     | **~9–11 weeks** |
| Phase 3 (issuer, its audit and docs) | I-16                                                                     | 14         | ~3 weeks        |
| **Minimum viable Identity**          | I-01–I-08, I-10, I-11, I-21, I-22 (`oidc` and `firebase` verifiers only) | **46**     | **~7 weeks**    |
| For comparison: Option A             | §4                                                                       | ~41        | ~7 weeks        |

**The cut line [I].** Minimum viable Identity is: product-scoped users and links, the console
Users page with export and audited support tools, email sign-in (hosted and in-app) with its
delivery operations, the fixed broker for any discovery-capable IdP, and token exchange for
bring-your-own-auth, in all six SDKs. It leaves out Apple and Discord kinds (I-20), the Pocket ID
end-user migration (I-09; I-03 already separates operators), game verifiers (I-12), native
redirect (I-13), passkeys (I-14), portal convergence (I-15) and the issuer (I-16). For roughly
Option A's cost it answers J1, J2, J3, J5 and J6; Option A answers J1 (partly), J3, J4, J5 and J9.
Adding I-12 (games) to the cut brings it to about 54 agent-days. **Note the App Review 4.8
constraint (§5.2):** an iOS product that uses Google through the MVI must wait for I-20.

## 8. Work packages

Sizes: S ≤ 1 day, M 2–4 days, L 5+ days, in the program's agent-days; the **Days** column is the
estimate used in §7.1 [I]. ⚑ = plan mode (wire-touching, or a new signed artefact). Gates are in
addition to the green gate. MVI = in the minimum viable cut.

| ID     | Work package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Deps                   | Size | Days | Gates and flags                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| I-01   | MVI. Hygiene: `origin: "oidc"` on fresh OIDC licences plus a test; portal identities keyed by issuer (migration); THREAT-MODEL A6 and §5 rows; docs vs code on portal gating (per D7); drop `authPoll` from discovery                                                                                                                                                                                                                                                                                          | —                      | S    | 1    | `gen:transcripts -- --check`; `check:links`                                                                                             |
| I-02   | MVI. Atomic single-use store (Durable Object) for magic links, codes, OIDC flows and device codes, with per-code attempt counters; shard `_portal` and `_admin` rate-limit buckets (R10-04a); per-recipient, per-device and per-product email limits                                                                                                                                                                                                                                                           | —                      | M    | 3    | `test:workerd`; rate-limit and portal suites                                                                                            |
| I-03   | MVI. Console gets its own Pocket ID client: today `ADMIN_OIDC_*` is only a fallback behind `PLATFORM_OIDC_*` (`W/platformOidc.ts:9-30`), so console auth must prefer its own variables; runbook update                                                                                                                                                                                                                                                                                                         | —                      | S    | 1    | Owner action in Pocket ID [U]                                                                                                           |
| I-04 ⚑ | MVI. **Plan**: replace D-14 with an Identity decision record; glossary nouns (rule 4); data model and migration; identity section of WIRE-CONTRACT-V4 including the email-code routes; error codes; parity feature ids; manifest schema; threat-model deltas of §5.4                                                                                                                                                                                                                                           | S-16 approved          | M    | 3    | Owner approval; planning only                                                                                                           |
| I-05   | MVI. Broker fix: OIDC discovery (all discovered URLs through the SSRF and allowlist gates), configurable scopes and groups claim, RFC 9207 `iss`, multiple `oidc` methods per product, mandatory allowlist once any exist                                                                                                                                                                                                                                                                                      | I-04                   | M    | 3    | Manifest validator rules + mutation table (rule 9)                                                                                      |
| I-06   | MVI. Users and identity links: tables, `licenses.user_id`, migration of `licenses.sub` (platform subjects become `oidc:https://id.plrs.im` links so they keep working), `signIn(verifiedIdentity)`, linking and conflict policy, licence claim rules (first attach, `license_owned`, email-bound claim, `claimByKey`), Identity without License, email-match attach for operator licences                                                                                                                      | I-04                   | L    | 6    | Migration test on a production-shaped copy; `boundaries` test (rule 6)                                                                  |
| I-07   | MVI. Console Users and Sign-in methods pages; per-user audit; **per-user JSON export**; disable, sign out everywhere, delete (soft for 14 days, personal columns scrubbed on hard delete); **support relink and reassign under step-up**, mandatory reason, before-and-after audit, user notification and 72-hour undo; test sign-in dry run; App Review 4.8 warning                                                                                                                                           | I-06                   | M    | 5    | Admin build; console CSP parity; step-up and audit tests                                                                                |
| I-08 ⚑ | MVI. Email login method: `email/start` and `email/verify` routes (flow-bound codes, attempt caps, lifetime), magic link with confirm-on-other-device, product-branded hosted page with Turnstile, in-SDK start gated on a device token, enumeration-safe responses; signed, revocable, product-scoped browser session replacing the fused document; device-code confirm screen and callback binding (R1-07)                                                                                                    | I-02, I-04, I-06, I-21 | L    | 5    | Contract first (I-04) → `errors.json` (rule 3) → transcripts (rule 1) → OpenAPI + `routeCoverage` (rule 10); cross-product session test |
| I-09   | End users of `provider: platform` move to the Polaris login; Pocket ID becomes operator-only. Pocket ID passkeys are bound to `rp_id = id.plrs.im` and **cannot carry over**: each migrated subject needs a verified email. Users with an email verify it on next sign-in; subjects with none keep a temporary `oidc:https://id.plrs.im` method until a published sunset date, then operator-assisted relink                                                                                                   | I-03, I-08             | M    | 3    | Rollout runbook; owner sign-off; count of email-less subjects before sunset                                                             |
| I-10 ⚑ | MVI. Exchange endpoint `POST /<p>/identity/token` with `oidc` (JWKS) and `firebase` (x509) verifiers; returns the activation response; discovery `methods[]`                                                                                                                                                                                                                                                                                                                                                   | I-04, I-06             | L    | 6    | `errors.json` first (rule 3); transcripts (rule 1); OpenAPI (rule 10); THREAT-MODEL delta                                               |
| I-11 ⚑ | MVI. SDK identity v2, part 1, in **Node, React, Python, Swift, Kotlin and Godot**: `signInWithEmail` and `verifyCode` (with the hosted-page fallback), `user`, `signOut`, `deleteUser`, P1-07 attach everywhere                                                                                                                                                                                                                                                                                                | I-08                   | L    | 6    | `parity:check`; `gen:constants -- --check`; each SDK's transcript replayer                                                              |
| I-12   | Game verifiers: Steam ticket (reuse commerce) with optional ownership grants through a Core hook; Game Center (reuse `core/x509.ts`); Play Games; EOS; Godot iOS and Android shims; Swift and Kotlin helpers                                                                                                                                                                                                                                                                                                   | I-10, I-22             | L    | 8    | Per-verifier security review; transcripts per kind                                                                                      |
| I-13 ⚑ | Native redirect sign-in: PKCE public-client token route for loopback, claimed-HTTPS and registered-scheme redirects; retire `/auth/poll`; `signIn({redirect})` in **all six SDKs**: Node and Python (loopback), Swift (ASWebAuthenticationSession), Kotlin (Custom Tabs), React (web redirect with the token route's CORS), Godot (desktop loopback; device code on mobile and console)                                                                                                                        | I-10                   | M    | 4    | Same as I-10                                                                                                                            |
| I-14   | Passkeys: `@simplewebauthn/server` under workerd, registration only after email verification, `rp_id = key.plrs.im`, per-product random user handle, legible `user.name`                                                                                                                                                                                                                                                                                                                                       | I-08                   | M    | 3    | `test:workerd`; D8 (domain story) decided first                                                                                         |
| I-15   | Portal convergence: links to product users, server-side sessions with logout, `GET /api/me/export`, keep F-21 revocation hooks (one Core hook for "link removed" and "user deleted")                                                                                                                                                                                                                                                                                                                           | I-06, F-21             | M    | 3    | Portal suite; F-21 regression                                                                                                           |
| I-16 ⚑ | **Plan** then build: per-product OIDC issuer (discovery, JWKS on a separate RS256 keyring, authorize, token, userinfo, refresh rotation, revocation, end-session), static clients in console and manifest, pairwise subjects, `pkey:*` scopes. The plan weighs in-house against Ory Hydra with the Worker as its login and consent app (D12)                                                                                                                                                                   | I-06, I-08             | L    | 10   | OIDF Basic OP and Config OP conformance plans against staging; THREAT-MODEL section; R-series audit (~3 days)                           |
| I-17   | Docs: Identity concepts, recovery ("the developer's job beyond links"), "bring your own auth" quickstarts (Clerk, Firebase, Auth0, Supabase), Steam and Game Center guides, "Sign in with <Product>" recipes                                                                                                                                                                                                                                                                                                   | each phase             | M    | 3    | `check:links`                                                                                                                           |
| I-18 ⚑ | Later: named-user seats (user claim in the licence `profile`, `devices.holder_user_id`, per-user caps)                                                                                                                                                                                                                                                                                                                                                                                                         | I-06                   | L    | —    | Corpus regeneration; all six SDKs                                                                                                       |
| I-19 ⚑ | Later: RFC 7523 product-backend assertion (consoles), with `jti` replay cache and key management in the console                                                                                                                                                                                                                                                                                                                                                                                                | I-10                   | M    | —    | As I-10                                                                                                                                 |
| I-20   | Provider kinds that are not generic OIDC: `apple` (Worker-minted ES256 client secret from the sealed `.p8`, `form_post` callback without Lax cookies, first-consent name capture, server-to-server notifications) and `discord` (configured endpoints, `/users/@me`, `verified` email)                                                                                                                                                                                                                         | I-05, I-06             | M    | 3    | Manifest validator rules (rule 9); provider fixtures                                                                                    |
| I-21   | MVI. Email delivery operations: SPF, DKIM and DMARC on a dedicated auth sending subdomain of `plrs.im` (reputation separate from portal mail); per-product sender display name ("<Product> via Polaris Key"); bounce and complaint handling where the Email Service exposes it [U], and a hashed suppression list; per-product daily send caps; on sender throttling or quota exhaustion, `email_unavailable` and the UI offers other methods, plus an operator alert; Apple private-relay sender registration | I-02                   | M    | 3    | Owner DNS action [U]; deliverability check on staging                                                                                   |
| I-22 ⚑ | MVI. SDK identity v2, part 2, in all six SDKs: `exchange`, `link` and `unlink`                                                                                                                                                                                                                                                                                                                                                                                                                                 | I-10, I-11             | M    | 4    | As I-11                                                                                                                                 |

Critical path: I-04 → I-06 → I-08 → I-11 → I-22 → I-12. I-01, I-02, I-03 and I-21 can start at
once (I-21 needs only I-02's limits).

## 9. Risks and open questions

**Risks** [I]:

1. **Scope creep into a game backend.** The charter in §2 (J16 never) is the guard.
2. **Becoming an IdP is permanent.** An issuer URL cannot change once relying parties integrate,
   and email reputation is shared. Mitigation: issuer last (phase 3), and path-based first.
3. **Migration of `licenses.sub`.** It touches every OIDC licence. It needs a reversible migration
   and a production-shaped rehearsal.
4. **Verifier breadth.** Each bespoke verifier (Steam, Game Center, Play Games) needs its own
   security review; Apple has rotated Game Center certificates before, so the leaf must not be
   pinned.
5. **Godot shims.** Game Center and Play Games need native plugin code outside pure GDScript; it
   fits the P5-06 Android binding and the iOS plugin work [U].
6. **F-21 timing.** If F-21 ships before I-15, its revocation hook must be written so I-15 can
   extend it rather than replace it.
7. **Shared email reputation.** Every product's sign-in email leaves one Polaris sender. One
   abused tenant, or a quota cut, stops email sign-in for all of them. I-21's per-product caps,
   suppression list and `email_unavailable` fallback limit the blast radius; per-product sender
   domains (later) remove it.
8. **Support takeover.** The console's relink and reassign tools are the softest target (§5.4
   item 9). Step-up, notification and undo reduce it; developer support training does the rest.
9. **Device-code phishing grows with use.** R1-07 is open today and this plan routes more
   sign-ins through device code. I-08 must ship the callback binding, or device-code email and
   upstream sign-in should wait.
10. **Pocket ID migration strands users.** Subjects with no email cannot move automatically
    (I-09). The sunset date must follow a count, not precede it.

**Open questions** (not decisions):

- Where Pocket ID is hosted, how it is backed up, and whether it can issue a second client for
  the console today [U].
- Whether a Polaris-hosted email account inside an iOS app counts as the developer's own account
  under App Review 4.8 (the constraint itself is settled in §5.2), and the exact 5.1.1(v)
  deletion requirement [U].
- Whether Cloudflare Email Service exposes bounce and complaint events to a Worker, and its
  current daily quota for `plrs.im` [U: needs the account].
- D1 Time Travel's retention on this account, which bounds how long a deleted user stays
  restorable [U].
- Whether Pocket ID can export users' verified-email status, which sets the size of I-09's
  email-less remainder [U].
- Store rules on unlocking content bought on another store, before cross-store linking is
  promised [U].
- Xbox XSTS, PSN and Nintendo token formats and the EOS Connect `iss` value [U: partner-gated].
- Whether Google rejects the `groups` scope in practice [U].
- Why React's `identity.oidc` row is marked implemented without an OIDC transcript
  (`conformance/transcripts/` has none) [V]: a parity gap for I-11 to close.

## 10. Owner decisions

Each has a recommended default; accepting all of them is a coherent plan.

1. **Option.** C (hybrid), phased as §7. _Default: C._
2. **Principal scope.** Product-scoped `user`, with the portal account as the only cross-product
   record. _Default: product-scoped._
3. **Operator and customer split.** End users leave Pocket ID for the Polaris login; operators stay
   on Pocket ID, with a dedicated console client now. _Default: split._
4. **Identity without License.** Identity stops minting licences when License is off.
   _Default: yes._
5. **Login methods in phase 1.** Email one-time code and magic link (hosted and in-app), plus
   upstream OIDC (Google and the product IdP through discovery; Apple and Discord as their own
   kinds, I-20); passkeys in phase 2; never passwords. _Default: as stated._
6. **Linking policy.** Explicit linking always available; email auto-link only between
   email-authoritative issuers and off by default for custom IdPs; Block on conflict.
   _Default: as stated._
7. **The portal and the Identity flag (G10).** Keep the portal a platform concern that runs for
   every product, and fix the docs and service summary to match the code. _Default: platform
   concern._
8. **"Sign in with <Product>" and the domain story.** In scope, as phase 3, at a path-based
   per-product issuer, RS256, entitlements in claims and no licence state. Custom auth domains
   stay deferred, and passkeys are enrolled on `key.plrs.im`, accepting re-enrolment if a custom
   domain ever comes. _Default: yes, phase 3; `key.plrs.im` only._
9. **Licence document.** No user claim until named-user seats (I-18) are commissioned.
   _Default: unchanged._
10. **Hygiene now.** Ship I-01 to I-03 as standalone changes immediately, ahead of the plan.
    _Default: yes._
11. **D-14.** Replace it with a new decision record in the services design spec, written by I-04.
    _Default: yes._
12. **Who builds the phase 3 OP.** In-house on `jose`, or Ory Hydra with the Worker as its login
    and consent app (Option F's best variant). _Default: decide in I-16's plan, leaning in-house
    to stay on Workers, unless the conformance work proves heavier than running Hydra._
13. **Scope to commit now.** The minimum viable cut (§7.1, about 46 agent-days), or all of phases
    0–2 (about 72). _Default: commit to the minimum viable cut, then decide I-12 (games) and I-13
    (native redirect) on demand from the Godot program._
14. **Licence claim policy.** First attach only; an owned licence never moves by key; licences
    with an email attach only by verified email unless the product sets `claimByKey: true`;
    operator reassign under step-up with undo. _Default: as stated._
15. **Recovery.** Through any remaining link; passkeys only after email; platform identities
    recover through the platform; beyond that, the developer's support with the console tool.
    Polaris runs no recovery desk. _Default: as stated._
16. **In-app email start.** Allowed from SDKs with a registered device token and per-device
    limits; otherwise the SDK opens the hosted page with Turnstile. _Default: on, product can turn
    it off._

## 11. Sources

Repo (all [V], at `0c35758e`): `AGENTS.md`; `tools/services.json`;
`packages/worker/src/services/identity/{index,routes,oidc,browserSession,doc,admin,registration,idToken}.ts`;
`packages/worker/src/services/identity/portal/{index,auth,session,repo,api,email}.ts`;
`packages/worker/src/{platformOidc,repo,rateLimitDo,keyvault}.ts`;
`packages/worker/src/admin/{auth,authz,api}.ts`; `packages/worker/src/core/{cors,identityTrust,authz,storeGrants,x509}.ts`;
`packages/worker/src/services/distribution/commerce/{steam,apple}.ts`;
`packages/worker/migrations/{0001_init,0008_portal,0009_oidc_provider,0011_auto_issue,0013_portal_auto_link,0016_drop_dead_pii,0052_commerce}.sql`;
`packages/shared-protocol/src/{license,core}.ts`; `packages/admin/src/console/pages/identity/SignIn.tsx`;
`packages/sdk-node/src/identity/client.ts`; `sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift`;
each SDK's `parity.json`; `conformance/parity/features.json`; `conformance/transcripts/`;
`packages/docs/src/content/docs/start/concepts.md`; `packages/docs/src/content/docs/services/identity/*.md`;
`docs/security/{THREAT-MODEL,WIRE-CONTRACT-V4}.md`; `docs/{DEPLOYMENT,RUNBOOK}.md`;
`docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (D-14);
`docs/research/2026-09-29-godot-omniplatform/program/plans/F-20.md`.

Measured ([M], 2026-10-04 14:34 UTC, macOS, anonymous):

```sh
curl -s https://id.plrs.im/.well-known/openid-configuration | python3 -m json.tool
curl -s https://id.plrs.im/.well-known/jwks.json
```

Standards: RFC 6749, 7009, 7517, 7523, 7591, 7636, 8252, 8414, 8628, 8693, 9068, 9207, 9700;
OpenID Connect Core 1.0 §8.1 and §15.1 (https://openid.net/specs/openid-connect-core-1_0.html);
OIDF certification fees (https://openid.net/certification/fees/).

Libraries and Cloudflare: https://github.com/cloudflare/workers-oauth-provider;
https://openauth.js.org/docs/; https://github.com/panva/node-oidc-provider/discussions/1250;
https://simplewebauthn.dev/docs/packages/server; https://pocket-id.org/docs;
https://developers.cloudflare.com/workers/platform/pricing/;
https://developers.cloudflare.com/kv/concepts/how-kv-works/;
https://developers.cloudflare.com/email-service/platform/limits/;
https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/;
https://developers.cloudflare.com/d1/reference/time-travel/ [U: not re-read].

Self-hosted IdPs (Option F, [U]: product pages not re-read for this revision):
https://www.ory.sh/docs/hydra/ (headless login and consent); https://www.ory.sh/docs/kratos/;
https://zitadel.com/docs; https://www.keycloak.org/documentation; https://pocket-id.org/docs.

Sign in with Apple: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret;
https://developer.apple.com/documentation/sign_in_with_apple/request_an_authorization_to_the_sign_in_with_apple_server
[U: summarised from the research angle, not re-read]. WebAuthn Related Origin Requests:
https://w3c.github.io/webauthn/#sctn-related-origins [U].

Providers: https://partner.steamgames.com/doc/features/auth;
https://developer.apple.com/documentation/gamekit/gklocalplayer/3516283-fetchitemsforidentityverificatio;
https://developer.android.com/games/pgs/android/server-access;
https://dev.epicgames.com/docs/epic-online-services/eos-fundamentals/connect-interface/connect-reference;
https://firebase.google.com/docs/auth/admin/verify-id-tokens; https://clerk.com/docs/backend-requests/manual-jwt;
https://supabase.com/docs/guides/auth/third-party/overview; https://developer.apple.com/app-store/review/guidelines/.

Landscape: https://keygen.sh/docs/api/users/; https://keygen.sh/blog/announcing-multi-user-licenses/;
https://cryptlex.com/docs/licensing-models/named-user-licenses/oidc-sso;
https://docs.licensespring.com/common-scenarios/single-sign-on-sso/user-portal-sso;
https://docs.lemonsqueezy.com/help/online-store/my-orders; https://developer.paddle.com/concepts/sell/customer-portal/;
https://heroiclabs.com/docs/nakama/concepts/authentication/; https://docs.unity.com/en-us/authentication/approaches-to-authentication;
https://docs.trytalo.com/docs/godot/identifying; https://developers.xsolla.com/doc/login/authentication-options/cross-platform-account/;
https://www.revenuecat.com/docs/projects/restore-behavior; https://supabase.com/docs/guides/auth/oauth-server.
