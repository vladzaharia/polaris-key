# A-18h CI-plane storefront adapters: the publish action's command allow-list, itch.io and Snap

| Field       | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                              |
| Size        | 1–2 engineer-weeks                                                                                                                      |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [P2-06](P2-06-publish-cli-action.md)                       |
| Unblocks    | [A-18i](A-18i-pr-plane-generators.md)                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                      |
| Plan mode   | no                                                                                                                                      |
| Gates       | adapter conformance over CI command plans; CLI docs drift gate; CLI bundle; THREAT-MODEL (CI command allow-list is a §9 review trigger) |
| Human input | per adopter: the butler key and a scoped Snap export-login as CI environment secrets (never in the Worker)                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                               |

## Goal

The publish action enforces a per-tool **command allow-list**, the CI-plane counterpart of A-18a's
gate. itch.io and Snap are `StorefrontAdapter`s whose operations run on the `ci` plane, and each CI
step reports back into `store_operations` through P2-06's ingest, so the ledger and the console
show CI steps beside Worker steps.

## Why

itch.io and Snap take builds through vendor CLIs (`butler push`, `snapcraft upload`), which run in
CI, never in the Worker (README decision 7; owner decision 2)
([S-15 §4.4, §6.2](../../notes/S-15-storefront-provisioning.md#44-outlets-without-keys-in-polaris-key)).
An allow-list keeps the CI plane as constrained as the Worker plane.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§4.4** (itch.io, Snap, Epic rows),
  §6.2 (the CI allow-list), §6.3 (ledger rows for `ci` steps), §9 item 2, §11 (A-18h).
- P2-06's `pkey release` and the `polaris-key/publish` action; P2-06's ingest.
- `packages/cli/src/transport*.ts` (P5-08).

## Scope

**In:**

- The command allow-list in the publish action, filled from each adapter's `ci` declarations
  (A-18a's type): steamcmd `+run_app_build` with `setlive` only on a named branch; butler `push`
  only; snapcraft `upload --release` only to channels in the outlet's identity, and
  `upload-metadata`; BuildPatchTool `UploadBinary` only; msstore never `publish` while the ledger
  shows a Worker-staged draft (A-18f).
- itch.io: `butler push <dir> user/game:<channel>` from the outlet identity, `--userversion`;
  channel names tag platforms.
- Snap: `snapcraft upload --release=<identity channels>`; `upload-metadata` (summary, description,
  icon) from A-18b's projection; documentation of the scoped `snapcraft export-login`
  (`--snaps`, `--channels`, `--acls package_push,package_release`, `--expires`).
- CLI-side command plans in `packages/cli/src/storefronts/<store>.ts`, importing the shared
  declaration chosen in A-18a.
- Report-back of CI steps into `store_operations` (`plane = 'ci'`) through P2-06's ingest.

**Out:**

- Epic as an outlet kind (decision 8); a BuildPatchTool step may be listed in the allow-list but
  no Epic adapter ships. PR-plane outlets (→ A-18i).

## Design notes

- **Never:** butler collection deletes or page edits; snapcraft `close` and collaborator ACLs
  (`package_manage`); BuildPatchTool `DeleteBinary` and `UnlabelBinary`. The conformance suite
  asserts each is outside the allow-list.
- The butler key is unscoped: it lives only in a CI environment with required reviewers for
  production channels. Never in the Worker.
- itch.io and Snap page text and art beyond `upload-metadata` are deep links.

## Acceptance criteria

- [ ] The allow-list rejects every never-list command in tests, and the conformance suite runs over
      the CI command plans.
- [ ] A CI step's report-back writes a `store_operations` row with `plane = 'ci'`.
- [ ] The CLI reference and action docs are regenerated; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test -- storefronts
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront ingest
```

## Hand-off

A-18i reuses the allow-list for PR-opening steps. A-18j shows CI steps as "waiting for the next
publish run" with the command line.

The role agent sets `--set A-18h in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18h done`.
