# Human-held hand-offs

Everything an agent could not do itself: deploys, real GitHub or Cloudflare checks, sign-offs and
PR-body items. Hand-written by the lead from the reviewers' reports; update it when a package
lands. [`INDEX.md`](INDEX.md#human-inputs) holds the generated per-package register of inputs;
this file is the execution-order checklist. Tick a row only when it is done against the real
resource, and record the date and the person.

## Order of operations

1. **P0-08 in production first.** No worker that writes a new service slug (P0-09, P2b-01) may be
   deployed until a build with P0-08's tolerant `parseServices` is live in production.
2. Then one production deploy of current `main` (it carries the D1 migrations and bindings below;
   apply migrations before the Worker that reads them).
3. Then the post-deploy checks, then the per-package sign-offs.

## Production check:representable (P3-12): done 2026-10-01

- [x] **Before the first wire v4 deploy:** the operator ran `pnpm check:representable` against
      `polaris_key_prod` (remote): clean, 21 columns checked, 0 warnings. The lead tags v0.7.0.

## Required checks for P1b-05's CI jobs (after it merges)

- [ ] On `main`'s branch protection or ruleset, add the new jobs as required checks: "Node floor
      (engines.node)", "Browser conformance (Chromium)", "Browser conformance (Firefox, Linux)",
      "Browser conformance (WebKit, macOS)" and the renamed Python matrix legs (3.9 and 3.14 on
      ubuntu, 3.12 on macos-14). The old "Python SDK (ubuntu-latest)" and "Python SDK (macos-14)"
      names stop reporting. No required checks are configured on `main` today.

## Storing a real App Store Connect key (P5-02, P5-02f)

- [x] **Wait for the operator-owned `appleId` pin before PUTting any `asc-api-key`.** Done
      2026-10-01: the pin landed with P5-02f (lead). The connector now runs only while the key's
      pin equals the `appleId` in `.pkey/distribution`; a key without a pin, or a manifest naming
      another app, leaves it inert and every control refused (THREAT-MODEL, "Closed: a
      manifest-chosen app"). When you store the real key, **pin it to the product's app**: the
      Secrets tab asks for the App Store Connect app id with the key, or send `"pin": "<Apple ID>"`
      on the `PUT`. Check the number against App Store Connect (App Information → Apple ID) before
      saving, and again before any re-pin.
- [x] **A Google Play service account waits for the same pin in P5-03.** Do not store a real
      `google-service-account` until P5-03's connector adds its `packageName` entry to
      `OUTLET_CREDENTIAL_PINS` and checks it in its setup (the mechanism is generic; see the doc
      comment in `core/outletCredentials.ts`).
      2026-10-01: the pin landed with P5-03. `google-service-account` is pinned by `packageName`;
      the Play connector runs only while the pin equals the `packageName` in `.pkey/distribution`,
      and a credential without a pin, or a manifest naming another package, leaves it inert with
      every control refused (409 `credential_pin_missing` / `credential_pin_mismatch`) and nothing
      polled (THREAT-MODEL, "Store connectors: Google Play"). When you store the real service
      account, **pin it to the product's package**: the Secrets tab asks for the Google Play
      package name with the key file, or send `"pin": "<package name>"` on the `PUT`. Check it
      against Play Console (the app's dashboard shows the package name) before saving, and again
      before any re-pin.

## Before djdl's next `.pkey` push (from v0.5.0)

- [ ] **Add `"distribution": { "enabled": true }` to `modules` in `vladzaharia/djdl`'s
      `.pkey/product.json`.** P2b-01's new coherence rule (`update_requires_distribution`) rejects
      djdl's current manifest (`update` on, no `distribution`). Migration `0033` already gave the
      stored row `distribution`, so djdl keeps serving; only its next manifest push would be refused
      (visible in the console) until this line is added. Also add `beta` to the `channels` enum in
      djdl's `.pkey/schema` (P0-04; optional, blocks nothing).

## Before the first production deploy

### P0-08 (unknown-slug tolerance)

- [x] Deploy to production a build containing P0-08; note the deploy in its PR description. — done 2026-09-30 (v0.3.0)
- [x] Only after that: allow P0-09 and P2b-01 to ship a new slug. — unblocked 2026-09-30

### D1 migrations (P0-01, P0-02, P0-05, P2-01)

Exercised only against the in-memory test D1. Apply to staging, then production, in number order.

- [x] `0022_*` (P0-01 operator ownership). — production, v0.3.0
- [x] `0023_release_resolution.sql` plus `0023_release_resolution_stable_tag_pattern.sql` and
      `0023_release_resolution_ignore_tags.sql` (P0-02; one bare `ALTER` per file, swaps the
      `(product, version)` unique index for a non-unique one).
- [x] `0024_product_web_origins.sql` (P0-05). — production, v0.3.0
- [x] `0026_blob_store.sql` (P2-01; `blob_objects`, `blob_refs`). Production, v0.4.0, together with P0-12's `0025_a`/`0025_b`.
- [x] `0027_a`…`0027_i` (P2-03 release model v2: deliverables, builds, `seq`, `deliverable_id`,
      artifact roles and locations, backfill). Apply in file order. From now on every deploy
      re-runs `0027_i_index_assertion.sql` (the newest assertion) instead of `0018`, so a database
      missing `idx_release_metadata_seq` fails the deploy: watch the first tagged deploy after this. — applied to production 2026-10-01 by v0.5.1 (deploy run 36835975944, success), with `0033_distribution_backfill`.
- [ ] P2-03, real GitHub: a repository with more than 1,000 releases whose stable floor release is
      beyond page 10 still gets a healthy store row (tested only with stubbed responses).

### P2-01 (blob store; Cloudflare)

- [ ] `wrangler deploy` the `BLOBS` bindings and the `dl.plrs.im`, `dl-staging.plrs.im` and
      `dl-dev.plrs.im` custom-domain routes in prod, staging and dev. Only `--dry-run` has run.
- [ ] `BLOB_ORIGIN` is set in every environment that has the `dl*` route. Route and variable are
      added and removed together: with the route and no `BLOB_ORIGIN`, host isolation fails open
      and the console answers on the same-site sibling. `BLOB_ORIGIN` must never equal the console
      hostname.
- [ ] On the real buckets `polaris-key-blobs-prod|-staging|-dev`, confirm the 180-day age locks,
      the 1-day `staging/` expiry and `r2.dev` disabled, as in `docs/DEPLOYMENT.md`.
- [ ] `docs/DEPLOYMENT.md` is the source of truth for the above; if a real setting differs, fix
      the document in the same change.

## After the first production deploy

### P2-01 (dl.plrs.im isolation; run from outside)

- [x] `curl -sI https://dl.plrs.im/manage` answers 404 with `X-Content-Type-Options: nosniff` and
      `Content-Security-Policy: sandbox; ...`.
- [x] The same for `https://dl.plrs.im./manage` (trailing dot). — both verified 2026-09-30 after v0.4.0: 404, JSON, `CSP: sandbox; default-src 'none'; frame-ancestors 'none'`, `nosniff`.
- [ ] Console session cookies are host-only: a browser signed in to `key.plrs.im` sends no cookie to
      `dl.plrs.im`.
- [ ] Repeat for `dl-staging.plrs.im` and `dl-dev.plrs.im`.

### P0-02 (release resolution; real GitHub)

Tested only against stubbed fetches, not a real GitHub App installation.

- [ ] Link pagination: a repository with more than 100 releases syncs all of them (check the
      store row count against GitHub).
- [ ] A repository tagging `1.2.3` without a `v`: pinned lookup, the download route and the
      appcast enclosure all resolve.
- [ ] Rate-limit behaviour during `checkReleaseHealth` (it now pays a full live resolution plus one
      per floored channel that looks below its floor): confirm no 403/429 storms on a real install.

### P0-10 (Sparkle streaming verifier)

- [ ] Verify a real 1 to 2 GiB DMG against GitHub on deployed workerd: Worker CPU time,
      first-request latency, and how long the stream takes (this sets the concurrency window for
      the accepted no-single-flight residual, R10-05; P3-03 removes it).

## PR bodies the lead must write (nothing was pushed by the agents)

### P0-07 (`pkey init` / validate)

- [ ] State that products created with the old scaffold have 14-day expiring tiers; the new
      `tier_ignored_field` warning is how owners find out.
- [ ] State that link and resync refusal text changed: `invalid catalog in manifest: ...` is now
      `manifest validation failed` / `schema: ...`, and `release/:` and `schema/:` lose the slash.
      A Config-off product whose schema does not normalise to a catalog is now refused in
      `parseManifest` (`invalid_schema`) before anything is written.
- [ ] Add `missing_product` and the reworded messages to `.changeset/pkey-init-validate.md`.

### P0-10 (Sparkle hardening)

- [ ] Give the reason for the new Worker runtime dependency: `@noble/curves` 2.4.0, audited, exact
      pin, only transitive dependency `@noble/hashes` 2.4.0 (THREAT-MODEL §4 T6; the lead approved it).
- [ ] State the accepted DoS residual (R10-05, R6-03): concurrent misses each pay a full download,
      an aborted request never caches its verdict, bounded only by 30 requests/min per IP. P3-03 is
      the fix.
- [ ] Note first-request latency ("seconds of Worker CPU", R10-05) and that negative verdicts are
      memoised for 24 h.

### P1b-01 (parity registry)

- [ ] PR body carries the acceptance checklist, the deleted-tag demonstration (removing the tag
      from `packages/sdk-node/test/local.test.ts` makes `checkParity` print
      `[rule 2] node: core.local is implemented but no test ... is tagged @pkey-feature core.local`
      and exit 1), the 26 unowned gaps `pnpm parity:check` prints, and every new web and
      desktop-bridge N/A.
- [ ] Sign off the 10 React desktop-bridge N/As (reason `runtime`) and the web N/As; React
      `devices.manage` and `identity.devicecode` depend on the web N/As being accepted.
- [ ] `AGENTS.md`'s repo map is stale: it lacks `conformance/parity/` and `tools/parity-check.ts`.
- [ ] Separate ticket: `packages/admin/test/identity.test.tsx:120` is a timing flake under
      parallel `turbo run test --force` (passes alone and on a second run).

### P0-02 (release resolution)

- [ ] PR body: the new `stableTagPattern` field widens the R10-09 regex-DoS finding (recorded in
      R10-dos.md and THREAT-MODEL).

## Inputs that do not exist yet

- [ ] **P6-04 (optional):** a new, separate registrable domain (not `plrs.im`) for hosted web
      builds, with DNS and a Worker route. P2-01 did not create one and `dl.plrs.im` must not be
      used for it.
- [ ] **P2-02:** R2 parent API token and `R2_ACCOUNT_ID`, `R2_PARENT_ACCESS_KEY_ID`,
      `R2_PARENT_SECRET_ACCESS_KEY` Worker secrets; against real R2, confirm what the binding
      exposes as `checksums.sha256` for multipart uploads (the AWS CLI goes multipart above 8 MB;
      a composite hash-of-parts would make valid uploads fail closed) and that minted credentials
      cannot read or copy outside `staging/<product>/<ticketId>/`.
- [ ] **P2-05 / P2b-04:** on the first deploy that registers `BYTE_ROUTES`, repeat the
      `dl.plrs.im` isolation checks above with a route that throws (expect a hardened JSON 500).

## Release infrastructure (found 2026-09-30)

- [ ] **Changesets cannot update the Version Packages PR.** `release.yml` runs `changesets/action`
      with `GITHUB_TOKEN`, which force-pushes `main`'s history to `changeset-release/main`. Since
      P0-09, P1b-03 and P1-01 changed `.github/workflows/ci.yml`, GitHub rejects that push
      ("refusing to allow a GitHub App to create or update workflow … without `workflows`
      permission"; run 36807091247). `GITHUB_TOKEN` cannot be granted `workflows`, so give the
      action a fine-grained PAT or GitHub App token with Contents + Pull requests + Workflows on
      this repository (secret, then `with: { token: … }` / `GITHUB_TOKEN: …` in `release.yml`).
- [ ] **PR #1 (Version Packages) CI is `action_required`.** Bot-opened PR runs wait for a
      maintainer's approval in the Actions tab; approve them (or the token above, being a user or
      App token, avoids the hold).
- [ ] **Required checks:** add the two new Godot CI legs ("Godot SDK (4.7.2 editor + release
      template)", "Godot SDK (4.4.1 editor, floor)") to `main`'s required status checks. Both
      passed on GitHub on 2026-09-30.

## v0.5.1 (2026-10-01): deployed and checked

- [x] Deploy run 36835975944 succeeded (migrations `0027_a`–`0027_i` and `0033` applied, smoke check
      green). The tag pushes were delayed ~25 min by GitHub, not lost; `v0.5.2` is the same commit.
- [x] Discovery lists all six services; djdl's `distribution` reads enabled (backfill), and
      `services.identity.endpoints.authDeviceEntry` is advertised (P1-06).
- [x] `POST /djdl/identity/auth/device/start` returns a `XXXX-XXXX` consonant user code, and neither
      verification URL contains the device code (P1-06).
- [x] `dl.plrs.im/manage` and the trailing-dot host still answer the hardened 404.
- [ ] P1-06 in a real mobile browser: open `verificationUriComplete` (QR path) and
      `verificationUri` (type a lower-case code with a space); confirm; reopen the same code → 404.
- [ ] P0-03: subscribe the GitHub App to Release events, then publish a release on a linked repo
      and confirm the store updates within one delivery.
- [x] P2-05's byte routes are not in v0.5.1 (merged after); checked after v0.5.3 below.

## v0.5.3 (2026-10-01): deployed and checked

- [x] Deploy run 36859366875 succeeded (P2-05, P5-01 with migration `0034`, P1-05).
- [x] `dl.plrs.im/djdl/release/blobs/sha256/<64 zeros>` → 404 JSON `not_found`, sandbox CSP, nosniff.
- [x] `dl.plrs.im/djdl/release/files/v0.3.8/SHA256SUMS` → 200 `application/octet-stream`,
      `Content-Disposition: attachment`, sandbox CSP, `immutable, no-transform`, no `Set-Cookie`;
      with `Range: bytes=0-99` → 206 `bytes 0-99/402`.
- [x] `dl.plrs.im/djdl/release/dl/latest/djdl-arm64` → 404 (legacy route not on the bytes host).
- [x] Discovery advertises `endpoints.builds` and `endpoints.blobs` on `dl.plrs.im`.
- [ ] For an `entitled` product: a pinned non-semver version (`/release/builds/1.2.3.4/<build>`) with
      a valid device token → 403 `version_blocked` (needs a real device token).

## v0.6.0 (2026-10-01): deployed and checked

- [x] Deploy run 36886345061 succeeded (P2-02, P2-06, P2b-02, P2b-04, P1-04; migrations `0035_a/b`,
      `0036`, `0038`). `0038` backfilled `dist_access` `app` rows from `release_config`, so no
      product flipped to `entitled`.
- [x] Discovery: `services.distribution` is `configured: true` with `download`, `install`, `builds`,
      `blobs`.
- [x] `install.sh` is byte-identical on `/djdl/install.sh`, `/release/install.sh` and
      `/distribution/install.sh`.
- [x] `/djdl/release/dl/latest/djdl-arm64` and `/djdl/distribution/dl/latest/djdl-arm64` both 200
      with the same ETag; `dl.plrs.im/djdl/release/files/…` still serves (permanent alias).
- [ ] djdl's appcast still answers 404, as it has since before this program (v0.3.0 log): Sparkle
      signatures are required and djdl has no `sparkle_ed25519_pub`. Configure the key (or the
      operator policy) to serve it.
- [ ] Grant `distribution:rollout` to a product's CI publisher before its CI calls the rollout routes
      (not in the default grant). Trusted publishing stays off (404) until the R2 parent-token
      secrets exist (see P2-02 above).
