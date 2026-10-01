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
- [ ] `0027_a`…`0027_i` (P2-03 release model v2: deliverables, builds, `seq`, `deliverable_id`,
      artifact roles and locations, backfill). Apply in file order. From now on every deploy
      re-runs `0027_i_index_assertion.sql` (the newest assertion) instead of `0018`, so a database
      missing `idx_release_metadata_seq` fails the deploy: watch the first tagged deploy after this.
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
