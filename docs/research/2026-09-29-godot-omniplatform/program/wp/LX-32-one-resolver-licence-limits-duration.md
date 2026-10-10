# LX-32 One resolver for licence limits and duration

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                    |
| Size        | 0.6–0.9 engineer-weeks                                                                                                              |
| Depends on  | [LX-08](LX-08-licensing-expand.md)                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-29](LX-29-new-license-wizard.md), [LX-33](LX-33-licence-tier-platform-default-every.md) |
| Role        | `pkey-implementer`                                                                                                                  |
| Plan mode   | no                                                                                                                                  |
| Gates       | none beyond the green gate                                                                                                          |
| Human input | none                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-32** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Goal

One resolver for licence limits and duration, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-32** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, for **LX-32**.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- core/licensing/terms.ts resolveLicenseTerms (identifier kept; UI word Limits) with per-field sources, behaviour-preserving: switch services/license/document.ts:136, identity/browserSession.ts:302, config/document.ts:144, licenseDeviceLimitInfo, tierFingerprintMode, injectAdminPolicy, the portal seat meter and the consent line; licence reads return terms; delete the console's effectivePolicy copy (shared.tsx:283).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-32**; DX consolidation E: Licensing model.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `licenses.change-tier`, `licenses.detail`, `entitlements.license-subscription`.

## Corrections found in the code (2026-10-09)

- The resolver lives at `packages/worker/src/core/licensing/terms.ts` (pure, no imports; the
  Worker adapter is `licenseTermsOf` in `core/entitlements.ts`, the async read is `licenseTerms`
  in `core/authz.ts`). The console imports the same file for its live read-out of unsaved forms.
- Today's rules are kept: offline days are licence else product (the tier's grace is stored for
  LX-09 and not read), channels are the union of tier and licence, versions the tighter bound.
  LX-33 changes the rules, not the resolver's shape.
- `graceClampFor` computes the same offline default in SQL (`COALESCE`); it is left for LX-33.
- Licence reads (admin summary and detail) now carry `terms`.

## Acceptance criteria

- [x] Signed documents byte-identical (tests)
- [x] One terms implementation (grep test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-32 done`.
