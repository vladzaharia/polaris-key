# I-29 Retire per-product account toggles; one App sign-in page

| Field       | Value                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                       |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                  |
| Depends on  | [HA-12](HA-12-presentation-discovery.md), [ST-38](ST-38-service-table-five-features-one-service.md), [I-30](I-30-connections-one-oidc-relying-party.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-36](I-36-sign-in-integration-card.md), [ST-14](ST-14-portal-settings.md)                                     |
| Role        | `pkey-implementer`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                      |
| Gates       | none beyond the green gate                                                                                                                              |
| Human input | none                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-02** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Goal

Retire per-product account toggles; one App sign-in page, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-02** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **IX-02**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- Stop reading oidc_enabled, magic_enabled, license_key_claim_enabled and auto_link_enabled (email and passkey always on, platform SSO when a connection exists, key claim always on), only after I-30's per-domain enforce exists, so a product that turned magic link off to require SSO keeps that control as an enforced domain; retire portal_product_settings.releases_enabled (portal downloads are gated on Ship builds plus the Polaris Key channel being live); /api/capabilities stops aggregating across tenants; Identity -> Portal and Identity -> Sign-in merge into Product -> App sign-in (Status, Methods derived, Key entry, Consent and terms, Customer portal, Presentation read-only from Core); a lead-run P0-49 dry-run lists products that had a toggle off and the enforced domain that replaces each.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-02**; DX consolidation F: Identity.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Four toggles and releases_enabled unread and never registered (ST-14)
- [ ] A product that had magic link off keeps SSO-only sign-in through an enforced domain (test)
- [ ] One App sign-in page
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-29 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-29 done`.
