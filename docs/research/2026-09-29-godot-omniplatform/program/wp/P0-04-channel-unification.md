# P0-04 Unify the licence-gate and Release channel vocabularies

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                                                 |
| Size        | 0.75–1 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                       |
| Unblocks    | [P1-03](P1-03-godot-license.md), [P1b-05](P1b-05-runners.md)                                               |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                       |
| Plan mode   | **yes**: `program/plans/P0-04.md` must be approved (merged) before any code                                |
| Gates       | plan mode; corpus `gate-matrix.json` + Swift mirror (`pnpm gen:corpus -- --check`); all SDKs; catalog data |
| Human input | approval of the plan and its open questions; djdl's own `.pkey/schema` edit (follow-up, not blocking)      |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Goal

One channel vocabulary across Polaris Key: Release's (`stable`, `beta`, `pr-<n>`, and a
product's manual channels). The licence build gate, the `entitled` access check, the SDKs'
`X-PKey-Channel` values and the gate matrix all use it. A licence entitled to `beta` can run a
build that declares `X-PKey-Channel: beta`, and clients already in the field that send `staging`
or `dev` keep working. The new decisions are pinned by appended `gate-matrix.json` rows that pass
in Node, React/`client-core`, Python and Swift.

## Why

The licence gate knows `stable | staging | pr | dev` (`packages/worker/src/core/gate.ts:51`,
`normalizeChannel` at `gate.ts:82-88`) and refuses any other header value with
`channel-not-entitled` (`gate.ts:144-148`). Release knows `stable | beta | pr-N | <manual>`
(`services/release/channels.ts:22,44-64`). So `X-PKey-Channel: beta` is refused, and there is no
coherent beta programme across License and Release (report
[§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issue #2, rated High).
The report decided the fix ([§11](../../README.md#11-decisions-needed) decision 5): **unify on
Release's vocabulary (`stable`, `beta`, `pr-N`, manual) and teach the licence gate; map `staging`
and `dev` as aliases for existing clients; plan mode (gate matrix).** Today a Godot beta build
would have to send `staging` to pass ([notes/A2 §1.9](../../notes/A2-sdk-port.md#19-gate-evaluation-and-every-license-status-value)).

## Read first

- `AGENTS.md` (rules 1, 2, 4); `program/README.md` §3 and §7 (plan mode); `program/plans/README.md`
  (the plan format).
- `docs/security/WIRE-CONTRACT-V3.md` §5 and the client-metadata header list (around line 147).
- Server: `packages/worker/src/core/gate.ts:51-157`, `core/entitledAccess.ts:126-135`
  (`channelAllowed`: the Release-side rule, `pr-N` allowed by `pr`), `services/release/channels.ts`,
  `services/release/access.ts:85-103` (`entitledSelectorFor`), `services/release/surfaces.ts:95`
  and `install.ts:128-138` (the installer advertises `staging`, which Release does not know).
- Clients: `packages/client-core/src/semver.ts:51-57`, `sdks/python/src/polaris_key/core/semver.py:86-95`,
  `sdks/swift/Sources/PolarisKeyCore/Semver.swift:14-19,76-80` (public `enum Channel`),
  `sdks/swift/Sources/PolarisKeyCore/CoreContext.swift:225`, `sdks/swift/Sources/PolarisKeyUpdate/UpdateFeed.swift:96-104`
  (`allowedChannels(from:)`; `:113-125` is `feedHeaders`),
  `packages/sdk-node/src/core/context.ts:181,292`.
- Corpus: `tools/sign-corpus.ts:1632-2115` (gate-matrix v2: carried rows are frozen, new rows
  are appended in `buildGateMatrixV2`), the runner ports in
  `conformance/runners/node/corpusV2.test.ts:322-420`, `sdks/python/tests/test_gate_matrix.py:72-99`,
  `sdks/swift/Tests/PolarisKeyTests/GateMatrixTests.swift:75-101`.
- Catalog and console: `products/djdl/catalog.json` (the `channels` flag, enum `stable, staging, pr`),
  `packages/admin/src/views/licenses/shared.tsx:84` (`CHANNELS = ["stable", "beta", "staging", "pr"]`;
  its `onChange` at `:107` drops any value it does not offer), and a second picker in
  `packages/admin/src/views/tiers/dialogs.tsx:34` (`["stable", "beta", "alpha", "nightly", "internal"]`).
- [notes/A1 §1.3](../../notes/A1-release-update.md#13-channel-model) (the mismatch, and manual
  channel names that the feed routes cannot reach).

## Scope

**In** (the plan decides the details; implementation follows the approved plan):

- The server gate and `entitledAccessCheck` share one channel normaliser and one entitlement
  predicate in `core/`.
- `channelForVersion` in the worker, `client-core`, Python and Swift agree on the new mapping.
- Appended `gate-matrix.json` rows, the Swift mirror, and the three runner ports updated.
- Release accepts `staging` as an alias selector for `beta` unless the product declares a manual
  channel named `staging` (manual wins).
- The djdl fixture catalog's `channels` enum gains `beta` (keeps `staging`); both console channel
  pickers (licence and tier) show the canonical names, the product's manual channels, and `staging`
  only as a labelled legacy alias.
- Docs: `WIRE-CONTRACT-V3.md`, `start/concepts.md` (glossary: "channel"), the License and Update
  pages that list channel values.

**Out** (and where it belongs instead):

- The Node runner's stale dev-build bypass (issue #15) and the carried row that encodes it
  (→ P1b-05). This package fixes only the channel half of the runner ports.
- Godot's gate and header values (→ [P1-03](P1-03-godot-license.md), which consumes this plan).
- Channel pointers, `includes: [stable]`, floors per channel (→ P2-03, P2-05).
- Generated SDK constants for channel names (→ P1b-02).
- Editing djdl's own repository (`vladzaharia/djdl`); record it as a follow-up for its owner.

## Design notes

**Plan-first flow.** Nothing is implemented until a human merges `program/plans/P0-04.md`. Wave
order is contract → catalog → corpus → every SDK:

1. **Contract.** `WIRE-CONTRACT-V3.md` lists the canonical `X-PKey-Channel` values and the two
   aliases. `shared-protocol` gains the shared constants if the plan wants them (plan mode covers it).
2. **Catalog.** `products/djdl/catalog.json` `channels` enum (use the `adding-a-catalog-entry`
   skill; the schema version rule applies).
3. **Corpus.** Append rows in `buildGateMatrixV2`; run `pnpm gen:corpus`; commit
   `conformance/corpus/v2/gate-matrix.json` and the Swift mirror
   `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` together. Never edit carried rows (rule 1).
4. **SDKs.** Node (`sdk-node`, via `client-core`), React (`client-core`; the browser adapter sends
   no channel header today, confirm and record), Python, Swift. Each passes the new rows.

**Proposed semantics** (the plan confirms or amends):

- Canonical names: `stable`; `beta`; `pr-<n>` (`pr` as the family grant); manual names in
  `^[a-z0-9][a-z0-9-]{0,63}$`, the intersection of the manifest's `CHANNEL_RE`
  (`shared-manifest/src/index.ts:347`, which also allows `A-Z`, `.` and `_`) and the feed routes'
  `^[a-z0-9-]+$` (`update/routes.ts:20`, `router.ts:181`, which has no length bound).
- Header normalisation: `stable` and `latest` → `stable`; `beta` → `beta`; `staging` → `beta`;
  `pr` or `pr-<n>` → `pr-<n>`; `dev` → `dev` (gate-only pseudo-channel for `0.0.0-dev*` builds,
  still entitlement-checked per R3-01); any other well-formed name → itself, which must be
  entitled by name; anything malformed → `channel-not-entitled`. An unknown value is never a
  free pass (R3-01, R3-13).
- Entitlement predicate: `stable` always; exact membership in `entitlements.channels`; `beta` ⇔
  `staging` equivalence in **both** directions (old licences carry `["stable","staging"]`, new ones
  `["stable","beta"]`); `pr-<n>` allowed by `pr`. The build-implied channel and the declared
  header are both checked, as today (`gate.ts:150-157`).
- `channelForVersion`: `0.0.0-beta*` → `beta`; `0.0.0-staging*` → `beta`; `0.0.0-pr-?<n>` and
  `0.0.0-dev*` unchanged.

**Open questions the plan must put to the human, each with a recommendation:**

1. `PROTOCOL_VERSION`: recommend **no bump**. No signed document changes shape; the server
   widens accepted header values and every old client stays valid. The plan must say so
   explicitly against rule 2.
2. Should SDKs send `beta` for `0.0.0-staging*` builds, or keep sending `staging`? Recommend
   `beta`: the Worker change is deployed before any SDK release, and it accepts both spellings.
3. Swift's public `enum Channel` gains `.beta`: adding a case breaks exhaustive `switch`es in
   adopters' code. Recommend adding it with a release note; the alternative is a `String`-backed
   struct, which is a larger API change.
4. Manual channel names: the manifest allows `A-Z`, `.` and `_` (`CHANNEL_RE`), the feed routes do
   not. Recommend a validator **warning** now (rule 9) and an error later.
5. `gateMatrixVersion` stays `2` with appended rows, or bumps to `3`. Recommend staying at `2`.

**Minimum new gate-matrix rows** (names as they would appear): `ok — beta header, channels
[stable, beta]`; `ok — beta header, channels [stable, staging] (alias)`; `ok — staging header,
channels [stable, beta] (alias)`; `channel-not-entitled — beta header, channels [stable]`;
`ok — manual channel header, entitled by name`; `channel-not-entitled — manual channel header,
not entitled`; `channel-not-entitled — malformed channel header`; `ok — 0.0.0-beta build with beta
entitlement`.

- Hotspot rule: one corpus-touching package in flight at a time (`program/README.md` §5). Do not
  run this alongside P1b-05 or P1-01.

## Steps

1. Planner: write `program/plans/P0-04.md` with all nine required sections, the semantics above,
   the open questions, and the exact row names; set status `awaiting-approval`; stop.
2. After approval: server gate, shared predicate, Release alias, tests (`test/gate.test.ts`,
   `test/attack/R3-licensing.test.ts`, `test/licensing.test.ts`, `test/release.test.ts`).
3. Catalog fixture and console picker.
4. Corpus rows, `pnpm gen:corpus`, mirror, then the Node, Python and Swift runner ports.
5. SDKs: `client-core`, Python, Swift; SDK unit tests for `channelForVersion`.
6. Docs; changeset entries for every published package touched.

## Acceptance criteria

- [ ] `program/plans/P0-04.md` exists and is merged before the first code commit.
- [ ] Worker test: `X-PKey-Channel: beta` with `channels: ["stable","beta"]` → licence document 200;
      with `["stable"]` → 403 `channel_not_allowed`; with `["stable","staging"]` → 200.
- [ ] Worker test: `X-PKey-Channel: staging` with `["stable","beta"]` → 200; a malformed header → 403.
- [ ] Worker test: `/update/staging/appcast.xml` resolves like `beta` unless a manual channel
      `staging` exists.
- [ ] Every new `gate-matrix.json` row passes in the Node runner, `sdks/python` and `sdks/swift`;
      `pnpm gen:corpus -- --check` is clean, mirror included.
- [ ] `channelForVersion("0.0.0-beta.3")` is `beta` in `client-core`, Python and Swift.
- [ ] The green gate passes (`AGENTS.md`), including Python and Swift.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- gate licensing R3-licensing release
mise exec node@22 -- pnpm test          # includes client-core, sdk-node, sdk-react, conformance
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_gate_matrix.py tests/test_gate.py )
( cd sdks/swift && swift test --filter GateMatrixTests )
```

## Hand-off

P1-03 relies on: the canonical header values and aliases, the entitlement predicate, the
`channelForVersion` mapping and the new row names in `gate-matrix.json`. P1b-02 generates channel
constants from whatever the plan fixes. P1b-05 fixes the remaining (dev-bypass) half of the runner
ports on top of this. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-04 done`.
