# P0-52 Feed coherence: atomic lockstep publishing and a closure check

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (SDK usability review (2026-10-08))                                                          |
| Size        | 0.6–1 engineer-weeks                                                                                                                  |
| Depends on  | none                                                                                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                |
| Role        | `pkey-implementer`                                                                                                                    |
| Plan mode   | no                                                                                                                                    |
| Gates       | `ci`                                                                                                                                  |
| Human input | the owner approves the `package-registry` run that publishes `jws@0.8.28` and `protocol@0.8.29` from their tags (approved 2026-10-08) |
| Repo        | `vladzaharia/polaris-key`                                                                                                             |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- P0-52 is already built. The lockstep set gains `@polaris-key/server` and `@polaris-key/oclif` in SP-55 and UK-52, which join `publish-sdks.yml`'s npm tiers and the feed-closure check.

## Goal

Feed coherence: atomic lockstep publishing and a closure check, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (P0-52) and §10.4.

## Scope

**In:** `publish-sdks.yml` publishes npm legs in dependency tiers (jws, protocol, catalog, zstd-wasm → client-core, brand, manifest → node, react, cli), and a leg publishes only when every leg it depends on succeeded. A job after each publish resolves every exact `@polaris-key/*` pin of every new version on `pkg.plrs.im` and fails before channel tags move; a failed set is yanked. A scheduled check covers every version on the npm feed, plus the PyPI equivalent. Repair the 9 broken versions: a repair run publishes `jws@0.8.28` and `protocol@0.8.29` from their tags (owner decision, 2026-10-08). `install-from-feeds.md`: the pnpm (10.16+, 11), npm and Bun age gates beside Yarn's, with `minimumReleaseAgeExclude: ["@polaris-key/*"]` as an opt-in; correct "beta = newest pre-release"; stale version snippets.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- The repair publishes; it does not deprecate the dependents (owner, 2026-10-08).
- No placeholder packages on public registries (owner decision 3, unchanged): `pkey` on npmjs and `polaris-key` on PyPI stay unclaimed.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The full-feed check finds no unresolvable sibling pin.
- [ ] After every publish, `pnpm add @polaris-key/node` (pnpm 11 defaults) and `npm install @polaris-key/react react react-dom` succeed in an empty directory in CI.
- [ ] A simulated stuck leg leaves no dependent published at that version.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set P0-52 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-52 done`.
