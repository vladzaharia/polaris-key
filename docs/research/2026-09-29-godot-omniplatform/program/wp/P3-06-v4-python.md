# P3-06 Wire v4 in the Python SDK

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4) (sdk-wave)                              |
| Size        | 0.5–0.75 engineer-weeks                                                            |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md)                                          |
| Unblocks    | [P4-07](P4-07-python-swift-packs.md), [P4-13](P4-13-revocation-floors-decision.md) |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no: behaviour is fixed by `plans/P3-01.md` and the corpus                          |
| Gates       | corpus (`feedCases`, `releaseRecordCases`, `update-matrix.json`)                   |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Goal

The Python SDK (`polaris-key` on PyPI) verifies `pkey-feed+jws` and `pkey-release+jws`, computes
the rollout bucket and the update decision with its own port of the rules, persists the signed
artifacts in its verified cache, and exposes the decision on `client.update`. Its pytest runner
passes every `feedCases`, `releaseRecordCases` and `update-matrix.json` row, on the lowest and
highest supported CPython.

## Why

Python is an independent port, proven identical to `client-core` only by the corpus
(`packages/client-core/README.md`, "Why one implementation"). Desktop tools and servers built on
it need the same verified decision as every other SDK
([PARITY §5.5](../../PARITY.md#55-release-and-update); Python gains "signed-feed verification"
in [README §8](../../README.md#8-carrying-the-concepts-to-the-other-sdks-and-products)).

## Read first

- `AGENTS.md` (Python has its own toolchain in the green gate); `.claude/agents/pkey-sdk-porter.md`;
  `plans/P3-01.md`.
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents) (client order),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next).
- `sdks/python/src/polaris_key/core/jws.py` (`verify_jws`, strict JSON, caps),
  `core/models.py` (`PROTOCOL_VERSION`, `TYP_*` at `:106-109`), `core/verify.py`, `core/trust.py`,
  `core/cache.py` (`CacheManager.load`, `patch`), `core/context.py` (`CoreContext.__init__`),
  `core/semver.py`, `update/client.py`, `discovery.py`, `client.py:193`.
- `sdks/python/tests/test_conformance.py` and `test_gate_matrix.py` (the runner patterns),
  `tests/test_release_update.py`.
- The reference implementation from [P3-05](P3-05-v4-react.md) in `packages/client-core/src`,
  when it has landed. The corpus is the authority either way.

## Scope

**In:**

- `core/models.py`: `TYP_FEED = "pkey-feed+jws"` and `TYP_RELEASE = "pkey-release+jws"` (unless
  P3-02 already added them), and frozen dataclasses for the feed, the release record and the
  decision (names per the plan).
- Pure functions (names per the plan; proposed): `verify_feed`, `record_hash`,
  `verify_release_record`, `rollout_bucket`, `decide_update`, and the outlet capability defaults
  table. Each returns `None` or a typed refusal on failure, never raises for a bad artifact.
- `core/cache.py`: the plan's new cache slices, written through `patch`, re-verified on `load`
  with freshness off; the `seq` floor derived from the re-verified feed.
- `update/client.py`: the plan's methods (proposed `feed(channel=)`, `release_record(hash)`,
  `decide(channel=, staged=, skip_version=)`), using discovery's endpoints and the device id as
  `install_id`. `check()` and `appcast_url()` are unchanged.
- Options: `pinned_release_keys`, `outlet` (host-supplied until [P3-11](P3-11-outlet-detection.md))
  and `build_number`, in the same place the plan puts them for the other SDKs.
- Tests: new parametrised sections in `tests/test_conformance.py` for `feedCases` and
  `releaseRecordCases`; a new `tests/test_update_matrix.py` for every row and bucket vector;
  wiring tests in `tests/test_release_update.py` (reload floor, hash-before-signature, stale feed).
- `packages/docs/src/content/docs/build/sdks/python.mdx`, `sdks/python/README.md`.
- `parity.json` for Python: `update.feed`, `release.record`, `update.decide` → `implemented`.

**Out** (and where it belongs instead):

- Outlet detection, including PEP 376 `INSTALLER` and MSIX identity probes (→ [P3-11](P3-11-outlet-detection.md)).
- The Velopack Python hand-off (`update.driver`; not in P3).
- An update command in `cli/core.py`: there is none today, and adding one is separate work.
- Packs (→ [P4-07](P4-07-python-swift-packs.md)).

## Design notes

- **Same order, same verdicts** as README §3.3 and the plan: feed against the product trust set;
  record hash compared with the pin **before** any signature work; record against
  `pinned_release_keys` only; `deliverable`, `version` and `seq` checked against the feed.
- **Strict JSON** comes from `core/jws.py`'s existing duplicate-key and payload rules. Every
  payload goes through `verify_jws`; do not call `json.loads` on an unverified segment.
- **Hashing** is `hashlib.sha256` over `jws.encode("ascii")`; the bucket takes the first four
  digest bytes as the plan specifies (endianness included).
- **Numbers.** Compare `seq` and timestamps as integers; reject non-integers where the plan says
  integer.
- **Floors are derived, never stored** (WIRE-CONTRACT-V3 §4.1).
- **Version range.** The package supports CPython 3.9+ (`pyproject.toml`); do not use syntax or
  stdlib newer than that.

## Steps

1. Confirm P3-02 is `done` (P3-05 ideally too); branch `wp/P3-06-v4-python`.
2. Models and pure functions; the conformance and matrix tests go green.
3. Cache slices and reload derivation.
4. Update client and options.
5. Docs, `parity.json`. Full pytest; set `in-review`.

## Acceptance criteria

- [ ] `pytest` passes every `feedCases`, `releaseRecordCases`, `update-matrix.json` row and
      bucket vector, with the same ids as the other runners.
- [ ] The suite passes on the lowest and highest CPython the SDK supports (3.9 and the newest in
      CI).
- [ ] A reload refuses a feed with a lower `seq`, using a floor derived from a re-verified cached
      JWS.
- [ ] A record with a mismatched hash is refused before signature verification; a record signed
      by the product key is refused.
- [ ] `check()` and `appcast_url()` behave as before.
- [ ] The green gate passes (`AGENTS.md`), including the Python job.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_conformance.py tests/test_update_matrix.py )
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- `verify_feed`, `verify_release_record`, `decide_update` and the cache slices, which
  [P4-07](P4-07-python-swift-packs.md) extends with the pack facet and
  [P4-13](P4-13-revocation-floors-decision.md) with content rows.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-06 done` in the PR
  that completes the work.
