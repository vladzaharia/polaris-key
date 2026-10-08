# ST-38 Service table: five features; one service-off state (absorbs DC-12)

| Field       | Value                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)                                                                                                                                                                               |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                  |
| Depends on  | none                                                                                                                                                                                                                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-29](I-29-retire-product-account-toggles-one-app.md), [ST-40](ST-40-integration-facts-sdk-sightings.md), [ST-42](ST-42-create-defaults.md), [ST-44](ST-44-one-home-delete-get-manage-api-summary.md), [ST-46](ST-46-interactive-pkey-init.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                                                                                                      |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-66.

## Goal

Service table: five features; one service-off state (absorbs DC-12), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-02**.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- tools/services.json gains console.group and each feature's switches; gen:services emits them to the console only (SDK constants byte-identical). The Services area shows Licensing, Managed config, Ship builds (release + distribution, In-app updates on by default), Sign-in and Cloud Sync (turns on config and identity); each feature row holds its own switches (Package feeds, Customer portal, Polaris Key storefront visibility, Minted tokens) and its facts as status (Commerce: a storefront is ready); the registration policy is always derived (a declared value gets a validator warning) and the per-slug state is read-only under Advanced; anonymous entry has one home, the Anonymous devices row of license.access; one data-driven service-off state for every service page (UX-66). Release-only products are reported, never migrated.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-02**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Discovery, coherence codes and SDK constants byte-identical
- [ ] Turning on Ship builds writes release, distribution and update in one audited batch
- [ ] One service-off component
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-38 done`.
