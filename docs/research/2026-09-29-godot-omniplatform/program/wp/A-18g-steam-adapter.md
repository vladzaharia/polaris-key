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

- [x] The conformance suite passes for Steam, including the denied public branch and the 403 stop.
- [x] The copy card and asset pack render from fixtures; checklist ticks persist and audit.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront steam
```

## Hand-off

A-18k decides the public-branch rule. A-18j renders Steam's plan ("store page: links only").

The role agent sets `--set A-18g in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18g done`.

## Corrections from the code (A-18g, 2026-10-04)

Where the brief and the code disagreed, the code won:

- **`uploadBuild` is declared `ci`, and the adapter's `ci` is A-18h's `STEAM_CI`.** A-18h landed
  first, and the conformance suite requires every registered adapter with a CI-plane row to carry
  that row's list (and its `neverTokens` as `never.ciTokens`). Nothing new runs: depot uploads stay
  out of scope, this only declares the existing `steamcmd` allow-list on the adapter. The CLI's
  generated copy (`ciPlane.generated.ts`) was regenerated.
- **The gate engine gained an optional `reads` predicate** (`core/storefront/gate.ts`). Every Steam
  Web API method is an ordinary path, so without it a write method sent as a `GET` would pass the
  engine's read rule; Steam admits exactly its three reads.
- **The publisher key opens through `openSteamPublisherKey`** (extracted from A-16's
  `commerce/steam.ts`, behaviour unchanged), under the audited use `steam:storefront`, inside the
  gated client's key thunk.
- **The checklist lives in Distribution's connector settings** (`steam-setup`, as A-17c's App Store
  portal checklist does), keyed by app id: no migration.
- **Routes:** `…/distribution/storefronts/steam[/apps|builds|pack|checklist|branches/<b>/live]`,
  narrative-only console API like the rest of Distribution's admin surface. A-18j renders them.
- **The 403 stop is a conformance item** (8, for every adapter whose rate declares `stopOn403`),
  besides the Steam test.
