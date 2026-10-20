# ST-27 Notification destinations on core/notify

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (phase 3: coverage)                                                                               |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                          |
| Depends on  | [ST-09](ST-09-platform-settings-area.md), [P0-21](P0-21-notification-substrate-core-notify.md), [ST-05a](ST-05a-one-settings-read-write-path.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                               |
| Plan mode   | no                                                                                                                                               |
| Gates       | THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`)                                                                                                |
| Human input | none                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Destinations are core/notify (P0-21), no new email path; absorbs UX-37 alerts-from-attention (reading ST-44's attention read); adds access.changed and commerce alert kinds (notifications failing, unmapped purchase, identity mismatch, refund spike).

- Title: was "Notification destinations: platform `alerts.destinations` and per-product overrides for auto-halt, store-connection and commerce alerts".
- Depends on: added P0-21 and ST-05a; removed ST-05.
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-37.

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Push delivery uses SP-66's Standard Webhooks format once SP-66 is approved; until then ST-27 signs with the same signer.

## Goal

Operators set notification destinations: a platform `alerts.destinations` (email among allowed senders, HTTPS webhook with a signing secret) and per-product overrides for auto-halt, store-connection and commerce alerts.

## Why

Operator alerts have no configurable destination ([S-18 §7.2](../../notes/S-18-settings-architecture.md#72-open-questions-not-blocking-phases-01)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-27, [S-18 §7.2](../../notes/S-18-settings-architecture.md#72-open-questions-not-blocking-phases-01).

## Scope

**In:**

- Registry entries, routes (rule 10), delivery through the existing email path, webhook delivery with signing.

**Out** (and where it belongs instead):

- Developer webhooks (descriptor reserved; I-04 Q8).

## Design notes

- The webhook URL is SSRF-shaped: HTTPS only, no private ranges; THREAT-MODEL row.

## Steps

1. Entries and routes.
2. Delivery.
3. Tests.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `admin.platform-settings`.

## Acceptance criteria

- [x] A private-range or non-HTTPS URL is refused (test: `test/alertDestinations.test.ts`, "webhook URL guard", route 422 `url_refused`, and a redirect is refused at delivery).
- [x] Alerts go to the product override when set (test: `test/alertDestinations.test.ts` "delivery", and `test/autoHalt.test.ts`).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set ST-27 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-27 done`.

## Built (2026-10-17)

- **Storage.** `notify_destinations` (address or `https://host/…`, alert kinds, enabled, version,
  last outcome) and `notify_destination_secrets` (the webhook URL and the `whsec_` signing secret
  sealed together under `PLATFORM_KEK`, kind `notify-destination`, re-sealed by the KEK sweep).
  Migration `0123_notify_destinations.sql`; the lead renumbers it at merge time.
- **Registry.** `alerts.destinations` (platform) and `core.alerts.destinations` (product): rich
  entries, written through dedicated routes rather than the scalar settings route, so the secret
  never passes through `writeSetting()` and its audit.
- **Routes** (rule 10, in the OpenAPI spec): `/platform/alerts[/:id[/test]]` and
  `/products/:slug/alerts[/:id[/test]]`. `POST` and `PATCH` are step-up rows (`STEP_UP_ROUTES`).
- **Delivery.** `raiseAlert()` (`core/notify/alertDestinations.ts`): the product's destinations for
  the kind replace the platform's; email goes through `deliverEmail`, a webhook through
  `core/notify/alertWebhook.ts` (both URL guards, redirects refused, Standard Webhooks signature).
  Wired to the auto-halt (halt and store-rollout alert). The other kinds (`store_connection`,
  `commerce`, `access_changed`) are defined and deliverable; their emit sites belong to the
  packages that own those events (P0-51 readiness, ST-44's attention read).
- **Console.** `console/sections/notify/AlertDestinations.tsx` in Platform → Settings → Email and
  alerts and in a product's Settings → Alerts.
- **Threat model.** "Notification destinations: operator alerts (ST-27)".

## Fix round 2026-10-19

- Security review: DELETE is a step-up row; atomic guarded update; per-scope test caps from the audit
  trail; no test send to a product's email address until confirmation exists; parallel delivery;
  tests do not move `failures`; a product's `notifications_failing` stays in its scope.
- UX review: PATCH checks the step-up in its handler (only `enabled: true` skips it); one
  page-level sign-in callout, shown once an action needs it; one-line rows with a ⋯ menu; an Edit
  dialog (URL write-only behind Replace URL); field errors under the field; "5 of 5"; `retryAfter`
  countdown on a throttled test; the last delivery error (`last_error`, host and status only); the
  per-kind routing summary; focus after Remove, Done and a new secret.
- **Follow-up, not built:** dual-secret signing for 24 h on rotate (sign with the old and the new
  secret, as Stripe's roll does), so a rotation has no gap. Today a new secret ends the old one at
  once.
