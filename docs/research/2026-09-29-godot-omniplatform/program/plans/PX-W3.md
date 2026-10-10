# PX-W3 plan: licensed R2 downloads from the portal (gap G3) through a download ticket

## Owner decisions (2026-10-05)

**Approved; every recommendation in "Open questions for the owner" accepted as written.** The
owner approved nine plans together (U-01, PX-W3, LX-01, I-24, I-09, PX-W8, PX-W9, PX-W13 and
PX-W17). These cross-plan overrides win over any text below that says otherwise:

- **Refusal link name.** `manageUrl` on **both** `device_limit` and `key_entry_limit`. PX-W8 Q1
  wins over PX-W9 Q3's `portalUrl`. `license_owned` keeps `signInUrl`. Portal paths are root
  paths, per PX-W8's corrections: `/activate?product=<slug>` and `/signin?product=<slug>`, never
  `/portal/activate` or `/portal/signin`. PX-W9, I-09, `plans/I-04.md` and their briefs are
  corrected to match.
- **Reserved display names** (PX-W13 Q4). Warn first, following LX-05 and S-19 (§7.4, decision
  15), then enforce in PX-W13. The rule is not a hard error from day one.
- **I-24** is split into **I-24a** and **I-24b** in `workpackages.json`, with the dependencies I-08
  and I-09 added. **I-09** gains the **ST-04** dependency (I-09 Q3).
- **Brief changes.** Every "Brief changes" list in the nine plans is applied to the named briefs,
  each under a section "Amendments from approved plans (2026-10-05)".
- **Superseded drafts.** The branches `wp/U-01-cloud-sync-plan` and
  `wp/PX-W3-licensed-downloads-plan` are superseded by `plans/U-01.md` and `plans/PX-W3.md` and
  must not be merged.

**Effect on this plan.** None of the overrides changes the text below. Q4 is answered (a), so
the PX-09 app-only copy change does not apply. The superseded draft is `72676b8e` on
`wp/PX-W3-licensed-downloads-plan`. Provisioning the `DOWNLOAD_TICKET_KEY` pair per environment is
the remaining human input (Q3).

> **Approved by the owner (2026-10-05)**; see "Owner decisions (2026-10-05)" above. As first written: It
> supersedes the draft on branch `wp/PX-W3-licensed-downloads-plan` (`72676b8e`), which must not
> be merged. That draft's mechanism is kept here, with S-19's rename to "download ticket", the
> resolver hand-off, a rotation-safe key id and the S-16/S-18 constraints added. §0 quotes the
> owner decisions this plan takes as given. "Open questions for the owner" lists the choices the
> research left open, each with a recommendation.

| Field       | Value                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief       | [`wp/PX-W3-licensed-r2-downloads.md`](../wp/PX-W3-licensed-r2-downloads.md); design [PORTAL.md §10.2 G3](../../../../design/PORTAL.md#102-gaps-the-worker-must-close); research [S-19](../../notes/S-19-licensing-model.md) §7.1, §7.3, §8, decisions 4, 5, 18 and 23; [S-18](../../notes/S-18-settings-architecture.md) §5.6 |
| Implementer | **PX-W3** (`pkey-implementer`) executes all of it. **PX-09** consumes it. **LX-09** later swaps the body of the eligibility check that this plan calls (§6.3)                                                                                                                                                                 |
| Wire change | **None.** `PROTOCOL_VERSION` stays **4** and `corpusVersion` stays **2**. No `typ`, claim, signed shape, discovery member or error code changes. The only HTTP change is one optional query parameter on an existing bytes-host route. Devices never send it                                                                  |
| Corpus      | **None.** No transcript changes either (§4)                                                                                                                                                                                                                                                                                   |
| Line refs   | `main` at `248fef64`. Re-locate by quoted text after a rebase                                                                                                                                                                                                                                                                 |

## 0. Owner decisions encoded (binding, 2026-10-04)

- **S-19 decision 18.** This feature is a **download ticket**:
  - the query parameter is `?ticket=`;
  - the MAC label is `pkey-download-ticket/1`;
  - the token shape is `v1.<kid>.<exp>.<mac>`.

  The word "grant" is reserved for S-19's entitlement grants (§7.1). It appears nowhere in this
  feature's code, docs or THREAT-MODEL rows.

- **S-19 decisions 1, 4, 5 and 23.**
  - A licence is an access contract. Grants are the reasons someone holds an entitlement.
  - The holder is the account signed in on the device (`entitlementHolder: device`). In the
    portal, that account is the session's account.
  - Existing products stay on `entitlementModel: legacy`, which must be byte-identical to today.
  - The `licensed` and `entitled` access modes still require a usable anchor licence.

  The ticket's re-run checks call `resolveDeviceEntitlements` once LX-09 lands (S-19 §8, PX-W3
  row).

- **S-16 / I-04.**
  - The account is platform-level. The per-product `identity` toggle does not gate the portal, so
    licensed downloads work on products with Identity off.
  - The global account id never leaves Identity and Core code (I-04 §6.2). A ticket carries no
    account id and no subject.
- **S-18 §5.6.** No new setting. The ticket lifetime is a security bound and stays a code
  constant. `releases_enabled` becomes the registry key `portal.releases.enabled`, with identical
  behaviour, when ST-04 lands.
- **S-17.** Nothing changes. Cloud Sync save exports do not reuse this label (§2).

## 1. Summary

- **Today.** `GET /download/<token>` on `key.plrs.im` 302s only to a GitHub storage URL, or, for a
  `public` deliverable, to the bytes host (`downloadTarget`, `portal/api.ts`). Non-public app
  files held only on R2 come back as `reason: "not_hosted"` (PX-W2), so the portal shows "Not
  available here yet".
- **Change.** `handlePortalDownload` re-runs every check it already runs. It then 302s to the
  canonical file URL on the bytes host with a ticket appended:
  `https://dl.plrs.im/<p>/distribution/files/<releaseId>/<name>?ticket=<t>`.
  - The ticket is an HMAC capability for one product, release, file name and SHA-256.
  - It lives **120 s** and may be reused inside that window, so `Range`, resume and `HEAD` work.
- **Where the bytes are served.**
  - The `files` byte route accepts a valid ticket in place of a device bearer, **on the bytes host
    only**.
  - The bytes keep P2-01's isolation: sandbox CSP, `nosniff`, no cookies and forced `attachment`.
  - `hasRef` tenancy and the `gated/` refusal still apply.
- **Stateless.**
  - No migration, table or new route.
  - Two Worker secrets.
  - With the secrets unset, behaviour is exactly today's, which also makes deleting them the kill
    switch.
- **Rejected alternatives.**
  - **Streaming through `/download/<token>` on `key.plrs.im`.**
    - It would serve customer bytes from the origin that holds the portal SPA and its `__Host-`
      cookies (THREAT-MODEL §3, P2-01).
    - A single-use token cannot carry `Range`.
    - Identity would need a byte-returning hook into Distribution.
  - **R2 S3 presigned URLs.** They need S3 keys, expose the bucket host, and bypass `hasRef`,
    `gated/` and the host headers.

## 2. Contract

`WIRE-CONTRACT-V4.md`, `shared-protocol`, `shared-jws` and `client-core` do not change. The
contract does not describe browser downloads (§5 covers device transport only), and no SDK mints,
sends or parses a ticket.

**Ticket format** (minted and verified by the Worker only, versioned by its `v1` prefix):

- **Shape.** `v1.<kid>.<exp>.<mac>`.
- **`kid`.** The first 6 bytes of SHA-256 over the key bytes, base64url (8 chars). It fingerprints
  the key itself. The draft used the labels `a` and `b` for "current" and "previous", but a
  ticket minted just before a rotation would then carry the wrong label. A fingerprint keeps
  verifying correctly across a rotation.
- **`exp`.** Unix seconds.
- **`mac`.** base64url HMAC-SHA256 over
  `pkey-download-ticket/1\n<bytes host>\n<product>\n<releaseId>\n<name>\n<sha256>\n<exp>`, where
  `<name>` is the decoded path segment.
- **Verification** uses `crypto.subtle.verify`. It refuses:
  - an unknown `kid`;
  - `exp ≤ now`;
  - `exp > now + 120`.
- **Failure handling.** An invalid ticket is **treated as absent**: the request gets today's answer
  for a caller with no credential. That is `401 download_auth_required` (flat) for
  `authenticated` and `licensed`, and `401 unauthorized` (wire) for `entitled`. No
  ticket-specific error code exists, so a probe cannot tell a bad ticket from a missing one.
- **Label namespace.** `pkey-download-ticket/1` covers release files only. Any other short-lived
  link (for example S-17's save-export links) takes its own label and never reuses this one.
- **Naming clash.** CI upload paths already say `staging/<product>/<ticketId>/` (P2-02). The
  glossary entry (§6.4) tells the two kinds of ticket apart.

## 3. Catalog and manifests

None. No `shared-catalog` or `shared-manifest` change, no validator rule and no schema change, so
rule 9 is not engaged. No `.pkey/` field exists, because availability depends on the deployment's
secret, not on the product (rule 5).

## 4. Corpus

None.

- `pnpm gen corpus --check` stays green, with no generator, constant or mirror change.
- `pnpm gen transcripts --check` stays green. The portal routes and `/download/<token>` are
  narrative-only and are not recorded, and the `files` route's answers without a ticket do not
  change. No Swift or Godot mirror moves.

## 5. SDKs and UI kits, in order

None follow, and none get a parity row or a typed N/A. A ticket exists only between the Worker
and a browser on the portal.

| SDK / kit                                                 | Follows? | Why                                                                                                                                               |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| client-core, Node (`packages/sdk-node`)                   | no       | Devices fetch bytes with their `pkeyt_` bearer, and that path is unchanged                                                                        |
| React (`packages/sdk-react`) and its activation component | no       | It does not render the portal. The portal SPA (PX-09) only sees `canDownload: true` where it used to see `not_hosted`, in PX-W2's unchanged shape |
| Python (`sdks/python`)                                    | no       | Same as Node                                                                                                                                      |
| Swift (`sdks/swift`) with `PolarisKeyUI`                  | no       | Same. In-app "Download update" opens `#/p/:product/download`, the portal flow, so it inherits the change with no SDK code                         |
| Kotlin (`sdks/kotlin`) with the activation component      | no       | Same                                                                                                                                              |
| Godot (`sdks/godot`) with `addons/polaris_key/ui`         | no       | Same                                                                                                                                              |

`gen constants --check` and `parity:check` stay green with no change.

## 6. Worker

### 6.1 Core module `src/core/downloadTicket.ts`

- **Constants.** `DOWNLOAD_TICKET_LABEL = "pkey-download-ticket/1"` and
  `DOWNLOAD_TICKET_TTL_SECONDS = 120`. Both stay in code (S-18 §5.6).
- **`mintDownloadTicket(env, {product, releaseId, name, sha256}, now)`** returns `string | null`.
  It returns `null` when `DOWNLOAD_TICKET_KEY` or `BLOB_ORIGIN` is unset.
- **`verifyDownloadTicket(env, ticket, {host, product, releaseId, name, sha256}, now)`** returns
  `boolean`, trying the current key and then the previous one.
- **Imports.** Identity and Distribution both import this module. Core-only imports keep rule 6
  clean, and `boundaries.test.ts` checks it.

**Env.** Two secrets, each 32 random bytes in base64:

- `DOWNLOAD_TICKET_KEY`;
- `DOWNLOAD_TICKET_KEY_PREVIOUS`, for rotation (the `REGISTRY_TOKEN_KEY` pattern).

Declare both in `env.ts`. Add them to `SECRET_NAMES` in `admin/handlers/platformSettings.ts` and
to the required-secrets comment in `wrangler.toml`. If ST-02 has already landed, annotate them
`@inventory secret` instead, so its generator lists them. Document provisioning and rotation in
`docs/DEPLOYMENT.md` and `docs/RUNBOOK.md`: move the current key to `_PREVIOUS`, put a new key,
and delete `_PREVIOUS` after 120 s.

### 6.2 Identity (`services/identity/portal/api.ts`, `downloads.ts`)

**`downloadTarget`** returns one of three answers:

1. **`{kind: "redirect", url}`**: today's GitHub branch, or the public bytes-host branch.
   Unchanged and still tried first.
2. **`{kind: "ticket", base}`**: used when all of these hold:
   - the mode is non-public;
   - there is no redirectable source;
   - `delivery.deliveryUrl` is `https` on `BLOB_ORIGIN` (`isAllowedDownloadRedirectHost`);
   - `artifact.sha256` is set;
   - `DOWNLOAD_TICKET_KEY` is set;
   - the trust question is answered as Q4 says.
3. **`null`**: anything else.

**Who uses the answer.**

- The listing and the token mint test only whether the answer is non-null, so they keep offering
  exactly what redemption serves.
- **Only `handlePortalDownload` mints a ticket**, and only after every existing check:
  1. portal and releases enabled;
  2. account active;
  3. owned licence (`hasLinkedProductLicense`);
  4. `accountMayDownload`;
  5. the single-use `markPortalDownloadUsed`.
- The 302 keeps `cache-control: no-store` and `referrer-policy: no-referrer`.
- The portal token keeps its 300 s TTL and single use.

**Wording.** Two comments use "grant" for a licence's channel and version window
(`downloads.ts` "no licence's grant holds", and the mint's comment in `api.ts`). Both say
"entitlement window" after this change.

### 6.3 The holder and the resolver hand-off (S-19)

- **Who is checked.** The download is judged for the portal session's account (`H`) over the
  licences it owns (`licenses.account_id`, since I-05). That is S-19's portal composition: a
  synthetic device that is signed in and has no anchor, with each owned licence as a candidate
  anchor (§7.3.5). Decision 23 holds: `licensed` needs a usable licence, and `entitled` needs one
  whose window holds the release.
- **Today.** PX-W3 calls `accountMayDownload` exactly as the mint and redemption do now, and adds
  no second eligibility function.
- **After LX-09.** LX-09 replaces the body of `accountMayDownload` with a call to
  `resolveDeviceEntitlements`; it is already in LX-09's caller list. Under `legacy` mode the
  answers must not change.
- **Regression for LX-09.** PX-W3's test matrix (§9) pins today's answers, so it serves as LX-09's
  regression for this caller. What `combined` mode decides for `entitled` windows is LX-09's
  business, not this plan's.

### 6.4 Distribution, routes, docs and THREAT-MODEL

**Distribution (`services/distribution/bytes.ts`, `file` target only).** After `resolveFile` and
the app-deliverable check, add the ticket check. It applies when all of these hold:

- the request is on the bytes host (`isBytesHost`);
- it carries `ticket`;
- `verifyDownloadTicket` passes for (host, product, releaseId, name, `file.artifact.sha256`).

Then the route sets `decided = null`, so `accessRefusal` is skipped. The mode stays non-public,
so the answer gets `PRIVATE_BYTES_CACHE` and `blobResponse(…, gated: true)`.

These do not change:

- the rate limit runs first;
- `gated/` keys are never served;
- `hasRef` is required;
- the `build`, `blob`, `dl` and `payload` targets ignore `ticket`;
- the console host ignores `ticket`.

**Rule 10.** No new route, so `routeCoverage` stays as it is. Changes:

- Add the optional `ticket` query parameter and its "invalid means absent" note to the OpenAPI
  operation `downloadReleaseFile` (`/{product}/distribution/files/{releaseId}/{name}`) and to its
  alias `/{product}/release/files/{releaseId}/{name}` in `openapi/polaris-key.v3.yaml`.
- `/download/<token>` is narrative-only (PORTAL.md §10.1). Document the new target on
  `packages/docs/src/content/docs/services/identity/portal.md`.
- Regenerate the reference pages (`pnpm --filter @polaris-key/docs gen`).

**Glossary (rule 4).** Add a **download ticket** entry to `start/concepts.md`: a 120 s,
single-file capability that the portal hands a browser. It is not a grant, and it is not a CI
upload ticket.

**Migrations and `TABLE_OWNERS`.** None.

**THREAT-MODEL.** Add a section, "Licensed portal downloads (PX-W3)", with one row each for:

- **Token leakage:** 300 s and single use, unchanged.
- **Ticket leakage:** 120 s, one file, never logged (R12).
- **Replay window:** reuse within 120 s, then refused. A transfer already in progress may finish.
- **Hotlinking:** bounded by `exp`, `no-referrer` and the `releaseArtifact` per-IP limit.
- **Revocation between mint and download:**
  - re-checked at token redemption;
  - the residual is at most 120 s after redemption (Q5).
- **Key compromise:** the 120 s cap and rotation through `_PREVIOUS`.
- **Origin isolation:** tickets work on the bytes host only.
- **Attested-trust products:** handled as Q4 decides.

## 7. Rollout

1. **Merge and deploy the Worker.** With no key set, every file answers as it does today.
2. **Owner sets the key per environment.** `wrangler secret put DOWNLOAD_TICKET_KEY --env dev`,
   then staging, then prod. Licensed R2 files become downloadable at once, with no redeploy.
3. **PX-09 drops the fallback copy** for R2-hosted builds.

**Kill switch.** Delete the key. Live tickets die at once, and files go back to `not_hosted`.

**Already deployed:**

- **Devices and SDKs:** unaffected. Nothing they send or receive changes.
- **A portal SPA build that is already loaded:** it sees `canDownload: true` and follows the same
  `/download/<token>` link.
- **Old Workers during a rolling deploy:** they never mint tickets, and they ignore one, which gives
  today's 401. The user clicks again.
- **LX-09 landing later:** it changes the eligibility body only. Live tickets are unaffected.

## 8. Open questions for the owner

1. **Q1 Mechanism.** Ticketed bytes-host URL or streaming through `/download/<token>`.
   **Recommend the ticket**, for origin isolation and `Range`/resume (§1).
2. **Q2 Lifetime and reuse.** 120 s multi-use, 60 s, or single use. Single use needs a D1 row and
   breaks `Range`. **Recommend 120 s, multi-use, bound to one file.**
3. **Q3 Key material.** A dedicated `DOWNLOAD_TICKET_KEY` pair, or HKDF from `PLATFORM_KEK`. HKDF
   needs no new secret, but it puts KEK-derived material on the bytes host, which P2-05 keeps
   KEK-free. **Recommend the dedicated pair.** Provisioning it per environment is an owner action.
4. **Q4 Products whose trust policy sets `gatedDelivery: attested` with `enforce: true`.** A
   browser cannot attest. The code already states "the portal download's rule": device trust does
   not apply to portal downloads (`entitledAccess.ts`, the licence-only check). GitHub-hosted
   licensed files are served that way today. Options:
   - **(a)** follow that rule for R2 files too;
   - **(b)** keep those products app-only: `not_hosted`, with PX-09's copy "Download it from
     inside the app".

   **Recommend (a)**, for one consistent portal rule, with a THREAT-MODEL row. Choose (b) if you
   read the policy as covering browsers; then the GitHub branch should get the same rule in a
   follow-up.

5. **Q5 Revocation residual.** A licence revoked within 120 s after redemption can still fetch
   that one file. **Recommend accepting and documenting it.** A re-check on the bytes route would
   need an account reference in the ticket and a new Core hook. Revisit once LX-09's
   `holder_versions` cache makes it cheap.
6. **Q6 Bind the ticket to the client IP?** **Recommend no.** It breaks under dual-stack, CGNAT
   and iCloud Private Relay, and the window is short.
7. **Q7 Licensed files from private GitHub repositories.** Their redirect fails for a customer.
   **Recommend leaving them out of PX-W3** and filing a follow-up that could reuse the ticket,
   because covering them reorders `downloadTarget`.

**Risks.** The secret is a new deploy dependency. Its absence fails closed: files stay
`not_hosted`.

**Briefs this plan changes** (the lead, after approval):

- **PX-W3:** no migration; key provisioning is a human input; an OpenAPI parameter instead of a
  route; the glossary entry.
- **PX-09:** the app-only copy, if Q4 is (b).
- **LX-09:** the PX-W3 test matrix is the `legacy` regression for the portal download caller.
- **ST-02:** inventory the `DOWNLOAD_TICKET_KEY` pair.
- **LX-22:** the THREAT-MODEL vocabulary uses "download ticket".

## 9. Acceptance

New tests in `test/portalLicensedDownloads.test.ts`:

- **Listing.** A licensed R2 file is `canDownload`, and an `authenticated` one is too.
- **Mint and redeem.** Redeeming gives a 302 to `BLOB_ORIGIN` with `?ticket=`.
- **Bytes host.** A GET gives 200. `Range` gives 206. `HEAD` works.
- **Expiry.** A ticket with `exp = now + 121` is refused, and so is an **expired ticket**.
- **Binding.**
  - A ticket checked against another name, release, product or SHA-256 gives 401.
  - A tampered ticket gives 401.
  - An unknown `kid` gives 401.
  - The previous key's ticket verifies.
- **Console host.** A ticket presented to the console host gives 401.
- **Revocation.** A **licence revoked, suspended or detached before redemption** gives 404.
- **Entitled mode.** `entitled` outside the window is refused at mint.
- **Fail closed.** An unset key or an unset `BLOB_ORIGIN` gives `not_hosted`.
- **`gated/`.** A `gated/` location is never served.
- **Identity off.** A product with Identity off downloads normally.
- **Trust.** The attested-enforced case behaves per Q4.

Existing and runtime coverage:

- `test/portalDownloads.test.ts` keeps "every file it offers is one the token mint answers"
  green.
- A workerd case runs mint and verify under `test:workerd`.

```sh
N="mise exec node@22 --"
$N pnpm --filter @polaris-key/worker test -- portalLicensedDownloads portalDownloads bytesHost routeCoverage boundaries
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm gen corpus --check && $N pnpm gen transcripts --check   # unchanged
$N pnpm gen constants --check && $N pnpm parity:check              # unchanged
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

Then run the full green gate (`AGENTS.md`, and PORTAL.md §11).
