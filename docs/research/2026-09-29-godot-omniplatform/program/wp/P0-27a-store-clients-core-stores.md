# P0-27a Store clients and events to `core/stores/`

| Field       | Value                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation H: Distribution channels, storefronts and commerce)                    |
| Size        | 0.4–0.6 engineer-weeks                                                                                                            |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                           |
| Unblocks    | [P0-27](P0-27-one-adapter-store-delivery-commerce.md), [P0-51](P0-51-1-0-readiness-review.md), [CM-29](CM-29-commerce-service.md) |
| Role        | `pkey-implementer`                                                                                                                |
| Plan mode   | no; split from P0-27 by [`plans/CM-29.md`](../plans/CM-29.md) Q5 (approved 2026-10-08)                                            |
| Gates       | none                                                                                                                              |
| Human input | none                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                         |

## Goal

Each store's shared client, credentials and events live in `core/stores/<store>/`, so Commerce imports only `core/` and its own directory. Done when every acceptance criterion holds and the green gate passes.

## Why

CM-29 needs only this move from P0-27. Splitting it out keeps A-19 and the adapter fold off CM-29's chain (CM-29 Q5 and D3).

## Read first

- `AGENTS.md` (always).
- [`plans/CM-29.md`](../plans/CM-29.md) D3 and Q5; [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md) §5.7.

## Scope

**In:**

- Move the shared client, credentials and events of Apple, Play, Microsoft Store, Steam and itch.io to `core/stores/<store>/{client,credentials,events}`, and repoint every importer.

**Out** (and where it belongs instead):

- `StoreAdapter` facets, `requirements()` and folding `DistributionConnector` and `StorefrontRuntime` (→ P0-27); the move of Commerce's code to `services/commerce/` (→ CM-29).

## Design notes

- A move, not a rewrite: no behaviour, route or transcript changes.
- The boundary tests decide where each file may be imported from.

## Steps

1. List every store module and its importers; record corrections to this brief here.
2. Move them; run the green gate; hand off.

## Acceptance criteria

- [ ] Commerce code imports store clients only from `core/stores/` (boundary test).
- [ ] Transcripts byte-identical.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- boundaries commerce
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

P0-27 builds the adapters over `core/stores/`; CM-29 moves Commerce onto it. The role agent sets `--set P0-27a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-27a done`.
