# PX-W6 Purchase source and store grants (G8) through a Core descriptor hook

| Field       | Value                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                        |
| Size        | 0.4–0.8 engineer-weeks                                                                                                         |
| Depends on  | [PX-W1](PX-W1-library-api-media.md)                                                                                            |
| Unblocks    | none                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                             |
| Plan mode   | no                                                                                                                             |
| Gates       | the PORTAL.md §11 green gate; rule 6 (Core descriptor hooks; no cross-service imports); `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                      |

## Goal

The product page knows where a license came from (store, developer, grant) through a Core descriptor hook, so the License card can say "Bought on Steam" or "Bought from <developer>" accurately.

## Why

Today the portal can only say "Bought from <developer>" ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G8). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `packages/worker/src/core/hooks.ts`
- License service purchase records

## Scope

**In:**

- A Core descriptor hook for purchase source and store grants; the field on `GET /api/products/:p`.

**Out** (and where it belongs instead):

- UI changes beyond reading the field (→ PX-09)

## Design notes

- **Rule 6:** Identity (where the portal lives) may not import Distribution, Update or License internals; reach them through descriptor hooks in `packages/worker/src/core/hooks.ts` (PORTAL.md §10.2 notes).

**Corrections against the code (PX-W6, 2026-10-04):**

- The hook is a fourth read-only descriptor hook, `licenseProvenance` (License is its one provider), not an extension of `delivery`: the facts are License's (`license_store_grants`, written only by `services/license/storeGrants.ts`, and `licenses.origin` from `0011_auto_issue.sql`). Distribution's `dist_purchases` is not read: the effect on the licence is what the card reports.
- The field is per licence, not per product: `licenses[].purchase` on `GET /api/products/:p` = `{source, store, stores, grants}`, `source` one of `store` (an active store grant wins, because the bridge grants onto a licence that already exists), `developer` (`origin = 'admin'` or unknown), `sign_in` (`oidc`), `free` (`enroll`); `null` with License off. A grant shows its flag and label only for a `userGrant` flag; no purchase key or hash is ever returned.
- "Steam: Activate key" (`activateUrl` + the held key, PORTAL.md §10.2 notes) and the "Key not activated" status need a Steam key, which no table holds; that stays out of this package.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W6:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W6 in-review`.

## Acceptance criteria

- [x] Identity imports no License internals (boundary test).
- [x] Fixtures for each purchase source render the right source (tests).
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

The License card reads the purchase source.

The role agent sets `--set PX-W6 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W6 done`.
