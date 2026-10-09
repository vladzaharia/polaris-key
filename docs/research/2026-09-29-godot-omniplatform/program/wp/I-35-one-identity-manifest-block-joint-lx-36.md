# I-35 One identity: manifest block (joint with LX-36)

| Field       | Value                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                                                   |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                              |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md), [I-09](I-09-key-entry-attach.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md)                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-32](I-32-product-connections-absorbs-i-22.md), [I-34](I-34-granular-consent-connected-apps.md), [I-36](I-36-sign-in-integration-card.md) |
| Role        | `pkey-implementer`                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                  |
| Gates       | `rule-9`                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-10** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the rest of the §3 block (Q4), with no deprecation warnings.

## Goal

One identity: manifest block (joint with LX-36), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-10** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **IX-10**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- identity.{methods, connections, claims, terms, keyEntry, redirectPaths} with validator rules and schema; deprecated spellings through ST-19's mechanism (oidc.\* -> identity.connections[] or nothing for provider: platform; groupRoleMap and autoIssue.mode -> licensing.access; provisioning[] entitlements -> access-rule targets); the keyEntry block is the manifest side of the setting I-09 implemented (claimByKey included); no identity.native; settings registry entries; rule 9 drift gates (schema-parity test, manifest tests, bundle:action --check).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-10**; DX consolidation F: Identity.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `identity.app-sign-in-changes`, `identity.app-sign-in`.

## Acceptance criteria

- [ ] Rule 9 drift gates pass
- [ ] djdl's manifest resyncs clean
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-35 done`.
