# ST-27 Notification destinations: platform `alerts.destinations` and per-product overrides for auto-halt, store-connection and commerce alerts

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | ST: Settings architecture (S-18) (phase 3: coverage)                           |
| Size        | 0.6–0.85 engineer-weeks                                                        |
| Depends on  | [ST-05](ST-05-settings-admin-api.md), [ST-09](ST-09-platform-settings-area.md) |
| Unblocks    | none                                                                           |
| Role        | `pkey-implementer`                                                             |
| Plan mode   | no                                                                             |
| Gates       | THREAT-MODEL; rule 10 (OpenAPI + `routeCoverage`)                              |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

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

## Acceptance criteria

- [ ] A private-range or non-HTTPS URL is refused (test).
- [ ] Alerts go to the product override when set (test).
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
