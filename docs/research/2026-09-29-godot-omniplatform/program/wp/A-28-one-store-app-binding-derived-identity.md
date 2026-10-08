# A-28 One store-app binding with derived identity

| Field       | Value                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                                                                                                  |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                 |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md)                                                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-22](A-22-channel-page-status-releases-listing.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [A-31](A-31-derived-identities-short-pkey.md), [CM-21](CM-21-storefront-connection-notifications.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                     |
| Gates       | none beyond the green gate                                                                                                                                                                                                                             |
| Human input | none                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-11** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Goal

One store-app binding with derived identity, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-11** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §4.3, for **DC-11**.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- Commerce settings and outlet identity checks derive from platform_credential_pins (appStore.bundleId/appAppleId, play.packageName and steam.appId are no longer typed); a mismatch attention item; prefilled console fields; product-key products unchanged; absorbs CM-21's identity half; dist_purchase_binding_aliases replaced by one alias path.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-11**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No store identity is typed twice
- [ ] A pin mismatch raises attention instead of failing silently
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-28 done`.
