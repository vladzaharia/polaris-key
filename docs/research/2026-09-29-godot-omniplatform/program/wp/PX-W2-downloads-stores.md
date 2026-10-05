# PX-W2 Downloads and stores (G2, G4) through Core hooks: `stores[]` per product and platform, `GET /api/products/:p/downloads`

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                             |
| Size        | 1–1.6 engineer-weeks                                                                                                                                                |
| Depends on  | [PX-W1](PX-W1-library-api-media.md)                                                                                                                                 |
| Unblocks    | [PX-W3](PX-W3-licensed-r2-downloads.md), [PX-09](PX-09-get-it-complete.md)                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                  |
| Gates       | the PORTAL.md §11 green gate; rule 6 (Core descriptor hooks; no cross-service imports); rule 10 (OpenAPI + `routeCoverage`); `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                           |

## Goal

The portal API returns store links per product and platform (`stores[]` `{kind, platform, url, live}`) and downloads shaped per product (`GET /api/products/:p/downloads`) through descriptor hooks in Core over Distribution's `page/model.ts` and `page/detect.ts`, without Identity importing Distribution internals.

## Why

"Also yours on" and a server-shaped Get it panel need store and download data the portal cannot reach today ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G2, G4). PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution)
- `packages/worker/src/core/hooks.ts`
- Distribution's `page/model.ts` and `page/detect.ts`
- `packages/worker/src/services/identity/portal/api.ts`

## Scope

**In:**

- A Core descriptor hook exposing store listings and download groups to Identity.
- `stores[]` on `GET /api/products/:p` and `GET /api/library` where the quick action needs it.
- `GET /api/products/:p/downloads` grouped per platform with detection hints.

**Out** (and where it belongs instead):

- Licensed R2 bytes (→ PX-W3)
- Email me the download (→ PX-W7)

## Design notes

- **Rule 6:** Identity (where the portal lives) may not import Distribution, Update or License internals; reach them through descriptor hooks in `packages/worker/src/core/hooks.ts` (PORTAL.md §10.2 notes).
- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W2:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W2 in-review`.

## Acceptance criteria

- [ ] Identity imports no Distribution module (the import-boundary test stays green).
- [ ] OpenAPI and `routeCoverage` cover the downloads route.
- [ ] Platform grouping unit tests over fixtures with several platforms and channels.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-09 renders these; PX-W3 adds R2-hosted licensed bytes behind the same shape.

The role agent sets `--set PX-W2 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W2 done`.
