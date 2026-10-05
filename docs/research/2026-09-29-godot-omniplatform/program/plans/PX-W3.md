# PX-W3 plan: licensed R2 downloads from the portal (gap G3)

| Field      | Value                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief      | [`wp/PX-W3-licensed-r2-downloads.md`](../wp/PX-W3-licensed-r2-downloads.md)                                                                                                                                                                                                                               |
| Status     | awaiting approval. Merging this plan is the approval, and nothing is implemented before it                                                                                                                                                                                                                |
| Implements | PX-W3 itself (the implementer executes this plan) and unblocks [PX-09](../wp/PX-09-get-it-complete.md)                                                                                                                                                                                                    |
| Basis      | [`docs/design/PORTAL.md`](../../../../design/PORTAL.md) §10.2 G3 (approved 2026-10-04) and the code on `main` at `5ad5c764`: `services/identity/portal/{api,downloads,repo}.ts`, `services/distribution/bytes.ts`, `core/{bytesHost,blobs,entitledAccess,deviceTrust}.ts`, and THREAT-MODEL §3 and P2b-04 |
| Versions   | `PROTOCOL_VERSION` 4, `corpusVersion` 2, the error registry and every generated SDK constant stay unchanged. **No device-wire change** (§2)                                                                                                                                                               |

## 1. Summary

- **Today.** `/download/<token>` on `key.plrs.im` only 302s to a GitHub storage URL, or, for a
  `public` deliverable, to the bytes host. A `licensed` or `entitled` file held only on R2 gets no
  target (`downloadTarget` → `null`). PX-W2 marks it `reason: "not_hosted"`, and the portal shows
  "Not available here yet".
- **Recommended: a signed short-lived bytes URL, served on the bytes host.** Redeeming the token
  re-runs every check it runs now, then 302s to the canonical immutable file URL with a grant
  appended: `https://dl.plrs.im/<p>/distribution/files/<releaseId>/<name>?grant=<g>`. The grant
  is an HMAC capability for that one product, release, file and SHA-256, and it lasts 120 s. The
  `files` route accepts a valid grant in place of a device bearer, **on the bytes host only**.
- **The bytes never touch the console origin.** They keep P2-01's isolation: sandbox CSP,
  `nosniff`, no cookies, forced `attachment`. They keep `hasRef` tenancy and the `gated/` refusal,
  and they keep `Range` and resume (`blobResponse`).
- **Stateless.** There is no migration, no new table and no new route. One optional query
  parameter goes on an existing route, and one new Worker secret is added.
- **Fails closed.** If the secret or `BLOB_ORIGIN` is unset, or the product requires attested
  devices for gated delivery (Q4), the file stays `not_hosted`, exactly as it is today.

**Alternative considered, not recommended: stream through `/download/<token>` on `key.plrs.im`.**
(1) It serves arbitrary customer bytes from the origin that holds the portal SPA and its
`__Host-` session cookies. A single sniffing or `inline` mistake then becomes stored XSS on the
console. Avoiding exactly that is why the bytes host exists (THREAT-MODEL §3, the owner decision
in P2-01).
(2) A single-use token cannot carry `Range`, so a 2 GB build that drops cannot resume.
(3) Identity would need a new byte-returning hook into Distribution's `serveArtifact`.
Worker CPU and egress cost the same either way.
**Also rejected: R2's native S3 presigned URLs.** They need S3 access keys as secrets, expose the
bucket host, and bypass `hasRef`, the `gated/` rule and the bytes host's headers.

## 2. Contract

There are no changes to `WIRE-CONTRACT-V4.md`, `shared-protocol`, `shared-jws` or `client-core`.
No signed document, discovery field or error code changes. The grant is opaque, minted and
verified only by the Worker, and never sent by an SDK. An invalid, expired or misbound grant is
**treated as absent**. The request then gets today's answer for a caller with no credential:
`401 download_auth_required` (flat) for `licensed`, or `401 unauthorized` (wire) for `entitled`.
No grant-specific code exists, so a probe cannot tell "bad grant" from "no grant".

**Grant format (Worker-internal, versioned):** `v1.<kid>.<exp>.<mac>`.

- `kid` is `a` (current) or `b` (previous).
- `exp` is Unix seconds.
- `mac` is base64url HMAC-SHA256 over
  `pkey-download-grant/1\n<bytes host>\n<product>\n<releaseId>\n<name>\n<sha256>\n<exp>`.

Verification uses `crypto.subtle.verify`, which is constant-time. An `exp` more than 120 s ahead
of now is refused, so a stolen key cannot mint long grants without the deployment noticing.

## 3. Catalog and manifests

None. No `shared-catalog` or `shared-manifest` change, no validator rule and no schema change
(rule 9 not engaged).

## 4. Corpus

None. `pnpm gen:corpus -- --check` stays green with no regeneration. No mirror changes.

`gen:transcripts -- --check` must also stay green. The portal and `/download/<token>` are
narrative-only and are not recorded, and the `files` route's answers without a grant are
unchanged.

## 5. SDKs, in order

None follow. No SDK (client-core, Node, React, Python, Swift, Godot, Kotlin) sends or parses a
grant, there is no parity-registry entry, and there are no typed N/As.

The only consumer is the portal SPA, through PX-W2's unchanged response shape: a file now
returns `canDownload: true` where it returned `not_hosted`. PX-09 drops the fallback copy.

## 6. Worker

**New Core module `src/core/downloadGrant.ts`:**

- `mintDownloadGrant(env, {product, releaseId, name, sha256}, now)` returns `string | null`.
  It returns `null` when `DOWNLOAD_GRANT_SECRET` or `BLOB_ORIGIN` is unset.
- `verifyDownloadGrant(env, grant, {host, product, releaseId, name, sha256}, now)` returns
  `boolean`.

Both Identity and Distribution import it, which is rule 6–clean: Core only, no cross-service
edge.

**Env:** `DOWNLOAD_GRANT_SECRET?` (base64 of 32 bytes) and `DOWNLOAD_GRANT_SECRET_PREVIOUS?` for
rotation. Document both in `env.ts`, the `wrangler.toml` comments, and `docs/DEPLOYMENT.md` and
`docs/RUNBOOK.md` (provisioning, and rotation by moving the current secret to previous, then
setting a new one).

**Identity (`portal/api.ts`):** `downloadTarget` returns a discriminated answer:

- `{kind: "redirect", url}`: today's GitHub or public-bytes-host branch, unchanged and still
  first.
- `{kind: "grant", base}`: a non-`public` mode, no redirectable source, `delivery.deliveryUrl`
  is `https` on `BLOB_ORIGIN` (`isAllowedDownloadRedirectHost`), `artifact.sha256` is set, the
  grant secret is configured, and the product's trust policy does not require `attested` for
  `gatedDelivery` with `enforce: true` (Q4).
- `null`: anything else.

The listing (`downloads.ts`) and the mint only test whether the answer is `null`. **Only
`handlePortalDownload` mints the grant**, after every existing re-check: account active, linked
licence, `accountMayDownload`, and the single-use `markPortalDownloadUsed`. The 302 keeps
`cache-control: no-store` and `referrer-policy: no-referrer`. The token keeps its 300 s TTL and
single use.

**Distribution (`bytes.ts`, the `file` target only):** add the grant check after `resolveFile`
and the app-deliverable check. When the request is on the bytes host (`isBytesHost`), carries
`grant`, and `verifyDownloadGrant` passes for (host, product, releaseId, name,
`file.artifact.sha256`), then `decided = null` and `accessRefusal` is skipped. The mode stays
non-public, so the answer is `PRIVATE_BYTES_CACHE` and `blobResponse` runs with
`gated: !publicMode`. Unchanged:

- The rate limit runs first.
- `gated/` keys are never served.
- `hasRef` is required.
- `builds`, `blobs`, `dl` and `payload` ignore `grant`.
- The console host ignores `grant`.

**Rule 10:** no new route. Add the optional `grant` query parameter, and its `401` semantics, to
`downloadReleaseFile` and its alias `/{product}/release/files/{releaseId}/{name}` in
`openapi/polaris-key.v3.yaml`. `routeCoverage` is unchanged and must stay green. Update
`packages/docs/src/content/docs/services/identity/portal.md` (`/download/<token>` now also
targets licensed R2 files) and regenerate the reference pages
(`pnpm --filter @polaris-key/docs gen`, then `gen:check`).

**Migrations / `TABLE_OWNERS`:** none.

**THREAT-MODEL:** add a section, "Licensed portal downloads (PX-W3)", with these rows:

- token leakage (300 s, single-use, unchanged);
- grant leakage (120 s, one file, multi-use inside the window for `Range` and `HEAD`, never
  logged; R12);
- hotlinking (bounded by `exp`, `no-referrer`, a per-IP rate lane);
- replay after expiry (refused; a transfer that already started may finish);
- revocation (re-checked at redemption; residual window ≤ 120 s after redemption, Q5);
- key compromise (rotation through `_PREVIOUS`; the 120 s cap);
- origin isolation (bytes host only);
- attested-trust products (app-only, Q4).

## 7. Rollout

1. Merge and deploy the Worker. With no secret set, behaviour is identical to today.
2. The owner sets `DOWNLOAD_GRANT_SECRET` on dev, then staging, then prod
   (`wrangler secret put`). Licensed R2 files become downloadable at once, with no redeploy.
3. PX-09 removes the fallback copy.

**Kill switch:** delete the secret. Outstanding grants die immediately, and files revert to
`not_hosted`.

**Deployed clients:** SDKs and devices are unaffected (no wire change). A portal SPA build that
is already loaded simply sees `canDownload: true`. **Older Workers** never mint grants. A grant
reaching one during a rolling deploy is ignored, which gives today's 401, and the user clicks
again.

## 8. Risks and open questions (owner decisions)

- **Q1 Mechanism.** Signed bytes-host URL (§1) or streaming through `/download/<token>`.
  **Recommend the signed URL**, for origin isolation and `Range`/resume.
- **Q2 Grant lifetime and reuse.** Options: 120 s and multi-use within the window; 60 s; or
  single-use (which needs a D1 row and breaks `Range`). **Recommend 120 s, multi-use, bound to one
  file.**
- **Q3 Key material.** A dedicated `DOWNLOAD_GRANT_SECRET` (plus `_PREVIOUS`), which the owner
  provisions per environment, or an HKDF derivation from `PLATFORM_KEK`, which needs no new
  secret but puts KEK-derived material on the bytes host. That host deliberately never touches
  the KEK (P2-05 least privilege). **Recommend the dedicated secret.**
- **Q4 Products whose trust policy requires `attested` for `gatedDelivery`, with `enforce: true`.**
  A browser has no device to attest. **Recommend app-only:** the file stays `not_hosted`, and
  PX-09 shows "Download it from inside the app". The alternative is to let a usable licence
  override the policy for portal downloads.
- **Q5 Revocation residual.** The licence is checked at redemption, so a licence revoked within
  the ≤ 120 s after it can still fetch that one file. **Recommend accepting and documenting
  this.** The alternative, a re-check on the bytes route, needs a new Core hook reading
  Identity's accounts from Distribution.
- **Q6 Bind the grant to the client IP?** **Recommend no.** It breaks under dual-stack, CGNAT and
  iCloud Private Relay, and the window is short.
- **Q7 Licensed files from private GitHub repositories.** Their `source_url` points at GitHub and
  fails for a customer. The grant could cover them, since the `files` route streams GitHub
  through `openSource`. **Recommend leaving this out of PX-W3** and filing a follow-up (it changes
  which branch `downloadTarget` takes first).

## 9. Acceptance

New tests:

- `test/portalLicensedDownloads.test.ts`:
  - a licensed R2 file is `canDownload` in the listing;
  - mint, then redeem, gives a 302 to `BLOB_ORIGIN` with a grant;
  - a GET on the bytes host gives 200, and `Range` gives 206;
  - an **expired grant** (now + 121) gives 401;
  - a grant with another name, release, product or SHA-256, or one that has been tampered with,
    gives 401;
  - a grant on the console host gives 401;
  - a **licence revoked or suspended before redemption** gives 404;
  - `entitled` outside the window is refused at mint;
  - an unset secret or `BLOB_ORIGIN` gives `not_hosted`;
  - an attested-enforced policy gives `not_hosted`;
  - a `gated/` location is never served;
  - the previous-key grant verifies, and an unknown `kid` does not.
- `test/portalDownloads.test.ts`: "every file it offers is one the token mint answers" stays
  green.
- A workerd case: mint and verify run in `test:workerd`.

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portalLicensedDownloads portalDownloads bytesHost routeCoverage boundaries
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm gen:corpus -- --check && mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

Then run the full green gate (AGENTS.md and PORTAL.md §11).

**Briefs this plan changes:**

- **PX-W3:** it now records "no migration", the secret provisioning as a human input, and the
  OpenAPI parameter in place of a new route.
- **PX-09:** the "Download it from inside the app" copy for attested-only products, if Q4 is
  accepted.
