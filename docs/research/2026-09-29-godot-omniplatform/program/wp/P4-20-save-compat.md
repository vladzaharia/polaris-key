# P4-20 Save compatibility: `provides`/`removes` checks, `isAvailable`, content-interface fingerprint

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v3)                                                                                                 |
| Size        | 1–1 engineer-weeks                                                                                             |
| Depends on  | [P4-12](P4-12-compat-resolution.md), [P4-08](P4-08-godot-packs.md)                                             |
| Unblocks    | none (milestone: localisation, events and supporter packs)                                                     |
| Role        | `pkey-implementer`                                                                                             |
| Plan mode   | no, because P4-01 reserved `provides[]` and `removes[]` in the pack record (see Design notes)                  |
| Gates       | none in the graph; in practice rule 9 for the deliverable's `provides` policy, and every SDK for `isAvailable` |
| Human input | none                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## Goal

Three save-compatibility guards work. (1) Publishing a pack release that stops providing a content
id its predecessor on the same `contentApi` line provided fails, unless the release moves to a new
`contentApi` range or lists the id in `removes`. (2) Every SDK answers
`client.update.packs.isAvailable(contentId)` (Godot: `is_available`) from the `provides` lists of
the active set, so a game can show "Continue (downloading 12 MB…)". (3) An app publish computes a
content-interface fingerprint from an explicit registry and warns when it changes while
`contentApi` does not.

## Why

Saves reference content ids, never paths. A pack release that silently drops an id breaks saves
for players instead of failing in CI ([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications)
item 8; [README §3.7](../../README.md#37-content-packs-across-release-distribution-and-update),
saves and support). `provides` also backs Diceroll's `Content.available()` and `needs.gd`
([README §13](../../README.md#13-diceroll-adoption-path): Diceroll keeps its save-compat rules).
`contentApi` bumps are a discipline, and the fingerprint lint is the CI help Expo's
`runtimeVersion` fingerprint gives ([CONTENT §6.2](../../CONTENT.md#62-the-compatibility-contract-contentapi)).

## Read first

- `AGENTS.md` (rule 9), the `authoring-pkey-manifests` skill.
- [CONTENT §6.2](../../CONTENT.md#62-the-compatibility-contract-contentapi),
  [§6.4](../../CONTENT.md#64-publishing-checks-in-both-directions) (the pack publish check lists
  "a removal of content ids that the previous release `provides` without a `contentApi` bump"),
  [§6.7](../../CONTENT.md#67-lifecycle-implications) item 8, [§6.9](../../CONTENT.md#69-record-and-table-changes),
  [§17](../../CONTENT.md#17-open-questions-and-spikes) question 10.
- [README §5.7](../../README.md#57-packs-at-runtime) (Godot `is_available(content_id)`) and
  [PARITY §5.6](../../PARITY.md#56-packs) (`packs.provides`).
- P4-12's publish checks in `packages/worker/src/services/release/packs/`; the pack facets from
  P4-06 (`client-core`, Node, React), P4-07 (Python, Swift) and P4-08 (Godot); the CLI publisher
  (P4-03, P2-06); the `.pkey/release` deliverables validator (P4-02) and
  `packages/shared-manifest/test/schema-parity.test.ts`.

## Scope

**In:**

- The `provides`/`removes` publish check beside P4-12's checks, included in `--dry-run`.
- CLI: collect `provides` for a pack release (from a file declared per deliverable or given on
  the command line) and write `provides[]` and `removes[]` into the descriptor.
- The deliverable's `provides` policy in `.pkey/release` (CONTENT §6.9), for example
  `provides: {required: true, from: ".pkey/provides.json"}`, with rule 9 (validator rule,
  mutation-table entry, schema, `validation-codes.mdx`).
- `isAvailable(contentId)` and `packFor(contentId)` (proposed name) in `client-core` (Node,
  React), Python, Swift and Godot, reading `provides` from the verified records of the active and
  target sets.
- The content-interface fingerprint: `pkey release publish --deliverable app --content-interface <file>`
  hashes an explicit registry and warns (fails with `--strict`) when it differs from the channel's
  current app release while `contentApi` is unchanged.
- Adopter docs for the three guards.

**Out** (and where it belongs instead):

- Deriving the fingerprint automatically from a Godot project (`load()` paths, resource types):
  CONTENT §17 Q10 is open. An explicit registry is the v3 answer; the Godot export plugin
  (P1-11) could emit one later.
- Named contracts (`contracts: {scenes: 4, balance: 7}`): a wire change, not scheduled.
- Diceroll wiring `needs.gd` to `is_available` (Diceroll work; D-04 does not depend on this
  package in the graph, so it either waits for it or keeps its own gating until later).

## Design notes

- **The rule.** For each pack release `N` and its predecessor `P` (the previous release of the
  same deliverable, and variant where `provides` differ by variant), for every live level that both
  `P` and `N` support: `provides(P) \ provides(N) ⊆ removes(N)`. If `N` supports none of `P`'s
  levels, it is a `contentApi` bump and the check passes. The failure names each dropped id and
  the levels affected. `removes` ids that `P` never provided are a warning, not a failure.
- **Wire and size, a stop condition.** CONTENT §6.9 puts `provides[]` and `removes[]` in the pack
  release record as optional fields, and P4-01's plan reserves both (decision 2). If the approved
  plan did not, adding them is a wire change: stop and escalate to a plan. The record payload cap is 65,536 bytes in v3
  (`docs/security/WIRE-CONTRACT-V3.md` §1). Measure a realistic registry (Diceroll's content ids).
  If `provides` would not fit, moving it to a hash-pinned artifact is also a wire change: escalate
  rather than truncate.
- **Where `provides` comes from.** CI reads it from a file inside the payload or next to it,
  declared per deliverable (proposed `.pkey/provides.json`, a sorted list of ids). The policy
  `required: true` fails a publish without it. Content ids are opaque strings; the recommended form
  is printable ASCII, and the validator enforces that shape on the declared file.
- **`isAvailable(contentId)`** is true when a pack in the **active** set provides the id and is
  installed and active (for restart types, mounted this boot). `packFor(contentId)` returns the
  pack id (and release) that would provide it in the target set, so a game can call
  `ensure([packId])` and show the size. Embedded baselines' records count. Unentitled optional
  packs are hidden from the plan (CONTENT §6.7 item 9), so they never answer.
- **Fingerprint.** The input is an explicit registry file (for Diceroll, its content-id registry
  as `needs.gd` defines it, exported to JSON) plus declared path prefixes. The fingerprint is the
  SHA-256 of the canonical JSON. Store it with the app release as unsigned release metadata, not in
  the signed record, so this stays off the wire. The comparison runs in the CLI against the
  channel's current app release.
- **Parity.** `packs.provides` is one feature in every SDK; the graph lists only P4-08 as an SDK
  dependency, so confirm P4-06 and P4-07 have landed before starting the other SDKs.

## Steps

1. Confirm the record fields exist in the v4 contract and measure a realistic `provides` size;
   stop if either condition in Design notes fails.
2. The publish check and dry-run output, with Worker tests.
3. The manifest policy (rule 9) and the CLI collection of `provides`/`removes`.
4. `isAvailable` and `packFor` in each SDK, with tests.
5. The fingerprint in the CLI and its storage; adopter docs; the green gate.

## Acceptance criteria

- [ ] Worker tests: dropping a provided id on a shared level fails the publish and names the id;
      the same drop listed in `removes` passes; a release that supports only a new level passes;
      the dry run reports the same result without writing.
- [ ] `schema-parity.test.ts` passes with a mutation entry for each new validator code.
- [ ] Every SDK has tests for `isAvailable` (installed and active; provided only by the target
      set; provided by an embedded baseline; not provided) and for `packFor`.
- [ ] `pnpm --filter @polaris-key/cli test` covers `provides` collection, the policy failure and
      the fingerprint warning (and failure with `--strict`).
- [ ] The green gate passes (`AGENTS.md`), including pytest, `swift test` and the Godot runner.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
```

## Hand-off

- Diceroll (D-04 or a later step) wires `Content.available()` and `needs.gd` to `is_available`
  and `packFor`, and adopts the `provides` file and the fingerprint registry.
- The unsigned fingerprint metadata is what a later automatic derivation (CONTENT §17 Q10) would
  replace.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-20 done`.
