# LX-41b Console durations and subscriptions: When it ends, trials, the subscription panel, Preview at a date

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)               |
| Size        | 0.5–0.7 engineer-weeks                                                                                         |
| Depends on  | [LX-41](LX-41-durations-subscriptions-core-trials.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-43](LX-43-licensing-presets-1-x-helper-new-major.md)               |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                          |
| Plan mode   | yes: executes the approved [`plans/LX-41.md`](../plans/LX-41.md) (2026-10-08) §7 item 2                        |
| Gates       | `plan-mode`, `console-csp-parity`                                                                              |
| Human input | none                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Goal

Operators set how a licence ends, give trials, and run manual subscriptions from the console, over the routes LX-41 built. Done when every acceptance criterion holds and the green gate passes.

## Why

LX-41 ships the server half with no console (its plan's §7 split). Until this lands, durations and subscriptions exist only through the API.

## Read first

- `AGENTS.md` (always), `CLAUDE.md`, and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- [`plans/LX-41.md`](../plans/LX-41.md) §2 (semantics), §6.3 (the six console routes and the CI upsert), §7 item 2 and Q1, Q4.

## Scope

**In** (`plans/LX-41.md` §7 item 2):

- The tier Duration group's "When it ends": Stop working, Keep the last version, Move to tier…, with the Release-off and "binds on Entitled delivery" notes.
- A licence's duration override and "Give a trial…".
- The subscription panel, the one subscriptions view: Start, Renew…, Cancel and Resume for `manual` subscriptions; store and `external` rows read-only; a `license:subscriptions` token's expiry.
- Preview at a date….
- The `license:subscriptions` scope in the CI token dialog (`console/pages/core/KeysCi.tsx`).
- The dunning row: `pending` removed, shown only when a subscription source exists.

**Out** (and where it belongs instead):

- Routes and semantics (→ LX-41); presets that fill "When it ends" (→ LX-43); the portal duration line (→ LX-15); the token-expiry attention kind (→ ST-44).

## Design notes

- A tier's new "When it ends" applies to licences sold after the change; there is no bulk apply (Q1).
- Copy is terse and in the reader's terms; the UX reviewer checks it beside the code review.

## Steps

1. Verify the brief against LX-41's merged routes and record corrections here.
2. Build the controls; run the green gate; hand off for code and UX review.

## Acceptance criteria

- [ ] Each control in Scope calls LX-41's route, and its errors show the route's reason.
- [ ] Store and `external` subscriptions are read-only in the panel.
- [ ] `pkey-ux-reviewer` passes the screens in a real browser, both themes and phone width.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

LX-43's presets write `onExpiry` through this package's "When it ends" control. The role agent sets `--set LX-41b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-41b done`.
