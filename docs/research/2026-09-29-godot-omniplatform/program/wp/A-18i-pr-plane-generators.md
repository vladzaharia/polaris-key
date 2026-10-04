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

## Acceptance criteria

- [ ] Golden files for each generator from a fixture release and listing.
- [ ] winget manifests validate against schema 1.12.0 in CI.
- [ ] The conformance suite runs over the PR-plane declarations; a PR step writes a ledger row.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- storefronts winget flathub
```

## Hand-off

A-18j shows PR steps with their review labels. A-18k checks the fine-grained winget token.

The role agent sets `--set A-18i in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18i done`.
