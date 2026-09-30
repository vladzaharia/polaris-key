# P3-04 Wire v4 in the Node SDK: feed and release-record verification, update decision

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4) (sdk-wave)                             |
| Size        | 0.5–0.75 engineer-weeks                                                           |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md), [P3-05](P3-05-v4-react.md)             |
| Unblocks    | [P4-06](P4-06-client-core-packs.md), [P4-13](P4-13-revocation-floors-decision.md) |
| Role        | `pkey-sdk-porter`                                                                 |
| Plan mode   | no: behaviour is fixed by `plans/P3-01.md` and the corpus                         |
| Gates       | corpus (`feedCases`, `releaseRecordCases`, `update-matrix.json`)                  |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

`@polaris-key/node` fetches the channel feed, verifies it, fetches the pinned release record by
hash, verifies it against the host's pinned release keys, persists both as signed artifacts in
its verified cache, and returns the update decision through `client.update`. The same corpus
sections the other SDKs pass (`feedCases`, `releaseRecordCases`, `update-matrix.json`) pass
through the Node SDK's own wiring, and the `seq` floor survives a restart.

## Why

Node is one of the six SDK languages that must decide identically about downgrades, floors and
outlet capabilities ([README §8](../../README.md#8-carrying-the-concepts-to-the-other-sdks-and-products)
item 4; [PARITY §5.5](../../PARITY.md#55-release-and-update)). Its CLIs and Electron main
processes are "verify, then stage" hosts ([notes/E9 §2.3](../../notes/E9-runtime-building-blocks.md)),
so the verified decision is what they act on.

**Dependency note.** The pure functions live in `client-core` and are written in
[P3-05](P3-05-v4-react.md), which also adds the Node conformance runner sections. Start this
package after P3-05 has merged. The graph lists only P3-02; adding P3-05 as a dependency is
proposed.

## Read first

- `AGENTS.md`; `.claude/agents/pkey-sdk-porter.md`; `plans/P3-01.md` (API names, cache slices,
  host options).
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents) (client order);
  [PARITY §2.1–§2.2](../../PARITY.md#22-typed-unsupported-here).
- `packages/sdk-node/src/update/client.ts` (today's `check()` and `appcastUrl()`),
  `src/client.ts` (`PolarisKeyClientOptions`, per-service option bags), `src/core/context.ts`
  (`CoreOptions`, `pinnedTrust`), `src/core/cache.ts` (the load procedure is the security
  boundary), `src/core/store.ts` (`FileStore`, `KeyringStore`), `src/discovery.ts`
  (`appcastUrlFrom`).
- `packages/sdk-node/test/releaseUpdate.test.ts`, `test/sync.test.ts`, `test/store.test.ts`.
- The `client-core` functions and cache slice types from [P3-05](P3-05-v4-react.md).

## Scope

**In:**

- **Options.** An `update` option bag on `PolarisKeyClientOptions` (proposed
  `UpdateClientOptions`): `pinnedReleaseKeys` (kid → raw Ed25519 key, base64url), `outlet`
  (host-supplied until [P3-11](P3-11-outlet-detection.md)) and `buildNumber`.
  `CoreOptions.version` stays the installed version.
- **`UpdateClient`**: the plan's methods (proposed `feed({channel})`, `releaseRecord(hash)` and
  `decide({channel, staged?, skipVersion?})`), using discovery's feed and record endpoints from
  [P3-03](P3-03-feed-composition.md), the device id as `installId`, and `client-core` for every
  check. `check()` and `appcastUrl()` keep their behaviour.
- **Cache.** Persist the verified feed and record JWSs in the plan's `CacheRecordV3` slices
  through Core's read-modify-write (`cache.ts` `patch()`); on load, re-verify them with
  `checkFreshness: false` and derive the `seq` floor; drop anything that fails.
- **Discovery.** Parse the new endpoints in `src/discovery.ts`.
- **Tests**: a projection suite (proposed `test/updateMatrixParity.test.ts`) that maps each
  `update-matrix.json` row's installed state onto client options and asserts the SDK's decision;
  `feedCases` and `releaseRecordCases` replayed through `UpdateClient` with a fake fetch; restart
  tests with `FileStore` (a lower `seq` after reload is refused; a hash mismatch is refused before
  any signature check; an expired cached feed yields the stale outcome, never an update).
- `packages/docs/src/content/docs/build/sdks/node.mdx` and `packages/sdk-node/README.md`.
- `parity.json` for Node: `update.feed`, `release.record`, `update.decide` → `implemented`.

**Out** (and where it belongs instead):

- The pure functions and the Node runner sections (→ [P3-05](P3-05-v4-react.md)).
- Outlet detection (→ [P3-11](P3-11-outlet-detection.md)).
- Handing off to Velopack, `electron-updater` or a SEA self-replace (`update.driver`; not in P3).
- An update command in the CLI adapters (`src/cli/`): there is none today, and adding one is
  separate work.
- Packs (→ [P4-06](P4-06-client-core-packs.md)).

## Design notes

- Use `client-core`; do not re-implement any check here. The SDK's job is transport, storage and
  mapping host state to decision inputs.
- `pinnedReleaseKeys` never merges with `trust.pinnedKeys` or the discovered set, and nothing
  learned from the network may add to it.
- Fetch the record by hash from the route P3-03 serves; compute `recordHash` over the exact bytes
  received before parsing anything.
- If the product does not run Update, the client refuses before dialling, as `check()` does
  (D-21 capability gate).
- Node CLIs are never store-installed; `direct` is the usual outlet, and the host can say
  otherwise until detection lands.

## Steps

1. Confirm P3-02 and P3-05 are `done`; branch `wp/P3-04-v4-node`.
2. Options and discovery parsing.
3. `UpdateClient` methods over `client-core`.
4. Cache slices and reload derivation.
5. Tests, docs, `parity.json`. Green gate; set `in-review`.

## Acceptance criteria

- [ ] `client.update.decide()` returns the plan's decision shape; every `update-matrix.json` row
      passes through the projection suite.
- [ ] Every `feedCases` and `releaseRecordCases` vector gives the expected verdict through
      `UpdateClient` (fake fetch).
- [ ] After a `FileStore` reload, a feed with a lower `seq` is refused, and the floor came from a
      re-verified cached JWS rather than a stored number.
- [ ] A record whose SHA-256 differs from the feed's pin is refused before signature
      verification; a record signed by a key outside `pinnedReleaseKeys` is refused.
- [ ] `check()` and `appcastUrl()` behave as before (existing tests unchanged).
- [ ] The green gate passes (`AGENTS.md`).
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- `UpdateClientOptions.pinnedReleaseKeys` and the `update.decide()` surface, used by Electron and
  CLI hosts and extended by [P4-06](P4-06-client-core-packs.md) with the pack facet.
- The cache slices on disk, which [P4-13](P4-13-revocation-floors-decision.md) extends with
  revocations.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-04 done` in the PR
  that completes the work.
