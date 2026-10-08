# P0-38 AuthCard in ui/auth (UX-40)

| Field       | Value                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                      |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                     |
| Depends on  | [P0-36](P0-36-portal-on-copy-catalog.md)                                                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-12](PX-12-login-card-v2.md), [PX-14](PX-14-passthrough-header.md), [PX-15](PX-15-after-sign-in.md), [PX-21](PX-21-email-gate-ui.md), [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                         |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                  |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-08** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-40, UX-43.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: after a copy edit, regenerate `ui-matrix.json` with `pnpm gen:corpus` without holding the corpus lane (D13).

## Goal

AuthCard in ui/auth (UX-40), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-08** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQF-08**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- Promote LoginCard, ProviderRow, Glyphs and KeyField; one CodeEntry for SignInPage, StepUp and SignInMethods; step slots per SIGN-IN.md §8; t() only; the Worker twin renderAuthCard() in brandHtml.ts reads the same catalog (expired code or link with Send a new code, device pages with the product header; UX-43). PX-12, PX-14, PX-15, PX-21 and the console login (ST-30) build on it. Absorbs UX-40 and UX-43.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-08**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One AuthCard used by portal sign-in, step-up and console sign-in
- [ ] The Worker's renderAuthCard pages use the same catalog strings (test)
- [ ] No sign-in string outside the catalog
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-38 done`.
