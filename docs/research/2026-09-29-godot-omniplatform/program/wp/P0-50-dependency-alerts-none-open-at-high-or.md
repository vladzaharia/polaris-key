# P0-50 Dependency alerts: none open at high or medium

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation A: Ground truth, decisions and quick wins) |
| Size        | 0.2–0.5 engineer-weeks                                                                                |
| Depends on  | none                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                |
| Role        | `pkey-implementer`                                                                                    |
| Plan mode   | no                                                                                                    |
| Gates       | `ci`                                                                                                  |
| Human input | none                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                             |

## Consolidation 2026-10-07

Added to [Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins) by the lead on 2026-10-07: item 3 of the 1.0 bar ([README §12](../../../2026-10-07-dx-consolidation/README.md#12-versions-09x-now-10-later)) needs it. It has no row in `tracks.md`'s Track A table.

## Goal

Dependency alerts: none open at high or medium, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner decided on 2026-10-07 that the consolidation ships as the 0.9 line and that 1.0 is decided later, from P0-51's readiness review against the 1.0 bar in [README §12](../../../2026-10-07-dx-consolidation/README.md#12-versions-09x-now-10-later). Item 3 of the bar (Secure) needs P0-50 done and no high or medium dependency alert open.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [README §12](../../../2026-10-07-dx-consolidation/README.md#12-versions-09x-now-10-later), item 3 of the 1.0 bar.
- The repository's Dependabot alerts (`gh api repos/vladzaharia/polaris-key/dependabot/alerts --paginate`), the root `package.json` (`pnpm.overrides`) and `pnpm-lock.yaml`.
- `.github/workflows/ci.yml`, where the new advisory step goes.

## Scope

**In:**

- GitHub Dependabot shows 28 open alerts on main: 10 high (electron, http-cache-semantics, source-map-js), 14 medium (electron, postcss-selector-parser, smol-toml) and 4 low (electron). Upgrade them, either directly or through pnpm overrides where the dependency is transitive. Confirm `electron` is only a dev/test dependency, or bump it in the kits that pin it. Add a CI step that fails on a new high-severity advisory in the production dependency tree.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track A (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Prefer a direct upgrade; use a `pnpm.overrides` entry only for a transitive dependency, with a comment naming the advisory.
- The CI step checks the production dependency tree only (for example `pnpm audit --prod --audit-level high`), so a dev-only advisory never blocks a release.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Zero open high or medium alerts on main after merge
- [ ] A frozen install works (`pnpm install --frozen-lockfile`)
- [ ] Gate green

## Verify

```sh
mise exec node@22 -- pnpm install --frozen-lockfile
mise exec node@22 -- pnpm audit --prod --audit-level high
gh api repos/vladzaharia/polaris-key/dependabot/alerts -X GET -f state=open --paginate --jq '.[].security_advisory.severity' | sort | uniq -c
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-50 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-50 done`.
