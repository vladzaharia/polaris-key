> Research note for [Godot on Polaris Key](../README.md), 2026-10-02. Spike S-08 of the
> [execution program](../program/wp/S-08-cloudflare-async-compute.md); it unblocks
> [P4-17](../program/wp/P4-17-lazy-deltas.md). Run on one Mac with no Cloudflare account access:
> nothing was created, enabled or deployed, and no credential was used. Every row is labelled
> **[M]** measured (real zstd, real Diceroll pack pairs, this Mac), **[E]** emulated (`wrangler dev`
> / workerd, or Docker standing in for a Cloudflare Container), **[D]** documented (Cloudflare docs
> read 2026-10-02) or **[U]** unmeasured (needs the owner's account; see §8). The scripts are in
> [`S-08/`](S-08/README.md).

# S-08: Cloudflare Queues, Workflows and Containers for lazy deltas

## 1. Question

P4-17 generates `zstd-patch-from` deltas for hot `(from, to)` pairs off the request path. Its brief
fixes the pipeline as R2 event → Queue → Workflow → Container, on the assumption (notes/E5 §3.2)
that "a Worker isolate cannot compute them". The brief asks:

1. Which mechanism fits (Queues, Workflows, Containers or a mix), and what does each cost per delta?
2. Which limits matter: CPU and wall time, memory, message size, retries and DLQ, R2 throughput,
   Container cold start?
3. Can the encoder run in a Worker (WASM zstd), and up to which pair size, or does it need a Container?
4. What can `wrangler dev` / miniflare emulate, and how should P4-17's tests be structured?
5. How does an R2 event notification trigger the pipeline, and what are its failure modes?

## 2. Short answer

1. **A Worker can encode every real Diceroll pack pair. A Container is needed only above about
   32 MiB per side.** libzstd 1.5.7 compiled to wasm32 with the same no-libc toolchain as
   `@polaris-key/zstd-wasm` encodes `--patch-from` inside workerd. Its output is **byte-identical**
   to `zstd --single-thread` [M]. At level 9 it fits all six Diceroll pack slices (≤ 20.8 MB) in
   **≤ 57 MiB of linear memory and ≤ 0.13 s** of in-isolate time. It verifies by decoding in the
   same memory, so the peak does not grow [E]. The whole 85 MB PCK needs 175–222 MiB, more than the
   documented 128 MB isolate (which counts WebAssembly) [D], so that pair needs a Container.
2. **Memory is the only binding limit. CPU never is.** The model is: encode memory ≈ `from + to +
T(level)`, with T ≈ 4–12 MiB at level 3, 17–29 MiB at level 9, 47–59 MiB at level 12 and ≥ 90 MiB
   at level 19 [E]. At level 9 the largest pair measured took 0.4 s of CPU (the 85 MB PCK), against
   a 30 s default and 5 min maximum [D].
3. **Do not use level 19 for lazy deltas.**
   - Single-threaded zstd 1.5.7 at levels 16–19 (btopt and above) **breaks down on large
     prefixes**. On the 85 MB pair it produced a 19.6 MB delta, against 0.53 MB at level 9; the
     cut-over sits between 32 and 48 MB [M].
   - Levels 9–15 single-threaded match or beat the CLI's default multi-threaded `-19`: 530–532 KB
     against 536 KB on rc.4→rc.5. Level 9 costs 0.12 s and level 12 costs 0.32 s, against 7.6–18.8 s
     for `-19` [M].
   - On the pack pairs, level 9 is within 0.9% (base) and 7.4% (extra, 31.7 KB against 29.5 KB) of
     `-19` [M].
   - **Recommendation: level 9 single-threaded in the Worker; level 12 single-threaded in a
     Container.**
4. **Mechanism:** Queue → one dedicated consumer Worker (batch 1, concurrency 1) that does plan →
   encode → verify → publish. **Workflows add nothing that P4-17 needs** for pairs that fit, and they
   bring two hazards:
   - concurrent instances share isolate memory (three ran in one workerd process here) [E];
   - local `create()` with a duplicate id silently no-ops, where the docs say it throws [E]/[D].

   Workflows plus a Container become the path only for pairs above the Worker cap, and that path
   should be its own follow-up package.

5. **Local emulation:**
   - Queues (retries, DLQ, batch semantics) and Workflows (steps, retries, ids) run under
     `wrangler dev` 4.116.0 [E].
   - R2 event notifications do not run locally [E]/[D].
   - Containers run locally only through Docker (wrangler 4.x) [D].
   - **workerd enforces neither the 128 MB memory limit nor `cpu_ms`**: a 1,000 MiB `WebAssembly.Memory`
     grew fine, and a 1.5 s spin passed under `cpu_ms = 100` [E]. P4-17 therefore needs an explicit
     memory-budget test.
6. **R2 events:** the documented message carries `bucket`, `object.key`, `size`, `eTag`, `action` and
   `eventTime` [D]. Delivery is through Queues (at-least-once, ordering best-effort) [D]. The R2 page
   documents no guarantees, latency or duplicate behaviour of its own [D]/[U]. Idempotency must come
   from the deterministic output key plus a D1 row, never from the event.
7. **Cost per delta:**
   - Worker tier: about **$0.00002** (Queue ops, R2 ops, a fraction of a CPU-second), all inside the
     Workers Paid inclusions at Diceroll's volume [D]/[I].
   - Container tier: about **$0.0001** (basic, `sleepAfter = 30s`) up to **$0.0065** (standard-1, default
     10 min `sleepAfter`), dominated by provisioned memory while awake [D]/[I].

**Go / no-go for P4-17: GO**, with the Worker-only tier (Queues plus the WASM encoder, no
Workflows, no Containers) and a 32 MiB per-side cap. **Container tier: NO-GO inside P4-17**. Split it
into a follow-up package that starts when a real pack above the cap changes often enough to be hot.

## 3. Environment

| Item         | Value                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host         | Apple M5 Pro (18 cores), 64 GB, macOS 27.0 (26A428). Load average 4–14 during runs; other agents shared the host. Byte counts are deterministic; times are indicative only.                                                                                                                                                              |
| Region       | none: everything ran on `localhost`. No Cloudflare network path was measured.                                                                                                                                                                                                                                                            |
| zstd CLI     | 1.5.7 (Homebrew, arm64). Default threading (`-T1`, one worker thread) and `--single-thread`.                                                                                                                                                                                                                                             |
| WASM encoder | libzstd 1.5.7 (`lib/common`, `lib/compress` minus `zstdmt`, `lib/decompress`) plus `S-08/wasm/zenc.c`. Built with Apple clang 21.0.0 `--target=wasm32 -O3 -nostdlib -ffreestanding`, linked with `rust-lld -flavor wasm`, using `packages/zstd-wasm/wasm/stub/` and the bump allocator from `zdec.c`. Module 485,306 B (117,860 B gzip). |
| Workers      | wrangler 4.116.0 (the version `packages/worker` pins), miniflare 4.20260730.0, workerd 1.20260730.1, `compatibility_date = "2026-07-30"`, `nodejs_compat`. Node 22.13.1 (`mise exec node@22`).                                                                                                                                           |
| Container    | Docker Desktop 29.4.0 (Linux VM, 18 vCPU, 16 GiB). `alpine:3.22` + `apk add zstd` (1.5.7) + a 6 MB static Go entrypoint; image 18.9 MB. Runs used `--cpus/--memory` caps mirroring Cloudflare's instance types, arm64 natively; amd64 only for a start check under emulation.                                                            |
| Inputs       | S-03's local, SHA-256-verified Diceroll release assets (rc.1–rc.5), never committed: the desktop PCK (84.8–85.4 MB), S-03's per-pack slices (base 4.2–4.7 MB, extra 14.0–14.2 MB, nature 20.0 MB, audio 20.8 MB), and prefix cuts of rc.1/rc.5 at 32, 48 and 64 MB as mid-size pairs ("cut").                                            |

Commands (paths relative to `notes/S-08/`):

```sh
wasm/build.sh                                       # ZSTD_SRC=<zstd-1.5.7 tree>
node wasm/node-run.mjs FROM TO OUT LEVEL            # one encode in Node; cmp against the CLI
node wasm/node-encverify.mjs FROM TO LEVEL          # encode + in-place verify, peak memory
./native.sh FROM TO LEVEL [--single-thread] [...]   # CLI encode/decode under /usr/bin/time -l
(cd worker && npx wrangler dev --port 8799 --persist-to state)   # then POST /put, /encode, /send
worker/run-encode.sh FROM TO LEVEL                  # outside wall time + workerd CPU delta
container/run.sh standard-1 0.5 4g s08-delta:arm64 "pck-rc4:pck-rc5:12:1"
```

## 4. Results

### 4.1 Encoder quality and cost by level and threading (zstd CLI 1.5.7) [M]

85 MB desktop PCK, rc.4→rc.5. MT is the CLI default (`-T1`); ST is `--single-thread`.

| Level / mode | Delta B        | Encode real s | User s | Max RSS MiB |
| ------------ | -------------- | ------------: | -----: | ----------: |
| 19 MT        | 536,168        |    7.6 / 18.8 |    8.7 |         475 |
| 17 MT        | 598,075        |          15.9 |   10.5 |         475 |
| 15 MT        | 552,678        |          27.5 |   20.1 |         538 |
| 12 MT        | 555,101        |          0.86 |   0.83 |         427 |
| 9 MT         | 555,573        |          0.22 |   0.22 |         317 |
| 3 MT         | 640,263        |          0.16 |   0.09 |         261 |
| **19 ST**    | **19,635,718** |           9.7 |    9.2 |         313 |
| **16 ST**    | **19,803,301** |           4.9 |    4.8 |         232 |
| 15 ST        | 530,855        |           6.6 |    6.5 |         264 |
| 13 ST        | 531,105        |           2.5 |    2.5 |         232 |
| **12 ST**    | **530,652**    |      **0.32** |    0.3 |         224 |
| **9 ST**     | **532,429**    |      **0.12** |    0.1 |         194 |
| 3 ST         | 545,796        |          0.08 |   0.06 |         176 |

The two 19 MT times come from two runs at different host loads. The same pattern holds on the
oldest pair (rc.1→rc.5): 19 MT gives 1,335,159 B, 19 ST 20,436,526 B, 12 ST 1,340,962 B and 9 ST
1,342,699 B.

- **Single-threaded levels ≥ 16 fail once the prefix is large.**
  - At level 19 ST the delta is fine on extra (14 MB: 29,482 B), nature (20 MB: 1,720 B) and
    cut32 (2,953 B).
  - It fails from cut48 on: 14.3 MB on cut48 and 19.1 MB on cut64, against 4–5 KB multi-threaded.
  - Shrinking the match tables (`chainLog=22,hashLog=20`) makes the failure start earlier: 4.95 MB
    on extra.
  - The WASM encoder is single-threaded by construction, so this rules out its high levels.
- **Pack pairs, level 9 ST against 19 MT:**
  - base rc.1→rc.5: 1,317,756 against 1,306,609 B (+0.9%);
  - base rc.4→rc.5: 519,587 against 515,763 B (+0.7%);
  - extra rc.2→rc.3: 31,705 against 29,524 B (+7.4%, about 2 KB);
  - nature/audio (unchanged across releases): 2.2–2.3 KB against 1.7 KB.
- **Decode** (client side, for reference): 14–169 MiB RSS, scaling as `from + to` (for example
  168 MiB on the 85 MB pair). Under 0.06 s everywhere.

### 4.2 WASM encoder inside workerd (`wrangler dev`) [E], with byte identity [M]

The inputs stream from local R2 into linear memory, the target streams through
`ZSTD_compressStream2` in 1 MiB chunks, and the frame goes back to R2. "Enc MiB" is
`memory.buffer.byteLength` after the encode, the WebAssembly share of the 128 MB budget. Verify
decodes the frame into a streaming SHA-256 (`crypto.DigestStream`) and compares it with `to`.

| Pair (from → to) | Max side MB | L3 enc MiB / ms | L9 enc MiB / ms | L12 enc MiB / ms | L19 enc MiB / ms | Verify-only MiB | Delta B (L9) |
| ---------------- | ----------: | --------------: | --------------: | ---------------: | ---------------: | --------------: | -----------: |
| base rc.1→rc.5   |         4.7 |         12.6/25 |         22.4/39 |          52.4/71 |         92.1/381 |            10.9 |    1,317,756 |
| extra rc.2→rc.3  |        14.2 |         31.6/59 |         41.8/84 |         71.8/115 |      118.6/2,179 |            29.3 |       31,705 |
| nature rc.1→rc.5 |        20.0 |         43.8/82 |        55.0/130 |         85.0/205 |      137.8/1,682 |            40.5 |        2,185 |
| audio rc.1→rc.5  |        20.8 |         45.3/70 |        56.6/108 |         86.6/164 |                — |            42.0 |        2,338 |
| cut32 rc.1→rc.5  |        32.0 |        66.7/112 |        77.9/148 |        107.9/255 |                — |            63.4 |        3,678 |
| cut48 rc.1→rc.5  |        48.0 |        99.2/174 |       112.4/209 |        142.4/368 |                — |            93.9 |        5,382 |
| cut64 rc.1→rc.5  |        64.0 |       129.8/230 |       143.0/272 |        173.0/482 |                — |           124.4 |        7,125 |
| PCK rc.4→rc.5    |        85.4 |       174.6/309 |       191.9/362 |        221.9/566 |                — |           165.3 |      532,429 |
| PCK rc.1→rc.5    |        85.4 |       174.0/334 |       191.3/384 |        221.3/555 |                — |           164.7 |    1,342,699 |

- **Byte identity [M].**
  - The WASM frames are the same bytes as `zstd --single-thread` at the same level: `cmp` passed for
    the 85 MB pair at level 9 and for extra at level 19.
  - Every size in the table equals the CLI's ST size.
  - Every frame decoded back to `to` with the matching SHA-256.
  - The frame header records the window as the content size (single segment), for example
    85,439,036 B. That meets P4-17's "window at least the larger file".
- **Time.**
  - In-isolate time equals workerd process CPU within about 50 ms (for example base L19: 381 ms in
    the isolate, 410 ms process CPU).
  - Outside wall time adds 50–250 ms of local R2 streaming.
  - Locally, `Date.now()` and `performance.now()` advance during CPU work, so in-isolate timing is
    meaningful [E]. Production freezes timers between I/O, so P4-17 should not rely on them there [D].
- **Verify costs no extra memory** when it runs in the same instance after a heap reset
  (`ze_mark`/`ze_reset` in `zenc.c`; the prefix stays resident, so R2 is not read twice).
  `node-encverify.mjs` shows peak = encode memory for every pair. Example: extra L9 41.8 MiB peak,
  29.3 MiB decode high-water [M].
- **Fit against 128 MB.** The documented limit counts WebAssembly allocations; JS heap and runtime
  come on top [D]. With about 30 MiB kept for those [I]:
  - every pack slice fits at level 3, 9 and 12;
  - cut32 fits at level 9 (78 MiB);
  - cut48 at level 9 (112 MiB) does not;
  - no 64 MB or larger pair fits at any level;
  - level 19 fits nothing above about 5 MB comfortably.
- **Recommended cap.** `max(from, to) ≤ 32 MiB` at level 9: about 85 MiB peak by the model above.

### 4.3 Container stand-in (Docker under instance-type caps) [E]

One fresh container per job. Cold start is `docker run` until `/health` answers. Fetch is HTTP
from the host (a stand-in for R2). Encode is the CLI. Verify is a CLI decode plus `sha256`.
"cgroup peak" includes page cache from the ephemeral `/tmp` files.

| Profile (cap)                      | Cold start ms (3 runs) | Job               | Encode ms (user ms) | Verify ms | cgroup peak MiB  |   Delta B |
| ---------------------------------- | ---------------------- | ----------------- | ------------------: | --------: | ---------------- | --------: |
| lite (1/16 vCPU, 256 MiB)          | 480, 450, 242          | extra L9 ST       |         3,900 (199) |     1,199 | 72               |    31,705 |
| lite                               |                        | PCK rc.4→5 L9 ST  |        10,794 (513) |     7,096 | 256 (at the cap) |   532,429 |
| basic (1/4 vCPU, 1 GiB)            | 132, 132, 132          | extra L19 MT      |      15,812 (3,927) |       202 | 147              |    29,524 |
| basic                              |                        | PCK rc.4→5 L9 ST  |         2,086 (423) |     1,115 | 413              |   532,429 |
| basic                              |                        | PCK rc.4→5 L12 ST |       7,229 (1,526) |     7,251 | 413              |   530,652 |
| basic                              |                        | PCK rc.4→5 L19 MT |     53,904 (13,323) |     1,200 | 477              |   536,168 |
| standard-1 (1/2 vCPU, 4 GiB)       | 159, 163, 157          | PCK rc.4→5 L19 MT |      13,867 (6,867) |       323 | 559              |   536,168 |
| standard-1                         |                        | PCK rc.4→5 L12 ST |         1,004 (482) |       204 | 413              |   530,652 |
| standard-1                         |                        | PCK rc.1→5 L19 MT |      19,106 (8,835) |       204 | 559              | 1,335,159 |
| standard-1                         |                        | PCK rc.1→5 L12 ST |         1,082 (504) |       197 | 414              | 1,340,962 |
| standard-2 (1 vCPU, 6 GiB)         | 122, 128, 115          | PCK rc.4→5 L19 MT |       4,692 (4,620) |        93 | 557              |   536,168 |
| standard-2                         |                        | PCK rc.4→5 L12 ST |           503 (487) |       107 | 413              |   530,652 |
| standard-4 (4 vCPU, 12 GiB)        | 145, 116, 546          | PCK rc.4→5 L19 MT |       3,860 (4,405) |        86 | 557              |   536,168 |
| standard-4                         |                        | PCK rc.4→5 L12 ST |           476 (456) |        86 | 413              |   530,652 |
| standard-1, amd64 image (emulated) | 169, 154, 131          | extra L9 ST       |            119 (50) |       228 | 110              |    31,705 |

- **basic (1 GiB) is enough for the 85 MB pair at level 12 ST.** standard-1 halves the wall time.
  Level 19 MT costs 14× the CPU and gives a larger delta, so it buys nothing.
- **Local cold starts of 0.12–0.55 s are not Cloudflare's.** Cloudflare documents "often … in the
  1-3 second range, but this is dependent on image size" [D]. The live figure is [U].
- **The image works as linux/amd64**, which Cloudflare requires [D]. The amd64 timings above ran
  under emulation, so the arm64 rows are the indicative ones.

### 4.4 Queues and Workflows under `wrangler dev` [E]

Config: one queue with `max_batch_size = 10`, `max_batch_timeout = 1`, `max_retries = 2` and a DLQ,
plus a Workflow `DeltaWorkflow` (steps plan → encode → record; the encode step has
`retries: {limit: 2, delay: "1 second"}`).

| Probe                                                            | Observed locally                                                                                                                                                  | Documented                                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer throws on the first message of a 6-message batch        | The **whole batch** was redelivered (attempts 1, 2, 3 at ~1 s spacing), then **all six** went to the DLQ, including five valid messages that were never processed | If the handler throws, the whole batch is retried except explicitly acked messages; 3 retries by default; DLQ after the limit [D]              |
| `msg.retry()` on one message, `ack()` on the rest                | Only that message was retried (attempts 1–3), then sent to the DLQ                                                                                                | as observed [D]                                                                                                                                |
| Same pair sent twice in a batch, and again 15 s after completion | `DELTA_WORKFLOW.create({id})` with a deterministic id **did not throw** any of the three times; the instance **ran once**                                         | `create` "Throws an error if the provided ID is already used"; `createBatch` skips existing ids and "is idempotent" [D]. Local and live differ |
| `createBatch` with an existing id                                | Returned the existing id (not excluded) and did not rerun it                                                                                                      | "skipped and excluded from the returned array" [D]                                                                                             |
| Encode step throws once                                          | Retried after the 1 s delay and succeeded; the step outputs are visible in `instance.status()` (`__LOCAL_DEV_STEP_OUTPUTS`)                                       | Default step retries `{limit: 5, delay: 10000, backoff: "exponential"}`, timeout 10 min [D]                                                    |
| Three Workflow instances started together                        | All three encoded **concurrently in one workerd process** (24 + 44 + 124 MiB of WASM at once)                                                                     | 128 MB is per isolate, and an isolate serves concurrent work [D]. Whether production co-locates Workflow instances is [U]                      |
| R2 event notification                                            | Not configurable in `wrangler.toml`; simulated by sending the documented message shape to the queue                                                               | Rules are created with `wrangler r2 bucket notification create` against the account [D]                                                        |
| Memory and CPU limits                                            | A `WebAssembly.Memory` grew to 1,000 MiB; a 1.5 s spin passed under a fresh `wrangler dev` with `limits.cpu_ms = 100`                                             | 128 MB per isolate including WebAssembly; `cpu_ms` up to 300,000 [D]                                                                           |

### 4.5 Documented limits that matter [D]

All read 2026-10-02 on developers.cloudflare.com (§9).

| Area           | Limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker isolate | "Memory per isolate: 128 MB", WebAssembly allocations included; CPU 30 s default, 5 min max (`limits.cpu_ms`); bundle 64 MiB; global-scope startup 1 s. zstd is not in `node:zlib` or `CompressionStream`, so it must ship as WASM (here 0.47 MiB).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Queues         | Message 128 KB; batch ≤ 100; ≤ 250 concurrent consumer invocations (`max_concurrency` 1–250); ≤ 100 retries; delay ≤ 24 h; retention ≤ 14 days on Paid; 5,000 msg/s per queue; consumer wall time 15 min; CPU 30 s default, 5 min max (the Workers limits page also lists 30 s / 15 min by cron interval, so verify live). At-least-once; ordering best-effort. $0.40 per million 64 KB operations, 1 M/month included on Paid.                                                                                                                                                                                                                                                                                                                    |
| Workflows      | 10,000 steps (25,000 configurable); step result and event payload ≤ 1 MiB (so payload bytes can never pass between steps); CPU per step 30 s default, 5 min max; wall time per step unlimited, but the default step timeout is 10 min and the docs advise ≤ 30 min; 50,000 concurrent instances; creation 100/s per workflow; id ≤ 100 chars `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`; retention 30 days. Steps billed $0.80 per 100k beyond 500k/month (billing since 2026-08-10).                                                                                                                                                                                                                                                                          |
| Containers     | GA 2026-04-13, Workers Paid. Types lite 1/16 vCPU/256 MiB, basic 1/4/1 GiB, standard-1 1/2/4 GiB, standard-2 1/6 GiB, standard-3 2/8 GiB, standard-4 4/12 GiB. linux/amd64 images, ≤ instance disk, 50 GB of images per account. Reached only through its Durable Object (`@cloudflare/containers`, `getContainer(...).fetch`). Ephemeral disk; `sleepAfter` default 10 min; `max_instances` default 20. Cold start "often … 1-3 second range". R2 via an outbound handler with the Worker's binding (`ContainerProxy`, `@cloudflare/containers` ≥ 0.2.0) or S3 credentials. Pricing: $0.000020/vCPU-s (active CPU only), $0.0000025/GiB-s and $0.00000007/GB-s (provisioned while awake); 375 vCPU-min, 25 GiB-h and 200 GB-h included per month. |
| R2             | Event notifications: object-create (`PutObject`, `CopyObject`, `CompleteMultipartUpload`) and object-delete; prefix/suffix filters (no regex); ≤ 100 rules per bucket; overlapping rules refused. Needs an existing queue with a consumer. Single PUT ≤ 5 GiB; multipart parts 5 MiB–5 GiB, equal size; 1 write/s per key. No R2 throughput figure is published.                                                                                                                                                                                                                                                                                                                                                                                   |

## 5. Answers to the brief

**(1) Mechanism and cost per delta.**

| Tier                                | Path                                                                                         | Per delta (Diceroll pack pair)                                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W: Worker** (pairs ≤ 32 MiB/side) | R2 event or sweep → Queue → dedicated consumer Worker: plan, WASM encode L9, verify, publish | ~3 Queue ops ($0.0000012) + 2 R2 reads, 1–2 writes ($0.00001) + ≤ 0.2 s CPU ($0.000004) ≈ **$0.00002** [D]/[I]. One delta a minute all month stays inside the Paid inclusions.                                                                                                                        |
| W + Workflow (optional)             | Queue → Workflow (plan / encode+verify / publish)                                            | + 3–4 steps (≈ $0.00003 beyond 500k steps/month) and Workflow requests. Adds durability that the deterministic key already provides.                                                                                                                                                                  |
| **C: Container** (pairs > 32 MiB)   | Queue → Workflow → Container DO → zstd CLI L12 ST                                            | basic, about 10 s awake plus `sleepAfter`. With `sleepAfter = 30s`: 1 GiB × 40 s ($0.0001) + 4 GB disk × 40 s ($0.00001) + 0.5 vCPU-s ($0.00001) ≈ **$0.00012**. standard-1 with the default 10 min `sleepAfter`: ≈ **$0.0065**. About 2,250 basic deltas/month fit in the included 25 GiB-h. [D]/[I] |

**(2) Limits that bite.** Only isolate memory, and only above about 32 MiB per side (§4.2). The rest
has wide margins:

- CPU: ≤ 0.6 s at level 12 on 85 MB [E], against a 30 s default [D].
- Consumer wall time: 15 min [D].
- Message size: a pair message is under 1 KB, against 128 KB [D].
- Retries: per message, with a DLQ [D]/[E].

A Container cold start of 1–3 s [D] does not matter for an asynchronous job. R2 read throughput from
a Worker or a Container is [U]; locally, streaming 2 × 85 MB took about 0.25 s, which is not
representative.

**(3) Worker or Container.** The Worker handles every pair up to 32 MiB per side, which covers every
real Diceroll pack. The whole 85 MB PCK, or any pack above the cap, needs a Container. basic
(1 GiB) is enough up to about 85 MB; size it as `from + to + ~300 MiB` (RSS 224 MiB at level 12 ST,
page cache on top).

**(4) Local emulation and test structure.**

- Unit-test the policy and consumer with fakes, as the brief already says.
- Run the consumer through `@cloudflare/vitest-pool-workers`: `createMessageBatch`, `getQueueResult`
  [D], plus synthetic R2-event messages.
- Add one **memory-budget test**. It encodes a synthetic pair at the cap (two 32 MiB buffers that
  differ in a few places) through the real module and asserts that `memory.buffer.byteLength` stays
  under 96 MiB, because workerd will not fail it.
- Add one **byte-identity test** against A7's v1/v2 payloads, which needs no Docker.
- Never rely on `create()` throwing for duplicates. Treat "throws" and "returns the existing
  instance" the same, because local and live differ.
- The Container needs Docker, so keep it out of the green gate, as the brief's step 4 already does.

**(5) R2 event trigger and failure modes.**

- **Choosing the rule prefix.** Put the object-create rule on the **final** payload prefix that
  P4-02 publishes to, not on `staging/`. A staged object may never be published. If the publish is
  a `CopyObject`, the final prefix fires exactly once per publish, and the same content-addressed
  key never changes.
- **What the message carries.** It names only the new object (`to`). The consumer joins it with
  the demand table to find hot `from`s, and enqueues nothing when there are none.
- **The daily sweep.** It catches pairs that turn hot later.

Failure modes:

- **Duplicates.** Queues are at-least-once [D]. An overwrite emits a new event. Handle both with
  the deterministic output key: `head` before work and before upload, plus the D1 row.
- **Ordering.** Best-effort [D]. An event can arrive before the release record is committed, so
  the consumer must `msg.retry({delaySeconds: 60})` while the target is unknown and never ack it as
  done.
- **Poison messages.** Isolate each message (batch size 1, or `try` per message with explicit
  `ack`/`retry`): one throw retries the whole batch [E].
- **DLQ.** After `max_retries` messages land there, and there they are deleted after 4 days without
  a consumer [D]. Alert on DLQ depth.
- **Unknowns.** Event latency, and any loss beyond the Queues guarantee [U].

## 6. Recommendation for P4-17

1. **Pipeline:** R2 object-create rule on the payload prefix, plus the daily sweep in
   `scheduled.ts`. Both send `{product, deliverable, from, to}` messages to one Queue
   (`pkey-deltas-<env>`) with a DLQ (`pkey-deltas-dlq-<env>`). The consumer settings are
   `max_batch_size = 1`, `max_concurrency = 1`, `max_retries = 3` and `max_batch_timeout = 5`, with
   `limits.cpu_ms = 60000` as headroom for slower production CPUs.
2. **Consumer in its own Worker script**, for example `packages/worker/wrangler.deltas.toml` with
   the entry `src/deltasEntry.ts`, built from the same `services/release/packs/deltas/` code. Then
   no request traffic and no second encode ever shares its isolate's 128 MB. This is [I]: isolate
   sharing between a script's handlers is documented as per-isolate memory, not measured live.
3. **Job steps, all in one invocation:**
   - **Policy:** the hot threshold, the 30% / 1 MB savings rule, no CI delta, no `37 A4 30 EC` base,
     and `max(from, to) ≤ LAZY_DELTA_MAX_BYTES` (default 33,554,432).
   - **Idempotency:** `head(deltas/<from>/<to>.zstd-patch-from)`.
   - **Encode:** instantiate the encoder per job, stream `from` into linear memory and `to` through
     the encoder at **level 9, single-threaded**, with the window from `highbit(to) + 1` and long
     mode exactly as `programs/fileio.c`.
   - **Verify:** reset the heap and decode against the resident prefix into `DigestStream`; require
     SHA-256 = `to`.
   - **Upload:** the bare frame, with `sha256`.
   - **Record:** the descriptor and D1 row (`memBytes` = window + `from` size).
   - **Drop the instance.**
4. **Ship the encoder as an encode-capable sibling of `@polaris-key/zstd-wasm`** (or a second module
   in it). `S-08/wasm/zenc.c` is the starting point: same toolchain, same stubs, a committed module
   with a SHA-256, and a rebuild that is a reviewed change. It must refuse levels above 15 so the
   single-threaded high-level failure cannot happen.
5. **No Workflows and no Container in P4-17.** Pairs above the cap are refused with a counted
   reason (`over-worker-cap`), so the demand data shows whether a Container tier is ever worth
   building. The follow-up package (proposed **P4-17b**: Workflow → Container, zstd CLI at level 12
   `--single-thread`, instance type basic, `sleepAfter = "30s"`, `max_instances = 2`, R2 through a
   `ContainerProxy` outbound handler) waits for that evidence.
6. **Tests:** see §5(4). Keep the brief's acceptance criteria, but replace "a Container result
   whose decoded hash is not `to`" with "an encode whose verify hash is not `to` is discarded".
   Add the memory-budget test.

### Proposed edits to P4-17's brief (not applied in this branch)

- **Goal / Why:** replace "a Workflow orchestrates it, and a Container runs the zstd CLI" with "a
  dedicated Queue consumer encodes it in WASM (S-08)". Notes/E5 §3.2's "a Worker isolate cannot
  compute them" holds only for pairs above about 32 MiB per side (S-08 §4.2).
- **Human input:** Queues only (Workers Paid), the R2 notification rule, and a second Worker
  deployment. Drop Workflows and Containers.
- **Scope In:** drop "the Workflow `DeltaWorkflow`" and "a Container image". Add "an encode-capable
  zstd WASM module (level ≤ 15, byte-identical to `zstd --single-thread`)" and "the
  `LAZY_DELTA_MAX_BYTES` cap (32 MiB)".
- **Design notes:**
  - "All byte work happens in the Container" becomes "all byte work happens in the dedicated
    consumer, never in a request handler".
  - "Sizing and cost: Container memory … 2 GiB" moves to P4-17b.
  - Idempotency: "duplicate events are no-ops by the output key and the D1 row; never rely on
    Workflow `create` throwing (local and live differ, S-08 §4.4)".
- **Steps 3–4** become "consumer with injected R2/D1 fakes; WASM encoder plus memory-budget and
  byte-identity tests".
- **Acceptance:** add "the encoder's linear memory stays ≤ 96 MiB at the cap" and "levels above 15
  are refused".
- **Reading:** add this note to "Read first".

No decision in the README changes. Decision 14 (lazy hot-pair deltas) stands; only the compute
venue moves from Container to Worker for pairs under the cap. Proposed one-line addition to
CONTENT §16's v3 row: "R2 events → Queue → Worker WASM encode (≤ 32 MiB per side); Workflow →
Container only above that (S-08)".

## 7. Limits of this spike

- No live Cloudflare run.
  - The 128 MB enforcement point (with real JS heap overhead), production CPU speed, R2 throughput,
    Container cold start and the real billing meters are all [U].
  - The cap carries a ~30 MiB [I] headroom guess for JS and runtime.
- One release history: five releases, script-heavy and asset-light (S-03 §9).
  - The extra pack is the only real content pack that changed.
  - Level 9's ≤ 7.4% gap against `-19` comes from these pairs only.
- The cut32/48/64 pairs are prefixes of the PCK: real bytes, but not real packs.
- The single-threaded failure at levels ≥ 16 was observed on zstd 1.5.7, not root-caused. Refusing
  levels above 15 avoids it whatever the cause.
- Docker caps stand in for Firecracker instances, on arm64 rather than amd64.

## 8. Hand-off: owner steps for the live parts

Nothing below was done. Each item is for the account owner, per environment (`staging`,
`production`):

1. Confirm Workers Paid on the account. Queues are also on Free, but P4-17 needs `cpu_ms` above
   Free's 10 ms.
2. Create the queues:
   `npx wrangler queues create pkey-deltas-<env>` and
   `npx wrangler queues create pkey-deltas-dlq-<env>`.
3. Deploy the consumer Worker (P4-17's `wrangler.deltas.toml`) so the queue has a consumer. The R2
   rule requires one.
4. Create the R2 rule:
   `npx wrangler r2 bucket notification create <payload-bucket> --event-type object-create --queue pkey-deltas-<env> --prefix <final payload prefix>`.
   Rules must not overlap.
5. Set `LAZY_DELTAS=on` for one product with `patch.deltaBases: hot-pairs`.
6. Run the live checks that close this note's [U] rows:
   - one 32 MiB pair, watching for Error 1102 or "exceeded resource limits";
   - the consumer's reported CPU ms;
   - the event-to-consumer latency;
   - a duplicate event (re-PUT) producing one delta.
7. Only for P4-17b: Containers are GA on Workers Paid with no separate enablement documented. The
   steps are a Durable Object migration (`new_sqlite_classes`), `wrangler containers push` (or
   wrangler building the image on deploy), and image storage within the 50 GB quota.

## 9. Sources

- [D] Workers limits: https://developers.cloudflare.com/workers/platform/limits/ (memory incl.
  WebAssembly, CPU, wall time, subrequests, bundle size)
- [D] Wrangler configuration (`limits.cpu_ms`, containers keys):
  https://developers.cloudflare.com/workers/wrangler/configuration/
- [D] `node:zlib` (gzip/deflate/brotli only):
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/
- [D] Queues limits, pricing, delivery, batching/retries, DLQ, concurrency, local dev:
  https://developers.cloudflare.com/queues/platform/limits/ ,
  https://developers.cloudflare.com/queues/platform/pricing/ ,
  https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ,
  https://developers.cloudflare.com/queues/configuration/batching-retries/ ,
  https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ ,
  https://developers.cloudflare.com/queues/configuration/consumer-concurrency/ ,
  https://developers.cloudflare.com/queues/configuration/local-development/
- [D] Workflows limits, Workers API (`create` throws on an existing id, `createBatch` idempotent),
  retries, pricing, local dev:
  https://developers.cloudflare.com/workflows/reference/limits/ ,
  https://developers.cloudflare.com/workflows/build/workers-api/ ,
  https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ ,
  https://developers.cloudflare.com/workflows/reference/pricing/ ,
  https://developers.cloudflare.com/workflows/build/local-development/
- [D] Containers limits, pricing, architecture, Container class, outbound/Workers connections,
  image management, local dev, GA changelog:
  https://developers.cloudflare.com/containers/platform/limits/ ,
  https://developers.cloudflare.com/containers/pricing/ ,
  https://developers.cloudflare.com/containers/platform-details/architecture/ ,
  https://developers.cloudflare.com/containers/api/container-class/ ,
  https://developers.cloudflare.com/containers/configuration/workers-connections/ ,
  https://developers.cloudflare.com/containers/platform-details/image-management/ ,
  https://developers.cloudflare.com/containers/guides/local-dev/ ,
  https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- [D] R2 event notifications, limits, multipart, Workers API, wrangler r2 commands:
  https://developers.cloudflare.com/r2/buckets/event-notifications/ ,
  https://developers.cloudflare.com/r2/platform/limits/ ,
  https://developers.cloudflare.com/r2/objects/upload-objects/ ,
  https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ ,
  https://developers.cloudflare.com/workers/wrangler/commands/r2/
- [D] Vitest integration test APIs (`createMessageBatch`, `getQueueResult`,
  `introspectWorkflowInstance`): https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- [V] zstd 1.5.7 `programs/fileio.c` (`FIO_adjustParamsForPatchFromMode`, `FIO_createCResources`):
  the window, long-mode and `refPrefix` rules the WASM encoder copies. Release tarball SHA-256
  `eb33e51f…6fa3`, as pinned in `packages/zstd-wasm/wasm/build.sh`.
- [S] notes/S-03 (pack slices, real pair sizes, the CLI `-19` deltas), notes/E5 §3.2 and §4.3,
  `packages/zstd-wasm` (toolchain, stubs, bump allocator).
