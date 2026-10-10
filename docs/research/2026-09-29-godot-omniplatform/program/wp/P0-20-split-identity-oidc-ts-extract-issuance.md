# P0-20 Split identity/oidc.ts; extract the issuance engine to core/licensing

| Field       | Value                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                    |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                     |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                                                                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-08](I-08-app-passthrough.md), [LX-10](LX-10-anchor-choice.md), [LX-25](LX-25-redeem-codes.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [LX-38](LX-38-account-keyed-automatic-licences.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                                                       |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Split identity/oidc.ts; extract the issuance engine to core/licensing, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.3, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.3, §5, for **CQW-06**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- core/licensing/issue.ts with issueLicense(product, holder, via, target, device?) and grantAddOn(licence, addon, source), extracted behaviour-preserving from oidc.ts (activateFromIdentity, identityIssuePolicy, previewIdentityIssue, identityTier, provisioning overlay, post-activation device limit); services/identity/productOidc/{config,browserFlow,deviceFlow,callback,chooser,poll,pages}.ts; RFC 8628 user codes shared with portal deviceLogin.ts. Semantics change later in LX-38. Also deletes the never-written account- and store-holder branches of core/grants.ts and the holder_versions and device_store_identities readers (behaviour-preserving: nothing writes them); LX-16b drops those tables.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-06**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Transcripts byte-identical
- [ ] Sign-in, Discover (issueFromPath) and codes call issue.ts
- [ ] oidc.ts under the file-size budget
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-20 done`.
