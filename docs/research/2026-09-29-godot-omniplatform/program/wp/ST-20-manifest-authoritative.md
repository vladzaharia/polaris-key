# ST-20 Manifest-authoritative mode with expiring break-glass claims: on and locked for the system product (7-day claims), deploy-hook summary of live claims, webhook resync of the system product refused

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 1: foundation)   |
| Size        | 0.4–0.55 engineer-weeks                                                |
| Depends on  | [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md) |
| Unblocks    | none                                                                   |
| Role        | `pkey-implementer`                                                     |
| Plan mode   | no                                                                     |
| Gates       | THREAT-MODEL                                                           |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

A product can be manifest-authoritative: console writes to claimable settings are refused except as expiring break-glass claims. It is on and locked for the system product `polaris-key`, whose break-glass claims last at most 7 days, and a webhook resync of the system product is refused.

## Why

The owner accepted manifest-authority for the system product ([S-18 owner decisions](../../notes/S-18-settings-architecture.md) item 1: model C; the system product is manifest-authoritative with 7-day break-glass claims): two environments deployed from the same commit must have the same product settings, so the deploy hook is its only writer ([S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 7–8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.5](../../notes/S-18-settings-architecture.md#45-manifest-interaction-model-c-made-safe) items 7–8, [S-18 §4.14.3](../../notes/S-18-settings-architecture.md#4143-the-two-real-products), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-20.

## Scope

**In:**

- `core.manifest.authoritative`, locked `true` for `system = 1` by a registry rule; offered per product for customers (default off, D14).
- Break-glass claim: reason required, L2, `expires_at` = earlier of 7 days or the first apply that changes that field.
- Every resync and deploy summary lists live break-glass claims; webhook resync of `polaris-key` refused with "the system product is applied by the deploy hook".

**Out** (and where it belongs instead):

- The dry-run plan UI (→ ST-17).

## Design notes

- An apply that leaves the field alone does not end a claim, so an unrelated deploy cannot undo an incident fix.
- ST-01b refuses all console claims on `system = 1` until this lands.

### Corrections from the code (builder, 2026-10-06)

- **No migration.** `product_settings.expires_at` already exists (ST-01b's migration 0086) and
  every claim guard already reads `expires_at > now`, so an expired claim stops counting with no
  job. The mode itself is a row-backed `product_settings` row (`value_json`).
- **The lock** is a new registry field, `systemLock: { value }`, plus the system-lock rule in
  `core/settings/rules.ts` (`SYSTEM_LOCKED_KEYS`): the registry test fails if the entry loses or
  changes its lock. `manifestAuthorityOf` reads the lock for `system = 1`, never a row.
- **Single writer, not only the webhook.** After `linkSystemProduct` the system product has
  `release_source = 'github'`, so the console's Resync (and its dry run) could also apply the
  monorepo's default-branch head. The refusal ("the system product is applied by the deploy
  hook") therefore sits in the webhook loop, the console resync route and `resyncRepo` itself.
- **The deploy hook applies no claimable product field today** (`linkSystemProduct` never wrote
  the name, licence defaults, web origins or catalog). It now ends a break-glass claim whose field
  the deployed `.pkey/` changes or whose 7 days ran out and writes the manifest's value for that
  field only; applying every claimable field there is ST-17's shared plan function (and waits for
  ST-01c's review of the live values).
- **Scope of the mode.** It governs the five `product_settings` claim keys (`CLAIM_KEYS`: name,
  licence defaults, web origins, catalog). Claimable settings still claimed through their older
  markers (`services_source`, `compat_source`, `access_source`, fingerprint and auto-issue
  policies, tier and profile rows, the trusted publisher) are not refused by it yet: they move to
  the one write path with ST-04/ST-05, which should call `decideClaim`.
- **The deploy summary in the job log** carries each claim's key and expiry only (the log may be
  readable beyond the operators); the reason and claimant are in the console and the platform
  activity row. `register-platform.mjs` prints each live claim as a warning annotation.

## Steps

1. Registry rule and claim expiry.
2. Deploy-hook summary.
3. Webhook refusal; tests.

## Acceptance criteria

- [x] A break-glass claim expires after 7 days or at the first apply that changes the field, whichever is first (test).
- [x] A webhook resync of the system product is refused (test).
- [x] The deploy-hook summary lists live claims (test).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-17's dry run shows break-glass claims (the worker's dry run already returns `breakGlass`).
- ST-04/ST-05: route the older-marker claimables through `decideClaim`, so manifest-authoritative
  mode refuses them too (services and registration, fingerprint and auto-issue policies, compat
  window, release access modes, tiers and profiles, trusted publisher).
- ST-17: the deploy hook applies every declared system-product field (today it applies only a
  field whose break-glass claim it ends).

The role agent sets `--set ST-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-20 done`.
