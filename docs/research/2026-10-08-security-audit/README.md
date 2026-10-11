# Security audit, v0.9.0

Clean-room audit of main @ 8cd7e6192, 2026-10-08. Local only. Machine-readable record: `findings.json` (244 entries).

## Summary

244 records: 154 confirmed, 63 plausible, 8 refuted, 19 duplicates (kept for the record, fixed with the finding they repeat).

| Severity | Confirmed | Plausible |
| -------- | --------- | --------- |
| critical | 0         | 0         |
| high     | 5         | 0         |
| medium   | 38        | 2         |
| low      | 82        | 40        |
| info     | 29        | 21        |

No critical findings. High findings, to fix first:

- **SEC-LIC-1** Cross-licence device-id takeover and keyless eviction via activate/enroll (unowned device row lookup)
- **SEC-ADM-1** Any platform-admin session can mint release:publish/yank CI tokens and repoint the trusted publisher on the system product
- **SEC-DST-1** Blob route serves private package files (all ecosystems) anonymously by sha256; dist_access, feed access_mode, yank and release removal ignored
- **SEC-WEB-1** Docs gate bypass: anonymous GET /manage/docs/<file> serves gated docs from ASSETS
- **SEC-PRV-1** Account erasure is non-atomic: status flipped to deleted before unguarded store hooks; failure leaves PII intact, no tombstone, no retry

Counts are per record after merging red/blue reports of the same defect inside an area. The same root cause often appears in several areas (the /64 rate-limit gap, the stale device upsert, the pepper fallback); each area keeps its own record, and later ones are marked duplicate where they only repeat an earlier one.

## Method

- Clean room, local only. Workers ran in the repo's vitest workerd pools and Node harnesses with fakes and recorded transcripts. No live endpoint, credential or store API was touched.
- 12 areas. Per area: 2 red agents attacked, 2 blue agents tested defensively (controls, hardening, detection gaps; they did not review red's work), and a green team reviewed all reports, pushed back, and sent follow-up requests to the opposing team where reports conflicted. Follow-up runs settled several ratings (race hit rates on real D1, /64 bypasses, the docs gate on the real asset tree).
- Verdicts: confirmed (reproduced or unambiguous in code), plausible (mechanism real, exploit or precondition unshown), refuted (tested and held), duplicate.
- `confirmedLocally` is true only where a test ran in the local harness. Static-only findings are false.

Reports read per area (red / blue): licensing 20/2, crypto 24/2, admin 22/2, identity 14/2, distribution 9/2, config 19/2, commerce 19/2, web 29/2, infra 22/2, supplychain 24/2, clients 11/2, privacy 23/2.

## Confirmed findings, high and medium

| Rank | Id         | Severity           | Finding                                                                                                                                              | Local | Package   |
| ---- | ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- |
| 1    | SEC-LIC-1  | high               | Cross-licence device-id takeover and keyless eviction via activate/enroll (unowned device row lookup)                                                | yes   | SEC-WP-01 |
| 2    | SEC-ADM-1  | high               | Any platform-admin session can mint release:publish/yank CI tokens and repoint the trusted publisher on the system product                           | yes   | SEC-WP-05 |
| 3    | SEC-DST-1  | high               | Blob route serves private package files (all ecosystems) anonymously by sha256; dist_access, feed access_mode, yank and release removal ignored      | yes   | SEC-WP-02 |
| 4    | SEC-WEB-1  | high               | Docs gate bypass: anonymous GET /manage/docs/<file> serves gated docs from ASSETS                                                                    | yes   | SEC-WP-03 |
| 5    | SEC-PRV-1  | high               | Account erasure is non-atomic: status flipped to deleted before unguarded store hooks; failure leaves PII intact, no tombstone, no retry             | yes   | SEC-WP-04 |
| 6    | SEC-LIC-2  | medium             | Device-id adoption inherits victim device's overrides, label and reported data                                                                       | yes   | SEC-WP-01 |
| 7    | SEC-LIC-3  | medium             | Stale full-row upsert resurrects a deauthorized device (touchDeviceMetadata, rotateDeviceToken)                                                      | yes   | SEC-WP-06 |
| 8    | SEC-LIC-4  | medium             | Dormant-seat revival: device returns on old token without reclaiming a seat                                                                          | yes   | SEC-WP-06 |
| 9    | SEC-CRY-1  | medium             | Retire on a revoked signing key silently un-revokes it                                                                                               | yes   | SEC-WP-07 |
| 10   | SEC-CRY-2  | medium             | Activate vs revoke race: revoked kid becomes active signing key, or no active key remains                                                            | yes   | SEC-WP-07 |
| 11   | SEC-CRY-3  | medium             | Pin-only clients are blinded on key rotation; a compromised pinned key cannot be revoked remotely                                                    | yes   | SEC-WP-17 |
| 12   | SEC-CRY-12 | medium             | Fingerprint drift ratchet: stored fingerprint overwritten on tolerated drift, allowing stepwise migration to different hardware                      | yes   | SEC-WP-18 |
| 13   | SEC-ADM-3  | medium             | Step-up (I-12) is satisfied by any ordinary login in the last 5 minutes                                                                              | yes   | SEC-WP-09 |
| 14   | SEC-ADM-4  | medium             | Irreversible and PII routes have no step-up or reason: users data/delete, export, detach, product DELETE, break-glass activate, KEK reseal           | yes   | SEC-WP-09 |
| 15   | SEC-ADM-5  | medium             | Admin sessions are stateless: no revocation, logout does not invalidate cookie, /docs and slug-check ignore current group                            | yes   | SEC-WP-09 |
| 16   | SEC-IDN-1  | medium             | Card returnTo policy yields protocol-relative redirect (//evil.com) after sign-in                                                                    | yes   | SEC-WP-10 |
| 17   | SEC-IDN-4  | medium             | Device-code flow: starter confirms its own flow, victim identity attaches to attacker's device (R1-07)                                               | yes   | SEC-WP-10 |
| 18   | SEC-IDN-8  | medium             | Recipient-keyed email-code lockout: unauthenticated suppression of a victim's sign-in mail                                                           | yes   | SEC-WP-15 |
| 19   | SEC-IDN-10 | medium             | DELETE /api/me, licence removal and registry-token mint require no fresh step-up                                                                     | yes   | SEC-WP-09 |
| 20   | SEC-DST-3  | medium             | Revoking a publish token does not cancel its open native-upload sessions; sweep/settle still publishes                                               | yes   | SEC-WP-12 |
| 21   | SEC-DST-4  | medium             | Any live pkeyci\_ token of the owner reads every non-public package feed and mints OCI pull tokens; revocation lags up to 30 s                       | yes   | SEC-WP-12 |
| 22   | SEC-DST-5  | medium             | Unauthenticated fabricated device events can trigger auto-halt of a victim's self-hosted rollout                                                     | yes   | SEC-WP-13 |
| 23   | SEC-CFG-1  | medium             | delivery:serverOnly/edgeMint not enforced outside kind:secret (signed raw into device document)                                                      | yes   | SEC-WP-11 |
| 24   | SEC-CFG-2  | medium             | Delivery downgrade of a stored serverOnly secret (resync or console PUT) silently declassifies it                                                    | yes   | SEC-WP-11 |
| 25   | SEC-CFG-3  | medium             | Owner-line account-override secrets delivered to any key-only device on an owned licence                                                             | yes   | SEC-WP-11 |
| 26   | SEC-CFG-7  | medium             | Manifest profile payload stored unvalidated: null entry crashes /config/document                                                                     | yes   | SEC-WP-11 |
| 27   | SEC-COM-1  | medium             | App Store hook product-wide rate bucket can be drained by any Apple-signed JWS, 429-ing real refunds                                                 | yes   | SEC-WP-13 |
| 28   | SEC-COM-3  | medium (plausible) | Apple claim vs REFUND: last-writer-wins upsert can leave a refunded purchase active                                                                  | yes   | SEC-WP-13 |
| 29   | SEC-COM-4  | medium             | Steam weekly recheck aborts on first failing row (head-of-line blocking)                                                                             | yes   | SEC-WP-13 |
| 30   | SEC-WEB-2  | medium             | Chunked request bodies buffered in full before rejection (GitHub webhook pre-HMAC, enroll, open register)                                            | yes   | SEC-WP-14 |
| 31   | SEC-WEB-3  | medium             | Credential rate limits keyed on full IPv6 address (routed /64 gives unlimited budgets)                                                               | yes   | SEC-WP-08 |
| 32   | SEC-INF-3  | medium             | GitHub webhook replay guard is non-atomic and keyed on an unsigned header                                                                            | yes   | SEC-WP-06 |
| 33   | SEC-SUP-1  | medium             | Deploy hook trusts client-supplied .pkey manifest; trusted-publisher workflow/environment can be repointed, then Worker mints release:publish tokens | yes   | SEC-WP-12 |
| 34   | SEC-SUP-2  | medium             | No Worker-side ref, sha or event binding for deploy and publish OIDC tokens                                                                          | yes   | SEC-WP-12 |
| 35   | SEC-SUP-3  | medium             | CI tokens are not ref or channel bound: any main-ref run can pin or promote stable to any older release                                              | yes   | SEC-WP-12 |
| 36   | SEC-CLI-1  | medium             | Offline licence cloning via unsigned importedBundle marker plus copied device file                                                                   | yes   | SEC-WP-16 |
| 37   | SEC-CLI-2  | medium             | Unsigned revocation and block hints (lastSyncUnauthorized, blocked) can be cleared offline                                                           | yes   | SEC-WP-16 |
| 38   | SEC-CLI-4  | medium             | Discovery response is unsigned; services.license.enabled:false yields not-applicable and isLicensed() true                                           | yes   | SEC-WP-16 |
| 39   | SEC-PRV-3  | medium             | Per-recipient email caps, lockout and suppression bypassed by address wrapping (parseEmail accepts 'Name<victim@x>')                                 | yes   | SEC-WP-15 |
| 40   | SEC-PRV-5  | medium             | Licence create/assign returns inAccount and ownerSubject oracle and auto-attaches an admin-chosen licence to a victim's account                      | yes   | SEC-WP-19 |
| 41   | SEC-PRV-6  | medium             | Buyer emails persist after erasure in audit.summary and license_relinks.holder_json; PRIVACY and THREAT-MODEL overstate                              | yes   | SEC-WP-19 |
| 42   | SEC-IDN-3  | medium             | Product OIDC callback and /session/license have no browser binding (R8-03 login CSRF / session fixation)                                             | no    | SEC-WP-10 |
| 43   | SEC-INF-12 | medium (plausible) | Deploy hook body not bound to claims.sha; deploy job holds id-token: write with unpinned actions                                                     | no    | SEC-WP-12 |
| 44   | SEC-SUP-5  | medium             | Deploy job runs install scripts, build, test, lint on same job that holds id-token: write and CLOUDFLARE_API_TOKEN                                   | no    | SEC-WP-12 |
| 45   | SEC-SUP-7  | medium             | No integrity or provenance binding between build jobs and the privileged publish job                                                                 | no    | SEC-WP-12 |

Low and info findings are listed per area below and in full in `findings.json`.

## Areas

### Licensing and devices

20 records. Live by severity: 0 critical, 1 high, 3 medium, 11 low, 5 info.

- **SEC-LIC-1** (high, confirmed) Cross-licence device-id takeover and keyless eviction via activate/enroll (unowned device row lookup). Victim token dies (401), seat freed, row moves to attacker licence; changed[] component oracle; 500 on seat_no collision.
- **SEC-LIC-2** (medium, confirmed) Device-id adoption inherits victim device's overrides, label and reported data. Attacker's signed document carries victim's comped entitlements, config/secret overrides and label.
- **SEC-LIC-3** (medium, confirmed) Stale full-row upsert resurrects a deauthorized device (touchDeviceMetadata, rotateDeviceToken). Revocation silently fails; old token works again; row authorized with seat_no NULL.
- **SEC-LIC-4** (medium, confirmed) Dormant-seat revival: device returns on old token without reclaiming a seat. 1-seat licence serves two machines; repeatable.

Lower: 5 Anonymous enrol farming and per-IP rate limit evaded by IPv6 /64 ro... [c]; 6 Build gate treats an unparseable or empty X-PKey-Version as in range [c]; 7 Key revoke does not deauthorize already-activated devices [c]; 8 Admin licence create/patch accept fractional, huge or wrong-typed e... [c]; 9 Device id format and length unvalidated on activate, enroll and token [c]; 10 hardware_mismatch 409 and enroll refusal states act as oracles [c]; 11 Licence-key hashing falls back to unsalted SHA-256 when KEY_HASH_PE... [c]; 12 No audit or refusal row for successful activation or cross-licence ... [c]; 13 No rate limit on /license/document and /license/deauthorize; deauth... [c]; 14 Store flag names under reserved keys (license.tier, deviceLimit, ch... [p]; 15 Token is a bearer credential with no post-activation device binding... [c]; 16 Anti-replay floor lastAcceptedIssuedAt is optional in the verifier [p]; 17 Offline bundles and cached documents cannot be revoked, last up to ... [p]; 18 Enroll catch-all swallows non-unique-violation errors [c]; 19 304 response on licence document lacks cache-control: no-store [c]; 20 Admin gate has no per-product role [p].

### Crypto and trust

28 records. Live by severity: 0 critical, 0 high, 4 medium, 17 low, 6 info.

- **SEC-CRY-1** (medium, confirmed) Retire on a revoked signing key silently un-revokes it. Revoked key rejoins JWKS and trust manifest; audit says only 'Retired'.
- **SEC-CRY-2** (medium, confirmed) Activate vs revoke race: revoked kid becomes active signing key, or no active key remains. Revoked key signs, or all signed surfaces go dark.
- **SEC-CRY-3** (medium, confirmed) Pin-only clients are blinded on key rotation; a compromised pinned key cannot be revoked remotely. Compromise response ineffective for lagging clients.
- **SEC-CRY-12** (medium, confirmed) Fingerprint drift ratchet: stored fingerprint overwritten on tolerated drift, allowing stepwise migration to different hardware. Hardware binding no longer limits transfers.

Lower: 4 Non-canonical base64url: 16 signature spellings and 4 public-key sp... [c]; 5 Download-ticket MAC and registry pull-token signature accept 4 spel... [d]; 6 Python b64url_decode accepts a trailing newline (regex $ with re.ma... [p]; 7 Uncaught DataError from crypto.subtle.importKey escapes verifyChain... [c]; 8 Apple JWS chain evaluated at attacker-chosen signedDate, no lower b... [c]; 9 Second keys/prepare in same second throws UNIQUE (500); kid is low-... [c]; 10 Attestation challenge redemption is not atomic (KV get-then-delete) [c]; 11 Attestation keyId not bound to a device; sticky attested level; unv... [p]; 13 Fingerprint matching is vacuous for stored fingerprints with few co... [p]; 14 Unknown or differently-cased key status in the trust manifest fails... [c]; 15 Revocation propagation window: revoked entries dropped after 2x300 s [p]; 16 Email sign-in lockout of a victim recipient: strikes extend the loc... [c]; 17 KEY_HASH_PEPPER optional with silent unpeppered SHA-256 fallback [c]; 18 No minimum length or entropy on HMAC secrets; download-ticket kid i... [c]; 19 KEK input parsing is lenient and secret-name namespaces are writable [p]; 20 Admin OIDC ID-token verification lacks maxTokenAge, clockTolerance ... [p]; 21 Admin session is a stateless HMAC cookie with no server-side revoca... [p]; 22 Non-constant-time comparison of raw CSRF tokens [c]; 23 Licence document verifier does not validate schemaVersion [c]; 24 Admin trust-manifest endpoint signs per request with no limiter; st... [p]; 25 Python verify_jws defaults to require_typ=False [p]; 26 Delegation expiry checked against signer-chosen issuedAt; offline b... [p]; 27 Detection gaps: no logging or audit for crypto failures and key events [c]; 28 CI hygiene: GitHub Actions pinned by tag; Dependabot lacks Swift an... [c].

### Admin console

18 records. Live by severity: 0 critical, 1 high, 3 medium, 7 low, 6 info.

- **SEC-ADM-1** (high, confirmed) Any platform-admin session can mint release:publish/yank CI tokens and repoint the trusted publisher on the system product. One admin cookie reaches platform SDK supply chain via 90-day static token. Propagation to live feeds unverified.
- **SEC-ADM-2** (medium, duplicate) Retiring a revoked signing key un-revokes it (revoked is not terminal). Same as SEC-CRY-1.
- **SEC-ADM-3** (medium, confirmed) Step-up (I-12) is satisfied by any ordinary login in the last 5 minutes. Gate proves only a session younger than 5 minutes exists; stolen fresh cookie clears it.
- **SEC-ADM-4** (medium, confirmed) Irreversible and PII routes have no step-up or reason: users data/delete, export, detach, product DELETE, break-glass activate, KEK reseal. PII export, permanent data erasure, product delete, forced key activation.
- **SEC-ADM-5** (medium, confirmed) Admin sessions are stateless: no revocation, logout does not invalidate cookie, /docs and slug-check ignore current group. Combined with step-up gaps, near-full takeover for 8 h.

Lower: 6 Admin OIDC login flow is not bound to the initiating browser (login... [c]; 7 Activity feed limit=-1 is unbounded and fractional limits throw 500 [c]; 8 Admin write paths 500 on bad or colliding input; slug-check reports... [c]; 9 Product secret names are unvalidated and can share an AAD with mana... [c]; 10 Login/callback rate limit keyed by exact IP (IPv6 /64), single glob... [c]; 11 Audit rows written after the mutation (not atomic) and have no tamp... [c]; 12 Detection gaps: no sign-in audit, CI-token use unaudited, break-gla... [p]; 13 Upload tickets not bound to requesting scope; no per-token issuance... [p]; 14 Override-migration stale lease holder writes duplicate audit rows [c]; 15 OIDC redirect_uri derived from request origin; callback responses l... [p]; 16 Non-constant-time CSRF comparison (admin) [c]; 17 Deploy hook runs ensureSystemProduct/manifest parse before spending... [p]; 18 native-desktop.yml uses actions pinned to mutable tags [c].

### Identity and portal

23 records. Live by severity: 0 critical, 0 high, 5 medium, 14 low, 3 info.

- **SEC-IDN-1** (medium, confirmed) Card returnTo policy yields protocol-relative redirect (//evil.com) after sign-in. Post-login phishing hop; no token leak.
- **SEC-IDN-3** (medium, confirmed) Product OIDC callback and /session/license have no browser binding (R8-03 login CSRF / session fixation). Victim's data lands in attacker's licence or account.
- **SEC-IDN-4** (medium, confirmed) Device-code flow: starter confirms its own flow, victim identity attaches to attacker's device (R1-07). Seat theft and access to victim entitlements.
- **SEC-IDN-5** (medium, duplicate) authorizeDevice/activate rebinds a device row held by another licence (device-id takeover). Silent eviction of victim browser session.
- **SEC-IDN-8** (medium, confirmed) Recipient-keyed email-code lockout: unauthenticated suppression of a victim's sign-in mail. Email-only users locked out silently.
- **SEC-IDN-10** (medium, confirmed) DELETE /api/me, licence removal and registry-token mint require no fresh step-up. Irreversible erasure.

Lower: 2 Card/gate JSON endpoints have no content-type, Origin or Fetch-Meta... [c]; 6 Custom-issuer token POST follows redirects and leaks client*secret;... [c]; 7 isSafeIssuerUrl gaps (https loopback, NAT64, 6to4) and OIDC_ISSUER*... [p]; 9 Provider and portal callbacks consume the single-use flow before th... [c]; 11 Email-less accounts receive no out-of-band notice for link, unlink ... [c]; 12 accountUsingEmail ignores verified account_links.email, one verifie... [c]; 13 Product browser-session cookie parsing: malformed percent-encoding ... [c]; 14 Browser sessions of one licence share one device (browser:<licenseId>) [c]; 15 parseEmail accepts address-list and header metacharacters passed ve... [p]; 16 redirectUriAllowed fails open when redirect_uris_json is NULL (R8-07) [c]; 17 Device confirmation page re-mints the CSRF token on every GET [p]; 18 Two flows share cookie name \_\_Host-pkey_signin with different SameSite [p]; 19 Chosen licence not re-checked for ownership at device-poll mint (TO... [p]; 20 Portal session secret falls back to ADMIN_SESSION_SECRET [p]; 21 Device login approval is a social-engineering primitive; guesses mu... [p]; 22 Gate provider fast path relies on later overwrite to reset joinAcco... [p]; 23 Detection gaps: no audit for failed ID-token, state, binder, lockou... [c].

### Distribution and registries

18 records. Live by severity: 0 critical, 1 high, 3 medium, 7 low, 5 info.

- **SEC-DST-1** (high, confirmed) Blob route serves private package files (all ecosystems) anonymously by sha256; dist_access, feed access_mode, yank and release removal ignored. Paid/licensed package contents disclosed; yank does not close it; 1-year public cache keeps bytes.
- **SEC-DST-3** (medium, confirmed) Revoking a publish token does not cancel its open native-upload sessions; sweep/settle still publishes. Attacker version published after revoke and number burned.
- **SEC-DST-4** (medium, confirmed) Any live pkeyci\_ token of the owner reads every non-public package feed and mints OCI pull tokens; revocation lags up to 30 s. Low-privilege CI token escalates to read paid packages (design Q4).
- **SEC-DST-5** (medium, confirmed) Unauthenticated fabricated device events can trigger auto-halt of a victim's self-hosted rollout. Rollout halted via system actor; dilution masks real bad release.

Lower: 2 F-Droid relay publicKeyIsPublic treats package-file 'artifact' refs... [c]; 6 ASC webhook per-product rate limiter spent before HMAC check [c]; 7 OCI upload continuation does not bind to creator sub [c]; 8 safeFetch guardUrl bypassed by multiple trailing dots [c]; 9 npm publish body parser: large-string placeholder aliasing [c]; 10 ciSecretCheck winget follow-up: GitHub login '..' escapes /repos/ s... [c]; 11 Registry list documents leak private package names under public fee... [r]; 12 Hash-existence oracle on blob route for licensees under entitled mode [p]; 13 Detection gaps: reads, failed auth, CI-token reads of private feeds... [c]; 14 Test fixture packageFixture never writes package bytes to R2, exclu... [c]; 15 Download ticket reusable as bearer for 120 s in query string [p]; 16 Overlapping Maven declarations shadow each other [r]; 17 GitHub Actions pinned to mutable tags in publishing/deploy workflows [p]; 18 Macaroon parser String.fromCharCode(...bytes) RangeError on large a... [p].

### Config and secrets

18 records. Live by severity: 0 critical, 0 high, 4 medium, 11 low, 2 info.

- **SEC-CFG-1** (medium, confirmed) delivery:serverOnly/edgeMint not enforced outside kind:secret (signed raw into device document). Server-only secrets leak to all devices and browser sessions.
- **SEC-CFG-2** (medium, confirmed) Delivery downgrade of a stored serverOnly secret (resync or console PUT) silently declassifies it. Sealed server-only secrets reach all devices; no approval or audit.
- **SEC-CFG-3** (medium, confirmed) Owner-line account-override secrets delivered to any key-only device on an owned licence. Holder gains owner's personal secrets.
- **SEC-CFG-6** (medium, duplicate) touchDeviceMetadata full-row upsert from a stale snapshot can revert deauthorize (config view). Revocation bypass.
- **SEC-CFG-7** (medium, confirmed) Manifest profile payload stored unvalidated: null entry crashes /config/document. Fleet-wide 500; non-wire fields signed.

Lower: 4 OIDC sign-in provisioning writes claim-derived secrets to licence's... [c]; 5 Browser session JSON strips only the secrets bucket; kind:config se... [c]; 8 Override and profile state not validated; unknown states signed int... [c]; 9 Seal/open round trip corrupts JSON-looking secret strings (e.g. '12... [c]; 10 Public /config/schema serves raw catalog incl. default/examples of ... [c]; 11 Unbounded request-header metadata persisted per document fetch; no ... [c]; 12 OIDC secretUrlTemplate: bare '.'/'..' claim escapes the path segment [c]; 13 Edge-mint per-IP budget spent before authentication [c]; 14 Anonymous GET /config/mint/<id>/auth serves auth_page_template of u... [c]; 15 ETag excludes graceUntil, so a 304 never refreshes the signed grace... [c]; 16 Mint has no per-recipe entitlement gate and no audit trail [c]; 17 Document, bundles and browser JSON ignore device-trust policy [p]; 18 No regression tests or detection for config secret delivery [c].

### Commerce hooks

16 records. Live by severity: 0 critical, 0 high, 3 medium, 6 low, 6 info.

- **SEC-COM-1** (medium, confirmed) App Store hook product-wide rate bucket can be drained by any Apple-signed JWS, 429-ing real refunds. Genuine REFUND/REVOKE refused; refunded purchase keeps entitlement; no App Store poll exists.
- **SEC-COM-3** (medium, plausible) Apple claim vs REFUND: last-writer-wins upsert can leave a refunded purchase active. Refunded purchase keeps entitlement.
- **SEC-COM-4** (medium, confirmed) Steam weekly recheck aborts on first failing row (head-of-line blocking). Later Steam refunds never revoked.

Lower: 2 Per-IP limiters on unauthenticated commerce hooks key on full IPv6 ... [c]; 5 Play voidedPurchaseNotification revokes on push body alone; OIDC to... [c]; 6 ASC webhook product-wide limiter charged before HMAC verification [d]; 7 Licence merge racing a revoke leaves dist_purchases revoked but gra... [p]; 8 Notifications ending 'unresolved' are answered 200 and deduped, nev... [c]; 9 Active purchase row downgraded to 'pending' without touching the grant [c]; 10 Play claim does not cross-check productId/purchaseToken against cli... [p]; 11 Play RTDN dedupe keyed on sender-chosen messageId [c]; 12 Hook 401 responses expose specific rejection reasons and which stor... [c]; 13 No freshness cap on Apple-signed JWS signedDate [c]; 14 Detection and observability gaps in commerce hooks and claims [c]; 15 Default commerceClaim device-trust policy is log-only; attestation ... [p]; 16 Raw Apple payloads, Play purchase tokens and Steam IDs stored in cl... [c].

### Web edge

20 records. Live by severity: 0 critical, 1 high, 2 medium, 8 low, 4 info.

- **SEC-WEB-1** (high, confirmed) Docs gate bypass: anonymous GET /manage/docs/<file> serves gated docs from ASSETS. Operator docs (KEK procedures, deploy shape) disclosed; no credentials.
- **SEC-WEB-2** (medium, confirmed) Chunked request bodies buffered in full before rejection (GitHub webhook pre-HMAC, enroll, open register). Isolate memory/CPU pressure; availability only.
- **SEC-WEB-3** (medium, confirmed) Credential rate limits keyed on full IPv6 address (routed /64 gives unlimited budgets). Guessing bounded only by key entropy; abuse limits weakened.

Lower: 4 GitHub webhook replay protection and routing rest on unsigned heade... [c]; 5 Webhook installation binding (R6-05) fails open when gh_installatio... [c]; 6 Malformed percent-encoding throws URIError (no global error boundary) [c]; 7 Admin session is stateless with no server-side revocation; docs gat... [d]; 8 Portal POST /logout accepts cross-site requests (forced sign-out) [c]; 9 RateLimitDO alarm sweep examines only first 2000 keys [p]; 10 Product JSON and error responses lack nosniff, X-Frame-Options, Ref... [c]; 11 Product existence oracle via OPTIONS and status codes [c]; 12 Product browser-session cookie lacks \_\_Host- and uses first-match p... [p]; 13 Admin cookie not in account-realm cookie set stripped on product ro... [c]; 14 safeFetch guard: single trailing-dot strip, no workers.dev deny, on... [c]; 15 Edge-mint auth page served on console origin without sandbox directive [r]; 16 Admin and portal sessions share a fallback signing key (cross-realm... [r]; 17 Release edge cache poisoning via CORS or Set-Cookie [r]; 18 Host-header trust, header injection, CR/LF and TE/CL conflicts [r]; 19 Deployment trap: BLOB_ORIGIN, PKG_ORIGIN, IMG_ORIGIN accept a bare ... [c]; 20 GitHub Actions pinned by tag, no CODEOWNERS for workflows [p].

### Infrastructure and DOs

20 records. Live by severity: 0 critical, 0 high, 2 medium, 10 low, 3 info.

- **SEC-INF-1** (medium, duplicate) Unauthenticated per-IP rate limits key on full IPv6 address, so one /64 bypasses them. Unlimited device rows, D1 write flood; credential guessing bounded by key entropy.
- **SEC-INF-2** (medium, duplicate) Sybil devices can trip update auto-halt through POST /devices/report. Healthy rollout halted.
- **SEC-INF-3** (medium, confirmed) GitHub webhook replay guard is non-atomic and keyed on an unsigned header. resyncRepo replay rewrites oidc_config/profiles/tiers.
- **SEC-INF-12** (medium, plausible) Deploy hook body not bound to claims.sha; deploy job holds id-token: write with unpinned actions. Rewrite of system product publisher; trust root.

Lower: 4 Attestation challenge consume is get-then-delete on KV, so one chal... [d]; 5 Blob GC can delete R2 bytes for an object that gains a ref between ... [p]; 6 Blob GC sweep claim token can collide between concurrent ticks [c]; 7 Overlapping scheduled ticks render the same queue rows twice [c]; 8 RateLimitDO trusts windowSec, limit and now (windowSec 0 gives perm... [c]; 9 SingleUseDO accepts unbounded ttl, value size and unknown key kinds [c]; 10 RateLimitDO and SingleUseDO alarm sweeps have no cursor [c]; 11 Unchunked IN (...) lists can exceed D1's 100 bound-parameter limit [p]; 13 Platform credential last_error contract is unenforced [c]; 14 Staging uploads rely on out-of-repo R2 lifecycle rule; upload crede... [p]; 15 No D1 recovery point recorded before remote migrations [p]; 16 Header-less requests share the literal 'unknown' rate-limit bucket [d]; 17 stmtUpdateProduct interpolates object keys as SQL column names [r]; 18 Env index signature and pk() key builder rely on convention [p]; 19 Session and device-token revocation on eventually consistent KV [p]; 20 Missing telemetry and regression tests for infra controls [c].

### CI/CD and supply chain

23 records. Live by severity: 0 critical, 0 high, 5 medium, 11 low, 4 info.

- **SEC-SUP-1** (medium, confirmed) Deploy hook trusts client-supplied .pkey manifest; trusted-publisher workflow/environment can be repointed, then Worker mints release:publish tokens. Persistent hijack of trusted publisher for platform packages.
- **SEC-SUP-2** (medium, confirmed) No Worker-side ref, sha or event binding for deploy and publish OIDC tokens. Unreviewed deploy, rollback, publish tokens from non-main refs.
- **SEC-SUP-3** (medium, confirmed) CI tokens are not ref or channel bound: any main-ref run can pin or promote stable to any older release. Silent downgrade or freeze of stable for all SDKs.
- **SEC-SUP-5** (medium, confirmed) Deploy job runs install scripts, build, test, lint on same job that holds id-token: write and CLOUDFLARE_API_TOKEN. Cloudflare token theft, deploy-audience tokens.
- **SEC-SUP-7** (medium, confirmed) No integrity or provenance binding between build jobs and the privileged publish job. Arbitrary bytes published under trusted identity.

Lower: 4 A release:publish-only token can trigger automatic prune and squat ... [c]; 6 sync-worker-secrets.yml has no ref guard; relies on unverified prod... [p]; 8 Python build toolchain unpinned (hatchling, build, pip) feeding a p... [c]; 9 First-party GitHub actions pinned by mutable tag in privileged jobs... [c]; 10 package-registry secrets (Swift signing key, static prune token) av... [p]; 11 secrets: inherit passes all repo secrets to publish-sdks build jobs [c]; 12 Webhook replay guard keyed on unsigned X-GitHub-Delivery; GUID reco... [d]; 13 Webhook installation binding skipped when gh_installation_id is NULL [d]; 14 GitHub webhook buffers and HMACs whole body before any size cap or ... [d]; 15 Registry token mint caps (500 per owner, 10 per licence) exceeded u... [c]; 16 Deploy hook and OIDC exchange do work before spending the single-us... [c]; 17 Stale GitHub JWKS served up to 24 h when refetch fails [c]; 18 sdk-version derive falls back to 0.0.1 on malformed nearest tag; st... [c]; 19 Deploy gate permits rollback to any ancestor of main; ancestry chec... [p]; 20 No CODEOWNERS or required review on .github/\*\*, actions/publish/dis... [p]; 21 Detection gaps: no audit for publisher changes via deploy hook, non... [p]; 22 Webhook secret has no rotation support; pull-token HMAC lacks domai... [p]; 23 Feed coherence and partial publish (P0-52) not verified [p].

### Client SDKs

19 records. Live by severity: 0 critical, 0 high, 3 medium, 10 low, 4 info.

- **SEC-CLI-1** (medium, confirmed) Offline licence cloning via unsigned importedBundle marker plus copied device file. Signed licence usable on second machine up to graceUntil; no revocation.
- **SEC-CLI-2** (medium, confirmed) Unsigned revocation and block hints (lastSyncUnauthorized, blocked) can be cleared offline. Revoked licence works until graceUntil (up to 1 year).
- **SEC-CLI-4** (medium, confirmed) Discovery response is unsigned; services.license.enabled:false yields not-applicable and isLicensed() true. Hosts gating on isLicensed() unlock without a licence.

Lower: 3 Node and Swift core transport follows cross-origin redirects, repla... [c]; 5 importBundle has no anti-rollback check [c]; 6 Pinned trust keys cannot be revoked by a signed manifest; unknown s... [c]; 7 Trust-manifest replay after cache wipe [p]; 8 Network-path freshness uses raw Date.now(), not the monotonic floor [c]; 9 Token, device and cache file permissions not enforced on existing f... [c]; 10 Token read follows symlinks and plaintext token file shadows keyrin... [c]; 11 Result objects carrying live tokens print in full [c]; 12 Android SecureStore wipes token and device blobs on a single transi... [c]; 13 baseUrl normalization returns raw string; product slug unvalidated ... [c]; 14 Config secrets stored base64-encoded in plain managed.json, outside... [p]; 15 Swift Core KeychainStore uses AfterFirstUnlock (restorable to anoth... [p]; 16 Godot downgrade to file store via PKEY_DESKTOP_KEYRING=0, and secre... [p]; 17 Electron IPC allowSender is optional [p]; 18 Device-id takeover: activating a known deviceId under a different l... [d]; 19 Offline verification, signature checks and trust-pin acceptance (Node) [r].

### Privacy and email

21 records. Live by severity: 0 critical, 1 high, 3 medium, 10 low, 2 info.

- **SEC-PRV-1** (high, confirmed) Account erasure is non-atomic: status flipped to deleted before unguarded store hooks; failure leaves PII intact, no tombstone, no retry. User told deleted while email, links, subjects and licence attachments remain; cannot retry.
- **SEC-PRV-2** (medium, duplicate) DELETE /api/me requires no step-up or confirmation. Irreversible erasure.
- **SEC-PRV-3** (medium, confirmed) Per-recipient email caps, lockout and suppression bypassed by address wrapping (parseEmail accepts 'Name<victim@x>'). Mail-bombing from shared sender; suppressed addresses mailed again.
- **SEC-PRV-4** (medium, duplicate) Silent email sign-in lockout of a victim via recipient-keyed strikes, re-armed on every wrong guess. Targeted denial of email sign-in.
- **SEC-PRV-5** (medium, confirmed) Licence create/assign returns inAccount and ownerSubject oracle and auto-attaches an admin-chosen licence to a victim's account. Account-existence enumeration; unsolicited licence injection.
- **SEC-PRV-6** (medium, confirmed) Buyer emails persist after erasure in audit.summary and license_relinks.holder_json; PRIVACY and THREAT-MODEL overstate. Email and name kept up to 180 days (audit) or indefinitely (relinks).

Lower: 7 Sender display-name reservation bypassed by confusable characters [c]; 8 KEY_HASH_PEPPER optional with no deploy guard; hashKey falls back t... [d]; 9 Magic-link relay: asking browser is signed in as the victim when vi... [c]; 10 Legacy flow-less magic records are accepted from any browser [c]; 11 Sign-in start timing differs between sent, suppressed and rate-limi... [p]; 12 Admin per-subject detail and export include other people's devices ... [c]; 13 Admin data/delete and licence detach lack step-up [d]; 14 Persistent invocation logs record request URLs containing single-us... [p]; 15 Documented privacy features are absent or inaccurate (self-service ... [c]; 16 Raw client IPs stored as RateLimitDO keys, undisclosed and outside ... [p]; 17 Retention gaps: account_tombstones, subject_events, registry_tokens... [p]; 18 Signed licence documents and offline bundles embed buyer name and e... [p]; 19 Account erasure races with concurrent writes [p]; 20 Detection gaps: half-finished erasure, store-hook failures, pepper ... [c]; 21 Per-IP email limits do not cap per-recipient wrapped mails (volume ... [d].

Key: [c] confirmed, [p] plausible, [r] refuted, [d] duplicate. Numbers are the suffix of the finding id.

## Systemic themes

1. **Non-atomic read-then-write.** Full-row device upsert revives revoked rows (35/200 on real D1), key activate/revoke races (23/150), KV get-then-delete used as single-use (attestation, webhook GUIDs, ASC), count-then-insert quotas, commerce grant races. Fix with compare-and-swap in D1 or SingleUseDO, and a lint.
2. **Row identity not tied to its owner.** Device ids are looked up globally, blob sha256 refs share one ref_kind, upload tickets carry no purpose, OCI uploads are not bound to the publisher, `pk()` keys rely on convention. Requests are authorized; the row being touched is not.
3. **Controls exist at one layer but not where it counts.** Step-up guards relink but not erasure, product delete or break-glass; admin sessions cannot be revoked; `revoked` key status is not terminal; client revoke/block hints are unsigned; `serverOnly` is enforced only for kind:secret; `clientNetwork` (/64) is used in 2 places and missing from about 15 buckets.
4. **CI/CD is the trust root and rests on unverified settings.** Tag-pinned actions, a deploy job that installs dependencies while holding id-token: write, no Worker-side ref or sha binding, a system-product publisher any admin can repoint, and GitHub rulesets nobody could see.
5. **Fail-open defaults and no boot-time validation.** KEY_HASH_PEPPER optional, no minimum HMAC secret length, OIDC_ISSUER_ALLOWLIST unset means allow-all, NULL installation id means allow, bare-hostname origins disable the host split, unknown key status is trusted.
6. **Almost no detection.** Nearly every area reports no audit, counter or alert for rejected or anomalous security events, so the other themes would go unseen.

## Preconditions the owner must verify

Live checks were forbidden, so these decide the final grade of several findings:

- GitHub: tag rulesets and branch policy on the `production` and `package-registry` environments; required reviewers (SEC-SUP-2, SEC-SUP-6).
- Secrets: KEY_HASH_PEPPER and PORTAL_SESSION_SECRET set in staging and prod; strength of HMAC secrets (SEC-LIC-11, SEC-CRY-17).
- Wrangler: `workers_dev = false` on every environment.
- Cloudflare Email binding: how it parses `Name<addr>` in `to` (SEC-PRV-3, SEC-IDN-15).
- Cron: whether `releaseDormantSeats` is scheduled (SEC-LIC-4).
- Whether the key-revoke UI promises a full cut-off (SEC-LIC-7).
- Whether a release record on polaris-key reaches the live pkg feeds (SEC-ADM-1).
- A fresh asset build at 8cd7e6192 reproduces the docs-gate paths (SEC-WEB-1; tested on an Oct 6 assembled tree).

## Coverage gaps

- Outbound fetch: callers of safeFetch (hostedAssetPulls, release mirror, media proxy), custom-OIDC JWKS/discovery, DNS rebinding and private-range redirects not traced.
- No systematic sweep for non-atomic read-modify-write across D1, KV and cron; more instances are likely.
- Multi-tenant isolation was not an area of its own (shared D1/KV/R2 namespaces, shared limiter scopes, platform fallbacks).
- Swift, Kotlin and Godot SDKs got grep-level review only; no cross-SDK differential run on the conformance corpus. Browser/React SDKs and the console SPA barely covered.
- Not covered: passkey/WebAuthn checks, account merge ordering, offline bundle issuance authz, R2 upload-credential scope, migrations, backup/restore, Go/Cargo/Maven parsers.
- Denial-of-service and cost were found piecemeal; no amplification model.

## Remediation plan

Package ids are suggestions. Each package fixes every finding that names it in `findings.json`; a package sits in the wave of its most severe finding.

### Wave 1: high

| Package   | Work                                          | Findings                                      |
| --------- | --------------------------------------------- | --------------------------------------------- |
| SEC-WP-01 | Device-id ownership scoping and validation    | 6: LIC-1, LIC-2, LIC-9, LIC-10, IDN-5, CLI-18 |
| SEC-WP-02 | Blob route ref_kind separation and cache plan | 4: DST-1, DST-2, DST-12, DST-14               |
| SEC-WP-03 | Docs gate allowlist                           | 1: WEB-1                                      |
| SEC-WP-04 | Resumable account erasure                     | 2: PRV-1, PRV-19                              |
| SEC-WP-05 | System product CI/publisher guard             | 1: ADM-1                                      |

### Wave 2: medium

| Package   | Work                                                      | Findings                                              |
| --------- | --------------------------------------------------------- | ----------------------------------------------------- |
| SEC-WP-06 | Atomic read-modify-write sweep (CAS, SingleUseDO)         | 12: LIC-3, LIC-4, CRY-10, ADM-14, IDN-19, CFG-6, ...  |
| SEC-WP-07 | Signing-key state machine: revoked is terminal            | 3: CRY-1, CRY-2, ADM-2                                |
| SEC-WP-08 | clientNetwork (/64) on every unauthenticated bucket       | 8: LIC-5, LIC-13, ADM-10, CFG-13, COM-2, WEB-3, ...   |
| SEC-WP-09 | Admin and portal session revocation and step-up table     | 9: CRY-20, CRY-21, ADM-3, ADM-4, ADM-5, IDN-10, ...   |
| SEC-WP-10 | Identity flow binders, returnTo, CSRF checks              | 13: ADM-6, ADM-15, IDN-1, IDN-2, IDN-3, IDN-4, ...    |
| SEC-WP-11 | Config secret delivery rules                              | 10: CFG-1, CFG-2, CFG-3, CFG-4, CFG-5, CFG-7, ...     |
| SEC-WP-12 | CI/CD trust root hardening                                | 30: CRY-28, ADM-17, ADM-18, DST-3, DST-4, DST-7, ...  |
| SEC-WP-13 | Commerce hook hardening and App Store re-check            | 16: CRY-7, CRY-8, DST-5, DST-6, COM-1, COM-3, ...     |
| SEC-WP-14 | Shared capped body reader, limit clamps, DO sweep cursors | 7: ADM-7, CFG-11, WEB-2, WEB-9, INF-10, INF-11, ...   |
| SEC-WP-15 | Email recipient handling and lockout keys                 | 9: CRY-16, IDN-8, IDN-15, PRV-3, PRV-4, PRV-7, ...    |
| SEC-WP-16 | Client SDK local-trust and transport fixes                | 19: LIC-16, LIC-17, CRY-25, CRY-26, CLI-1, CLI-2, ... |
| SEC-WP-17 | Trust-manifest rotation and canonical base64url           | 8: CRY-3, CRY-4, CRY-5, CRY-6, CRY-14, CRY-15, ...    |
| SEC-WP-18 | Fingerprint baseline and minimums                         | 2: CRY-12, CRY-13                                     |
| SEC-WP-19 | Privacy residue, retention and docs accuracy              | 9: COM-16, PRV-5, PRV-6, PRV-12, PRV-14, PRV-15, ...  |

### Wave 3: low

| Package   | Work                                            | Findings                                                |
| --------- | ----------------------------------------------- | ------------------------------------------------------- |
| SEC-WP-20 | Security event audit and counters               | 12: LIC-12, CRY-27, ADM-11, ADM-12, IDN-11, IDN-23, ... |
| SEC-WP-21 | Required-secret and config validation at deploy | 7: LIC-11, CRY-17, CRY-18, IDN-20, WEB-19, SUP-22, ...  |
| SEC-WP-22 | Low-risk hardening batch                        | 44: LIC-6, LIC-7, LIC-8, LIC-14, LIC-15, LIC-18, ...    |
| SEC-WP-23 | Outbound fetch and issuer URL guards            | 4: IDN-6, IDN-7, DST-8, WEB-14                          |

Order inside wave 1: SEC-WP-03 (smallest fix), 01 (device ownership), 02 (blob route; purge the CDN cache too), 05 (system CI guard), 04 (erasure). Before closing wave 2, add the lints that stop recurrence: no bare `req.text()/json()`, no `clientIp` in rate-limit callers, no full-row device upsert from request paths.
