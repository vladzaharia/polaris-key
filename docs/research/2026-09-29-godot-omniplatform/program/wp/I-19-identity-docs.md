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

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-24.md`](../plans/I-24.md):** the named-user seats docs page.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Developer docs: the sign-in step model (SIGN-IN.md §3), license choice and what end users see, `status: "choose"` on the exchange, `license_choice_required` on the card's Continue, Replace a device and its shared rate budget, Account-wide licences; glossary entry "Account-wide" (`start/concepts.md`).

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

- **The account and the Identity service are different things (owner, 2026-10-04).** The Polaris Key account is platform-level, part of Core and the portal, and always present; no product toggles it. Identity is the per-product service (console toggle and the SDK Identity feature): app passthrough sign-in ("<App> wants you to sign in"), and later app-specific profiles and "Sign in with <Product>". Products without Identity still attach licences to accounts through Activate License, the portal and Discover, but never show app sign-in.
- **Key-entry limits apply only with Identity on (owner, 2026-10-04).** Without Identity a key is the app's only activation path: unlimited key entry, and the portal offers the account upgrade but never forces it.
- **Cloud Sync needs sign-in (owner, 2026-10-04, final answers).** It requires the Identity service; its principal is the pairwise subject of the person signed in on the device, never the licence owner's, so key-activated devices and floating licences get no Cloud Sync. U-15a writes the Cloud Sync pages; these pages link to them.
- The decided defaults D17–D23 (owner, 2026-10-04): credentials only on the login card; a product's own IdP is product-only, linkable from the portal under step-up; console email is the buyer email, the account email only with consent; which key entries count; merge keeps the survivor's subject with an alias and a `subject.merged` event; "Continue to <App>" on the first sign-in per app and always on device code; dormant-account deletion at 36 months with a warning. Also the email step's join offer (both accounts proven in one session, never silent).
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
- [ ] The concepts page separates the platform account from the per-product Identity service, and the key-entry page says limits apply only with Identity on.
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
