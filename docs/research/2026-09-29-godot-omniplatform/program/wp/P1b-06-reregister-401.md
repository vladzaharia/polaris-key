# P1b-06 Re-register on 401 for licence-less devices, in every SDK

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                         |
| Size        | 0.75–1 engineer-weeks                                                                                   |
| Depends on  | [P1b-03](P1b-03-http-transcripts.md)                                                                    |
| Unblocks    | none                                                                                                    |
| Role        | `pkey-sdk-porter` (see `.claude/agents/`)                                                               |
| Plan mode   | no (it implements an existing contract rule; it must not change the `client-core` store contract)      |
| Gates       | all SDKs; the `register-reregister-401` transcript; `pnpm parity:check`                                 |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Goal

A device whose token came from `POST /<p>/devices/register` (a registered device without a licence)
reacts to a 401 on a document fetch by making exactly one `POST /<p>/devices/register` attempt, with
no `Authorization` header, then storing the new token and retrying the failed fetch once. This works
in Node, Python and Swift, and in React's desktop mode through the host's Node client. The P1b-03
transcript `register-reregister-401` replays green in Node, Python and Swift, and `license.reregister`
is `implemented` in their manifests.

## Why

Wire contract v3 §5 says: "exactly one `POST /<p>/license/token` re-acquire attempt, then one retry
of the failed fetch. (Registered-without-license devices re-register instead; same single-attempt
rule.)" (`docs/security/WIRE-CONTRACT-V3.md:145`). No SDK does the second half
([README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #14,
[PARITY §8](../../PARITY.md#8-parity-gaps-to-close-now)).

A config-only product's devices (D-08) therefore lose their credential for good on the first 401.
`POST /<p>/license/token` needs a licensed device (`requireLicensedDevice` in
`packages/worker/src/services/license/activation.ts:164-203`), and the route does not exist at all
when License is disabled.

## Read first

- `AGENTS.md`, `CLAUDE.md`; `docs/security/WIRE-CONTRACT-V3.md` §5 and §6 (registration policies).
- [notes/A2 §1.14](../../notes/A2-sdk-port.md#114-retries-backoff-etag304-401) and
  [§14](../../notes/A2-sdk-port.md#14-repo-divergences-found-along-the-way-worth-tickets) items 3
  and 12.
- The transcript `conformance/transcripts/register-reregister-401.json` and the replayers from
  [P1b-03](P1b-03-http-transcripts.md).
- Node: `packages/sdk-node/src/core/token.ts` (the header comment already says register is the
  licence-less mint path; `ReacquireFn`, `reacquireOnce`), `src/client.ts:126-137` (only
  `reacquireToken` is injected), `src/license/endpoints.ts:123-133`, `src/devices/client.ts`
  (`register()`), `src/core/sync.ts`.
- Python: `sdks/python/src/polaris_key/client.py:161` and `:409-412` (`_reacquire`), `core/token.py`,
  `core/sync.py:180-230`, `devices/client.py:159-200` (`register()`, which deliberately sends no
  `Authorization` header).
- Swift: `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:193-230` (both `reacquire:`
  closures), `Sources/PolarisKeyCore/CoreContext.swift` (`registerDevice`, `sync`).
- Worker: `packages/worker/src/core/register.ts` (policies and the single `registration_closed`
  refusal).

## Scope

**In:**

- A re-acquire strategy in each SDK's token manager that chooses between
  `POST /<p>/license/token` and `POST /<p>/devices/register`, within the existing single attempt
  per sync pass shared by the parallel licence and config fetches.
- Node, Python and Swift implementations; unit tests; the transcript replay switched on by
  marking `license.reregister` `implemented` in their manifests.
- React: no renderer change. The desktop adapter reaches the Worker through the host's Node client,
  which gains the behaviour. Record in React's manifest whatever P1b-01 decided for the `web` runtime,
  whose browser adapter holds no device token.
- A line in each SDK's docs page (`packages/docs/src/content/docs/build/sdks/{node,python,swift}.mdx`)
  describing the rule.

**Out** (and where it belongs instead):

- Persisting a "token source" in the offline cache. `CacheRecordV3` is `client-core`'s store contract
  (`packages/client-core/src/store.ts:33-50`), and changing it is plan-mode. If the heuristic below
  proves insufficient, stop and raise a plan instead.
- Native re-registration under the `requires-identity` policy. It needs a browser session cookie
  (notes/A2 §14 item 12), so a native device gets `registration_closed` and falls back to the hard-401
  path. Document it; changing it is a Worker design question with no owner yet.
- Godot (→ [P1-03](P1-03-godot-license.md)).

## Design notes

**Choosing the path.** Use `devices/register` when either:

- the License service is disabled for the product (`ctx.enabled("license") === false`, resolved from
  discovery, `expectedServices` or the default); or
- the current token was minted by `devices.register()` in this process, or, after a restart, the
  device has no verified licence document and no imported bundle.

Otherwise use `license/token`, as today.

- The in-memory source can live beside the token in each token manager (Node already has a
  `TokenSource` type with `"register"` in `core/token.ts`).
- A wrong guess is safe. `register` for a licensed device returns `403 registration_closed`, and
  `license/token` for a licence-less device returns 401. Either way the single attempt fails, and the
  existing hard-401 handling (`lastSyncUnauthorized`, the offline `revoked` signal) applies. There is
  no loop.

**The request is the same as `register()`.** It sends the fingerprint when fingerprinting is enabled,
and no `Authorization` header (Python documents why in `devices/client.py:159-165`). On `200` it
stores the new token and retries the failed fetch once. On `403`, `404` or `429` the attempt counts
as spent.

**Keep the single-attempt budget.** Reuse `reacquireOnce` and the per-pass re-arm (`beginPass`). Do
not add a second budget for register. Both documents may 401 in the same pass, and there must still
be one network call.

**Registered devices keep their device id.** Registration is keyed by the device id the SDK derives,
and re-registering an id that is already registered rotates its token on the same device row
(`packages/worker/src/core/register.ts`, the comment above the `existing` lookup). An id bound to a
real licence is refused with `registration_closed`.

## Steps

1. Replay `register-reregister-401` in Node with the manifest entry flipped locally to see it fail.
2. Implement the strategy in Node's `TokenManager` and `client.ts`; add unit tests; make the
   transcript pass.
3. Port to Python, then Swift, one SDK per commit, each with unit tests and the transcript.
4. Update the manifests and docs pages; run the green gate.

## Acceptance criteria

- [ ] Node, Python and Swift replay `register-reregister-401` green.
- [ ] Unit tests in each of the three SDKs show:
  - [ ] a licensed device still uses `/license/token`;
  - [ ] a licence-less device, and a product with License disabled, use `/devices/register` with no
        `Authorization` header;
  - [ ] two parallel 401s cause exactly one register call;
  - [ ] a `403 registration_closed` records the hard 401 and makes no second attempt.
- [ ] React's desktop adapter test shows the renderer picking up the host's new state after a
      host-side re-register (bridge fixture), tagged `@pkey-feature license.reregister`.
- [ ] `parity.json` manifests are updated for every SDK this changes, and `pnpm parity:check`
      passes.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Behaviour others rely on:** the path-selection rule and the shared single-attempt budget, now
  identical in Node, Python and Swift. Godot's licence client (P1-03), Kotlin (P6-05) and C# (X-01)
  implement the same rule against the same transcript.
- Leave a note in the PR if the "no verified licence document" heuristic misfired anywhere in
  testing; that is the trigger for a plan-mode store change.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-06 done`.
