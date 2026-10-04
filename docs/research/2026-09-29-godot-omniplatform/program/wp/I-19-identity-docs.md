# I-19 Identity docs: the account and Library, recovery, key-entry limits for developers, tenant-scoped native links, Steam and Game Center guides, privacy-notice inputs

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, each phase)                                                                                                           |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                            |
| Depends on  | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-12](I-12-console-users.md), [I-14](I-14-game-verifiers.md) |
| Unblocks    | none                                                                                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                                                                                 |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                           |
| Gates       | `check:links`; generated docs pages (`gen-docs` drift); privacy docs                                                                                                                               |
| Human input | none                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                          |

## Goal

Developers and end users have accurate docs for layer 1: the account and the Library, recovery ("remaining links, then the developer's licence tool"), key-entry limits for developers, tenant-scoped native links, Steam and Game Center guides, and the inputs for the Polaris privacy notice.

## Why

The shared account changes what developers can promise their users, and recovery is now the developer's job beyond a person's remaining links ([S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model)). S-16 lists the docs as following each phase.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (recovery, tenant-scoped links), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (key-entry limits), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-19.
- `packages/docs/src/content/docs/services/identity/`, `packages/docs/src/content/docs/start/concepts.md`.

## Scope

**In:**

- Concepts (the I-04 glossary), the account and Library, recovery, key-entry limits and the refusals, device code and web redirect quickstarts, tenant-scoped links, Steam and Game Center guides, the "system browser only" rule, and privacy-notice inputs (controller and processor split, deletion behaviour, D1 restore window).

**Out** (and where it belongs instead):

- Cloud Sync docs (→ U-15a, U-15b, U-15c).

## Design notes

- This package depends on I-14 for the platform guides. If the lead wants phase 1a docs earlier, ship the phase 1a pages in one PR and the platform guides in a second PR under this id.
- Never hand-edit generated docs pages; regenerate.

## Steps

1. Concepts and the account pages.
2. Developer guides; platform guides once I-14 lands.

## Acceptance criteria

- [ ] Every page above exists and links resolve (`check:links`).
- [ ] Recovery says plainly that Polaris runs no recovery desk.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- U-15a links to these pages from the Cloud Sync docs.

The role agent sets `--set I-19 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-19 done`.
