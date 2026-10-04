# I-04 Plan the Identity service: decision record replacing D-14, glossary, data model, WIRE-CONTRACT-V4 identity section, error codes, parity ids, manifest schema, threat-model deltas

| Field       | Value                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-0, MVI)                                                                                         |
| Size        | 0.6–0.85 engineer-weeks                                                                                                           |
| Depends on  | none                                                                                                                              |
| Unblocks    | [I-05](I-05-broker-discovery.md), [I-06](I-06-users-and-links.md), [I-08](I-08-email-login.md), [I-10](I-10-exchange-endpoint.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                               |
| Plan mode   | yes: planning only; writes `plans/I-04.md`, which needs human approval (merging the plan PR)                                      |
| Gates       | plan mode; human approval                                                                                                         |
| Human input | none                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                         |

## Goal

An approved plan, `plans/I-04.md`, that fixes every name and shape the Identity build depends on: a decision record replacing D-14, the glossary nouns, the D1 data model and the `licenses.sub` migration, the Identity section of WIRE-CONTRACT-V4 including the email-code routes, the error codes, the parity feature ids, the `.pkey/product` `identity.methods` schema, and the threat-model deltas of S-16 §5.4.

## Why

S-16 is research; the build needs a contract. Phase 1 is not wire-free: the email-code routes are device wire, so the order is I-04 (contract) → I-08 (routes) → I-11 (SDKs) ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)). Owner decisions D1–D16 are accepted as stated, with full scope ([S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- All of [S-16](../../notes/S-16-identity-service.md), especially [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model)–[S-16 §5.6](../../notes/S-16-identity-service.md#56-how-it-composes), [S-16 §7](../../notes/S-16-identity-service.md#7-phases), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) and [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions).
- `docs/superpowers/specs/2026-08-26-polaris-suite-services-design.md` (D-14).
- `docs/security/WIRE-CONTRACT-V4.md`, `docs/security/THREAT-MODEL.md`.
- `packages/shared-protocol/src/`, `conformance/parity/features.json`, `errors.json`, `packages/shared-manifest/`.
- `packages/docs/src/content/docs/start/concepts.md` (glossary, rule 4).
- [`plans/F-20.md`](../plans/F-20.md) (the F-20/F-21 revocation hooks Identity must keep).

## Scope

**In:**

- The decision record replacing D-14 (owner decision D11), written into the services design spec by the plan's implementer (I-08, which executes this plan).
- Glossary nouns: user, identity link (login), login method, portal account, client.
- Table design (`identity_users`, `identity_links`, `licenses.user_id`, `identity_sessions`, `identity_passkeys`, `identity_clients`, `identity_grants`) and the reversible `licenses.sub` migration (platform subjects become `oidc:https://id.plrs.im` links).
- The WIRE-CONTRACT-V4 Identity section: `POST /<p>/identity/email/start` and `/verify` request, response and error shapes; the discovery fragment's `methods[]`; the first identity types in `shared-protocol`.
- Error codes (at least `link_conflict`, `license_owned`, `email_unavailable`, `last_link`, flow and code errors) and parity feature ids for every SDK-facing Identity call.
- The `identity.methods` / `identity.linking` manifest schema and its validator rules (rule 9), including `claimByKey`, `emailTrust` and the App Review 4.8 warning.
- The threat-model deltas of §5.4 items 1–11 as THREAT-MODEL text to land with the implementing packages.
- Which later packages need their own plans (I-10, I-11, I-13, I-16, I-22) and what this plan pre-decides for them.

**Out** (and where it belongs instead):

- Code of any kind (planning only).
- The exchange route contract in detail (→ I-10's plan), native redirect (→ I-13's plan), the issuer (→ I-16's plan).

## Design notes

- **Safety defaults the plan must encode, not reopen** (owner decisions): a licence carrying an email attaches only to a user with that verified email, never by key unless the product sets `claimByKey: true`; a licence with an owner never moves by presenting its key (`license_owned`); Polaris runs no recovery desk, and beyond a user's remaining links recovery is the developer's via the audited console relink tool (step-up, reason, notice, 72-hour undo); custom auth domains are deferred and passkeys enrol on `key.plrs.im` only.
- `PROTOCOL_VERSION` stays 4; the email routes are additive and feature-detected from discovery; `verify` returns the existing activation response. Transcripts and parity, not the signed corpus.
- `DocProfile` gains no subject (D9); named-user seats are I-18.
- I-08 executes this plan directly (`planRef`), so the plan must be specific enough for the email routes, the session, the hosted page and the device-code binding.

## Steps

1. Draft `plans/I-04.md` against the code (correct S-16 where the code disagrees, and say so).
2. Set status `awaiting-approval` and stop.

## Acceptance criteria

- [ ] `plans/I-04.md` exists and covers every item in Scope → In.
- [ ] It names the corpus impact (none), the transcripts to add, and every SDK that follows (Node, React, Python, Swift, Kotlin, Godot).
- [ ] It encodes the owner's safety defaults verbatim.
- [ ] Status is `awaiting-approval`; nothing is implemented.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- I-05, I-06, I-10 build on the names fixed here; I-08 executes this plan as written.
- Merging the plan PR is the approval (program README §3).

The role agent sets `--set I-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-04 done`.
