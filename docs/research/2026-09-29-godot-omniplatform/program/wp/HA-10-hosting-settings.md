# HA-10 Hosting settings and quotas in S-18's registry: `assets.hosting.enabled`, `assets.releases.mirror`, `assets.quota.mediaBytes`, `assets.quota.releaseBytes`; usage in the console

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 4: operate)                      |
| Size        | 0.4–0.6 engineer-weeks                                                                                   |
| Depends on  | [ST-03](ST-03-settings-registry.md), [HA-05](HA-05-pull-on-sync.md), [HA-08](HA-08-release-mirroring.md) |
| Unblocks    | [HA-15](HA-15-hosted-assets-closeout.md)                                                                 |
| Role        | `pkey-implementer`                                                                                       |
| Plan mode   | no                                                                                                       |
| Gates       | rule 6 (boundaries); rule 10 (OpenAPI + routeCoverage); THREAT-MODEL; console CSP parity                 |
| Human input | none                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Goal

The four S-20 settings are registry entries with S-20's scopes and defaults. Ingest and mirroring enforce them. The console shows each product's usage against its quotas.

## Why

Quotas and the kill switch are knobs, and S-18 makes knobs registry settings ([S-20 §6.10](../../notes/S-20-hosted-assets.md#610-quotas-and-settings-s-18-registry-ha-10)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-18 §4–§5 and ST-03's brief.
- S-20 §6.10.

## Scope

**In:**

- Registry entries. `assets.hosting.enabled` is a platform runtime switch; the deny-list test must accept it.
- Enforcement points in `ingest` and the mirror consumer.
- Usage query and console display.

**Out** (and where it belongs instead):

- Per-file caps (code constants).

## Design notes

- Over quota: ingest fails with `quota` and the old copy keeps serving; mirroring stops and GitHub keeps serving.

## From the approved [`plans/HA-11.md`](../plans/HA-11.md) (2026-10-06)

- **The switch hides the discovery icon.** `assets.hosting.enabled` also gates the icon in
  discovery's `core.presentation`. Register `core/presentation.ts` among the setting's readers.
- **What off means there.** With the switch off, the member carries no `icon`, while the name and
  accent remain.
- **If HA-12 lands first.** HA-12 then reads nothing, and this package adds the read with a test.

## Corrections from the code (HA-10, 2026-10-06)

- **HA-12 has not landed.** `core/presentation.ts` does not exist yet, and the registry test
  refuses a reader file that does not exist, so HA-10 cannot list it. HA-12 reads the switch the
  way every HA-07 surface does, through `hostedImageOrigin(env, db)` (or `hostedImages`), and adds
  `core/presentation.ts` to `assets.hosting.enabled`'s `readers` in `core/settings/platform.ts`.
- **The switch read is asynchronous.** HA-07 said making the switch a settings read "touches
  nothing else"; a settings read needs the database, so `hostedImageOrigin` became
  `hostedImageOrigin(env, db)` and every HA-07 surface awaits it (the portal shell's CSP, the
  bytes host's document policy, `/media`, the library, the feeds, the download page).
  `hostedImageUrl` stays synchronous: it is only handed copies `hostedImages` answered, which is
  empty while hosting is off.
- **Where each setting lives.** `assets.hosting.enabled` is an A-13 store entry (row and `[vars]`
  name `ASSET_HOSTING`, `runtime`, area `delivery`), so Platform → Settings → Delivery switches it
  today. The two platform quota defaults are registry-only rows with no console writer until
  ST-05 and ST-16; the three product settings are written through `writeSetting()` by
  `PATCH|DELETE /manage/api/products/<slug>/assets/settings/<key>` (narrative-only admin routes,
  rule 10) and edited on the Presentation page.

## Steps

1. Entries.
2. Enforcement.
3. Console.

## Acceptance criteria

- [ ] Switching `assets.hosting.enabled` off restores today's behaviour on every HA-07 surface (test).
- [ ] Over quota, the old copy keeps serving (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

HA-15 documents the settings.

The role agent sets `--set HA-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-10 done`.
