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

## Corrections (2026-10-23)

The code is the fact; plan: `_lead/plans/F-37-ST-46-A-29-slices.md` §0. F-37.1 landed F1 to F3.

- **F1.** The device-login start refused any CLI scope but `admin` (`deviceLogin.ts`), and the portal's lookup and approve answered every CLI record as expired. F-37.1 lets the start take `packages:read`, which only the portal approves; `admin` stays console-only.
- **F2.** Reuse `pkey login`'s `cli` flow, not the portal's session purpose. The poll mints `packages:read` through `mintAccountToken` (90 days by default).
- **F3.** The poll answer carries no feeds today; for `packages:read` it now answers `registryOrigin`, `username` and `feeds` (the reader behind `GET /api/me/tokens`). Decision D-F2.
- **F4.** The renderer already takes a real token (`{kind:"token"}`, `feedSetup.ts`). `renderCombinedFeedSetup` does not exist. Ecosystems: npm, pypi, swift, maven, oci, godot, cargo, go. Godot's token rides in its URL and only the console shows it.
- **F5.** "`--print` for CI" is today's default (`pkey feeds setup` with `--token-env`); no new flag (D-F4).
- **F6.** No alias: the Consolidation note above wins over the Scope line.
- **F7.** There is no `replaces` machinery; the break goes in `build/upgrade-to-0-9.md` as a Removed / Use instead table.
- **F8.** `pkey feeds fdroid` is named in `index.ts`, `feeds.ts`, `ci.ts`, `help.ts`, `test/feeds.test.ts`, `test/fixtures/build-metadata/make.sh`, `features/ship-builds/channels/feeds.md`, `features/ship-builds/ci-stores.md`, `THREAT-MODEL.md`, `polaris-key.v3.yaml` and three Worker comments; the Action's dist copy regenerates.
- **F9.** The docs targets exist: `features/ship-builds/packages/{index.md,publish.mdx}`, `build/install.mdx`, `help/packages.md`.

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `admin.cli-login`, `packages.feeds-setup`, `packages.feeds`, `packages.portal-packages`.

## Acceptance criteria

- [ ] Never writes a token into a project file
- [ ] Never writes an admin-scope token anywhere (test)
- [ ] One command configures every package manager a product uses
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/packages/*`; `build/install` (private feeds); `help/packages`.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-37 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-37 done`.
