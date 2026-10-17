# DOC-10b Channels

| Field       | Value                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Developers: features) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                      |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                      |
| Role        | `pkey-implementer`                                                                                                          |
| Plan mode   | no                                                                                                                          |
| Gates       | `docs-generated`, `docs-links`                                                                                              |
| Human input | none                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                   |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-10b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `channels/*` (index with the decision table and the matrix section, delivery, rollouts, availability, App Store, Google Play, Microsoft Store, Steam, install sources, update health, storefronts, Polaris Key with listing); `features/ship-builds/commerce` until CM-29; `build/manifest/distribution`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`services/distribution`; `packages/cli/src/{distribution,channels}.ts`, `storefronts/`; the store adapters

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [x] The common definition of done in the docs plan §6.3 holds.
- [x] No "outlet" in prose (the code word only, in code spans).
- [ ] `pkey-wp-reviewer` passes the package.
- [x] The green gate passes (lead gate on wp/DOC-lane-C, 2026-10-16; step 6 retried once under machine load 300 to 550) (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-10b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-10b done`.

## Verification notes (2026-10-16)

- Vocabulary pass on `channels/*`, `commerce` and `build/manifest/distribution`: prose "outlet" became "channel" (a place builds reach customers), and the release-track sense of "channel" became "release track" first, so the two never share a word. Console labels are quoted as the screen shows them (**Outlet credentials**), in bold. Code identifiers, routes and file names keep `outlet`.
- `channels/app-store` ran over its type budget: Distribute, Pushing the listing, In-app purchases and the App Store page moved to `channels/app-store-distribute`. Anchors that changed (`#channel-capabilities`, `#channel-readiness`) were updated site-wide.
- `channels/feeds` is titled Install sources (the glossary word). `channels/index` gained **Choose a channel**, built from `OUTLET_KINDS` in `shared-protocol/src/distribution.ts`; the Distribution matrix section was already there.
- HTTP lines the lint could not match (store APIs, manage-API routes outside the OpenAPI spec) are written as path then method, for example `/v1/webhooks` (POST). The routes were checked against `worker/src/console/routes.ts`.
- Not done: a per-claim file:line list for the unchanged body text (carried over from the services pages); the Windows and Linux store pages (`channels/*` for itch, Snap, winget live in `ci-stores` and `storefronts`).
