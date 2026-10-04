# I-04 Plan the layer 1 account contract: decision record replacing D-14, glossary, accounts/links/pairwise-subject data model and migrations, key-entry and attach wire, passthrough and web redirect routes, errors, parity ids, manifest schema, threat-model deltas

| Field       | Value                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-0)                                                                                                                                                                                   |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                  |
| Depends on  | none                                                                                                                                                                                                                                                                    |
| Unblocks    | [I-05](I-05-accounts-core.md), [I-06](I-06-login-providers.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [U-01](U-01-cloud-sync-plan.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                                                                                                                     |
| Plan mode   | yes: planning only; writes `plans/I-04.md`, which needs human approval (merging the plan PR)                                                                                                                                                                            |
| Gates       | plan mode; human approval                                                                                                                                                                                                                                               |
| Human input | owner answers S-16 §10 D24, D25 and D27 (proposed defaults; the plan encodes each default unless the owner says otherwise; D17–D23 were accepted on 2026-10-04); D27 also needs a legal review of the DPA wording                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                               |

## Goal

An approved plan, `plans/I-04.md`, that fixes every name and shape layer 1 of Identity depends on: one Polaris Key account across all products, sign-in methods as links, licences attached to the account, pairwise subjects per product, the bounded key-entry on-ramp, app passthrough (device code and web redirect), and the device binding and hooks Cloud Sync (S-17) builds on. I-05, I-06, I-07 and I-11 build to it; I-08, I-09, I-10a and I-10b execute it directly (`planRef`).

## Why

The owner decided on 2026-10-04 that Identity is two layers, with layer 1 (one account, Steam-like) shipping first ([S-16 owner decisions](../../notes/S-16-identity-service.md)). That replaces the earlier product-scoped plan this package was written for, so the contract is re-scoped ([S-16 §8.1](../../notes/S-16-identity-service.md#81-briefs-that-change)). Layer 1 is still device wire: two refusals on key entry, an attach route and the passthrough routes are additive, but each goes contract → `errors.json` → transcripts → six SDKs and the UI kits ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)). S-17 depends on the same contract for its principal ([S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block, 2026-10-04) and this brief's "Owner decisions" section below.
- All of [S-16](../../notes/S-16-identity-service.md), especially [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) to [S-16 §5.7](../../notes/S-16-identity-service.md#57-portal-surface), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) and [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions); [S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model), [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision) and [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) ("Changes to S-16 work packages").
- `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (D-14).
- `docs/security/WIRE-CONTRACT-V4.md`, `docs/security/THREAT-MODEL.md`.
- `packages/worker/migrations/0001_init.sql:64-81` (`licenses.sub`, `name`, `email`), `0008_portal.sql` (`portal_accounts`, `portal_license_links`), `packages/worker/src/core/devices.ts`, `packages/worker/src/services/license/activation.ts`, `tools/services.json` (the `identity` descriptor).
- `packages/shared-protocol/src/`, `conformance/parity/features.json`, `conformance/parity/errors.json`, `packages/shared-manifest/`.
- `packages/docs/src/content/docs/start/concepts.md` (glossary, rule 4); [`plans/F-20.md`](../plans/F-20.md) (the revocation hooks Identity must keep).

## Scope

**In:**

- The decision record replacing D-14 (owner decision D11), written into the services design spec by I-05.
- Glossary nouns (rule 4): account, sign-in method (link), Library, floating licence, key entry, pairwise subject, account × product data, personal details; "profile" keeps its managed-payload meaning.
- The D1 data model and migrations: `portal_accounts` → `accounts`; `account_links` keyed `(issuer_key, tenant_scope, subject)`; `account_product_subjects` with aliases; `licenses.sub` and `portal_license_links` → `licenses.account_id`; `license_key_entries`; `account_sessions`; `account_product_grants`; `account_passkeys`. A reversible migration with a production-shaped rehearsal (executed by I-05).
- **The device binding and Core accessors** that I-05 creates and S-17 relies on: the binding column, `resolveSyncPrincipal(device)` and `subjectFor(account, product)`, the one Core clearing hook and its triggers, the per-product merge-hook and deletion-hook registry.
- The one Core revocation hook's contract (F-21 and I-11 write against it).
- **The account/service split** (owner, 2026-10-04; supersedes D26): the Polaris Key account is platform-level, part of Core and the portal, always present and never a per-product toggle. The account, login card, Library, Discover, the portal's Activate License, licence attach in the portal, pairwise subjects and `subjectFor`, the account override layer and the console Users page are platform-wide for every product. The per-product `identity` service toggle (console toggle plus the SDK Identity feature) gates only sign-in _through the product_: passthrough sign-in ("<App> wants you to sign in") by device code, web redirect and native redirect, the exchange, device-wire attach, `subject()`/`signOut()`, key-entry limits and the `license_owned` key-entry refusal, the Users page's sign-in columns and sign-in settings, and layer 2. Cloud Sync declares `requires: [config]`: it depends on the account, not on the Identity toggle, and its principal is `devices.subject ?? subjectFor(licenses.account_id, product)`.
- Key-entry counting rules (D20, accepted) and the owned-licence refusal (D24, proposed), both only for products with Identity on (owner, 2026-10-04).
- The WIRE-CONTRACT-V4 Identity section: `key_entry_limit` (403, `portalUrl`), `license_owned` (403, `signInUrl`), optional `keyEntries: { used, limit }`, `POST /<p>/identity/attach`, device-code poll members (`subject`, `attachable`), the web redirect (`GET /<p>/identity/authorize`, S256 only, and the code-exchange route returning the activation response), discovery members (`account`, `keyEntryLimit`, later `exchange.kinds[]`).
- Error codes (at least `key_entry_limit`, `license_owned`, `link_conflict`, `last_link`, `redirect_uri_mismatch`, `invalid_grant`, `email_unavailable`, `interstitial_required` reserved for I-13), parity feature ids for every SDK-facing call, and the `.pkey/product` `identity:` block (`keyEntryLimit`, `claimByKey`, `native`, `requireTerms`, `redirectPaths`) with its validator rules (rule 9) and the App Review 4.8 warning.
- THREAT-MODEL text for [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 1–17, to land with the implementing packages.
- Which later packages need their own plans (I-13, I-15, I-20, I-24, I-25) and what this plan pre-decides for them.

**Out** (and where it belongs instead):

- Code of any kind (planning only).
- The exchange route in detail (→ I-13's plan), native redirect (→ I-15's plan), layer 2 (→ I-20).
- Cloud Sync's own wire (→ U-01), which builds on the binding and hooks fixed here.

## Owner decisions (2026-10-04, binding)

- **Two layers.** Layer 1 now: one Polaris Key account across all products, one login, one Library holding licences from every developer. Layer 2 later: app-specific profiles, apps signing users in beyond licence attach, the per-product issuer ("Sign in with <Product>", leaning in-house on `jose`). Full scope approved; layer 1 ships first.
- **Sign-in methods are links on the account:** email code or magic link, passkeys, Apple, Google, Steam; no Discord; Game Center, Play Games and EOS native identities as links; Microsoft/Xbox only if that storefront becomes real; never passwords. Connect and disconnect at any time under step-up, with a last-method guard, audited and emailed.
- **Sign-in UX:** identifier-first email; an "add another way to sign in" nudge; link-existing-account (merge only with proof of both identities, never by email match); sign in on another device by QR or code.
- **Required first-provider-sign-in interstitial** confirming the email, prefilled from the provider (including an Apple relay address); the user may switch to a real email. A provider-verified email needs no code; a typed or unverified address gets a one-time code. If the confirmed email already belongs to another Polaris Key account, the step **offers to join the two accounts**, with both proven in one session; it never joins silently (if the new identity has no account yet, joining links it to that account; if it has one, it is a merge under D21). Profile import (name, picture, locale) is shown there; the account's Profile section chooses a source or takes an upload; avatars are copied to R2; apps get profile claims only by consent.
- **Licences attach to the account.** Floating licences (no account) keep working but prompt sign-up.
- **Legacy key flow is a bounded on-ramp:** limited, product-configurable key entries; each portal entry prompts the account upgrade (skippable), forced at the limit; apps refuse the key at the limit and deep-link to the portal's `/activate`; existing installs are never affected. **Entry limits apply only to products with the Identity service on** (owner, 2026-10-04): without Identity a key is the app's only activation path, so the portal offers the account upgrade on every entry but never forces it, and apps never refuse the key.
- **Portal (proto-Steam):** Library (default), Discover (eligible auto-issue products; Add to library mints a licence), the Activate License modal, Cloud Sync only on the product pages of products with that service; app passthrough is the same login card with a persistent "<App> wants you to sign in" header (web, native, device code).
- **Safety defaults stay:** an email-bound licence attaches only to a matching verified email unless `claimByKey`; an owned licence never moves by key; no recovery desk (the developer relink tool with step-up, reason, notice and 72-hour undo); custom auth domains deferred; passkeys on `key.plrs.im`.
- **Operators stay on Pocket ID** (separate console client, I-03); `email_verified` is a claim there; a bulk export needs an admin API key.
- **Developer privacy:** developers only ever see data for their own products; each product gets a pairwise subject, never the global account id; no cross-product visibility; GDPR deletion removes the account and all links; per-product data deletion and export.
- **The account is platform-level; Identity is a per-product service** (owner, 2026-10-04): the account (layer 1) is part of Core and the portal and always present. "Identity" is the per-product service (console toggle plus the SDK Identity feature); its core is the passthrough sign-in "<App> wants you to sign in", only for products with Identity on, and it later covers app-specific profiles and "Sign in with <Product>". Products without Identity still attach licences to accounts through Activate License, the portal and Discover, but never show app sign-in.
- **D17–D23 accepted as proposed** (owner, 2026-10-04): credentials only on the `key.plrs.im` login card, no in-app email-code API (D17); a product's own IdP stays product-only in layer 2, linkable from the portal under step-up (D18); the console shows the buyer email, the account primary email only with consent (D19); a key entry counts only when it enrols a new device or is a portal submission (D20); on merge the survivor's pairwise subject wins, the other becomes an alias, and the developer gets `subject.merged` (D21); no silent SSO into apps: the first sign-in per app needs "Continue to <App>", and device code always does (D22); dormant accounts (no sign-in, no licence) deleted after 36 months with an email warning (D23).
- **Cloud Sync (S-17)** is its own service with its own toggle, depending on Config and the account (layer 1), not on the Identity toggle; the licence-level config override layer is removed everywhere in favour of account × product managed config; web apps get a device token from the product's `web.origins` allowlist through I-08.

## Design notes

- `PROTOCOL_VERSION` stays 4: every layer 1 wire change is additive and feature-detected. Transcripts and parity, not the signed corpus. `DocProfile` gains no subject (D9).
- **D17–D23 are decided** (owner, 2026-10-04; above) and the plan encodes them as binding. **Proposed defaults the plan must still carry, flagged until the owner answers** ([S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions)): `license_owned` on key entry of an owned licence on a new device, only with Identity on (D24); per-product removal keeps the licence unless "also remove" (D25); deletion leaves developer-set buyer columns to the developer, notified by `subject.deleted` (D27, legal review). D26 (the toggle rule) is superseded by the owner's account/service split above.
- **Reconcile the two notes (correction recorded here, 2026-10-04).** S-16 §5.1 first named the device binding `devices.account_id` (since corrected in the note to `devices.subject`); S-17's later revision ([S-17 §5.2](../../notes/S-17-user-data-sync.md#52-data-model)) stores the pairwise subject instead, as `devices.subject`, so no product-tenant row S-17 adds carries the global id. Default to S-17: `devices.subject`. Reword S-16's "the global account id never leaves the Identity service and the portal" to "never leaves the Worker's Identity and Core code", which admits `licenses.account_id`. S-16 names the web code-exchange route `POST /<p>/identity/redirect/token`; S-17 used `/identity/web/token`. Default to S-16's name, which I-15 reuses for native redirects.
- I-05 creates the binding column ([S-16 §8.1](../../notes/S-16-identity-service.md#81-briefs-that-change)); U-02 builds on it and adds no second migration.
- `portalUrl` and `signInUrl` are built by the Worker, never carry the key, and are never treated as auth failures by the SDKs.

## Steps

1. Draft `plans/I-04.md` against the code; correct S-16 or S-17 where the code disagrees, and say so.
2. List D24, D25 and D27 with their defaults for the owner in the plan PR, and D17–D23 and the account/service split as decided.
3. Set status `awaiting-approval` and stop.

## Acceptance criteria

- [ ] `plans/I-04.md` exists and covers every item in Scope → In.
- [ ] It names the corpus impact (none), the transcripts to add, and every SDK and UI kit that follows (Node, React, Python, Swift, Kotlin, Godot; `PolarisKeyUI`, Godot `addons/polaris_key/ui`, the React and Kotlin activation components).
- [ ] It encodes the owner decisions above verbatim (D17–D23 and the account/service split as decided) and marks D24, D25 and D27 as defaults pending the owner.
- [ ] Its toggle matrix says which surfaces are platform-wide and which need the Identity toggle, matching the account/service split above, and pins `requires: [config]` for the `sync` descriptor.
- [ ] It fixes the device binding's name and content and the code-exchange route's path, with the correction above.
- [ ] Status is `awaiting-approval`; nothing is implemented.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- I-05, I-06, I-07, I-11, I-12 build on the names fixed here; I-08, I-09, I-10a and I-10b execute this plan as written.
- U-01 builds Cloud Sync's plan on the binding, accessors and hooks fixed here.
- Merging the plan PR is the approval (program README §3).

The role agent sets `--set I-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-04 done`.
