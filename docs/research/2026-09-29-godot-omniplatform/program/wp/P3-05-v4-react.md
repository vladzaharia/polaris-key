# P3-05 Wire v4 in `client-core` and the React SDK

| Field       | Value                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4) (sdk-wave)                                                                                                                                                                                                               |
| Size        | 1.25–1.75 engineer-weeks                                                                                                                                                                                                                                            |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md)                                                                                                                                                                                                                           |
| Unblocks    | [P3-04](P3-04-v4-node.md), [P3-06](P3-06-v4-python.md), [P3-07](P3-07-v4-swift.md), [P3-08](P3-08-v4-godot.md), [P3-11](P3-11-outlet-detection.md), [P4-06](P4-06-client-core-packs.md), [P4-13](P4-13-revocation-floors-decision.md), [X-02](X-02-tauri-plugin.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                   |
| Plan mode   | no: behaviour is fixed by `plans/P3-01.md` and the corpus                                                                                                                                                                                                           |
| Gates       | corpus (`feedCases`, `releaseRecordCases`, `update-matrix.json`)                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                           |

## Goal

`@polaris-key/client-core` verifies a `pkey-feed+jws`, checks a `pkey-release+jws` against the
feed's hash pin and then against pinned release keys, computes the rollout bucket and returns the
update decision, all without I/O. The Node conformance runner proves all three against
`feedCases`, `releaseRecordCases` and every `update-matrix.json` row. The React SDK exposes the decision to a
browser or desktop host and renders it in `<UpdatePrompt>`. This is the JavaScript reference
implementation of wire v4; [P3-04](P3-04-v4-node.md) builds the Node SDK on it.

## Why

`client-core` is where verification, trust merge, the gate and the clock floor are implemented
once for both JavaScript SDKs (`packages/client-core/README.md`,
`packages/docs/src/content/docs/contribute/waves.md` step 1). The research makes the update
decision a conformance-tested pure function like the licence gate
([README §3.6](../../README.md#36-update-what-an-installed-app-should-do-next),
[§8](../../README.md#8-carrying-the-concepts-to-the-other-sdks-and-products) item 4), and
[PARITY §5.5](../../PARITY.md#55-release-and-update) lists `update.feed`, `release.record` and
`update.decide` as new in every SDK. Running this package first after P3-02 surfaces any corpus
mistake once, in the reference, instead of in five languages.

## Read first

- `AGENTS.md`; `.claude/agents/pkey-sdk-porter.md`; `plans/P3-01.md` (names, verify order,
  decision schema, cache slices).
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents) (client order),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next); [notes/A4 §1.6 and
  §5](../../notes/A4-diceroll-mapping.md) (the invariants the rows encode).
- `packages/client-core/src/verify.ts` (envelope, `DocTypeSpec`), `trust.ts` (pins-only
  verification), `clock.ts`, `store.ts` (`CacheRecordV3`), `semver.ts` (`compareSemver`),
  `index.ts` and `package.json` (subpath exports); `packages/client-core/README.md`.
- `conformance/runners/node/corpusV2.test.ts` (how each section is driven).
- React: `packages/sdk-react/src/update/{index,useLatestVersion}.ts`,
  `src/components/UpdatePrompt.tsx`, `src/core/{adapter,store,types}.ts`,
  `src/browser/browserAdapter.ts`, `src/desktop/{bridge,desktopAdapter}.ts`,
  `test/gateMatrixParity.test.ts` (the pattern for a projection test), `test/updatePrompt.test.tsx`.

## Scope

**In:**

- **`client-core` pure functions**, one module each with a subpath export (names per the plan;
  proposed): `feed.ts` `verifyFeed(jws, {trust, expectedAud, channel, lastSeq?, lastIssuedAt?, now?, checkFreshness?})`;
  `record.ts` `recordHash(jws)` (lowercase hex SHA-256 of the ASCII string) and
  `verifyReleaseRecord(jws, {releaseKeys, expectedAud, expectedHash, expect})`; `decide.ts`
  `rolloutBucket(salt, installId)` and the synchronous `decideUpdate(input)`, with the outlet
  capability defaults table from the plan. Each returns `null` or a typed refusal on any failure,
  never a throw, like `verifyDoc`.
- **Cache contract**: the plan's new optional slices on `CacheRecordV3` (for example `feeds` and
  `releaseRecords`), and a helper that derives the `seq` floor from a re-verified cached feed.
- **Node runner sections** in `conformance/runners/node`: `feedCases`, `releaseRecordCases`,
  every `update-matrix.json` row and bucket vector, through the functions above.
- **React**: a headless hook (proposed `useUpdateDecision`) beside `useLatestVersion`, which is
  kept. The browser adapter fetches the feed and the record (discovery endpoints from P3-03) and
  persists the slices in its store. The desktop adapter calls the bridge's
  `invoke("update", "decide", …)` (`src/desktop/bridge.ts`), which an Electron host answers with
  the Node SDK's `client.update.decide()` from [P3-04](P3-04-v4-node.md); test it with a fake
  bridge. `<UpdatePrompt>` renders `store`, `binary`, `platform`, `blocked(app-floor)` and
  mandatory states. A new `updateMatrixParity.test.ts` proves the adapters feed `decideUpdate`
  the right inputs.
- If the Chromium runner from P1b-05 exists, it runs the three new sections too.
- `packages/client-core/README.md` subpath table; `packages/docs/src/content/docs/build/sdks/react.mdx`.
- `parity.json` for React (which covers `client-core`, PARITY §1): `update.feed`,
  `release.record`, `update.decide` → `implemented`, with `@pkey-feature` tags.

**Out** (and where it belongs instead):

- Node SDK wiring, persistence in `FileStore`/`KeyringStore`, CLI adapters (→ [P3-04](P3-04-v4-node.md)).
- Outlet detection (→ [P3-11](P3-11-outlet-detection.md)); until then the host passes `outlet`,
  and the web build uses `web`.
- Pack sets, `packs`, `prestage` and content rows (→ [P4-06](P4-06-client-core-packs.md),
  [P4-13](P4-13-revocation-floors-decision.md)).
- Any change to the corpus. A missing or wrong case is plan-mode: stop and report.

## Design notes

- **Plan amendments (`plans/P3-01.md` §8, approved).** Where this brief and the plan differ, the
  plan wins:
  - the function names, refusal reasons and steps in plan §2.7 and §2.5, including
    `parseVersion`, `compareVersions`, `resolveUpdateOutlet` and
    `effectiveCapabilities(kind, {platform, …})`;
  - `decide()` returns an `UpdateCheck` (`channel`, `decision`, `feed`, `record`, `errors`) with
    §2.5's error map, the record-body bound (`MAX_RECORD_JWS_BYTES`, 88 844 bytes, refused at
    step 12 without hashing) included; the decision inputs are `outlet {id, kind}`, `subkind`,
    `format` and `methods`;
  - every pattern goes through the SDK's whole-string pattern helper, and member presence is as
    plan §2.2 says (a required member present, an optional one absent or typed, never `null`);
    `builds[].id` and `targets[].platform` are ASCII by `BUILD_ID_PATTERN` and
    `FEED_PLATFORM_PATTERN`;
  - the cache slices are `feeds` and `releaseRecords`; `bootDecision` never answers `required`,
    and `mandatory` and `blocked` are prompts the player cannot dismiss; an empty
    `pinnedReleaseKeys` raises `not-configured` and a release key that is also a trust pin raises
    `invalid-options`;
  - the canonical channel (§2.3, §2.5, §2.6): `feeds` and the floors are keyed by each feed's own
    `channel` claim, `verifyFeed`'s `floors` map is read only after step 5, the fallback order,
    the removal of the requested name's entry after an alias answer, and `UpdateCheck.channel`;
    no SDK resolves an alias itself, and the decision has no `channel` input;
  - this package's transcript replayer learns the `updateDecide` action and the `initial.update`
    block in the same PR that flips `update.feed`, `release.record` and `update.decide`
    (plan §5).
- **Starts from P3-02's four functions.** `parseVersion`, `compareVersions`, `feedClaims` and
  `releaseRecordClaims` (with the Node runner's `versionCases` and claims sections) land in
  [P3-02](P3-02-wire-v4-contract-corpus.md); this package adds the rest of `feed.ts`,
  `record.ts` and `decide.ts`, the full Node runner sections for `feedCases` and
  `releaseRecordCases` and every `update-matrix.json` section but `versionCases`, and React's
  replayer. [P3-03](P3-03-feed-composition.md) does not wait for this package.
- **The order is the contract** (README §3.3, the plan's numbering): verify the feed with the
  product trust set; compare the record's hash with the feed's pin **before** verifying its
  signature; verify the record with `releaseKeys` only, never the merged trust set; check the
  record's `deliverable`, `version` and `seq` against the feed; refuse a lower `seq`.
- **`decideUpdate` stays synchronous.** WebCrypto digests are async, so `rolloutBucket` is async
  and its result is an input. Other languages hash synchronously; the matrix pins the bucket
  separately so every SDK agrees on both halves.
- **No persisted counters** (WIRE-CONTRACT-V3 §4.1): persist signed JWSs only and derive every
  floor on load with `checkFreshness: false`.
- **Invariants that the rows pin**: no downgrade; `behind` suppresses the floor; the binary
  supersedes code updates; store builds never self-update code; a halted or out-of-bucket outlet
  gets `none`; a stale feed never triggers an automatic update; a channel switch drops staged
  code; engine and format gating.
- **Capabilities only narrow.** The compiled defaults per outlet are the ceiling; the feed can
  lower them, never raise them.
- Keep `compareSemver` as the one version comparison; the decision must agree with the server's
  build gate.

## Steps

1. Confirm P3-02 is `done`; branch `wp/P3-05-v4-react`.
2. `client-core` modules and exports; unit tests for each refusal path.
3. Node runner sections; all rows green.
4. Cache slice types and the floor helper.
5. React hook, adapters, `<UpdatePrompt>` states, projection test.
6. Docs, README, `parity.json`. Green gate; set `in-review`.

## Acceptance criteria

- [x] `conformance/runners/node` passes every `feedCases`, `releaseRecordCases` and
      `update-matrix.json` row and bucket vector through `client-core`.
- [x] `client-core` exports the plan's functions through the barrel and one subpath each; the
      package stays isomorphic (no Node built-ins; `pnpm --filter @polaris-key/client-core build`
      and the React browser bundle build).
- [x] A record whose hash does not match the pin is refused without a signature check, and a
      record signed by the product key is refused (unit tests).
- [x] The React hook reports the decision for the browser and desktop adapters;
      `updateMatrixParity.test.ts` and `updatePrompt.test.tsx` cover every action the plan
      defines for v4.
- [x] `useLatestVersion` and today's `/update/version` path still work unchanged.
- [x] The green gate passes (`AGENTS.md`).
- [x] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Corrections from the implementation

Recorded by P3-05 where the code or the plan made this brief's text inexact:

- **Names.** The plan's §2.7 signatures win over the "proposed" ones in Scope: `verifyFeed(jws,
{trust, expectedAud, channel, platform, now?, checkFreshness?, floors?})` and
  `verifyReleaseRecord(jws, {releaseKeys, productTrust, expectedAud, expectedHash, pin?})`.
  The floor helper is `feedFloor`, with `reloadFeeds` (the reload path, which derives the floors),
  `commitFeed` (step 9's write) and `reloadReleaseRecords`. `decide.ts` also exports
  `outletEntry`, `feedTarget`, `isValidHostOutlet` and `isUndismissable`.
- **`resolveUpdateOutlet` never throws** (plan §2.7: "None of them throws"): it answers `null`
  for an invalid host value, and the SDK raises `invalid-options` at construction.
- **`runUpdateCheck` (new subpath `/check`).** §2.5's order, fallback and error map are shared by
  both JavaScript SDKs as one I/O-free function that takes the two fetches as callbacks and the
  cache slices, and returns the `UpdateCheck` plus the slices to write. P3-04 builds
  `client.update.decide()` on it.
- **Browser trust.** A browser holds no verified trust manifest, so its feeds verify against the
  pinned product keys (`trust.pinnedKeys`), which `decideUpdate()` requires beside
  `update.pinnedReleaseKeys`. The slices persist in the IndexedDB record beside the bundle cache
  and survive a sign-out and a bundle import.
- **Transcripts.** P3-03's `update-feed-rollback` and `update-record-by-hash` require
  `core.store`, which React declares `na`, so they never apply to React. The React replayer
  learns `updateDecide` and `initial.update` all the same, proven by a synthetic transcript in
  `test/transcripts.test.ts`.
- **Chromium runner.** P1b-05 has not landed, so no Chromium job runs the new sections yet.
- **Status.** The lead sets the package's status at merge; this branch does not run
  `check.mjs --set`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm build && mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- `verifyFeed`, `verifyReleaseRecord`, `recordHash`, `rolloutBucket`, `decideUpdate`, the outlet
  defaults table and the cache slice types, consumed by [P3-04](P3-04-v4-node.md) and by
  [P3-03](P3-03-feed-composition.md)'s end-to-end test.
- The decision type with its reserved `packs` and `prestage` members, which
  [P4-06](P4-06-client-core-packs.md) and [P4-13](P4-13-revocation-floors-decision.md) extend.
- The React hook and adapter methods, which [X-02](X-02-tauri-plugin.md)'s Tauri host reuses.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-05 done` in the PR
  that completes the work.
