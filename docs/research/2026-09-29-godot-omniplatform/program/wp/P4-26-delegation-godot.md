# P4-26 Content-key delegation in Godot

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs                                                                                                          |
| Size        | 0.5–0.75 engineer-weeks                                                                                            |
| Depends on  | [P4-19](P4-19-content-key-delegation.md), [P4-24](P4-24-content-decision-godot.md)                                 |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                           |
| Plan mode   | yes: execute the approved `plans/P4-19.md` (its P4-26 parts); the plan's approval is this package's plan-mode gate |
| Gates       | plan mode; corpus (runners only; P4-19 owns the corpus); all SDKs                                                  |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Port P4-19's content-key delegation to the Godot SDK, so every `delegationCases` and
`dataOnlyCases` row passes in the editor and the release template exactly as in client-core.

## Read first

- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-19.md`**: §2.3–§2.7, §4.2–§4.3,
  §5's order-3 row, §8.1 decisions and §8.5's P4-26 bullet. Where it and this brief differ, the
  plan wins.
- client-core's P4-19 implementation on main (the reference); P4-08's engine and `files.tree`
  handler; P4-24's content decision.

## Scope

**In:**

- `PKeyRecord` (the chain, `recordRevoked`), `PKeyDataOnly` (`dataOnlyRefusal`: normalised paths
  only, content-sniffed heads never extensions, the tail sniff, tree layout only), step 11
  relevance, the decision-input expansion, the install member and the engine refusals.
- The `simplify_path()` identity assertion in the `files.tree` handler.
- **A delegated file is never passed to `load_resource_pack`** or any API that mounts or loads code.
- Runners for both sections in `run_tests.sh` (4.4.1 floor and current); `parity.json` moves
  `packs.delegation` from `planned` to implemented; README. Signed bytes go through `PKeyJson`;
  thread-reachable code never indexes a const Array.

**Out:** the Worker, CLI, client-core and corpus (P4-19); Python and Swift (P4-25).

## Steps

1. Branch from `main` after P4-19 and P4-24 have merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [x] Every `delegationCases` and `dataOnlyCases` row passes in the editor and the release template.
- [x] Non-normalised paths and extension-disguised resources are refused (P4-08 review lesson).
- [ ] The full green gate passes.

## Hand-off from P4-24

P4-24 ported the feed revocation `kind` rule into `PKeyFeed.feed_content`, but Godot's update check
(`services/update/flow.gd`, around lines 341 and 404) skips `kind: delegation` entries both for step
11 fetching and when deciding whether `relearn` can clear. That is harmless until Godot can hold a
delegated install. When this package adds delegation support, restore client-core's relevance rule:
delegation entries count as relevant for `relearn` clearing, exactly as `check.ts` does. Also remove
the `DELEGATION_PLANNED` and `DATA_ONLY_PLANNED` lists once the sections run for real.

## Corrections from implementation

- **Names.** The plan's `PKeyRecord` is the existing `PKeyReleaseRecord` (`core/release_record.gd`):
  the chain (`delegation_hash_of`, `delegated_kid`, `delegation_of`, `verify_delegation`,
  `covers_pack`, `record_revoked`, `is_delegated_kid`) lives beside `verify_release_record`, whose
  result gains `delegation` (null for a release key). `PKeyDataOnly` is `packs/dataonly.gd`, beside
  client-core's `packs/dataonly.ts`; "" is client-core's null (admitted).
- **The delegation cache.** `verify_delegation` caches a verified delegation in the process under its
  hash, `expectedAud` and SHA-256 digests of the sorted pinned release keys and product trust set
  (plan §2.3), at most 64 entries; a hit still checks that the bytes hash to the kid. The engine
  also keeps fetched delegation bodies by hash and re-verifies them at every use, as client-core,
  Python and Swift do.
- **Strict UTF-8 and the text rule.** `PKeyDataOnly.is_strict_utf8` checks the WHATWG ranges by
  hand (TextDecoder fatal's verdict: overlongs, encoded surrogates, above U+10FFFF, truncated and
  stray bytes refused), with direct vectors in the new `delegation` packs group. The NUL check runs
  on the bytes; the rest runs on the losslessly decoded String: each `\u`/`\U` occurrence is found
  natively (client-core visits every backslash, which reaches the same occurrences) and the five
  markers are searched raw and with backslashes removed. About 820 KB of JSON takes 38 ms in the
  editor and 32 ms on the release template.
- **Holds.** As in P4-25, the engine gains `holds` (the stamp's `stamp_holds`, set by
  `PolarisKey.update.packs.start()`), so a held release is never delegated; the facet test pins it.
- **No delegated byte is mounted, including by the GDDL route.** Godot decodes `zstd-patch-from`
  deltas by mounting helper packs that hold the delta's base files and frame (P4-08), which would
  put delegated bytes through `load_resource_pack`. A delegated plan, or one whose installs include
  a delegated one, therefore plans without `zstd-patch-from` (`file` and `full` remain). The
  `godot.pck` handler's `activate` and `PolarisKey.update.packs.mount()` also refuse any install
  that carries a delegation (step 16 already refuses a delegated `godot.pck`).
- **The `simplify_path()` assertion** is in two places: `PKeyDataOnly.data_only_path_refusal`
  (rule 1) and `PKeyFilesTreeHandler.check_tree`, which refuses (`files-unsafe-path`) any staged
  path that is not its own `simplify_path()` before the existing tree check. The files index's path
  rules make both the identity on every admitted path.
- **`pack_for`.** `PKeyPackProvides` now verifies a target through `PKeyPackEngine.fetch_verified`
  (shared with `_preflight`, as client-core's `fetchVerified`), resets the delegation bound per call,
  and skips a target whose record or delegation is revoked before the memo is consulted.
- **A pinned `pkd1-` kid** is refused by `PKeyCore.check_update_options` (`invalid-options`), as in
  sdk-node, Python and Swift.
- **Timings (M-series Mac, 4.7.2).** The `delegationCases` section runs inside the conformance
  suite; `dataOnlyCases` takes 7.8 ms in the editor and 6.2 ms on the template; the `delegation`
  packs group 3.7 s in the editor and 2.9 s on the template (most of it the test signer).
