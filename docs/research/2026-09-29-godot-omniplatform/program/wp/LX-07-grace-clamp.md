# LX-07 Clamp offline grace to licence expiry (G9), on by default after the affected-licence report, with a per-product opt-out

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.2–0.3 engineer-weeks                                                                  |
| Depends on  | [LX-06](LX-06-licensing-settings.md)                                                    |
| Unblocks    | none                                                                                    |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | THREAT-MODEL                                                                            |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q7: add one informative §3.6 sentence now ("`graceUntil` may be earlier when the licence expires sooner").

## Corrections (LX-07 build, 2026-10-06)

Recorded by the builder where the code or a closer reading changed the approach. The code is the fact.

- **The setting already exists and needs no `pending` change.** LX-06 registered `licensing.clampGraceToExpiry` (claimable `product_settings` row, default `true`, critical) without `pending`. LX-07 is its reader: `core/graceClamp.ts` resolves it through ST-04's `resolveProductSetting()` (a context built by hand reads the stored row the same way) and is added to the entry's `readers`. No migration, no new route, no manifest rule.
- **"The document" is every document a licence grants.** The clamp applies to the licence document, to the config document of a device that R1 binds to its licence (`services/config/document.ts`: its secrets already stop with the licence online, so its offline window stops too), to both inner documents of an offline bundle (the operator's `graceDays` is the window there; the `bundle.minted` audit summary says when it was clamped), and to Identity's fused browser-session document. A config-only product and a keyless device have no licence and are never clamped.
- **The clamp floors at the document's own `expiresAt`.** Every verifier refuses `graceUntil < expiresAt` (WIRE-CONTRACT-V4 §3, always enforced), so `graceUntil = min(window, max(expires_at, issuedAt + DOC_EXPIRY_SECONDS))`. A licence expiring within the hour gets an hour-long document; the licence route refuses the next fetch. A window already below that floor (zero days) is left unchanged.
- **The report is an offline tool, not a route.** The clamp is on for every product the moment the release deploys, so the report has to run before it, on a production copy: `pnpm --filter @polaris-key/worker grace-clamp:report -- --sql prod.sql --out dir` (`scripts/grace-clamp-report.ts`, the U-03 dry-run pattern; it writes nothing, checked). `graceClampReport()` lives in Core so LX-09's holder report (S-19 §7.3.4) reuses it. Adding a console route would have needed rule 10's OpenAPI entry and could not be read before the deploy.
- **Behaviour change in an existing field's value, not a shape change.** No claim, no corpus case and no `PROTOCOL_VERSION` change; §3.6 gains the informative sentence plans/LX-01.md Q7 approved.
- **Cost.** The setting is read only when the clamp would move the window, so a perpetual licence and a licence whose expiry lies past its window add no read to the document routes.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Already stamped done on main (2eb10597c); the hygiene PR leaves it. Merged (884e5780e). LX-40 removes the opt-out: the grace clamp is always on (null for keepVersion licences, LX-41).

## Goal

Offline grace is clamped to licence expiry on every product by default, after a report lists the affected licences, with a per-product opt-out (`licensing.clampGraceToExpiry`); grace is never clamped to a grant's expiry.

## Why

A licence expiring tomorrow with 30 offline days keeps working offline for 30 days (G9, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decision 7 accepted on-by-default ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 7).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps) G9, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-07.

## Scope

**In:**

- Affected-licence report; the clamp in the document's offline window; the setting's default.

**Out** (and where it belongs instead):

- Grant expiry (→ LX-12).

## Design notes

- Perpetual licences are unaffected.

## Steps

1. Report.
2. Clamp.
3. Document tests.

## Acceptance criteria

- [x] A licence expiring before its grace window ends gets a clamped window (test: `packages/worker/test/graceClamp.test.ts`, licence, config, bundle and browser-session documents through the reference verifiers).
- [x] Opt-out restores today's window (test: same file, through `writeSetting()`).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen corpus --check
```

## Hand-off

- **Owner, before the release that carries LX-07:** run the affected-licence report on a production copy and opt out any product that must keep the full window (RUNBOOK "Offline grace clamp (LX-07)").
- **LX-09:** the holder report (S-19 §7.3.4) lists the licences hit by the clamp by calling `graceClampReport()` (`packages/worker/src/core/graceClamp.ts`), not a second query.

The role agent sets `--set LX-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-07 done`.
