# P1b-03 Capture HTTP transcripts from Worker tests and replay them in every SDK

| Field       | Value                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                                                                                                           |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                        |
| Depends on  | [P1b-01](P1b-01-parity-registry.md)                                                                                                                                                                                       |
| Unblocks    | [P1b-06](P1b-06-reregister-401.md), [P1b-07](P1b-07-license-config-release-gaps.md), [P1b-08](P1b-08-devicecode-edgemint-ports.md)                                                                                        |
| Role        | `pkey-implementer` (see `.claude/agents/`)                                                                                                                                                                                |
| Plan mode   | no (transcripts are not the signed corpus; nothing here changes the wire)                                                                                                                                                 |
| Gates       | a new drift gate (`pnpm gen:transcripts -- --check` plus a Worker freshness test); all SDKs replay; a generator-owned Swift mirror; the `parity:check` extension. No new route, so rule 10 is untouched                   |
| Human input | none                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                 |

## Goal

Server conversations are pinned as generated transcripts in `conformance/transcripts/*.json`,
recorded through the real Worker router by scenario tests. Their ids, clock and signatures are
deterministic, and the documents in them are signed with the corpus test key. The Node, React,
Python and Swift suites replay every transcript whose features their `parity.json` marks
`implemented`. Each replay asserts the method, path, required headers and body shape of every
request, rejects unexpected calls, and checks the client outcome. `pnpm gen:transcripts -- --check`
and a Worker test fail when a Worker change alters a recorded response. `pnpm parity:check` enforces
`transcript` proofs.

## Why

Registration, activation and sign-in are conversations, not pure functions, so the corpus cannot pin
them ([PARITY §4.2](../../PARITY.md#42-http-transcripts-flows-the-corpus-cannot-express)). Today
each SDK's HTTP behaviour is checked only against its own hand-written fakes, which is how gaps such
as re-register-on-401 went unnoticed (README §9.1 #14). P1b-06, P1b-07 and P1b-08 are defined as
"make this transcript pass".

## Read first

- `AGENTS.md`, `CLAUDE.md`; [PARITY §2.1](../../PARITY.md#21-the-contract),
  [§2.3](../../PARITY.md#23-concurrency-models-per-language),
  [§4.2](../../PARITY.md#42-http-transcripts-flows-the-corpus-cannot-express),
  [§11](../../PARITY.md#11-open-questions) Q2.
- `docs/security/WIRE-CONTRACT-V3.md` §5 (transport, 401 rule, headers) and §6 (device principal).
- `packages/worker/src/index.ts:68-153` (`dispatch`), `packages/worker/test/helpers.ts`
  (`makeTestDb`), `test/seed.ts` (`TEST_KID`, `makeEnv`, `seedProduct`, `mkReq`), `test/e2e.test.ts`
  (the richest existing flow), `test/kvMock.ts`, `test/rlMock.ts`, `test/oidcEdge.test.ts:30-45`
  (how the IdP is mocked).
- Replay seams: Node `fetchImpl` (`packages/sdk-node/src/core/context.ts`, `CoreOptions`); React
  `fetchImpl` (`browser/browserAdapter.ts`, `BrowserAdapterOptions`); Python `httpx.MockTransport`
  (`sdks/python/tests/helpers.py:257`); Swift `PolarisTransport`
  (`sdks/swift/Sources/PolarisKeyCore/Transport.swift:97`, stubbed in
  `Tests/PolarisKeyTests/TestSupport.swift:194`).
- `tools/sign-corpus.ts` (`reconcile()` and the Swift mirror constant `SWIFT_V2_RESOURCES`).

## Scope

**In:**

- **A router seam.** Export `dispatchWith(req, env, db, now)` from `packages/worker/src/index.ts`.
  Today `dispatch` builds `new D1Db(env.DB)` and reads `Date.now()` inline (`index.ts:72-73`); the
  production `fetch` keeps doing exactly that through the new function.
- **A recorder and scenarios** under `packages/worker/test/transcripts/`. Each scenario seeds a
  product, drives a conversation through `dispatchWith` with `makeTestDb()`, asserts the server
  behaviour as an ordinary test, and returns the recording.
- **The first set:**
  - `discovery-capabilities`, and `discovery-failure` (404 and 5xx; the client fails closed);
  - `sync-etag-304` (both documents, per-document ETags, the trust manifest);
  - `sync-errors` (401, then one `POST /<p>/license/token`, then one retry; a 403 block with
    `allowedRange`; a 5xx);
  - `activate-enroll-deactivate` (remote best-effort, local wipe mandatory);
  - `register-open`, and `register-reregister-401` (recorded here, replayed from P1b-06);
  - `telemetry-report` (allowlisted keys only).
- **Generation.** `packages/worker/test/transcripts.test.ts` runs every scenario and compares the
  recording with `conformance/transcripts/<id>.json`, failing when stale. With
  `PKEY_WRITE_TRANSCRIPTS=1` it writes the files and the Swift mirror
  (`sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/`, added to `Package.swift` resources
  beside `Resources/v2`). Root script `"gen:transcripts"`, a small Node wrapper that runs that test
  file with or without the write flag, and supports `--check`.
- **Replayers:**
  - Node: `conformance/runners/node/transcripts.test.ts`, driving `PolarisKeyClient`;
  - React: `packages/sdk-react/test/transcripts.test.ts` (discovery only; see Design notes);
  - Python: `sdks/python/tests/test_transcripts.py`;
  - Swift: `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift`.

  Each replayer reads its own `parity.json` and replays the transcripts whose `features` are all
  `implemented`, so a new transcript for a missing feature does not break an SDK until it claims the
  feature.
- **The checker.** Extend `tools/parity-check.ts`: an `implemented` feature with a `transcript` proof
  needs at least one transcript that lists it and a tagged replayer in that SDK.
- CI step, `AGENTS.md` green gate and `waves.md` row for `pnpm gen:transcripts -- --check`. Add a
  "Transcripts" section to `contribute/corpus.md`.

**Out** (and where it belongs instead):

- Device-code and edge-mint transcripts (→ [P1b-08](P1b-08-devicecode-edgemint-ports.md)): P1-06
  changes the device flow and P0-12 changes who may mint, so record them after those land.
- Making SDKs pass `register-reregister-401` (→ [P1b-06](P1b-06-reregister-401.md)); transcripts for
  the catalog fetch and the release client (→ [P1b-07](P1b-07-license-config-release-gaps.md)).
- Asserting `X-PKey-Platform` and `X-PKey-Arch` values (→ [P1b-04](P1b-04-headers-config-corpora.md);
  assert presence only until then).
- `429`/`503` back-off with `Retry-After` in the SDKs: no SDK implements it and the Worker's
  `rate_limited` responses send no `Retry-After`. Record today's responses; adding back-off is a
  behaviour change with no owner yet (report it).
- Feed, release-record, `Range`/`If-Range` and `dcz` transcripts (→ P3 and P4 packages); a Godot
  replayer (→ the Godot P1 packages).

## Design notes

**The research's "capture what the suite already exercises" does not work as-is.** Existing Worker
tests call handlers directly with `mkReq`, whose URL is always `https://key.plrs.im/x`
(`test/seed.ts:264-275`), so their requests carry no real path or routing. Transcripts therefore
come from new scenario tests through the router seam. They can reuse the seeds and helpers.

**Determinism.**

- Freeze `Date` with Vitest fake timers. Some handlers read `Date.now()` directly rather than the
  injected `now`, for example `handleDeauthorize` in `services/license/activation.ts` and
  `handleAuthDeviceStart` in `services/identity/oidc.ts`.
- Stub `crypto.getRandomValues` and `crypto.randomUUID` with a seeded generator during recording.
- The Worker's test signing key is the corpus key (`pkey-test-prod-2026`, `test/seed.ts:24-27`,
  identical to `tools/sign-corpus.ts`), so recorded documents verify against the corpus pins.
- Never rewrite signed bodies after recording: that breaks the signatures.

**Format** (`transcriptVersion: 1`; keep the field names):

```jsonc
{
  "transcriptVersion": 1,
  "id": "sync-etag-304",
  "description": "…",
  "features": ["core.sync"],
  "product": "djdl",
  "baseUrl": "https://key.plrs.im",
  "now": 1700000000,
  "trust": { "pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
  "initial": { "deviceId": "…", "token": "pkeyt_…", "version": "2.0.0", "services": ["license", "config"] },
  "steps": [
    {
      "action": "sync", // discover | sync | activate | enroll | register | deactivate | report
      "args": { "force": false },
      "exchanges": {
        "ordered": false, // true only where the protocol orders requests (PARITY §2.3)
        "items": [
          {
            "request": {
              "method": "GET",
              "path": "/djdl/license/document",
              "headers": { "authorization": "Bearer {token}", "if-none-match": "\"…\"" },
              "requiredHeaders": ["x-pkey-device", "x-pkey-version", "x-pkey-channel", "x-pkey-sdk",
                                  "x-pkey-sdk-version", "x-pkey-platform", "x-pkey-arch"],
              "body": null // or { "json": {…}, "match": "subset" }
            },
            "response": { "status": 200, "headers": { "etag": "\"…\"" }, "body": "eyJ…" },
            "capture": { "token": "$.token" } // optional: bind a value for later steps
          }
        ]
      },
      "expect": { "result": "applied", "licenseStatus": "ok" }
    }
  ]
}
```

- Header names are compared lowercased. Only presence and the listed values are asserted, never
  order or casing ([§11](../../PARITY.md#11-open-questions) Q2).
- `{token}` and `{deviceId}` refer to `initial` or to earlier captures.
- Each SDK maps the `action` verbs onto its idiomatic calls, and `expect` onto its result types; keep
  that mapping in one helper per SDK.
- The replay fake serves the canned response for the next matching expected request. It fails on an
  unexpected request, on a leftover expected request at the end of a step, and on a body-shape
  mismatch.

**React.** The browser adapter is a cookie-session client with no device token
(`browserAdapter.ts:1-20`), so the device-token transcripts do not apply to it. The desktop adapter
reaches the Worker through the host's Node SDK, which the Node replayer covers. React therefore
replays `discovery-*` here and gains more when it implements more (P1b-07). Whether React's
`web`-only gaps become N/As is P1b-01's decision.

**Observed quirks to record, not fix:**

- Node maps every `429` on a document fetch to `device-cap` (`core/context.ts`, `getDocument`).
- The Worker's `429 rate_limited` responses carry no `Retry-After`.
- PARITY §4.2 says `authorization_pending`, but the device poll answers `status: "pending"`
  (`services/identity/oidc.ts:1211-1290`). That matters for P1b-08.

## Steps

1. Add `dispatchWith` and prove that the existing tests and `test:workerd` are unchanged.
2. Build the recorder and the determinism harness; record `discovery-capabilities` end to end and
   write the Node replayer against it.
3. Add the remaining scenarios, then the Python, Swift and React replayers.
4. Add the Swift mirror, the root script, the CI step and the checker extension; tag the replayers
   with the features they prove.
5. Update `AGENTS.md`, `waves.md` and `contribute/corpus.md`; run the green gate.

## Acceptance criteria

- [ ] `conformance/transcripts/` holds the eight transcripts listed under Scope, and the Swift mirror
      matches byte for byte.
- [ ] `mise exec node@22 -- pnpm gen:transcripts -- --check` exits 0; changing one Worker response
      body makes it and `pnpm --filter @polaris-key/worker test` fail (shown in the PR).
- [ ] Two consecutive `pnpm gen:transcripts` runs produce identical files.
- [ ] Node, Python and Swift replay every transcript except `register-reregister-401`, which their
      manifests keep `planned` for P1b-06; React replays `discovery-*`.
- [ ] A replayer fails when the SDK sends an extra request, omits one, or drops a required header
      (a unit test per SDK uses a doctored transcript).
- [ ] `pnpm parity:check` enforces `transcript` proofs, and its tests cover the new rule.
- [ ] `parity.json` manifests are updated for every SDK this changes.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd` after the `dispatchWith` change.

## Verify

```sh
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_transcripts.py )
( cd sdks/swift && swift test --filter TranscriptTests )
```

## Hand-off

- **Interfaces:** `dispatchWith(req, env, db, now)`; the scenario and recorder helpers under
  `packages/worker/test/transcripts/`; the transcript format; `conformance/transcripts/` and its
  Swift mirror; one replayer per SDK that filters by `parity.json`; `pnpm gen:transcripts`.
- [P1b-06](P1b-06-reregister-401.md) makes `register-reregister-401` pass;
  [P1b-07](P1b-07-license-config-release-gaps.md) and [P1b-08](P1b-08-devicecode-edgemint-ports.md)
  add scenarios with the same harness. Godot's P1 packages can replay the same files.
- Any later Worker change that alters a recorded response must regenerate the transcripts in the same
  PR; the SDK replayers then show which SDKs must follow.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-03 done`.
