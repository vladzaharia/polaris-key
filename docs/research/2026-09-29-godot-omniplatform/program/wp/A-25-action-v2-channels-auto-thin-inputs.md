# A-25 Action v2: channels auto and thin inputs (absorbs CQS-10)

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce)                                                |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                 |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md), [P0-45](P0-45-pkey-command-registry-context-doctor.md)                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P4-33](P4-33-pack-transports-auto.md), [D-03](D-03-diceroll-after-p3.md), [A-32](A-32-github-write-path-publish-from-ci.md) |
| Role        | `pkey-implementer`                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | `rule-9`                                                                                                                                                             |
| Human input | none                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **DC-08** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.
- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-56.

## Goal

Action v2: channels auto and thin inputs (absorbs CQS-10), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **DC-08** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.3, for **DC-08**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- pkey storefronts sync, pkey channel add and renderOutletBlock (UX-56); the Action's channels: auto covers CI and PR channels and implied transport steps; thin inputs (command, args, secrets, base-url, working-directory, dry-run; the product from .pkey/), old inputs, and the storefront, itch-platform and storefront-outlet inputs, removed in the same release, each refused with a message naming its replacement (docs plan §10 amendment 6); bundle regenerated. Absorbs UX-56.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **DC-08**; DX consolidation H: Distribution channels, storefronts and commerce.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Corrections (2026-10-24)

The code is the fact. Recorded by A-25.1; the slice plan is `pk-wt/_lead/plans/A-25-DOC-12a-DOC-06b-slices.md` (§0, §8).

- **A1. The brief contradicts itself on old inputs.** The Consolidation note and Scope say removed and refused, naming the replacement; the acceptance line says "Old inputs warn through the window". Refusal wins (D-A2): the step fails before any network call with one line naming the replacement. Docs plan §10 amendment 6 removes the deprecation wording.
- **A2. The registry already maps every old input to a flag.** P0-45's `PkeyCommand.action` (`cli/src/help.ts`; `release`, `storefront`, `assets`, `transport`). `registry.test.ts` and `action.test.ts` hold its union to `ACTION_INPUTS` (`action.ts`, 36 inputs). Each refusal names its flag from this table; no second table.
- **A3. The CLI already reads the secrets from env** (`PKEY_RELEASE_KEY` in `publish.ts`; the content key in `help.ts`). The Action sets them in the in-process env and never puts a key on argv.
- **A4. `--product` and `--base-url` already resolve from `.pkey/product` and `PKEY_BASE_URL`** (`help.ts`, `context`). The Action just stops sending them.
- **A5. The Action is detected by `INPUT_PRODUCT`** (`action.ts`, `bin/standalone.ts`). With `product` gone, detection moves to `INPUT_COMMAND` (D-A6).
- **A6. External users pin a commit SHA, not a tag** (`action.yml`, README, docs `ci.md`, `ci-stores.md`). An old pin keeps its old bundle; only a repo that bumps its pin meets the change. In-repo users: `publish-package.yml` and the console's `workflowStep` (`FirstReleasePanel.tsx`).
- **A7. Nothing of UX-56 existed.** `renderOutletBlock` was only a comment (`shared-manifest/src/integration/index.ts`); there is no `pkey channel` command. Built on: `OUTLET_IDENTITY_FIELDS`, the catalogue's `plane` per channel, `loadStepProduct`/`pickOutlet`, the PR and CI step runners, `scanDir`/`matchArtifacts`, and the CLI's `yaml` dependency. A-25.1 adds `renderOutletBlock` in `shared-manifest/src/outletBlock.ts`. In `.pkey/distribution`, `outlets` is an object keyed by outlet id (not an array); the block is one such entry.
- **A8. Vocabulary.** The glossary calls a Channel the delivery place; a Storefront is never one. The command is `pkey channel add` / `pkey channel sync` (D-A1), not `pkey storefronts sync`.
- **A9. Implied transport steps belong to P4-33** (`transports.packs: auto`; runner-specific inputs). Their Action inputs are removed; `command: transport <step>` with `args` replaces them (D-A4).
- **A10. Rule 9 is not triggered.** `channel add` validates with the existing validator; no new rule code.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A product's workflow needs no per-channel step
- [ ] Old inputs warn through the window
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/channels/*`, rewritten in place (one page per channel; the matrix section at A-21); `reference/channels`.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set A-25 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-25 done`.
