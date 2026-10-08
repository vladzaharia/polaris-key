# I-19 Identity and portal docs (absorbs PX-19)

| Field       | Value                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, each phase)                                                                                                           |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                            |
| Depends on  | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-12](I-12-console-users.md), [I-14](I-14-game-verifiers.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                             |
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

- Developer docs: the sign-in step model (SIGN-IN.md §3), license choice and what end users see, `status: "choose"` on the exchange, `license_choice_required` on the card's Continue, Replace a device and its shared rate budget, sign-in licences; a glossary entry saying licences are not typed: every licence is account-bound and shows its origin in plain words ("From signing in", "Steam key ending 3WPLDA", "From Steam") (`start/concepts.md`; owner decision 2026-10-05: no 'Account-wide' label).

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **Key-entry limits page.** It documents for developers:
  - the product setting `identity.keyEntry.limit` (default 10, range 1–100, no unlimited value while Identity is
    on; set from the manifest once I-09 lands, from the console once ST-04 lands);
  - what counts (D20: a new device by key, a browser key session, a portal claim) and what never counts;
  - that the limit applies to licences in no account;
  - the `keyEntries` member and the `key_entry_limit` refusal with `manageUrl`.
- **Rollout.** Explain the platform switch `identity.keyEntryRefusals`: counting runs while it is off, and
  refusals start only when an operator turns it on. Publish this before the switch is turned on (PX-W9 §7).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs PX-19: one identity and portal docs package. Rewrite the stale services/identity/index.md; pages for connections and domain routing, product connections, pkey login and personal tokens, consent and Connected apps, store sign-in derived from channels; replace every PKEY_ADMIN_COOKIE recipe; snippets from SP-33b.

- Title: was "Identity docs: the account and Library, recovery, key-entry limits for developers, tenant-scoped native links, Steam and Game Center guides, privacy-notice inputs".
- Absorbs PX-19: One identity and portal docs package; customer help moves into the portal.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 1: customer help lives in the docs site's public Help area (D1); the portal links to it and keeps its in-product copy on the catalog. This package narrows to developer identity docs; the consumer identity articles are DOC-04b's, and each I- package updates its article.

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
