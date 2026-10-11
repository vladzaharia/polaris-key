# F-36 Feed cleanup on by default (dev and main prereleases)

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)           |
| Size        | 0.3–0.5 engineer-weeks                                                                     |
| Depends on  | [P2-08](P2-08-built-in-dev-release-track-default-store.md)                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [F-38](F-38-feeds-console-cleanup-and-registry.md) |
| Role        | `pkey-implementer`                                                                         |
| Plan mode   | no                                                                                         |
| Gates       | `threat-model`                                                                             |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-04** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Feed cleanup on by default (dev and main prereleases), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-04** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, for **FX-04**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- The existing rule (services/release/packages/prune.ts:1-50: prereleases at or below V are pruned when V publishes on stable) turns on by default for tenants (release.packages.prunePrereleases, prune.ts:48) after a one-time dry-run notice, and prunes the built-in dev channel beside the system main; OCI covered; public registries never pruned. No new setting, no per-channel ephemeral flag.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-04**; DX consolidation I: Packages, updates and packs.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections found against the code (2026-10-11)

- The brief said `prune.ts` prunes "prereleases at or below V ... on stable"; the code pruned only
  the `main` channel by version SHAPE (`X-main.N`, `X.devN`). The built-in `dev` channel (P2-08)
  has its own spelling, `X-dev.N` (PyPI `X.devN`), and a build is a candidate only on the channel
  its spelling belongs to (`ephemeralPrerelease`). OCI needed no change: it reads the same rows.
- "A one-time dry-run notice" had no mechanism. It is `release_package_retention_notices`
  (placeholder `00XX_`, the lead numbers it) plus one `package.prune.notice` audit row, raised by
  Release's cron hook or the first stable publish; cleanup starts `PRUNE_NOTICE_SECONDS` (a week)
  later. A stored `release_package_retention` value (on or off) is the operator's choice and wins
  at once. The registry default flips to `true`; no new setting and no per-channel flag.
- `pruneRetentionOf` takes `now` (the default depends on the notice window); the retention route's
  GET and the prune report carry `source` and `notice`, the data F-38's dialog reads.
- The public registries are never pruned: the prune has no network client; a test pins it.
- The stable-tag backstop job's "builds of main only" check in `publish-sdks.yml` admits `X-dev.N`.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `packages.cleanup-dry-run`, `packages.feeds`, `packages.release-tracks`.

## Acceptance criteria

- [x] Tenants get pruning on after a dry-run notice
- [x] -main.N and dev builds disappear at the next stable
- [x] Docs, in this PR (`features/ship-builds/packages/index`, `build/install`, RUNBOOK, THREAT-MODEL; `help/packages` has no page yet: a stub owned by the docs lane) ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/packages/*`; `build/install` (private feeds); `help/packages`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-36 done`.
