# P0-43 CI consolidation

| Field       | Value                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                              |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                               |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md)                                                                                                                                      |
| Unblocks    | [P0-46](P0-46-lint-baselines-debt-ledgers.md), [P0-51](P0-51-1-0-readiness-review.md), [SP-36](SP-36-examples-in-one-tree-built-in-ci.md), [AX-04](AX-04-pnpm-gate-in-the-repo.md) |
| Role        | `pkey-implementer`                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                 |
| Gates       | none beyond the green gate                                                                                                                                                         |
| Human input | none                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                          |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

CI consolidation, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-02** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.3, for **CQT-02**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- Composite setup-js action for the 17 repeated setup blocks; tools/ci-scope.json shared with gate.sh; a changes job and a ci-ok aggregator; PR versus main matrices; swift and apple lanes merged; duplicated named test steps removed.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-02**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections from the code (2026-10-11)

- Setup blocks: 21 repeated pnpm, Node and install sequences were found, not 17 (ci.yml 9, native-desktop.yml 2, feed-closure.yml 1 and the release workflows). The composite action `.github/actions/setup-js` (inputs `node-version`, `install`, `install-args`) replaces the ones in `ci.yml`, `native-desktop.yml` and `feed-closure.yml`. `deploy.yml`, `publish-sdks.yml`, `npm-repair.yml` and `sync-worker-secrets.yml` keep theirs inline: `npm-repair.yml` checks out an old tag, and the two workflow tests pin those steps to commit SHAs.
- `gate.sh` is not in the repository (`/Users/vlad/Repos/pk-wt/_lead/gate.sh`, the lead's). The repository side is `tools/ci-scope.json` and `tools/ci-scope.mjs`; gate.sh changes its `touches` calls to `node tools/ci-scope.mjs touches <lane> --worktree` (lanes `docs`, `python`, `swift`, `godot`) in place of its `SHARED` regex. That edit is the lead's and is not part of this branch.
- `ci.yml` now has a `changes` job, lane gates on every job but `js`, the `js` docs link check gated on lane `docs`, matrices read from the scope file (PR: the floor and the latest; main: full) and `ci-ok` (name `CI OK`), the one check branch protection should require. The old `swift` job is merged into `apple`, except its Xcode 16.4 half, which stays as the build-only `swift-floor` job (see the review fixes below); `releaseWorkflows.test.ts` still pins `jobs.apple` on macos-26. The duplicated "Adapter conformance and spec classification" step is removed (`pnpm test` runs those suites); the transcript check named in the audit already runs only inside `pnpm gen --check`.
- Review fixes (2026-10-11), each pinned by `tools/ci-scope.test.ts`: a pull request whose changed files cannot be listed takes the full matrices as well as every lane (the reduced matrices were chosen from the event alone); `changedFiles` lists a rename at both its old and its new path (`--no-renames`) and reads NUL-separated paths (`-z`, so a non-ASCII name is not C-quoted into a path no lane matches); the `python` lane names the Python samples (`examples/python-cli/`, `examples/python-renpy/`, `examples/ui/terminal-python/`) and the two cross-SDK fixtures its tests open (`sdks/godot/tests/qr/fixtures.json`, `docs/design/ui-kits/terminal-parity.json`); `swift-floor` (macos-15, Xcode 16.4 selected by `sdks/swift/tools/select-xcode-16.sh`, which fails on Swift 6.3 or later) builds the package and the iOS schemes the old `swift` job built, so the `#if compiler(>=6.3)` guards of `PolarisKeyPlatform` keep compiling out on the oldest supported toolchain, which `apple` (Xcode 26.6) never does, and it has its own lane, `swift-floor` (`sdks/swift/` alone), so a Godot or CLI change does not buy a second macOS run of the package; `native-desktop.yml` triggers on `.github/actions/setup-js/**` for push and pull request.
- Human input after merge: repository settings, branch protection `Require status checks`: replace the per-job checks with `CI OK`. Not done here.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] CI reads one scope file (`tools/ci-scope.{json,mjs}`; ci.yml `changes`)
- [ ] gate.sh reads `ci-scope.mjs`: moved to AX-04 (2026-10-22)
- [x] PR runs only affected lanes; main runs the full matrix
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-43 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-43 done`.

## Progress and continuation (2026-10-16)

Reconciled against main in the 2026-10-16 audit. Remaining:

- Lead's local gate.sh must read tools/ci-scope.json (AGENTS.md says it does not yet)
- Owner step: branch protection should require 'CI OK' instead of per-job checks
- Split Apple jobs not yet run on GitHub (per PR #67)

## Split 2026-10-22 (triage)

Set done on 10dfa01cc: `.github/actions/setup-js`, `tools/ci-scope.{json,mjs}` and its test, ci.yml `changes` / `swift-floor` / `apple` / `ci-ok`, the PR and main matrices. The "Apple jobs not run on GitHub" note above is stale (they have run on main since). The lead's `gate.sh` reading `ci-scope.mjs` (about 20 min) moves to [AX-04](AX-04-pnpm-gate-in-the-repo.md), which replaces gate.sh. Owner step: branch protection requires `CI OK`.
