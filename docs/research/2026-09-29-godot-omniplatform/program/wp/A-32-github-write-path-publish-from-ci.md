# A-32 GitHub write path and Publish from CI

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce) |
| Size        | 1–1.4 engineer-weeks                                                                                                  |
| Depends on  | [ST-39](ST-39-wizard-kit.md), [A-25](A-25-action-v2-channels-auto-thin-inputs.md)                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | `threat-model`                                                                                                        |
| Human input | owner step `github-app`                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-17** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-62, UX-70, UX-71.

## Corrections (2026-10-24)

Verified against the code; the plan is `_lead/plans/P4-33-A-32-slices.md` (§0 G1-G13, sliced A-32.1-14).

- **G1.** The owner granted Contents, Pull requests, Workflows, Secrets, Environments and Administration write on the App (2026-10-06); each installation still has to accept them. `humanInputs` is `["github-app"]`. `docs/DEPLOYMENT.md:219` still says "Contents: read, Actions: read".
- **G2.** Nothing of W9, W17, W18 exists: no `ci-readiness`, `pkey/setup`, `distribution:pr` (`core/ciVocabulary.ts:28-38`) or `renderCiWorkflow`, and no GitHub write call in the Worker before A-32.1.
- **G3.** The App belongs to Release (`services/release/githubApp.ts`, ~20 importers). The write client lives beside it, `services/release/github/{write,allow}.ts`, not in `core/github/write.ts` (rule 6, D-G1). Distribution's token route reaches it through one core hook (A-32.7).
- **G4.** The trusted publisher is already manifest-driven with server-resolved ids (`core/publisher.ts:23-35`, `stmtUpsertManifestPublisher`); a manifest cannot grant itself scopes (:248-252); `DEFAULT_CI_SCOPES` = publish, promote, report. UX-62's policy row is a read plus a scope grant.
- **G5.** Tap and bucket PRs need a personal token today (`prRun.ts:69-70,385-391`, `PKEY_PR_TOKEN`); sync skips homebrew, scoop and flathub without it (`channelSync.ts:94-102`).
- **G6.** `pkey ci init` does not exist (UX-62's One command, `SETUP.md:1383-1389`).
- **G7.** The wizard kit has no `RepoChangeStep` (`ui/wizard/steps.tsx`: `ChoiceStep`, `FormStep`, `SnippetStep`, `DoneStep`); A-32 is its first consumer (ST-39).
- **G8.** The workflow pins `@<commit-sha>` (`FirstReleasePanel.tsx:49-57`, `features/ship-builds/ci.md`). The Worker knows its commit (`PKEY_GIT_SHA`, D-G5).
- **G9.** UX-62's last step `pkey storefronts sync` is replaced by A-25's `channels: auto`; the workflow has no such step.
- **G10.** The scope is over budget (UX-62 L + UX-70 L + UX-71 M). Deferred to follow-ups (D-G2): CI secrets through the App (W19, a sealed-box dependency), repository creation from a template (D39), the storefront wizards adopting `RepoChangeStep`.
- **G11.** SETUP D38 names "Environments" for the `release` environment. GitHub's REST reference puts environment create/update and ruleset create/update under **Administration: write**. The action table in `services/release/github/allow.ts` is the one source (below).
- **G12.** The CI-secret live check exists (`distribution/ciSecretCheck.ts`, UX-69); only its write half (W19) is deferred.
- **G13.** Verify misses the CLI, admin and shared-manifest suites; each slice names the suites it touches.

### Write allow-list (A-32.1)

Permissions checked on GitHub's REST reference, "Fine-grained access tokens for ...", 2026-10-24. Metadata: read rides on every token.

| Action         | Endpoint                                                                     | App permission                     |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `setup.branch` | `GET /repos/{o}/{r}/git/ref/heads/{branch}`                                  | Contents: read                     |
|                | `POST /repos/{o}/{r}/git/refs` (`refs/heads/pkey/setup`)                     | Contents: write                    |
|                | `PATCH /repos/{o}/{r}/git/refs/heads/pkey/setup` (no `force`)                | Contents: write                    |
| `setup.file`   | `GET /repos/{o}/{r}/contents/{path}?ref=pkey/setup`                          | Contents: read                     |
|                | `PUT /repos/{o}/{r}/contents/{path}` (branch `pkey/setup`)                   | Contents: write                    |
|                | `PUT .../contents/.github/workflows/release.yml`                             | Contents: write + Workflows: write |
| `setup.pr`     | `GET /repos/{o}/{r}/pulls?head={o}:pkey/setup&state=open`                    | Pull requests: read                |
|                | `POST /repos/{o}/{r}/pulls` (head `pkey/setup`)                              | Pull requests: write               |
|                | `PATCH /repos/{o}/{r}/pulls/{n}` (title, body only)                          | Pull requests: write               |
| `env.release`  | `PUT /repos/{o}/{r}/environments/release`                                    | Administration: write              |
|                | `POST .../environments/release/deployment-branch-policies` (`v*`, tag)       | Administration: write              |
| `ruleset.tags` | `GET /repos/{o}/{r}/rulesets`                                                | Metadata: read                     |
|                | `POST /repos/{o}/{r}/rulesets`, `PUT .../rulesets/{id}` (tag `refs/tags/v*`) | Administration: write              |

Never: merge, close, retarget, delete a ref or file, force update, any branch but `pkey/setup`, any path outside `.pkey/{distribution,release}.{yaml,yml,json}` and `.github/workflows/release.yml`, collaborators, settings, hooks, secrets, another repository.

## Goal

GitHub write path and Publish from CI, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-17** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §6, for **DC-17**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- A setup pull request (outlet blocks, workflow), the release environment and a v\* ruleset, the trusted-publisher policy and the CI installation-token exchange (UX-70, UX-71, UX-62); a One-command fallback when the GitHub App lacks the optional write permissions (owner step); security review. Absorbs UX-62, UX-70 and UX-71.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-17**; DX consolidation H: Distribution channels, storefronts and commerce.
- Security review and THREAT-MODEL rows before merge (`sec`).
- Needs an owner step (`github-app`; tracks.md Track A, lead action 5, and `~/Downloads/polaris-key-owner-steps.md`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Setup opens one PR instead of manual edits
- [ ] Works without write permissions via One command
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-32 done`.
