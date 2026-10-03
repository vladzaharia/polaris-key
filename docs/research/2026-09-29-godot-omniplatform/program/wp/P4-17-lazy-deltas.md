# P4-17 Lazy hot-pair delta generation from install telemetry

| Field       | Value                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v3)                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                      |
| Depends on  | [P4-22](P4-22-ci-chunk-indexes.md), [P3-03](P3-03-feed-composition.md), [S-08](S-08-cloudflare-async-compute.md)                                          |
| Unblocks    | none                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                        |
| Plan mode   | no: lazy deltas use the existing `pkey-patch/1` descriptor and the feed's delta menu                                                                      |
| Gates       | none in the graph; in practice a migration (`TABLE_OWNERS`), new `wrangler.toml` bindings (workerd smoke job) and a threat-model note                     |
| Human input | none in the graph; in practice Cloudflare Queues, Workflows and Containers enabled per environment, plus an R2 event-notification rule (see Design notes) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                 |

## Goal

When install telemetry shows that many devices move between the same two payloads of a pack, and
no CI delta exists for that pair, Polaris Key generates a `zstd-patch-from` delta **off the
request path**: R2 event notifications and a telemetry sweep put work on a Queue, a Workflow
orchestrates it, and a Container runs the zstd CLI. The delta is verified, stored at
`deltas/<from>/<to>.zstd-patch-from`, recorded as a server-generated delta, and offered in the
feed's delta menu. Deltas that go cold are marked for GC.

## Why

CI computes deltas only against the last few releases, but the pairs devices actually need depend
on who updates when. Telemetry finds the hot `(from, to)` pairs, and generating only those is
Epic's A→B optimisation and butler's "cheap now, optimal later"
([CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner), telemetry bullet;
[README decision 14](../../README.md#11-decisions-needed)). A Worker isolate cannot compute them:
128 MB of memory, CPU limits, and a 70 MB pair needs a window larger than that
([notes/E5 §3.2](../../notes/E5-frontier-tech.md#32-recommendation)). The research fixes the
pipeline as R2 events → Queue → Workflow → Container ([CONTENT §16](../../CONTENT.md#16-phasing-and-effort), v3).

## Read first

- `AGENTS.md` (rules 6 and 10; the workerd smoke job) and `docs/security/THREAT-MODEL.md`.
- [CONTENT §8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner), [§9](../../CONTENT.md#9-formats)
  (patch descriptor, publish and decode rules) and [§11](../../CONTENT.md#11-server-side-by-service) (GC).
- [notes/A7 §3.2](../../notes/A7-xlang-content.md#32-delta-artifacts-pkey-patch1-fields-the-vectors-use)
  (descriptor fields, the magic-base rule, the window) and
  [§7](../../notes/A7-xlang-content.md#7-decoder-behaviour-matrices).
- [notes/E5 §3.2](../../notes/E5-frontier-tech.md#32-recommendation) and
  [§4.3](../../notes/E5-frontier-tech.md#43-r2-facts-v-unless-marked) (R2 event notifications,
  Workflows and Containers limits); [notes/E8 §5.7](../../notes/E8-content-delivery.md#57-storage-layout-and-garbage-collection).
- `packages/worker/src/core/devices.ts` (~L855–890, `REPORT_KEYS` and `boundedReport`). The
  comment there names `licensingReport.test.ts`, which does not exist; the report tests are in
  `packages/worker/test/register.test.ts` (~L624).
- `packages/worker/wrangler.toml` (no R2, Queue, Workflow or Container bindings today),
  `packages/worker/src/index.ts`, `packages/worker/src/scheduled.ts`.
- P4-03's delta descriptor and publish lint, P4-10's CLI zstd helpers, P3-03's feed composer (the
  delta menu), P4-14's GC.

## Scope

**In:**

- Telemetry: a bounded report key for pack install outcomes, added to `REPORT_KEYS` beside the
  `packSetId` key P4-02 added, with a test in `register.test.ts` and the report description in the
  OpenAPI spec (it counts "fifteen top-level keys"; update the count). The SDKs send it; if
  P4-06, P4-07, P4-08 or P4-11 did not already emit it, add the emission in `client-core` and flag
  the other SDKs as a follow-up.
- A demand store and the hot-pair policy, active only for products whose `.pkey/release` sets
  `patch.deltaBases: hot-pairs` (README §3.12).
- Producers: an R2 event-notification rule on the payload prefix (a new target payload) and a
  daily sweep in `scheduled.ts` (pairs that turned hot), both enqueuing to one Queue.
- A Queue consumer that starts a Workflow per pair, and the Workflow `DeltaWorkflow`.
- A Container image (the zstd CLI at the version P4-03 pins, plus a small HTTP entrypoint) that
  streams both payloads from R2, produces the frame, verifies it by decoding, and uploads it.
- The descriptor stored as a server-generated delta, included in update's delta menu.
- Marking cold lazy deltas for P4-14's GC; per-product daily caps; a feature flag.
- `wrangler.toml` bindings per environment, and `docs/DEPLOYMENT.md` and `docs/RUNBOOK.md` entries.

**Out** (and where it belongs instead):

- Per-entry lazy deltas for `godot.pck`: whole-payload only here. Godot can decode a
  whole-payload `--patch-from` frame through its engine decoder (CONTENT §8.3).
- Serving deltas as `dcz` to browsers (→ [P4-18](P4-18-web-dcz.md)).
- CI-computed deltas (P4-03). Chunk boundaries are never computed server-side.
- Deleting objects (→ [P4-14](P4-14-readiness-gc-rollouts.md)); update funnels and auto-halt
  (→ P6-03).

## Design notes

- **Never in the Worker request path.** The report handler only increments counters and, at
  most, calls `env.DELTA_QUEUE.send(...)`. All byte work happens in the Container; the Workflow
  step may do integer arithmetic over the two chunk indexes (P4-10) to estimate savings.
- **Trust.** A lazy delta is not in any CI-signed record. It appears only in the Worker-signed
  feed's delta menu ([README §3.3](../../README.md#33-trust-model-two-signers-two-documents) lists
  "the delta menu" among the feed's fields). The client checks the artifact hash, that its base
  equals `from`, and that the output equals `to` (the A7 §3.4 delta algorithm); `to` comes from
  the CI-signed pack record. So a bad delta only fails and the client falls back
  ([notes/E8 §5.8](../../notes/E8-content-delivery.md#58-signing-and-trust)). The planner drops
  deltas whose `memBytes` exceed the budget, and decoders set `windowLogMax` within `memBytes`.
  Record in the threat model that a compromised Worker can offer junk deltas, which costs
  bandwidth and CPU, not integrity.
- **Publish rules hold for lazy deltas** (A7 §3.2): never against a base that begins with
  `37 A4 30 EC`; the window is at least the larger file, passed explicitly; one frame with the
  content size and checksum; the stored artifact is the bare frame. The descriptor carries
  `method: "zstd-patch-from"`, `from`, `to`, `size`, `artifact`, `artifactSha256`, `memBytes` and
  the window. The Container decodes with a raw-content prefix and checks SHA-256 = `to` before
  upload.
- **Worth generating** (notes/E5 §3.2): only when it saves more than ~30% and more than ~1 MB
  against the cheapest strategy the device would otherwise use. Chunk-sync bytes can be computed
  from the two chunk indexes without touching payloads.
- **Hot threshold** (proposed, configurable): at least 25 distinct devices reported moving from
  `from` to `to` with a strategy other than `delta` within 7 days. Proposed report key:
  `packInstalls: [{pack, from, to, strategy, bytes, durationMs, fallbackUsed, failureStage}]`,
  at most 8 entries, strings capped at 128 characters. The report is a last-snapshot per device
  (`setDeviceReported`), so count on ingest and deduplicate per device and pair. Proposed table
  `release_delta_demand(product, deliverable_id, from_sha256, to_sha256, devices, window_start, last_seen)`
  plus a short-lived per-device dedupe table pruned by `scheduled.ts`; both need `TABLE_OWNERS`
  entries. Analytics Engine is an alternative if P6-03 has introduced it.
- **Idempotency.** The Workflow instance id is derived from the pair and method
  (`delta-<from>-<to>-zstd-patch-from`), so duplicate events are no-ops; the upload checks for an
  existing object first.
- **Gated deliverables.** Read from and write to the gated prefix; serve through the same
  delivery authorisation.
- **Sizing and cost.** Container memory must hold both files plus the window; Cloudflare offers
  instances up to 12 GiB (E5 §4.3). Refuse pairs above a configured size (say 2 GiB) and cap
  generated deltas per product per day.
- **Where the code lives** (rule 6): the policy, consumer and Workflow in
  `packages/worker/src/services/release/packs/deltas/`; `src/index.ts` exports the `queue`
  handler and the Workflow and Container classes. The Container source sits beside the Worker
  (proposed `packages/worker/containers/delta/`). `boundaries.test.ts` must still pass.
- **Human inputs and waiting.** An operator must enable Queues, Workflows and Containers on the
  Cloudflare account (Workers Paid), create the Queue and the R2 event-notification rule per
  environment, and allow the container image to be pushed. Until then, keep the feature flag
  (proposed env var `LAZY_DELTAS=off`) off and test against fakes; the request-path counters can
  ship first.

## Steps

1. Telemetry key and demand counting on report ingest, with tests.
2. The hot-pair policy as a pure function with table tests (threshold, savings, size limits,
   magic base, existing CI delta).
3. Queue consumer and Workflow with injected R2, D1 and Container fakes.
4. The Container image and its entrypoint; a test that runs it against A7's v1/v2 payloads when
   Docker and zstd are available in CI.
5. Descriptor storage and the delta menu in the feed composer; cold marking for GC.
6. Bindings, docs, threat-model note, the green gate.

## Acceptance criteria

- [ ] Report ingest counts a pair once per device, ignores reports with `strategy: "delta"`, and
      drops unknown or oversized fields; the tests live beside the existing report tests.
- [ ] Policy tests: a pair below threshold is not queued; a hot pair with an existing CI delta is
      not queued; a base beginning with `37 A4 30 EC` is refused; a pair over the size cap is
      refused; savings under 30% or 1 MB are refused.
- [ ] Workflow tests with fakes: a hot pair produces one upload at `deltas/<from>/<to>.zstd-patch-from`
      and one descriptor; a duplicate event does nothing; a Container result whose decoded hash
      is not `to` is discarded.
- [ ] The composed feed's delta menu lists the lazy delta for devices on `from`, and `client-core`'s
      planner picks it on the A7 `plan-real-v1-v2` inputs.
- [ ] No Worker request handler decodes, encodes or diffs payload bytes (reviewer check; a test
      asserts the report handler only touches D1 and the Queue).
- [ ] Bindings exist for every environment in `wrangler.toml`; `test:workerd` passes.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- delta
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- register
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- **P4-18** serves any `zstd-patch-from` delta, lazy or CI, as `dcz` when the base is advertised.
- **P4-14** collects deltas this package marks cold.
- The `packInstalls` report key and the demand table are what P6-03's funnel can read.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-17 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (S-08)

The spike note [`notes/S-08-cloudflare-async-compute.md`](../../notes/S-08-cloudflare-async-compute.md) changes this package: its §6 recommendation (Queues plus a WASM zstd encoder in a separate consumer Worker; level 9, levels above 15 refused; a 32 MiB per-side cap; no Workflows or Containers, which move to a later P4-17b) and its §8 owner steps override this brief where they differ. Human inputs shrink to Workers Paid with Queues enabled and an R2 event-notification rule.

## Corrections from implementation

- **The delta menu is a wire change, so it is not in this package.** The brief says "Plan mode:
  no" because it assumed the feed already has a delta menu. It does not:
  WIRE-CONTRACT-V4 §2.4 lists `deltas` (P4-17) only as a **reserved** feed member that v4
  verifiers ignore, with no shape. Giving it a shape, reading it in client-core (`feedContent`),
  adding `feedContentCases` and porting the reader to every SDK is the same kind of change P4-13
  made under plan mode. Per AGENTS.md and the lead's instruction it was not improvised. Everything
  up to the menu ships: telemetry, demand, policy, queue, consumer, encoder, storage, descriptor
  rows and cold marking. Generated deltas are stored, verified and recorded, and nothing offers
  them to devices yet. The fourth acceptance criterion (the feed lists the lazy delta and the
  planner picks it) moves to a plan-mode follow-up. `release_lazy_deltas.descriptor_json` already
  holds `{method, scope, from, to, size, memBytes, windowLog, artifact}`, and
  `readyDeltasTo(db, product, to)` is the composer's read.
- **The per-product opt-in is a D1 row, not `patch.deltaBases: hot-pairs`.**
  `.pkey/release`'s `patch.deltaBases` is an integer from 0 to `MAX_PACK_DELTA_BASES` that the CLI
  uses as the number of CI bases. A string value would be a manifest validator and schema change
  (rule 9) plus a CLI change. The lead specified `LAZY_DELTAS` as a per-product opt-in flag, so
  this package uses two switches, both off by default:
  - the `LAZY_DELTAS` var, a kill switch in both Worker scripts;
  - a `lazy_delta_settings` row per product (`enabled`, plus optional `hot_devices` and
    `daily_cap`), set by an operator (RUNBOOK "Lazy deltas"). Enabling a product never needs a
    deploy (rule 5).
- **The encoder's frame is not byte-identical to the CLI's.** S-08 measured identity with a
  buffered input. That needs a second target-sized buffer: about 116 MiB at the 32 MiB cap,
  against the 96 MiB budget. The committed encoder reads the target from a stable input buffer
  (`ZSTD_c_stableInBuffer`) and stream-decodes `zstd`-coded inputs into place
  (`ZSTD_d_stableOutBuffer`), so the compressed bytes are never resident. That keeps the cap at
  about 84 MiB. On the corpus v1 → v2 pair the frame is 9 bytes smaller than
  `zstd --single-thread -9` (325,258 against 325,267 bytes). The test pins its SHA-256 and decodes
  it back. Every frame is verified by decoding before it is stored, so identity was never a
  correctness property.
- **The R2 rules are two, one per final payload prefix:** `blobs/sha256/` and
  `gated/blobs/sha256/`. Both prefixes also hold file blobs and indexes, and no narrower prefix
  exists. The consumer resolves each event through the key's `pack-object` refs and acknowledges
  anything that is not a pack payload of an opted-in product; an object of at most 1 MiB is acknowledged at once (it cannot save the 1 MiB the policy asks for). An event that arrives before its
  record's ingest is retried 3 times, 5 minutes apart. A new payload has no demand of its own yet,
  so an event fans out to the payloads most devices sit on (`installedBase`: devices that last
  moved to X are on X), at most 3 pair jobs.
- **There is no `queue` export on the request Worker.** The consumer is its own script
  (`src/deltasEntry.ts`, `wrangler.deltas.toml`, deployed as `polaris-key-deltas-<env>`), as S-08
  §6.2 recommends, and it is the only module that imports the encoder. `src/index.ts` is
  unchanged. The request Worker only produces (`DELTA_QUEUE`), from the nightly sweep.
- **The report handler never sends to the queue.** The brief allows it ("at most"). Hot pairs are
  found by the nightly sweep instead, so the request path is D1-only. The test asserts both: it
  touches no blob store and sends nothing.
- **Delta installs are stored, not counted.** A `strategy: "delta"` entry is not demand, but its
  row keeps a generated delta warm, so cold marking is "no device reported the pair, by any
  strategy, for 30 days".
- **The demand tables are Core's.** The report handler is in `core/devices.ts` and may not import
  a service (rule 6), so `lazy_delta_settings`, `delta_demand_devices` and `delta_demand` belong
  to Core (`core/deltaDemand.ts`). Only `release_lazy_deltas` is Release's.
- **The `packInstalls` emission is in client-core and the Node SDK only.**
  - `PackEngine.packInstalls()` keeps the last 8 finished installs. A first install is not
    reported.
  - `@polaris-key/node` sends them.
  - React, Python, Swift and Godot are follow-ups, as is P6-03's `updates`, which no SDK emits yet
    either.
  - `durationMs` is accepted but not sent: the engine's clock is in seconds.
- **The report test lives in `test/register.test.ts`.** The brief's pointer is right. The comment
  in `core/devices.ts` still names `licensingEdge.test.ts`.
- **HTTP transcripts were regenerated.** The report allowlist the transcripts record (`allowedKeys`)
  gained `packInstalls`. The regeneration ran through `pnpm gen:transcripts`, with the Swift and
  Godot mirrors.
- **The `dev` queues do not exist yet.** `wrangler.toml` and `wrangler.deltas.toml` bind
  `pkey-deltas-dev` and `pkey-deltas-dlq-dev` for the `dev` environment, as for the others. They
  must be created before `dev` is deployed (DEPLOYMENT §3 "Lazy deltas").
