# SP-40 Retire React cookie-mode browser sessions

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)                                  |
| Size        | 0.4–0.6 engineer-weeks                                                                                                             |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-32b](I-32b-retire-legacy-identity-engine.md)                                            |
| Role        | `pkey-sdk-porter`                                                                                                                  |
| Plan mode   | no                                                                                                                                 |
| Gates       | none beyond the green gate                                                                                                         |
| Human input | owner decision 7 (answered 2026-10-07, open to veto)                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-09** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break. Its server half goes in the same release: the Worker drops cookie mode and its route with the SDK, with no window for 0.8 clients (`tracks.md` rule 6).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: removes cookie mode outright, from the React SDK (`BrowserAuthMode` `'cookie'`) and the Worker, in the same 0.9.x release as I-10a. Retiring cookie mode is a prerequisite of I-32b.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: remove `"cookie"` from React's `auth` row and add its `removed` row (note: bearer mode plus I-08's redirect), with the Worker half in the same release.

## Goal

Retire React cookie-mode browser sessions, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-09** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **SDX-09**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §6, for **SDX-09**.

## Scope

**In:**

- BrowserAuthMode 'cookie' (packages/sdk-react/src/core/types.ts:366) is removed from the React SDK, and identity/browserSession.ts's cookie route from the Worker, in the same 0.9.x release as I-10a, with no deprecation entry and no window. `api.json` records it as a `removed` row whose note names bearer mode plus I-08's web redirect.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track J (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-09**; DX consolidation J: SDK and UI-kit consolidation.
- Gated on owner decision 7 ([README §8](../../../2026-10-07-dx-consolidation/README.md#8-owner-decisions)), answered on 2026-10-07 under delegated authority with the recommendation and open to the owner's veto; a veto takes that row's "If the answer is no" column.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `api.json` has the `removed` row with its note
- [ ] Cookie mode and its Worker route are removed in the same release as I-10a (test)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-40 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-40 done`.
