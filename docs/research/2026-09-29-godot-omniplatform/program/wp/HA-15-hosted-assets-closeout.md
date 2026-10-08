# HA-15 Hosted assets close-out: production backfill, Polaris Key system product `presentation.icon` as data, docs page, glossary terms, THREAT-MODEL rows, DJDL migration note

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 4: operate)                            |
| Size        | 0.4–0.6 engineer-weeks                                                                                         |
| Depends on  | [HA-07](HA-07-serve-hosted-copies.md), [HA-08](HA-08-release-mirroring.md), [HA-10](HA-10-hosting-settings.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                         |
| Role        | `pkey-implementer`                                                                                             |
| Plan mode   | no                                                                                                             |
| Gates       | docs links; generated docs; THREAT-MODEL                                                                       |
| Human input | an operator runs the production release-file backfill (HA-08's action) after deploy                            |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Close-out documents A-27's one listing truth instead of the manifest blob; presentation-access docs use generated SDK tabs.

## Goal

Production holds verified copies of every existing release file and presentation asset. The Polaris Key system product has an icon, supplied as data. The docs explain hosted assets end to end. The glossary and THREAT-MODEL carry S-20's terms and deltas.

## Why

It closes the migration with no client break, and documents the feature ([S-20 §6.8](../../notes/S-20-hosted-assets.md#68-migration-and-no-break-guarantees), §6.12).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §6.1, §6.8, §6.12.
- `packages/docs/src/content/docs/start/concepts.md`, `docs/security/THREAT-MODEL.md`, `admin/systemProduct.ts`, `packages/brand`.

## Scope

**In:**

- Backfill runbook.
- System-product icon uploaded through HA-06's path. No code branch on the slug (rule 5).
- Docs page "Hosted assets" under build/manifest.
- Glossary entries: hosted asset, source, slot.
- THREAT-MODEL rows.
- A note for DJDL: it may move its art into its private repo and retire `djdl-assets`. Optional; nothing breaks if it does not.

**Out** (and where it belongs instead):

- Changes in the DJDL repository itself.

## Design notes

- Docs are gated (rule 11). The repo is the agent-readable source.
- **Presentation is HA-12's.** The THREAT-MODEL subsection "Product presentation in discovery (HA-12)" is written by HA-12 ([`plans/HA-12.md`](../plans/HA-12.md) §6). HA-15 does not duplicate it; its rows cover the rest of S-20 §6.12.

## Steps

1. Runbook and backfill.
2. System icon.
3. Docs, glossary, THREAT-MODEL.

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/docs build` is green, including links.
- [ ] The THREAT-MODEL contains every S-20 §6.12 row.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

## Hand-off

None.

The role agent sets `--set HA-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-15 done`.
