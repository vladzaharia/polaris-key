# CM-15 Checkout hand-off and manageBilling() in the SDKs (deferred)

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | CM: Commerce: store commerce (required) and Polaris Key checkout (deferred)      |
| Size        | 1.4–2 engineer-weeks                                                             |
| Depends on  | [CM-14](CM-14-device-checkout-wire.md), [LX-19](LX-19-sdks-licensing.md)         |
| Unblocks    | [CM-17](CM-17-commerce-closeout.md), [CM-18](CM-18-store-link-out-programmes.md) |
| Role        | `pkey-sdk-porter`                                                                |
| Plan mode   | no (executes its sections of the approved [`plans/CM-01.md`](../plans/CM-01.md)) |
| Gates       | `all-sdks`, `drift-gate`, `corpus-runner`                                        |
| Human input | the owner's go signal (removes `deferred`)                                       |
| Repo        | `vladzaharia/polaris-key`                                                        |

> **Deferred. Do not dispatch.** This package is optional and carries `deferred` in
> `workpackages.json`: the owner asked for the commerce plan on 2026-10-05 but not for its
> execution. `check.mjs --ready` does not list it. It becomes dispatchable only when the owner says
> go and the lead removes the `deferred` field.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Adds only the Polaris Key checkout hand-off and manageBilling(); offers()/purchase() names come from api.json and the store side ships in LX-20; Paywall renders in the rebuilt kits.

- Title: was "SDKs and UI kits: `offers()`, `purchase()` hand-off to Polaris Key checkout on desktop and web, store billing on store builds, `manageBilling()`".

## Goal

Node, React/client-core, Python, Swift, Kotlin and Godot expose `offers()`, `purchase(offerId)` and `manageBilling()`: desktop and web builds open the checkout ticket in the system browser and poll for the entitlement; store builds use their store's billing through the existing commerce client; each SDK replays the CM-14 transcript; parity manifests updated.

## Why

"In-app purchase hand-off to the Polaris Key checkout for desktop; store rules for mobile" ([S-22 §7.12](../../notes/S-22-polaris-key-commerce.md#712-sdk-impact-and-the-store-rules)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode for wire-touching work).
- [S-22 owner decisions](../../notes/S-22-polaris-key-commerce.md) (the 2026-10-05 header block and §10; they win over the sections below them).
- [S-22 §7.12](../../notes/S-22-polaris-key-commerce.md#712-sdk-impact-and-the-store-rules)
- [`wp/LX-20-commerce-clients.md`](LX-20-commerce-clients.md)
- `conformance/parity/features.json`
- `plans/CM-01.md`

## Scope

**In:**

- Six SDKs; `commerce.checkout` and `commerce.offers` parity rows; UI-kit buy button and price label where the kit exists.

**Out** (and where it belongs instead):

- Store link-outs (→ CM-18)

## Design notes

- Never show a Polaris Key price or buy button in a store build.
- Python is a desktop target; Swift and Kotlin implement checkout only for macOS outside the MAS and JVM desktop.

## Steps

1. client-core and Node first.
2. Python, Swift, Kotlin, Godot.
3. UI kits.

## Acceptance criteria

- [ ] Every SDK replays the checkout transcript.
- [ ] `pnpm parity:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm test
```

## Hand-off

- CM-17 documents the SDK surface.

The role agent sets `--set CM-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-15 done`.
