# A-18i PR-plane storefront generators: winget, Homebrew tap, Scoop bucket and Flathub

| Field       | Value                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                   |
| Size        | 1–2 engineer-weeks                                                                                                           |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [A-18h](A-18h-ci-plane-adapters.md)             |
| Unblocks    | none                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                           |
| Plan mode   | no                                                                                                                           |
| Gates       | generator golden files; winget schema 1.12.0 validation in CI; adapter conformance; THREAT-MODEL (new CI secrets)            |
| Human input | per adopter: GitHub tokens as CI environment secrets (decision 7); the first Flathub PR is opened and shepherded by a person |
| Repo        | `vladzaharia/polaris-key`                                                                                                    |

## Goal

winget, an own Homebrew tap, an own Scoop bucket and Flathub are `StorefrontAdapter`s on the `pr`
plane. Generators produce each outlet's manifest from the release and the listing model; CI opens
or updates the pull request with a scoped token; the adapter's verifier follows the PR through the
public GitHub API; each step lands in `store_operations` with `plane = 'pr'`.

## Why

These outlets are written entirely through files in a repository
([S-15 §4.4](../../notes/S-15-storefront-provisioning.md#44-outlets-without-keys-in-polaris-key)).
Once the adapter contract and the CI allow-list exist, each is a generator plus a PR step.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§4.4** (winget, Homebrew, Scoop,
  Flathub rows), §6.3 (PR-plane natural key), §7.3, §11 (A-18i), owner decision 7.
- The existing Scoop and Flathub feeds (`/scoop/<ch>.json`, `/flathub/<ch>.json`,
  `feeds/render.ts`); `page/model.ts` (`direct.homebrewCask`).

## Scope

**In:**

- winget: multi-file manifests at schema **1.12.0** (version, installer, default and extra locale
  files from the model); HTTPS direct installer URLs from the release; validation in CI.
- Homebrew cask for the own tap (`version`, `sha256`, `url`, `name`, `desc`, `homepage`, `app`,
  `livecheck`, `auto_updates`). Never pushed to `homebrew/cask`.
- Scoop manifest from the existing feed, committed to the own bucket with `checkver` and
  `autoupdate`.
- Flathub MetaInfo XML (name, summary, description, screenshots, `releases` from notes, OARS from
  content descriptors, `developer` id, `branding` with `tint` and `tintDark`) and a manifest
  skeleton for the first, human PR. Later updates go through Flathub's external-data checker or a
  PR.
- CI opens PRs through A-18h's allow-list. Natural key: an open or merged PR for
  `(package, version)` (winget allows one PR per package version).
- Verifiers on the public GitHub API: PR state and labels (`Validation-Domain`,
  `Needs-Author-Feedback`).

**Out:**

- The winget REST source (README §9 gap). Pushing to `homebrew/cask` without the owner.

## Design notes

- **Decision 7:** a fine-grained token limited to the own tap and bucket repos; for winget, a
  classic `public_repo` token only if A-18k shows a fine-grained one cannot open the PR. Both are CI
  environment secrets, never in the Worker.
- Every winget version is moderator-reviewed; the flow shows the PR, never a promise of a date.
- Never close a Flathub app or delete a repository.

- **Screenshot URLs (S-20, 2026-10-05).** Flathub MetaInfo `<screenshots>` needs public https
  URLs. They come from S-20's media host (`https://img.plrs.im/<p>/a/<sha256>`, built in
  [HA-02](HA-02-media-host.md)). The images get there in either of two ways:
  [HA-07](HA-07-serve-hosted-copies.md)'s `source = 'manifest'` listing rows, or uploads through
  [HA-06](HA-06-upload-paths.md). If those packages have not landed yet, omit `<screenshots>`.
  Never emit a developer's raw URL or a `dl` blob URL
  ([notes/S-20 §4.2 L6](../../notes/S-20-hosted-assets.md#42-storefront-listing-assets-s-15--a-18)).

## Acceptance criteria

- [x] Golden files for each generator from a fixture release and listing.
- [x] winget manifests validate against schema 1.12.0 in CI.
- [x] The conformance suite runs over the PR-plane declarations; a PR step writes a ledger row.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- storefronts winget flathub
```

## Corrections from the code (A-18i implementation)

- **Where the generators live.** The generators run in CI, in the CLI
  (`packages/cli/src/storefronts/{winget,homebrew,scoop,flathub}.ts`), and read one Worker answer,
  `GET /<p>/distribution/pr/<store>?channel=&outlet=` (`services/distribution/prInputs.ts`,
  `distribution:report`; rule 10: OpenAPI and `routeCoverage`): the outlet, the channel's newest
  release with its builds' HTTPS URLs and SHA-256, the listing model's projection, the release
  notes and the feed URLs. The Worker never calls GitHub.
- **The PR plane is a declaration like the CI plane.** `core/storefront/prPlane.ts` declares per
  store the repository, `pull-request` and `status` commands for the pseudo-tool `github`, the
  path templates a PR may write, the natural key and the review labels; the CLI reads the
  generated copy (`ciPlane.generated.ts`, `prStores`). PR steps report through the existing
  `type: "store-step"` ingest with `plane = 'pr'`, op `pr.pull_request` or `pr.status`, natural
  key `pr:<package>:<version>`, each file's path and SHA-256, the pull request and its verdict.
- **The tap and bucket had no identity field**: `direct` gains `homebrewTap`
  (`<owner>/homebrew-<name>`) and `scoopBucket` (`<owner>/<repo>`), both refusing the `Homebrew`
  and `ScoopInstaller` organisations (no new outlet kind, no new error code; schema updated).
- **winget's identity has no installer details**, so a `.zip` build needs `--portable <exe in the
archive>` (and `--command` for its alias); `.exe` is a portable installer, `.msi` and `.msix`
  map directly. `License` defaults to `Proprietary` (`--license`).
- **Homebrew's livecheck** reads the public `download.json`, which serves the stable channel only;
  a cask for another channel gets `livecheck { skip … }`. The `.app` bundle name is `--app`
  (default `<listing name>.app`): no build metadata records it.
- **Flathub updates** rewrite the app repository's existing manifest in place (each `extra-data`
  source's `url`, `sha256` and `size`, comments kept) plus the regenerated MetaInfo, rather than
  replacing a hand-maintained manifest; Flathub's `pull-request` also performs
  `writeListingAssets` and `contentRating` (the MetaInfo's screenshots and OARS rating). The OARS
  mapping from the listing's content descriptors lives in one function (`oarsAttributes`).
- **Scoop's `autoupdate` for content-addressed builds.** The feed (`renderScoopManifest`) writes
  `autoupdate` only when a build URL contains the version; Polaris-hosted URLs are
  `…/blobs/sha256/<hash>` and never do. The generator (`withHashAutoupdate` in `scoop.ts`) adds
  it for such manifests: `checkver` becomes a regex over the feed JSON capturing the version and
  each architecture's hash (`hashx` for `64bit`, `hasharm` for `arm64`, letter-only names because
  Scoop title-cases them into `$matchHashx`/`$matchHasharm` and substitutes case-sensitively), and
  `autoupdate.architecture.<arch>.url` is `…/blobs/sha256/$matchHash…`, with the hash read from
  the feed's JSON path. The Worker's feed is unchanged (P2b-05 owns it).
- **Flathub's runtime** defaults to Freedesktop `25.08` (24.08 is end of life, which Flathub's
  linter refuses on a new submission); `--runtime-version` overrides it.
- **The token** is `PKEY_PR_TOKEN`, a CI environment secret read from the job's environment.
- **The Action's `storefront` input does not gain PR steps here**: the steps run as
  `pkey storefront <store> pr|status` from a workflow (documented in the CI page); adding Action
  inputs for them is a follow-up.

## Hand-off

A-18j shows PR steps with their review labels. A-18k checks the fine-grained winget token.

The role agent sets `--set A-18i in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18i done`.
