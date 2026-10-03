# S-08 Spike: Cloudflare Queues, Workflows and Containers for lazy deltas

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                                                                            |
| Size        | 0.5–1 engineer-weeks                                                                                                                                                 |
| Depends on  | none                                                                                                                                                                 |
| Unblocks    | [P4-17](P4-17-lazy-deltas.md)                                                                                                                                        |
| Role        | `pkey-spike-runner`                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                   |
| Gates       | `pnpm format` on the files it adds; no product code changes                                                                                                          |
| Human input | none to run the local parts; Workers Paid with Queues, Workflows and Containers enabled for the live parts (the note marks those unmeasured if they are not enabled) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Goal

A research note, `notes/S-08-cloudflare-async-compute.md`, that tells P4-17 how to generate hot-pair
deltas off the request path, with evidence:

1. Which mechanism fits: Queues (consumer Worker), Workflows (durable steps), Containers (a native
   `zstd --patch-from` / bsdiff binary), or a combination; and what each costs per delta.
2. Measured or documented limits that matter: CPU and wall time per invocation, memory, message
   size, retries and dead-lettering, R2 read/write throughput from each, cold start of a Container.
3. Whether the delta encoder can run in a Worker (WASM zstd with a dictionary, memory ceiling for
   the largest real pack pairs from S-03) or needs a Container.
4. What `wrangler dev` / miniflare can emulate locally (Queues and Workflows: yes or no;
   Containers: no) and how P4-17's tests should be structured given that.
5. How an R2 event notification (object created under `staging/` or a telemetry key) triggers the
   pipeline, and the failure modes (duplicates, ordering).

Mark every claim measured [M], emulated [E], documented [D] or unmeasured [U]. End with a
recommendation P4-17 can implement and the exact Cloudflare settings the owner must enable.

## Out of scope

Product code; enabling paid features; anything that writes to production resources.
