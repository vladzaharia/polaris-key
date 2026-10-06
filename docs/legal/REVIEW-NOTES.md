# Review notes for the legal drafts

This file is for the lawyer and the owner. It lists every factual claim in `privacy.md`,
`terms.md` and `help.md`, with the code it came from, so each one can be checked. It also lists
the open placeholders and the data practices worth a decision before launch.

The claims were researched against `main` at commit `9c00cc95f` (2026-10-06). Paths are relative
to the repository root. `W/` is short for `packages/worker/src/`, `M/` for
`packages/worker/migrations/`, and `A/` for `packages/admin/src/`.

If the code changes, these claims can go stale. `docs/PRIVACY.md` is the existing engineering
data inventory and agrees with most of this file. Where it disagrees, see "Corrections to
docs/PRIVACY.md" below.

---

## 1. Open placeholders (`[[OWNER: …]]`)

| #   | Placeholder                                                   | Where                        | Notes                                                                                                                                          |
| --- | ------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Legal entity name, registered address, company number         | privacy, terms               | Nothing in the repo names an entity.                                                                                                           |
| P2  | Effective date                                                | privacy, terms               |                                                                                                                                                |
| P3  | Privacy contact email                                         | privacy, help                | None exists in the repo. Google's OAuth consent screen also needs one (`docs/RUNBOOK.md:855-857`).                                             |
| P4  | Support email, and expected response time                     | all three                    |                                                                                                                                                |
| P5  | Security contact                                              | terms §5                     |                                                                                                                                                |
| P6  | Postal address                                                | privacy, terms               |                                                                                                                                                |
| P7  | Governing law and courts                                      | terms §13                    |                                                                                                                                                |
| P8  | Minimum age                                                   | privacy (Children), terms §3 | 13 (US COPPA) vs 16 (GDPR default; varies by EU country).                                                                                      |
| P9  | Lead supervisory authority; EU/UK representative if required  | privacy                      | Depends on where the entity is established.                                                                                                    |
| P10 | Data location and EU/UK transfer mechanism                    | privacy                      | No D1 jurisdiction or location hint is set in `packages/worker/wrangler.toml`.                                                                 |
| P11 | Cloudflare Workers Logs retention (3 days Free / 7 days Paid) | privacy                      | Depends on the account's Workers plan. Cloudflare docs: Workers Logs pricing table.                                                            |
| P12 | Completeness of the processor list; Cloudflare DPA signed     | privacy                      |                                                                                                                                                |
| P13 | Controller/processor split and DPA wording                    | privacy, terms §10           | Decided in principle (S-16 §5.5, D27), wording pending legal review.                                                                           |
| P14 | Law-enforcement request commitment                            | privacy                      | A policy choice, not in code.                                                                                                                  |
| P15 | Support channel and support-message retention                 | privacy                      | No support system in the repo.                                                                                                                 |
| P16 | Dormant-account deletion (36 months)                          | privacy                      | Decided (S-16 D23, 2026-10-04) but **not implemented**. Keep as "planned" until it is.                                                         |
| P17 | Payments / Stripe section                                     | privacy, terms §7            | G1–G4 decided (S-22, 2026-10-06); needs the G1 legal review before live payments.                                                              |
| P18 | Notice periods (policy change, terms change, shutdown)        | privacy, terms §8, §12       |                                                                                                                                                |
| P19 | Shutdown commitment for licences                              | terms §8                     |                                                                                                                                                |
| P20 | Liability cap                                                 | terms §9                     |                                                                                                                                                |
| P21 | Developer terms and DPA (separate document)                   | terms §10                    | Not written yet.                                                                                                                               |
| P22 | Apple private relay registration                              | help                         | `EMAIL_APPLE_RELAY` is commented out in prod (`packages/worker/wrangler.toml:218-220`).                                                        |
| P23 | How to add a second email address                             | help                         | Account → Sign-in methods shows one email today (`A/portal/pages/AccountPage.tsx:165-193`).                                                    |
| P24 | "Get a new key" in the portal                                 | help                         | Server route exists (`W/services/identity/portal/selfService.ts:519-608`); UI waits for G7 (`A/portal/components/product/LicenseCard.tsx:33`). |
| P25 | Remove a product from the library                             | help                         | `removeProductData` (`W/services/identity/accounts/deletion.ts:57`) has no caller and no route.                                                |

---

## 2. Things worth the owner's attention before publishing

Listed roughly by importance.

1. **Full licence keys land in Cloudflare's persisted request logs.** The portal's activation
   deep link is `/activate?key=<full licence key>`, and the Worker serves that path itself
   (`W/router.ts:134-139`; `A/portal/router.ts:189-194`). Workers Logs are on with
   `invocation_logs = true`, `persist = true` and 100 % sampling
   (`packages/worker/wrangler.toml:11-15`). Cloudflare's invocation log for a fetch records the
   method and URL, and captures request metadata and headers. Other one-time secrets in query
   strings also land there: magic-link `?token=` (`W/services/identity/card/emailSignIn.ts:462-468`),
   download `?ticket=` (`W/core/downloadTicket.ts:51`), OIDC `?code=` and the device-flow
   `?user_code=` (`W/services/identity/oidc.ts:1699-1702`). These expire quickly, but a licence
   key does not. Options: make `/activate` a fragment-only link (`/#/?activate=`, which never
   reaches the server), turn off `invocation_logs`, or lower the sampling. **Also verify with
   Cloudflare whether `Authorization` and `Cookie` headers are redacted in invocation logs:**
   licence keys are sent as `Authorization: Bearer` (`W/services/license/activation.ts:122`).
2. **Disconnecting a device does not delete its record.** `setDeviceStatus` deletes the
   fingerprint and software facts but keeps the `devices` row with the raw User-Agent, label,
   platform, versions and the last full report (`reported_json`, which includes config values
   and entitlements) (`W/repo.ts:1482-1524`). Dormant devices only lose their seat after 90 days
   (`W/repo.ts:1204`). Device rows are deleted only when an operator deletes the licence
   (`W/core/licenseDelete.ts:214`). The privacy draft says this plainly. Consider clearing
   `ua`, `label` and `reported_json` on deauthorise, or a time limit.
3. **Raw User-Agent stored with no time limit** in `devices.ua` (`W/core/devices.ts:418,747`).
   The account-session table was deliberately reduced to a coarse label (commit `498bd2810`), but
   the device table wasn't.
4. **Licences and buyer name/email have no retention limit and survive account deletion.** This
   is the intended design (developer's records, `W/services/identity/accounts/deletion.ts:7-9`),
   but it depends on the DPA wording (D27) still under legal review.
5. **No self-service data export.** "Download my data" waits for I-15 (`A/portal/pages/AccountPage.tsx:238`).
   GDPR Art. 15/20 requests must be handled by email until then. The console export (I-12) is
   per product, for developers.
6. **Console per-subject delete is effectively a no-op today.** `registerSubjectStore(` has no
   callers, so `POST …/users/<subject>/data/delete` only writes an audit row and the export's
   `stores` is `{}` (`W/services/identity/accounts/productUsers.ts:593-631`). The drafts don't
   promise more than export/delete exists; the developer terms should not over-promise.
7. **Turnstile is enforced server-side but the portal never sends a token.** `A/portal/api.ts:517-521`
   posts only `{email, returnTo}`, nothing renders the widget, and the CSP allows scripts only from
   `'self'` (`W/securityHeaders.ts:34-44`). If `TURNSTILE_SECRET_KEY` is set in prod, email sign-in
   fails with `turnstile_failed`; if not, Turnstile is off. The privacy draft says "when it is
   switched on".
8. **City and country kept for 180 days in the account history.** Device-login approvals write
   "…near Berlin, Germany" into `portal_audit.summary` (`W/services/identity/portal/deviceLogin.ts:599,632-641`),
   pruned at 180 days (`W/scheduled.ts:336-338`). `docs/PRIVACY.md:152` says IP-derived
   geolocation is not collected.
9. **The account cookie carries name and email, signed but not encrypted**
   (`W/services/identity/portal/session.ts:15-30`). It's `HttpOnly`, `Secure` and host-only, so
   the risk is low, but it is disclosed in the draft.
10. **The device report has no opt-out.** Only the hardware fingerprint and probes can be turned
    off by the developer; the end user has no switch (`packages/sdk-node/src/core/sync.ts:161-164`).
    Locale and time zone are always sent.
11. **Hardware fingerprinting is on by default** (`docs/PRIVACY.md:188`). It's hashed on device,
    but some regulators treat device fingerprints as personal data and possibly as needing
    consent under the ePrivacy rules (reading information from a device). Ask counsel whether
    "strictly necessary for the licence the user asked for" covers it.
12. **Session rows are pruned only on the next sign-in** of the same account
    (`W/services/identity/portal/accountSessions.ts:33,140-148`); there is no cron. An account
    that never signs in again keeps its ended session rows until it is deleted.
13. **Some records are kept forever:** `subject_events`, `account_tombstones` (id only),
    `account_product_subject_aliases`, `license_relinks` (includes the operator's name and a
    free-text reason), `store_operations`, and expired `email_suppressions` rows (hashed). None
    holds an email address, but the relink reason is free text.
14. **The KV browser-session record holds the raw device bearer token**
    (`W/services/identity/browserSession.ts:66-72,155-165`), the one exception to "credentials are
    stored hashed". 30-day TTL. Not mentioned in the drafts.
15. **Licence-key hashing falls back to unpeppered SHA-256** if `KEY_HASH_PEPPER` is unset
    (`W/crypto.ts:129`). Confirm it is set in prod.
16. **Prod still sends from `noreply@plrs.im`**: `EMAIL_SENDER_ADDRESS` is commented out in prod
    (`packages/worker/wrangler.toml:217`), so the help page names both addresses.
17. **No public privacy page exists today.** `docs/PRIVACY.md` is rendered at
    `/docs/users/privacy/` but the docs site is behind the platform-admin sign-in
    (`W/docs.ts:2-5`). The sign-in mockup's "By continuing you agree to the Terms and Privacy
    Policy" (`docs/design/sign-in/frames.js:279`) is not in the shipped UI.
18. **Console access is a single admin role** from the IdP group `PLATFORM_ADMIN_GROUP`
    (`W/admin/authz.ts:1-44`). There are no per-developer accounts, teams or invitations yet, so
    "developers" in the drafts are, today, platform operators. Terms §10 will need rework when
    third-party developers get console access.

---

## 3. Claims and their sources

### Privacy policy

**Who we are / scope**

| Claim                                                                                                 | Source                                                                                        |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Polaris is controller for the account; developer is controller and Polaris processor for product data | `docs/research/2026-09-29-godot-omniplatform/notes/S-16-identity-service.md:1072-1100` (§5.5) |
| Hostnames key.plrs.im, dl.plrs.im, pkg.plrs.im                                                        | `packages/worker/wrangler.toml:145-153`                                                       |

**Sign-in data**

| Claim                                                                                                                                      | Source                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers are Google, Apple, Steam (plus email and platform OIDC single sign-on)                                                           | `W/services/identity/providers/config.ts:31`; `W/platformOidc.ts:28-38`                                                                                                                |
| Google: scopes `openid email profile`; reads sub, email, email_verified, name, picture; access token dropped                               | `W/services/identity/providers/google.ts:5-6,41-46,91-112`                                                                                                                             |
| Apple: scope `name email`; name only on first consent; no avatar; relay flag                                                               | `W/services/identity/providers/apple.ts:75-78,88-100,147-171`                                                                                                                          |
| Steam: SteamID64, persona name and avatar from GetPlayerSummaries; no email                                                                | `W/services/identity/providers/steam.ts:20,85-195`                                                                                                                                     |
| Single sign-on reads name, email (verified only) and groups; groups stored                                                                 | `W/services/identity/portal/auth.ts:205-233,313,409-410`; `W/services/identity/portal/repo.ts:270-280`                                                                                 |
| Account columns: primary email, display name, avatar key, locale, terms acceptance                                                         | `M/0068_a_accounts.sql:23-38`                                                                                                                                                          |
| Link columns: subject, email, email_verified, display_name, profile_json {name, locale, pictureRef, avatarKey}, provider_flag, groups_json | `M/0068_a_accounts.sql:48-62`; `M/0079_account_links_profile.sql`, `M/0081_account_links_provider_flag.sql`, `M/0071_portal_discover.sql`; `W/services/identity/card/profile.ts:35-42` |
| Session record: hashed id, times, coarse browser label (no versions), sign-in method                                                       | `M/0068_a_accounts.sql:120-129`; `W/services/identity/portal/accountSessions.ts:29-66,118-138`                                                                                         |
| City/country from Cloudflare on sign-in requests                                                                                           | `W/services/identity/card/http.ts:130-136`; `W/services/identity/card/emailSignIn.ts:219-224`; `W/services/identity/portal/deviceLogin.ts:247-275`                                     |
| Sharing choices per product; app terms acceptance                                                                                          | `M/0068_a_accounts.sql:134-141`; `W/services/identity/card/gate.ts:26-27,129-133`                                                                                                      |
| 6-digit code plus link, stored as peppered hash                                                                                            | `W/services/identity/portal/email.ts:229-288`; `W/core/emailLimits.ts:109-111,217-224`                                                                                                 |
| Avatar copied to R2 under a random key, served same-origin, only from Google/Steam hosts                                                   | `W/services/identity/card/avatars.ts:36-50,158-175,221-261`                                                                                                                            |

**Licence and device data**

| Claim                                                                                                                  | Source                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence holds name, email, groups, sub set by developer or OIDC                                                        | `M/0001_init.sql:64-81`; `W/services/identity/oidc.ts:957-1003,1777-1810`                                                                                  |
| Keys stored as HMAC-SHA-256 with a secret pepper                                                                       | `W/crypto.ts:128-143`; `M/0001_init.sql:86-96`                                                                                                             |
| Device ID is a hash of the OS machine ID, per product                                                                  | `packages/sdk-node/src/devices/deviceId.ts:37-69`; `sdks/swift/Sources/PolarisKeyCore/DeviceID.swift:29`; `sdks/kotlin/android/.../DeviceInputs.kt:78-148` |
| No hostname or username read; device name only from user/app                                                           | `docs/PRIVACY.md:150-153`; `packages/sdk-node/src/identity/client.ts:252-256`; `sdks/godot/addons/polaris_key/services/devices.gd:52`                      |
| X-PKey headers: device, version, channel, platform, arch, SDK, SDK version                                             | `docs/security/WIRE-CONTRACT-V3.md:202`; `packages/sdk-node/src/core/context.ts:318-333`                                                                   |
| Raw User-Agent stored on device row                                                                                    | `W/core/devices.ts:418,739-747`                                                                                                                            |
| first_seen / last_seen; last_seen updated on each document fetch                                                       | `W/core/devices.ts:410-428,710-730`                                                                                                                        |
| Seven fingerprint components hashed on device with product in the hash; on by default; browser none; Android no serial | `docs/PRIVACY.md:13-70`; `packages/sdk-node/src/devices/fingerprint.ts`; `packages/sdk-react/src/browser/bearer/facts.ts:1-5`                              |
| Software facts incl. locale, timezone, probes; Godot GPU and outlet                                                    | `packages/sdk-node/src/devices/facts.ts:40-119`; `sdks/godot/addons/polaris_key/core/facts.gd:179-189`; `M/0010_fingerprint.sql`                           |
| Report carries config values, entitlements, caps; allowlisted, 16 KiB cap                                              | `packages/sdk-node/src/core/telemetry.ts:25-91`; `W/core/devices.ts:934-956`                                                                               |
| Update result events, max 16 per report, no free text                                                                  | `docs/PRIVACY.md:93-107`; `packages/sdk-node/src/core/telemetry.ts:41-42`                                                                                  |
| Store purchase: hashed key, transaction/order ids, Steam ID; notifications as received                                 | `docs/PRIVACY.md:120-131`; `M/0052_commerce.sql:41-77`                                                                                                     |
| Download links single-use, five minutes; token tied to device                                                          | `M/0016_drop_dead_pii.sql:16-31`; `W/services/identity/portal/repo.ts:888,997-1024`                                                                        |
| Package feed tokens hashed; 90 days after expiry                                                                       | `M/0067_registry_tokens.sql:22-44`; `W/core/registryTokens.ts:515-531`                                                                                     |
| No console accounts table; operator name/email/sub in audit                                                            | `W/admin/session.ts:1-19,55-64`; `W/admin/audit.ts:33-35`; `M/0001_init.sql:181-194`; `M/0054_b_platform_audit.sql:13-25`                                  |

**Who sees it**

| Claim                                                                                                                                            | Source                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Developer sees per-product pairwise ID, licences, devices, sign-ins by method kind; account email/name only with consent; never account id or IP | `docs/PRIVACY.md:222-239`; `W/services/identity/accounts/productUsers.ts:1-27,402-611`               |
| Export, delete, detach, relink with reason, emails to both, 72-hour undo                                                                         | `W/admin/handlers/users.ts:4-27`; `M/0082_license_relinks.sql:18-36`                                 |
| No admin can delete, sign out or merge an account                                                                                                | `docs/PRIVACY.md:238-239`                                                                            |
| Email sent via Cloudflare `send_email` binding; no other email provider                                                                          | `packages/worker/wrangler.toml:231-233`; `W/core/emailDelivery.ts:246-318`                           |
| Turnstile sends token and `remoteip` to Cloudflare                                                                                               | `W/services/identity/card/turnstile.ts:18,44-71`                                                     |
| Steam ID sent to GetPlayerSummaries                                                                                                              | `W/services/identity/providers/steam.ts:163-195`                                                     |
| Store APIs receive purchase ids / Steam ID                                                                                                       | `W/services/distribution/commerce/apple.ts:58`; `.../commerce/play.ts:6`; `.../commerce/steam.ts:69` |
| Sentry: inbound alerts only, reduced record kept 30 days, no crash payload; no Sentry in SDKs                                                    | `W/services/distribution/sentry.ts:1-40`; `docs/PRIVACY.md:102-107`                                  |
| No Stripe, Resend, Postmark, analytics vendors in code                                                                                           | repo-wide grep (no matches in `packages/` source)                                                    |

**Retention**

| Claim                                                                                                | Source                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session 14 days; ended session row removed 30 days later (on next sign-in)                           | `W/services/identity/portal/session.ts:13`; `W/services/identity/portal/accountSessions.ts:31-33,140-148`                          |
| Codes and links 10 minutes, single use; 5 wrong tries kills a code; 10 wrong in an hour locks 15 min | `W/core/emailLimits.ts:28-61`                                                                                                      |
| Pending sign-in 10 min; email gate 15 min; device login 5 min                                        | `W/services/identity/providers/flow.ts:67`; `W/services/identity/card/gate.ts:125`; `W/services/identity/portal/deviceLogin.ts:84` |
| Account activity log 180 days                                                                        | `W/scheduled.ts:97,336-338,366-368`                                                                                                |
| IP used only as a rate-limit key, deleted when its window ends (longest 1 day)                       | `W/core/rateLimit.ts:289-310`; `W/rateLimitDo.ts:41,56,92-113`                                                                     |
| Fingerprint and facts deleted on disconnect; device row kept                                         | `W/repo.ts:1482-1524`                                                                                                              |
| Seat freed after 90 days, row kept                                                                   | `W/repo.ts:1204,1278-1295`                                                                                                         |
| Device rows deleted only with the licence                                                            | `W/core/licenseDelete.ts:199-227`                                                                                                  |
| Update counters 30 days                                                                              | `W/updateHealthDo.ts:7-58`                                                                                                         |
| Refusal log 30 days                                                                                  | `W/core/refusals.ts:30,262-277`                                                                                                    |
| Console audit 180 days                                                                               | `W/scheduled.ts:97`; `W/repo.ts:1893-1908,2059-2070`                                                                               |
| Store notifications 30 days                                                                          | `W/services/distribution/connectors/state.ts:301,432-446`                                                                          |
| Suppression: hashed address, 90 days after bounce, permanent after complaint                         | `M/0066_email_delivery.sql:19-31`; `W/core/emailDelivery.ts:48-60,173-211`                                                         |
| Avatar copy removed on change or account deletion                                                    | `W/services/identity/card/profile.ts:131-145,246-253`; `W/services/identity/accounts/deletion.ts:182-184`                          |
| Workers Logs persisted, 100 % sampled; no app-level logging                                          | `packages/worker/wrangler.toml:11-15`; no `console.*` calls in `W/`                                                                |

**Rights**

| Claim                                                                                                                 | Source                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Library lists licences and devices                                                                                    | `W/services/identity/portal/api.ts:1408-1424`; `A/portal/components/product/DevicesCard.tsx`                 |
| Remove device from portal, seat freed straight away, email sent                                                       | `A/portal/components/product/DevicesCard.tsx:20-27,215-275`; `W/services/identity/portal/freeDevice.ts:1-50` |
| Delete account at Account → Your data, typed email confirmation, immediate, email first                               | `A/portal/pages/AccountPage.tsx:22-26,236-350`; `W/services/identity/portal/api.ts:535-599`                  |
| What deletion removes and keeps (licences detached, developers notified with licence ids, id-only tombstone, receipt) | `W/services/identity/accounts/deletion.ts:141-279`; `W/core/accountSubjects.ts:253-258`                      |
| Download my data: planned                                                                                             | `A/portal/pages/AccountPage.tsx:238`                                                                         |
| Remove one app's data: planned                                                                                        | `W/services/identity/accounts/deletion.ts:57` (no caller)                                                    |
| Passkeys: planned                                                                                                     | `W/services/identity/portal/session.ts:225`; table only in `M/0068_a_accounts.sql:143-156`                   |

**Cookies and browser storage**

| Claim                                                                                      | Source                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie names, lifetimes, `__Host-`, Secure, HttpOnly                                       | `W/core/accountCookies.ts:17`; `W/services/identity/portal/session.ts:187-196`; `W/services/identity/card/emailSignIn.ts:280`; `W/services/identity/providers/flow.ts:134-143`; `W/services/identity/card/gate.ts:407`; `W/services/identity/portal/deviceLogin.ts:328-337`; `W/services/identity/licenseChoice.ts:69-78`; `W/admin/session.ts:259-274` |
| Account cookie holds account id, name, email; signed not encrypted                         | `W/services/identity/portal/session.ts:15-30,129-143`                                                                                                                                                                                                                                                                                                   |
| localStorage keys (theme, library view, recent products, table density, celebration flags) | `A/components/theme.tsx:22`; `A/portal/model/libraryView.ts:64`; `A/portal/components/JumpPalette.tsx:20-40`; `A/ui/data-table/DataTable.tsx:50`; `A/ui/motion/Celebration.tsx:13-27`                                                                                                                                                                   |
| Licence key held in sessionStorage across a sign-in redirect, then cleared                 | `A/portal/carriedKey.ts:15-56`                                                                                                                                                                                                                                                                                                                          |
| No analytics; CSP `'self'` only; fonts self-hosted                                         | `W/securityHeaders.ts:34-44,73`; `A/styles.css:21`                                                                                                                                                                                                                                                                                                      |

**Coming later**

| Claim                                                                                      | Source                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Developer is merchant of record via Stripe Connect; no fee at launch; EU withdrawal waiver | `docs/research/2026-09-29-godot-omniplatform/notes/S-22-polaris-key-commerce.md:909-926` (G1–G4)                     |
| No Stripe code today                                                                       | grep `stripe` in `packages/` returns no source matches                                                               |
| Cloud Sync planned; developer controller; deleted with account; no floating licences       | `docs/research/2026-09-29-godot-omniplatform/notes/S-17-user-data-sync.md:1309-1335`; workpackages U-05, U-12 `todo` |

### Terms of service

| Claim                                                                    | Source                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Developer sets device limit, expiry, version range, offline grace        | `packages/docs/src/content/docs/users/devices.md`; `.../users/troubleshooting.md:24-42`               |
| Developer can revoke after refund                                        | `docs/PRIVACY.md:167` (refund marks store grants revoked)                                             |
| App terms acceptance recorded                                            | `W/services/identity/card/gate.ts:26-27,129-133`                                                      |
| Keys can't be shown again                                                | `W/services/identity/portal/selfService.ts:575-576,603-608`                                           |
| 90-day seat reclaim, re-claims on return                                 | `W/repo.ts:1195-1204`                                                                                 |
| Download links once, five minutes; feed tokens only while licence active | `W/services/identity/portal/repo.ts:997-1024`; `packages/docs/src/content/docs/users/portal.md:58-64` |
| No payments taken today                                                  | see "Coming later" above                                                                              |
| Developer notified of account deletion with licence ids                  | `W/services/identity/accounts/deletion.ts:203-276`; `W/services/identity/accounts/events.ts:1-5`      |

### Help page

| Claim                                                                                     | Source                                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Email + Continue, 6-digit code and Sign in button, 10 minutes, once                       | `A/portal/pages/SignInPage.tsx:18-41`; `W/services/identity/portal/email.ts:229-288`                |
| "Continue with … / single sign-on" button                                                 | `A/portal/pages/SignInPage.tsx:264`                                                                 |
| "Have a license key?" on-ramp                                                             | `A/portal/pages/SignInPage.tsx:22-31`                                                               |
| Products bought with the account email join the library                                   | `A/portal/pages/AccountPage.tsx:186`                                                                |
| Sender addresses                                                                          | `W/core/emailSender.ts:20-34,198-200`; `packages/worker/wrangler.toml:217,231-233`                  |
| Resend after 60 s                                                                         | `A/portal/pages/SignInPage.tsx:40`                                                                  |
| 5/hour, 20/day per address; error copy "Too many codes" / "We can't send email right now" | `W/core/emailLimits.ts:28-61`; `A/portal/pages/SignInPage.tsx:186-189`                              |
| Relay addresses get no email until registered                                             | `W/core/emailDelivery.ts:18-21,86-94,265-266`                                                       |
| Apple notifications flag the link, never delete it; audited                               | `W/services/identity/providers/linkFlags.ts:1-40`; `W/services/identity/providers/apple.ts:175-220` |
| Keys start with `pkey_`; portal shows a masked prefix                                     | `W/crypto.ts:32-34`; `A/portal/components/KeyMask.tsx`                                              |
| Remove device flow and notice email                                                       | see Rights above                                                                                    |
| Same message for every invalid-key cause                                                  | `packages/docs/src/content/docs/users/troubleshooting.md:8-15`                                      |
| New-device and device-removed notices                                                     | `W/services/identity/portal/notices.ts:219,268`                                                     |

---

## 4. Corrections to docs/PRIVACY.md

The engineering inventory should be updated to match, whatever happens to these drafts:

- Line 152 says IP-derived geolocation is not collected. City and country are collected on
  sign-in (minutes) and kept in `portal_audit` summaries (180 days).
- It doesn't mention `devices.ua` (raw User-Agent, no time limit), Workers Logs, or the
  config/entitlements snapshot in `reported_json` that survives a disconnect.
- It says update events come from "Godot today"; Node's report type carries `updates` too.
- It says disabling a licence purges every device; only deauthorising a device and deleting a
  licence were confirmed to purge.
- `packages/docs/src/content/docs/users/portal.md` still describes sign-in as a magic link and
  deletion as "on request"; the portal now sends a code plus link, and deletion is self-service.
