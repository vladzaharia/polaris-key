# A-18g Steam storefront adapter: reads, named-branch releases, asset pack, copy card and checklist

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                           |
| Size        | 0.5–1 engineer-weeks                                                                                 |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18d](A-18d-listing-asset-derivation.md)               |
| Unblocks    | none                                                                                                 |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no                                                                                                   |
| Gates       | adapter conformance suite; THREAT-MODEL (rule table)                                                 |
| Human input | none to build; the public-branch release stays a deep link until A-18k verifies the key (decision 5) |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

Steam is a registered `StorefrontAdapter` that is honest about what Steam allows: reads, setting a
build live on a named branch, and, for everything else, a generated asset pack, a pre-filled copy
card of the text fields, and a per-app checklist with operator ticks.

## Why

Steam has no listing API: none of its 33 Web API interfaces edits a store page
([S-15 §4.3](../../notes/S-15-storefront-provisioning.md#43-steam-worker-plane-for-reads-and-branch-moves-ci-for-depots-the-rest-is-ui)).
What Polaris Key can still do is generate every asset at Steam's sizes, pre-fill the text, track the
human steps, and confirm by read that the branch the operator set is live.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§4.3**, §5.1, §6.2–§6.6, §11
  (A-18g), owner decision 5.
- `commerce/steam.ts` (A-16's lister, the publisher key); A-18d's asset pack.

## Scope

**In:**

- Reads: `ISteamApps/GetPartnerAppListForWebAPIKey`, `GetAppBuilds`, `GetAppBetas`, on
  `partner.steam-api.com`.
- `rules/steam.ts` with the `form` matcher: `SetAppBuildLive` allowed on named branches;
  `betakey=public` denied.
- Budget: 100,000 calls per day per key, with a **hard stop on the first 403** (403s rate-limit the
  Worker's shared egress IP).
- The store-page copy card from A-18b's projection; the generated asset pack download from A-18d.
- The checklist: fee paid, 30 days elapsed, Coming Soon page live (two weeks), store review passed,
  build review passed; operator ticks stored per product, shown as unverified.
- Deep links: app create, store page, App Admin (public-branch release).

**Out:**

- Depot uploads (`ci`, P5-08's VDFs). Console (→ A-18j).

## Design notes

- **Decision 5:** the public-branch release is a deep link to App Admin until A-18k shows the
  group-scoped key may call `SetAppBuildLive` with `betakey=public`. After that, a follow-up flips
  the rule to **typed confirmation** (phrase: Steam's app name). It is never plain.
- **Never:** users and permissions, app credits, pricing, branch or depot deletion (UI only
  anyway).
- Natural key for a branch move: `GetAppBetas` already shows the build id on that branch.

## Acceptance criteria

- [ ] The conformance suite passes for Steam, including the denied public branch and the 403 stop.
- [ ] The copy card and asset pack render from fixtures; checklist ticks persist and audit.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront steam
```

## Hand-off

A-18k decides the public-branch rule. A-18j renders Steam's plan ("store page: links only").

The role agent sets `--set A-18g in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18g done`.
