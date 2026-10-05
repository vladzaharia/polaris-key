# PS-01 `polaris-key` storefront adapter: the `first-party` Support mode, the declaration and registry line, the listing profile and readiness checklist, and the conformance-suite branch

| Field       | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 1: substrate)         |
| Size        | 0.5–0.8 engineer-weeks                                                                                |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md)                           |
| Unblocks    | [PS-06](PS-06-console-polaris-key-storefront.md)                                                      |
| Role        | `pkey-implementer`                                                                                    |
| Plan mode   | no                                                                                                    |
| Gates       | adapter conformance suite (`test/storefront/conformance.test.ts`); THREAT-MODEL (storefront adapters) |
| Human input | none                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                             |

## Goal

The A-18 registry holds a `polaris-key` storefront adapter whose operations run against Polaris Key's own tables through a new `first-party` Support mode, with a listing profile and a readiness checklist, and the conformance suite proves a first-party operation can never reach a vendor.

## Why

The owner asked for the portal Library to become a distribution channel shown in the distribution hub ([S-21 §6.1](../../notes/S-21-polaris-storefront.md#61-the-polaris-key-storefront-adapter-ps-01), D1). A-18j renders tiles and capability strips from `STOREFRONT_ADAPTERS`, so registering the adapter is what puts Polaris Key beside the other stores.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/worker/src/core/adapters/contract.ts` (`Support`, `Capabilities`), `core/storefront/adapter.ts` (`StorefrontId`, `STOREFRONT_ADAPTERS`), `core/storefront/stores/itch.ts` (a credential-less adapter), `stores/ciShared.ts`.
- `core/storefront/listingProfiles.ts` and `projection.ts` (fit report).
- `packages/worker/test/storefront/conformance.test.ts`; THREAT-MODEL "Storefront adapters: the common layer (A-18a)".

## Scope

**In:**

- `Support` gains `{mode: "first-party", plane: "worker", handler: string}`; `supports()` treats it as supported.
- `StorefrontId` gains `"polaris-key"`; `core/storefront/stores/polarisKey.ts` with the op table of S-21 §6.1 (unsupported reasons verbatim in the ADMIN.md §5.8 voice); one registry line.
- `polaris-key` in `LISTING_STORES` with the profile in S-21 §6.1 (name 60, short 140, description 4,000, icon, 16:9 header, 0–8 screenshots).
- A pure readiness function `polarisKeyReadiness(input)` returning the five checks of S-21 §6.1 with a pass, warn or fail state and a reason.
- Conformance branch: a `first-party` op only on an adapter with `credential: null` and `gate: null`; running each first-party handler stub with `fetch` replaced by a thrower; every first-party op names a handler.

**Out** (and where it belongs instead):

- The handlers' real reads and writes (→ PS-02, PS-03, PS-06). The console tile (→ A-18j, PS-06). Pricing (→ S-22).

## Design notes

- `outletKinds: ["direct"]`: the id stays `direct` and is shown as "Polaris Key" (S-21 D9, PS-10).
- Do not add `polaris-key` to the console's hard-coded Store connections list: there is nothing to connect.
- No "coming soon" copy in any reason string.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-01:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-01 in-review`.

## Acceptance criteria

- [ ] `storefrontAdapter("polaris-key")` returns the declaration; the conformance suite passes for every adapter, with the first-party branch.
- [ ] A test registers a fake first-party op on an adapter with a credential and the suite fails.
- [ ] The fit report projects the shared listing for `polaris-key` (test).
- [ ] `polarisKeyReadiness` has a test per check.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test storefront
```

## Hand-off

PS-06 renders the tile, panel and readiness from this declaration. S-22 flips `pricing` and `iap` to `first-party` when a payment provider is connected.

The role agent sets `--set PS-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-01 done`.
