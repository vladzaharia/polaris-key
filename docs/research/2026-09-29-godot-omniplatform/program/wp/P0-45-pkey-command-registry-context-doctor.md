# P0-45 pkey command registry, context and doctor

| Field       | Value                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                       |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                        |
| Depends on  | [UK-14](UK-14-node-terminal.md)                                                                                                                                                                                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-25](A-25-action-v2-channels-auto-thin-inputs.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md), [ST-46](ST-46-interactive-pkey-init.md), [AX-08](AX-08-pkey-agents-product-repo-block-console-card.md), [AX-16](AX-16-the-cli-for-agents-json-codes-pkey-explain.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                          |
| Gates       | `rule-9`                                                                                                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- Registry entries for `agents` (AX-08), `explain` (AX-16) and `mcp` (AX-17), each as it lands.
- Every command declares whether it has `--json`.

## Goal

pkey command registry, context and doctor, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQT-04**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- Typed command registry grown from UK-14's help.ts driving parse, help, completion, reference/cli.mdx and the Action mapping; --product and --base-url default from .pkey/product and PKEY_BASE_URL; pkey doctor as the CLI twin of the console's Integration verdict; pkey validate --fix. A wave-7 item (A-25 and ST-46 wait for it).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-04**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] reference/cli.mdx generated with --check
- [ ] pkey doctor reports the same Verified facts as ST-40
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-45 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-45 done`.
