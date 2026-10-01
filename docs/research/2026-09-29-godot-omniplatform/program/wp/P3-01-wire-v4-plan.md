# P3-01 Plan wire v4: `pkey-feed+jws`, `pkey-release+jws`, update and outlet matrices

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                               |
| Depends on  | [P2-03](P2-03-release-data-model.md), [P2b-01](P2b-01-distribution-service.md)                                     |
| Unblocks    | [P3-02](P3-02-wire-v4-contract-corpus.md), [P3-12](P3-12-worker-representability.md), [P4-01](P4-01-packs-plan.md) |
| Role        | `pkey-wire-planner` (planning only)                                                                                |
| Plan mode   | yes: this package **is** the plan. It writes `plans/P3-01.md`, then stops for human approval                       |
| Gates       | plan mode; human approval (merging the plan PR is the approval)                                                    |
| Human input | approval of `plans/P3-01.md`, and an answer to each open question it raises                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

`docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md` exists, follows the nine
required sections of [`plans/README.md`](../plans/README.md), and fixes the whole wire v4 event
precisely enough that P3-02 can implement it without a design decision of its own: the two new
`typ`s and their payloads, the client verification order, the `PROTOCOL_VERSION` 3 → 4 bump, the
corpus sections and files with their version constants, the `update-matrix.json` and
`outlet-matrix.json` row schemas, the routes P3-03 serves, and every SDK in order with the work
package that does it. A human merges it. No code, corpus or generated file changes.

## Why

The research moves the trust root for shipped code and packs to a **two-signer** model: a CI-held
release key signs _what exists_, and the Worker's product key signs _which and when_
([README §3.3](../../README.md#33-trust-model-two-signers-two-documents)). A compromised Worker
can then only withhold, delay or re-target among already-signed releases; it cannot ship code.
Diceroll's offline RSA key has that property today, and adopting Polaris Key must not lose it
([notes/A4 §5.7](../../notes/A4-diceroll-mapping.md)). This is the program's one `PROTOCOL_VERSION`
bump, and `CLAUDE.md` makes it plan-mode: contract → catalog → corpus → every SDK. Packs
(P4-01) reuse the same two documents, so the v4 shapes must leave room for them
([CONTENT §6.9](../../CONTENT.md#69-record-and-table-changes)).

## Read first

- `AGENTS.md` (rules 1–3, the wave model), `CLAUDE.md` (plan mode), `.claude/agents/pkey-wire-planner.md`,
  and [`plans/README.md`](../plans/README.md) (the required sections).
- Research: [README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next),
  [§3.9](../../README.md#39-rollouts-halts-and-telemetry),
  [§5.5](../../README.md#55-distribution-layer-one-build-any-outlet),
  [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #19;
  [CONTENT §6.7 and §6.9](../../CONTENT.md#67-lifecycle-implications);
  [PARITY §2.2, §4.1, §5.5, §7](../../PARITY.md#41-corpora-behaviour-as-data).
- Notes: [E5 §1](../../notes/E5-frontier-tech.md#1-update-security-frameworks) (TUF/Uptane, the
  verification order, the compromise table); [A2 §1.1–§1.8 and §7.1](../../notes/A2-sdk-port.md)
  (today's 13-step verify order, envelope, clock floor, malleability);
  [A5 §3](../../notes/A5-godot-empirical.md#3-pure-gdscript-ed25519-verify);
  [A4 §1.6 and §5](../../notes/A4-diceroll-mapping.md) (Diceroll's decision table and invariants);
  [E9 §1–§2](../../notes/E9-runtime-building-blocks.md#1-outlet-detection) (outlet signals,
  updater feeds).
- The contract and code as they are: `docs/security/WIRE-CONTRACT-V3.md` (§1, §2, §4.1, §8–§10);
  `packages/shared-protocol/src/core.ts:9` (`PROTOCOL_VERSION = 3`), `release.ts`, `update.ts`;
  `packages/shared-jws/src/index.ts:31-35` (`JwsTyp`) and `:308-379` (`verifyJws`);
  `packages/client-core/src/{verify,trust,clock,store}.ts`; `tools/sign-corpus.ts` (`KEYS` at
  `:87-100`, `buildV2` at `:1709`, the mirrors in `main` at `:4308`);
  `conformance/runners/node/corpusV2.test.ts`; `packages/docs/src/content/docs/contribute/{waves,corpus}.md`.
- The landed P2-03 and P2b-01 work: the names they chose for `seq`, deliverable ids, channel
  policy and the descriptor hooks. Use those names, not the research's.

## Scope

**In:**

- The plan file, with every required section, and concrete answers to every item in "Design
  notes" below: an answer with its reason, or an explicit question for the human with a
  recommendation.
- In the plan's summary, the list of work packages whose briefs the plan changes.
- Setting the status to `awaiting-approval` and opening the plan PR.

**Out** (and where it belongs instead):

- Any change to code, the corpus or generated files (→ [P3-02](P3-02-wire-v4-contract-corpus.md)).
- Implementing ingest, the feed routes and composition (→ [P3-03](P3-03-feed-composition.md)).
- `kind: pack` records, pack sets, bindings and `plan-matrix.json`
  (→ [P4-01](P4-01-packs-plan.md)); revocations, pack floors and the content rows of
  `update-matrix.json` (→ [P4-13](P4-13-revocation-floors-decision.md)); content-key delegation
  (→ [P4-19](P4-19-content-key-delegation.md)). The plan reserves their slots only.
- App-updater feed renderers (→ [P3-09](P3-09-updater-feeds.md)), except the extended
  `/update/version` shape if it becomes a `shared-protocol` type.

## Design notes

**Already decided by the research. Carry these names verbatim.**

- Two `typ`s: `pkey-feed+jws` (product key, device-less like the trust manifest, public and
  edge-cacheable) and `pkey-release+jws` (CI release key; the Worker never holds the private half).
- `PROTOCOL_VERSION` 3 → 4. New corpus material: `feedCases` and `releaseRecordCases` in
  `cases.json`, `update-matrix.json`, `outlet-matrix.json`, signature-malleability vectors
  (non-canonical S, A and R) in `jwsCases`, and the JSON edge vectors of README §9.1 #19 (lone
  surrogate, raw control characters, NUL).
- Client order (README §3.3): verify the feed against the product trust set (`kid`, `expiresAt`,
  `seq` ≥ stored); fetch each release record **by the hash the feed pins**; verify it against the
  **pinned release keys** only, never the Worker-served trust set; verify payloads against the
  record's SHA-256s; refuse a lower `seq` (roll back by rolling forward).
- Release record fields: `deliverable`, `kind`, `version`, `seq`, builds
  `{platform, arch, format, sha256, size, buildNumber}`, requirements, patch artifacts,
  `minSupportedSeq`; reserved for P4: `content: {contentApi, pins[], holds[], expects[], packChannels}`,
  `kind: pack`, `kind: revocation` (CONTENT §6.9).
- Feed fields: `seq`, `issuedAt`, `expiresAt`, the app's current release (record hash), floors,
  `critical`, per-outlet availability, `rollout{bp, salt}`, `halted`, the delta menu; reserved for
  P4: `packSets`, pack floors per `contentApi`, revocations.
- Rollout bucket `u32(sha256(salt ‖ installId)[0..4]) mod 10000`, evaluated client-side so the feed
  is identical for everyone.
- Decision outputs `none` (with `behind`), `packs`, `code-ready`, `binary` (with `prestage`),
  `store`, `blocked(app-floor | content-floor | revoked-content)`, `platform`; the invariants of
  README §3.6 and notes/A4 §5 (P1, P4–P6, P9–P11, P13).
- Outlet ids and capabilities (`binaryUpdates`, `codeUpdates`, `dataUpdates`, `channelSwitch`,
  `commerce`, `downloadedScripts`) from README §3.1. The server may narrow capabilities, never
  widen them past the compiled defaults (README §5.5).
- Release keys are pinned in the app and declared in `.pkey/release` `releaseKeys`; two are valid
  during rotation (README §3.3, §3.12).

**Open in the research. The plan answers each one (recommendation in brackets).**

1. Contract document: a new `docs/security/WIRE-CONTRACT-V4.md` that supersedes V3 as V3 did V2,
   plus the AGENTS.md rule 2 text ("currently **3**", the signed document set). [New V4 file.]
2. Feed granularity: one feed per (product, channel) with per-platform and per-outlet entries, and
   a `selector` object that P4 can extend with `contentApi` and variant. State the 64 KiB cap and
   the rule for splitting by platform if a feed would exceed it. [One per channel.]
3. Feed envelope: `iss`, `aud`, no `deviceId` or `graceUntil`, a shape discriminator
   (`schemaVersion: 1`, like the trust manifest), TTL (README §3.9 says 5–15 min), network and
   reload profiles, and what a stale feed means for the decision (notes/E5 §1.4 "freeze": keep
   running, never auto-update). Whether the feed joins the clock floor. [No, not in v4.]
4. `seq` rules: per (aud, channel, selector), bumped on content change only; accept `seq > stored`,
   or `seq == stored` with a newer `issuedAt`. Who assigns a release's `seq`, and how an installed
   build learns its own release (the build stamp of [P1-11](P1-11-godot-export-plugin.md)). [CI
   takes `seq` from [P2-02](P2-02-trusted-publisher.md)'s `nextSeq` ticket, as P2-06 does;
   installs identify themselves by version and build number.]
5. The `seq` floor must survive restarts, but WIRE-CONTRACT-V3 §4.1 forbids persisted counters.
   [Cache the verified feed JWS in a new optional `CacheRecordV3` slice and derive the floor on
   load; keep `CACHE_VERSION` 3 because the change is additive.]
6. Record details: the payload is P2-04's descriptor body moved, not reshaped
   (`builds[] {id, platform, arch, format, buildNumber, minOS, requires, artifacts[]}`, with
   P2-03's `build_id` as `id`); whether `ReleaseRecordDoc` lives in `shared-protocol` [yes, it is
   device-facing]; `iss` (the Worker's `key.plrs.im` would be false here) and `aud`;
   `buildNumber` type (iOS, Android, MSIX and Sparkle differ) [string]; `issuedAt` informational,
   no expiry; how a v4 verifier treats the reserved kinds [verify, then refuse to act on them];
   where clients get byte URLs [not in the signed body, since locations change after signing
   (README §3.3); from distribution by content hash].
7. The record hash: lowercase hex SHA-256 over the ASCII compact JWS, checked before signature
   verification. Field name in the feed.
8. Release-key trust: a separate `pinnedReleaseKeys` input in every SDK (`pinned_release_keys` in
   Python and GDScript), never merged with the product trust set; what discovery may advertise
   (fingerprints for tooling only). Whether the Sparkle EdDSA key may equal the release key,
   given one key would then sign both archives and JWS signing inputs. [Separate keys.]
9. Decision schema: inputs (installed version, build number, platform, arch, outlet, channel,
   engine, staged state, skip version, previous channel, capabilities, bucket, `now`) and
   outputs, with `binary.method` (`native` | `download` | `sidecar-pck`) and the reserved
   `packs`, `prestage`, `content-floor`, `revoked-content`. Keep `decideUpdate` synchronous: the
   bucket is computed by `rolloutBucket` and passed in, because WebCrypto hashing is async.
   Define `installId` [the SDK's device id] and the exact bytes and endianness of the bucket.
10. Outlet capability defaults per outlet id: the values, where they live and how the feed
    narrows them. [One table in `outlet-matrix.json`, which
    [P2b-02](P2b-02-distribution-manifest.md) already treats as the source of truth for its
    proposed defaults; `update-matrix.json` rows refer to it; later emitted by
    [P1b-02](P1b-02-sdk-constants.md)'s `gen-sdk-constants`.]
11. `outlet-matrix.json`: row schema, signal vocabulary from notes/E9 §1.1 (named
    `<platform>.<signal>`), confidence levels, precedence of runtime evidence over the build
    stamp, the `unknown` outcome and its capabilities, and how unverified signals are marked
    until [S-06](S-06-outlet-signals.md) reports.
12. Corpus placement: keep `conformance/corpus/v2/` and `corpusVersion: 2` with additive sections
    and new files versioned `updateMatrixVersion: 1` and `outletMatrixVersion: 1`, or open
    `corpus/v3/`. Every runner asserts `corpusVersion == 2` today (Node runner `:217`, Python
    `test_conformance.py:62`, Swift `ConformanceTests.swift:186`). [Keep v2, additive.]
13. Committed test keys: new release test keys in `KEYS` (e.g. `djdl-release-test-2026` and a
    second for rotation); feeds signed by the existing `pkey-test-prod-2026`.
14. Malleability vectors: the list, the expected verdict for each, and the rule when backends
    disagree (WebCrypto/OpenSSL in Node, `cryptography` in Python, CryptoKit in Swift, the
    GDScript verifier). [Record each backend's verdict with a throwaway script before fixing
    expectations; choose the strict verdict and add pre-checks where a backend is lenient.
    Decide explicitly on small-order public keys.] JSON edge vectors: lone surrogates [reject
    everywhere, per I-JSON], raw control characters [reject], `valid-nul-byte-in-string` [settled
    by P1-01: kept, with WIRE-CONTRACT-V3 §10's declared representation limit; this plan still
    decides U+0000 in object keys].
15. Routes for P3-03, with content types, caching and access mode: proposed
    `GET /{product}/update/feed/{channel}` and `GET /{product}/release/records/{sha256}`, both
    `application/jose`; discovery fields `update.endpoints.feed` and `release.endpoints.record`;
    channel-name collisions with the new path words.
16. The manifest field `.pkey/release` `releaseKeys: [{kid, ed25519}]` (rule 9), which work
    package adds it [P3-03, unless P2-04 already has; see
    [P2-04](P2-04-release-descriptor.md)], and `contentKeys` reserved for P4-19.
17. The extended `/update/version` shape if P3-09 needs a `shared-protocol` type.
18. The SDK order and assignment. [P3-02 → P3-05 (the `client-core` reference and the Node
    runner) → P3-04, P3-06, P3-07, P3-08 in parallel → P3-11.] No typed N/A for `update.feed`,
    `release.record` or `update.decide`; `update.driver` on iOS is `outlet`.
19. Rollout: deploy order, what deployed v3 clients see (no SDK enforces `protocolVersion`;
    licence, config, trust and bundle documents are byte-identical), old workers, and whether the
    interim release-key-only option of README §3.3 is used for Diceroll's minimum slice.
20. Boot-guard rows for `stage-matrix.json`. [P1-09](P1-09-boot-stage-machine.md) hands them to
    P3-10 "under its own plan", but P3-10 is not plan-mode. [Plan them here (rollback after two
    failed boots, the skipped version, the `boot_rolled_back` event) so P3-02 emits them.] The
    stage runners read every row, so say whether P3-02 also updates `client-core`'s
    `bootTransition` and the Godot port, or which package makes the new rows pass.
21. Update telemetry event names (README §3.6: `update_applied`, `update_confirmed`,
    `update_reverted`, `pack_failed`, `boot_rolled_back`). They travel on the unsigned
    `devices/report` and are not a wire change. [Fix the names here so P3-10 and P6-03 agree;
    leave shapes and the allowlist to [P6-03](P6-03-update-funnel-autohalt.md).]

If the plan cannot fit in about two pages, propose a split (for example, `outlet-matrix.json`
planned on its own) instead of shortening the answers.

## Steps

1. Run `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --show P3-01` and
   confirm P2-03 and P2b-01 are `done`. Set `planning`.
2. Read everything in "Read first". Note the names P2-03 and P2b-01 actually landed.
3. Optionally probe backends for item 14 with a throwaway script outside the repo tree. Record
   the verdicts in the plan; commit no code.
4. Write the plan section by section, answering items 1–21.
5. List the open questions, each with a recommendation, and the briefs the plan changes.
6. `check.mjs --set P3-01 awaiting-approval`, regenerate the index, run prettier, push
   `wp/P3-01-plan` and open the PR titled `P3-01 plan: wire v4`.

## Acceptance criteria

- [ ] `plans/P3-01.md` has the nine required sections of `plans/README.md`.
- [ ] Both payloads are specified field by field: name, JSON type, required or optional, and the
      check a verifier applies. The reserved P4 fields are named.
- [ ] The client verification order is numbered, and each step names the corpus case family that
      pins it.
- [ ] The `update-matrix.json` row schema is given with a list of row names that covers every
      invariant above, plus bucket vectors with exact byte encoding.
- [ ] The `outlet-matrix.json` row schema, the outlet id list, the signal vocabulary and the
      capability defaults are given.
- [ ] Every SDK (Node, React over `client-core`, Python, Swift, Godot) is named with its work
      package, in order, with any typed N/A.
- [ ] Rollout and compatibility for deployed v3 clients and workers are stated.
- [ ] Every open item is answered or raised as a question with a recommendation.
- [ ] Only `plans/P3-01.md`, `workpackages.json` and `INDEX.md` change; `node check.mjs` passes.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm exec prettier --check docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md
git diff --name-only origin/main...HEAD
```

## Hand-off

- [P3-02](P3-02-wire-v4-contract-corpus.md) executes the approved plan exactly; it writes no
  separate plan unless this one says to split.
- [P3-03](P3-03-feed-composition.md) takes the route names, the ingest checks and the feed
  composition rules. [P3-09](P3-09-updater-feeds.md) takes the extended `/version` shape.
- [P3-04](P3-04-v4-node.md) to [P3-08](P3-08-v4-godot.md) take the function names, the cache
  slices and the corpus sections. [P3-11](P3-11-outlet-detection.md) takes the outlet matrix.
- [P3-10](P3-10-godot-updater.md) takes the boot-guard rows and the event names;
  [P6-03](P6-03-update-funnel-autohalt.md) takes the event names.
- [P4-01](P4-01-packs-plan.md) extends the reserved slots rather than adding shapes.
- The planner sets `awaiting-approval`. The lead sets
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-01 done` once the
  human merges the plan PR.
