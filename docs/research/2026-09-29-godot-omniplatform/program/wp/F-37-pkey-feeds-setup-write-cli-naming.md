# F-37 pkey feeds setup --write and CLI naming

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)             |
| Size        | 0.5–0.8 engineer-weeks                                                                       |
| Depends on  | [F-33](F-33-personal-tokens-pkeyp-packages-read.md)                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-38](SP-38-conditional-token-provisioning-sdk.md) |
| Role        | `pkey-implementer`                                                                           |
| Plan mode   | no                                                                                           |
| Gates       | `rule-9`                                                                                     |
| Human input | none                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-05** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.
- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).

## Goal

pkey feeds setup --write and CLI naming, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-05** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **FX-05**.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.

## Scope

**In:**

- pkey feeds setup --write mints its own pkeyp\_ token with only packages:read through the account device-code flow (the portal's deviceLogin.ts), never pkey login's admin token, and writes npm, yarn, pnpm, bun, uv and pip netrc, docker, swift registry login and gradle.properties at user level (--print for CI); renderCombinedFeedSetup in @polaris-key/manifest beside SP-33a's generator; pkey feeds fdroid becomes pkey storefront fdroid (alias kept for the CLI deprecation window in P0-24).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-05**; DX consolidation I: Packages, updates and packs.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Never writes a token into a project file
- [ ] Never writes an admin-scope token anywhere (test)
- [ ] One command configures every package manager a product uses
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-37 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-37 done`.
