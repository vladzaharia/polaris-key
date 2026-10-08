# P2-06 `pkey release` publishing commands and the `polaris-key/publish` Action

| Field       | Value                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P2: Release truth, publishing and release tracks                                                                                                                                                                   |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                               |
| Depends on  | [P2-02](P2-02-trusted-publisher.md), [P2-04](P2-04-release-descriptor.md), [P2-05](P2-05-release-routes.md)                                                                                                        |
| Unblocks    | [P2b-03](P2b-03-availability-keys.md), [P3-03](P3-03-feed-composition.md), [P4-03](P4-03-ci-patch-artifacts.md), [D-03](D-03-diceroll-after-p3.md), [A-18h](A-18h-ci-plane-adapters.md)                            |
| Role        | `pkey-implementer`                                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                                 |
| Gates       | CLI tests; an end-to-end publish test against the Worker; a freshness check for the committed Action bundle (a new generated file)                                                                                 |
| Human input | none in the graph; publishing the Action as `polaris-key/publish@v1` needs a GitHub organisation or repository and a Marketplace listing. Until then workflows use `vladzaharia/polaris-key/actions/publish@<sha>` |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                          |

## Goal

In a GitHub Actions release job with `permissions: id-token: write`, one step
(`uses: …/publish`) or one command (`pkey release publish`) exchanges the job's OIDC token for a
`pkeyci_` token, matches the built files against the `.pkey/release` artifact map, hashes them,
uploads what the blob store lacks with R2 temporary credentials, and submits a release descriptor.
`--dry-run` prints the descriptor and the server's validation without uploading or writing.
`pkey release promote|pin|unpin|yank` drive channel policy from CI. No long-lived secret is
stored in the product's repository.

## Why

The developer's release day in [README §6.1](../../README.md#61-developer-adopter) is "tag, CI
exports and signs as today, then `pkey release publish`". Polaris Key stays "records, decides,
serves, controls": it never builds or uploads to stores, and vendor CLIs keep doing that
([§3.4](../../README.md#34-release-the-record-of-everything-that-exists) "CLI + Action",
[notes/E7 §6](../../notes/E7-server-ci-tools.md#6-godot-ci-tooling-and-whether-to-ship-polaris-keypublish)).
Diceroll's adoption (D-03) publishes through this Action and deletes `update_manifest.py` and
`altstore_source.py` afterwards ([§13](../../README.md#13-diceroll-adoption-path)).

## Read first

- `AGENTS.md`, `CLAUDE.md`, the `authoring-pkey-manifests` skill.
- [README §3.4](../../README.md#34-release-the-record-of-everything-that-exists) "Publishing" and
  "CLI + Action", [§6.1](../../README.md#61-developer-adopter).
- [notes/A3 §4.3–§4.5](../../notes/A3-admin-dx.md#43-ci-facing-commands-a-game-needs);
  [notes/E5 §2.2, §4.5](../../notes/E5-frontier-tech.md#45-ci-upload-flow-i);
  [notes/E7 §6](../../notes/E7-server-ci-tools.md#6-godot-ci-tooling-and-whether-to-ship-polaris-keypublish).
- Contracts: [P2-02](P2-02-trusted-publisher.md) (routes, `aud`, ticket shape, `nextSeq`),
  [P2-04](P2-04-release-descriptor.md) (`ReleaseDescriptor`, `validateReleaseDescriptor`, the
  artifact map and `match`), [P2-05](P2-05-release-routes.md) (CI channel routes).
- Code: `packages/cli/src/index.ts` (command switch `:66-88`, `parseArgs`, `helpText` `:306`),
  `src/manifest.ts` (`loadManifest`), `src/bundle.ts` (the HTTP client pattern and
  `DEFAULT_BASE_URL`), `test/cli.test.ts`; `.github/workflows/release.yml` (JS packages publish to
  GitHub Packages, so an Action cannot `npx` the CLI without credentials).

## Scope

**In:**

- `pkey auth github-oidc --product <slug> [--base-url]`: requests the Actions OIDC token for the
  product's `aud` (`ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=`, bearer
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`), exchanges it at `POST /{product}/release/publish/token`, and
  writes `PKEY_CI_TOKEN` to `$GITHUB_ENV` after `::add-mask::`. Other commands call it implicitly
  when `PKEY_CI_TOKEN` is unset and the job is an Actions job.
- `pkey release publish` with `--product <slug> --deliverable app --version <v> --dir <path>`
  and the options `--tag vX.Y.Z`, `--channel <c>`, `--source r2|github`, `--meta builds.json`,
  `--dry-run`, `--base-url`:
  1. load `.pkey/`, match files in `--dir` against the deliverable's `artifacts[].match` (none: a
     warning and the build is omitted; more than one: an error), pick up `<file>.sig` and
     `<file>.sha256` as sidecars;
  2. hash each file with a streamed SHA-256; read build numbers, minimum OS and `requires` from
     `--meta` (`{"<buildId>": {buildNumber, minOS, requires}}`);
  3. request a ticket, upload objects not already `present` with a single-part S3 `PUT` carrying
     `x-amz-checksum-sha256` (SigV4 with the session token), retrying transient failures;
  4. build the descriptor (no `seq`, so the Worker assigns the next one — corrected, see below;
     `provenance` from `GITHUB_SHA` and the run URL), validate it locally with
     `validateReleaseDescriptor`, and submit it.
     `--source github` uploads nothing and lists `github` locations; the tagged release must be
     immutable.
- `pkey release promote|pin <releaseId> --channel <c>`, `pkey release unpin --channel <c>` and
  `pkey release yank <releaseId> --reason <text>`, calling P2-05's CI routes.
- **The Action** at `actions/publish/action.yml` (`runs.using` the current Node runtime GitHub
  supports), inputs `product`, `deliverable`, `version`, `tag`, `channel`, `dir`, `source`, `meta`,
  `base-url`, `dry-run`. Its `dist/index.js` is an esbuild bundle of the CLI, committed with a
  GENERATED banner and a `--check` script in CI that rebuilds and diffs it.
- **CLI outside npm** (P0-07 hands this here): the same bundle runs as a standalone `pkey`
  (`node pkey.mjs validate`), attached to the monorepo's GitHub releases, so a Godot repository with
  no `node_modules` can validate locally; and `pkey manifest schemas --out <dir>` vendors
  `schemas/v1/*.schema.json` for editors. Publishing `@polaris-key/cli` publicly on npm is a human
  decision (the packages publish to GitHub Packages today).
- Docs: a `build/ci.md` page (permissions, the workflow snippet, `--dry-run`, the branch or tag
  ruleset `ref_protected` needs, troubleshooting policy refusals), linked from
  `build/onboarding.md`; `helpText` updated.

**Out** (and where it belongs instead):

- Signing release records with the release key (`pkey-release+jws`): the record format is wire v4
  (→ P3-02 contract, [P3-03](P3-03-feed-composition.md) ingest). Leave a `signRecord` seam; see
  the report, since P4-03's brief assumes P2-06 signs.
- `pkey build-info` (README §3.4) (→ P1-11, which stamps the build in the Godot exporter).
- Pack publishing, patch artifacts and lint (→ [P4-03](P4-03-ci-patch-artifacts.md)).
- `pkey distribution report` (→ [P2b-03](P2b-03-availability-keys.md)); `rollout|halt`
  (→ [P2b-04](P2b-04-rollouts-delivery.md)); `pkey feeds fdroid` (→ [P2b-05](P2b-05-storefront-feeds.md));
  `pkey feeds zsync` (→ P3-09); `pkey validate --strict` (→ P0-07).
- IPA and APK metadata extraction into the descriptor (→ P2b-05 for AltStore's `appPermissions`).

## Design notes

- **No secret in the repo.** The OIDC exchange is the default; `PKEY_CI_TOKEN` from an operator
  (a static `pkeyci_` token, P2-02) is the fallback for other CI. Never print a token or
  temporary credential; mask them in Actions logs.
- **The CLI is not a build server.** It never exports, signs binaries, notarises or uploads to a
  store; the Action documents recipes for vendor tools instead (E7 §6).
- **Promote/pin/yank need P2-05's routes.** P2-05 is not a declared dependency. If it is not
  `done`, land `auth` and `publish` first and the channel commands in a follow-up PR.
- **Streaming.** Hash and upload with streams; artifacts can reach 2 GiB and the runner has
  limited memory. Refuse files over 5 GiB (the single-part PUT limit); GitHub caps assets at 2 GiB.
- **Dependencies.** The S3 SigV4 signer may be `aws4fetch` (small, no dependencies) or
  `node:crypto`; any new CLI dependency is a reviewed change.
- **Generated bundle.** `actions/publish/dist/index.js` is a new generated file. Add it to the
  table in `AGENTS.md` rule 3 with its writer and freshness check, in this PR.
- **Error output** prints the server's `reason` (policy mismatch, missing object, descriptor
  refusal) and exits non-zero, so a failed publish fails the job.

## Steps

1. `auth github-oidc` with tests (env handling, masking, `$GITHUB_ENV`).
2. File matching and descriptor building over a fixture directory shaped like Diceroll's outputs.
3. Ticket, upload and submit against a fake server; retries; `--dry-run`.
4. End-to-end test in `packages/worker/test/publishE2e.test.ts` (add `@polaris-key/cli` as a worker
   devDependency): the CLI's publish function runs against the Worker's `fetch` handler, the R2
   fake behind a fetch shim for the S3 endpoint, and a test OIDC issuer via P2-02's injectable
   JWKS fetcher. Assert rows and blobs.
5. Channel commands (after P2-05). The Action, its bundle script and `--check`; docs.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/cli test` covers matching (zero, one, two files per entry),
      sidecar pickup, streamed hashing, `--meta`, skipping `present` objects, masking, and
      `--dry-run` making no upload and no write.
- [ ] The end-to-end test publishes a six-build release from a fixture directory and the Worker
      holds the builds, roles, SHA-256s and blobs the descriptor names; publishing it again is a
      no-op.
- [ ] A policy refusal from the server is printed with its reason and exits non-zero.
- [ ] The Action bundle freshness check passes in CI and fails on a stale bundle.
- [ ] `build/ci.md` exists, is in the sidebar, and `docs check:links` passes.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- publishE2e
mise exec node@22 -- pnpm --filter @polaris-key/cli bundle:action -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm typecheck
```

## Corrections from the code (P2-06 implementation)

- **No `seq` in the descriptor.** The brief said to copy the ticket's `nextSeq`. The Worker hashes
  the submitted descriptor to recognise "the same release again", and `nextSeq` moves on once the
  first publish lands, so a re-run would become a different descriptor and be refused
  `release_exists` instead of being the no-op acceptance requires. P2-04's ingest assigns the next
  `seq` when it is absent, which is what the P2-02 hand-off recommends for CI.
- **`unpin` takes no release id.** P2-05's `POST …/channels/<c>/unpin` reads none.
- **A dry run before the uploads needed a Worker change.** P2-02's submit verified staged objects
  before honouring `dryRun`, so a dry run that uploads nothing was always refused
  `staged_object_missing`. The submit now judges a ticket object that is not yet staged as if it
  were and lists it in `unverified` (dry run only; a staged copy that is present must still
  verify). OpenAPI, the artifacts page and the threat model say so.
- **`--source github` still requests a ticket**: submit requires one, so the uploads route (and
  the blob store's R2 configuration) must exist even when nothing is uploaded.
- **The bundle's freshness gate is a CI step, not a vitest test**: it reads the built
  `dist/` of `@polaris-key/manifest`, `@polaris-key/catalog` and `@polaris-key/protocol`, so it
  runs after `pnpm build` (AGENTS.md rule 3 and the green gate list it). The CLI suite proves the
  `--check` mechanics on a temporary copy.
- The Action runs on `node24`; the bundle targets Node 20 so `node pkey.mjs` runs on older
  runtimes too.

## Hand-off

- P2b-03 adds `pkey distribution report`, P2b-04 `rollout|halt`, P2b-05 `pkey feeds fdroid`, all
  reusing the token and HTTP plumbing here (`ciClient(baseUrl, product)`, name proposed).
- P3-03 and P4-03 extend `pkey release publish` with record signing and pack patch artifacts
  through the `signRecord` seam and the upload path.
- D-03 adds the Action to Diceroll's release workflow.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P2-06 done`.
