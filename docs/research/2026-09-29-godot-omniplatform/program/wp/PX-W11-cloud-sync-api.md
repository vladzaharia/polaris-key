# PX-W11 Cloud Sync API for the portal (G26) on top of the S-17 service: `services.cloudSync`, usage, classes, devices, export, delete with step-up

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                  |
| Depends on  | none                                                                                                                    |
| Unblocks    | none                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                      |
| Plan mode   | no                                                                                                                      |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                               |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [PX-18](PX-18-cloud-sync-section.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [PX-18](PX-18-cloud-sync-section.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One portal Cloud Sync package (API and card). Its 'not on Identity' note was wrong.

- Dependencies cleared on closing (they were U-05 and I-05), so nothing in the graph waits on or through a closed package.

## Goal

For products with the Cloud Sync service on, `GET /api/products/:p` carries `services.cloudSync` and `GET /api/products/:p/sync` returns `{quota, used, classes[], devices[]}`, with `POST …/sync/export` and `DELETE …/sync` under step-up.

## Why

The product page's Cloud Sync section needs these ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G26); Cloud Sync depends on the account and the license, not on Identity ([PORTAL.md §3.1](../../../../design/PORTAL.md#31-model)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `wp/U-05-cloud-sync-do.md`, `wp/U-12-privacy-settings-portal.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- The four portal routes over the S-17 service; step-up on delete.

**Out** (and where it belongs instead):

- UI (→ PX-18)

## Design notes

- **Cloud Sync** appears only on the product page of a product whose `services.cloudSync` is on; there is no global Cloud Sync page, nav item or account section.
- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Overlap with the re-cut S-16/S-17 graph:** U-12 also names the portal Cloud Sync section and its export and delete. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W11:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W11 in-review`.

## Acceptance criteria

- [ ] S-17's gates hold; delete requires a fresh step-up (test).
- [ ] A THREAT-MODEL row covers export.
- [ ] OpenAPI and `routeCoverage` cover every new route.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen transcripts --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-18 renders `CloudSyncCard`.

The role agent sets `--set PX-W11 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W11 done`.
