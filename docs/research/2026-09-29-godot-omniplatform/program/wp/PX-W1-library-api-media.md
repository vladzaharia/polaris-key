# PX-W1 Library API and media (G1, G5, G16): `GET /api/library`, `GET /api/products/:p` with `services`, seats and dormancy, support links, same-origin media proxy

| Field       | Value                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                                                                        |
| Size        | 1–1.6 engineer-weeks                                                                                                                                                                                                                                           |
| Depends on  | none                                                                                                                                                                                                                                                           |
| Unblocks    | [PX-W2](PX-W2-downloads-stores.md), [PX-W5](PX-W5-rename-newkey-preview.md), [PX-W6](PX-W6-purchase-source.md), [PX-W10](PX-W10-discover.md), [PX-W16](PX-W16-profile-avatars.md), [PX-08](PX-08-library-api.md), [PX-10](PX-10-focused-flows.md)              |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                             |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); rule 9 (validator rule, mutation table, JSON schema) if `supportUrl`/`supportEmail` are validated; THREAT-MODEL; CSP browser test (zero violations); `typecheck:workerd` and `test:workerd` |
| Human input | owner answers to PORTAL.md Q-2 (hero art field; recommended `headerUrl`) and Q-4 (media proxy storage; recommended R2, content-addressed)                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                      |

## Goal

The Worker serves `GET /api/library` (per product: presentation, status and reason, best license summary with seats, quick-action inputs, support links, Discover count) and `GET /api/products/:p` (adding licenses, devices, `services`), with `deviceLimit`, `activeSeatCount` and per-device `dormant`, `supportUrl`/`supportEmail` per product, and a same-origin media proxy `GET /media/:product/:asset` for developer art.

## Why

The front end groups licenses client-side and cannot show art, seats or support links ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G1, G5, G16); the site's CSP is `img-src 'self' data:`, so art must be same-origin ([PORTAL.md §7](../../../../design/PORTAL.md#7-layout-and-visual-details)). PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §7](../../../../design/PORTAL.md#7-layout-and-visual-details)
- `packages/worker/src/services/identity/portal/api.ts`, `packages/worker/src/services/identity/portal/repo.ts`, `packages/worker/src/services/identity/portal/index.ts`
- `packages/worker/src/mount.ts` and `test/routeCoverage.test.ts`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- `GET /api/library` and `GET /api/products/:p` (with `services`, including `services.cloudSync` and `services.identity` as known today) for the signed-in account.
- Presentation from `ManifestListing` (`name`, `developerName`, `iconUrl`, `headerUrl`, `tintColor`, `website`).
- Seat data: `deviceLimit`, `activeSeatCount`, per-device `dormant` (G5).
- `supportUrl`/`supportEmail` per product (G16), with a validator rule if validated in the manifest (rule 9: rule, mutation-table entry, JSON schema).
- Media proxy `GET /media/:product/:asset`: fetch-once from allowlisted sources, re-encode to the §7 sizes, store per Q-4, serve same-origin.
- `GET /api/me` stops re-running `syncAccountLicenseLinks` on every call once `GET /api/library` exists (§10.2 notes).

**Out** (and where it belongs instead):

- Downloads and stores (→ PX-W2)
- Discover data beyond the count placeholder (→ PX-W10)
- Avatars (→ PX-W16)

## Design notes

- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Rule 6:** Identity (where the portal lives) may not import Distribution, Update or License internals; reach them through descriptor hooks in `packages/worker/src/core/hooks.ts` (PORTAL.md §10.2 notes).
- **THREAT-MODEL (SSRF):** the proxy fetches only from declared listing URLs on an allowlist, never follows redirects to private ranges, caps size and decodes images before re-encoding.
- **Overlap with the re-cut S-16/S-17 graph:** I-11 also names the Library and product-page API. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W1:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W1 in-review`.

## Acceptance criteria

- [ ] OpenAPI operations and `routeCoverage` entries exist for every new route (rule 10).
- [ ] A THREAT-MODEL row covers the media proxy's SSRF surface, with tests for redirect-to-private and oversize responses.
- [ ] A CSP browser test loads real proxied art with zero violations.
- [ ] If `supportUrl`/`supportEmail` are manifest fields, rule 9's validator rule, mutation-table entry and JSON schema land together.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen transcripts --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-08 consumes `GET /api/library`; PX-W2, PX-W5, PX-W6, PX-W10 and PX-W16 extend these routes.

The role agent sets `--set PX-W1 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W1 done`.
