---
title: "Operations"
description: "What the Operations page reports about cron runs, consumers, queues, storage and store connectors, and what Healthy, Degraded and Failed mean."
sidebar:
  order: 14
---

**Platform → Operations** is the instance's own account of its background work. It reads one
platform-admin endpoint, `GET /manage/api/platform/operations`, which answers from the Worker's
bindings and from rows the Worker writes about itself. It needs no Cloudflare API token, and it
makes no outbound call.

The page refreshes every 30 seconds while the tab is visible. The **Refresh every 30 s** switch
under the title pauses it, and the choice is remembered in your browser. **Refresh** in the header
reads the snapshot straight away.

## Healthy, Degraded and Failed

Every section is reduced to one of three states, shown as an icon and a word. The title carries the
worst of them.

| State        | Meaning                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **Healthy**  | Every check in the section passed.                                                                             |
| **Degraded** | Something needs a look but the instance is serving: a failed cron step, a backlog, a missing index.            |
| **Failed**   | Something the instance cannot work without has stopped: a core binding not answering, or the cron gone silent. |

A section the Worker could not read is Degraded and says so. It is never shown as Healthy.

Anything that is not Healthy is also listed under **Needs attention**, with the reason in one line.

## Cron jobs

The Worker has two cron triggers. The nightly maintenance job runs at 03:17 UTC, and the connector
poll runs every 15 minutes. After each tick the Worker records the run, and the page shows:

- the **latest run** of each job as a table of steps: the step, when it last ran, how long it took,
  its outcome and an error summary for a failed step;
- **Recent runs**, the last ten ticks across both jobs, with duration and outcome;
- **Recent failed steps**, the newest failures with their error text.

Per-product steps are folded into one row (`audit:*`), so a run stays short however many products
exist. A failed step keeps its full name. Error text is cut to 300 characters and is the message of
the exception the step raised. Run records are kept for 30 days.

A run with any failed step is Degraded. The other steps of that run still ran.

## Heartbeats

Each script writes a heartbeat row when it does work.

| Script                  | Writes it                      | State                                                                                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Main Worker (cron)**  | At the end of every cron tick  | Ticking, **Stale** after 45 minutes (three missed ticks, Degraded), **Silent** after 2 hours (Failed).              |
| **Lazy-delta consumer** | After every batch it processes | **Idle** while the queue is empty. With messages waiting, **Stale** after 10 minutes and **Stalled** after an hour. |

The consumer has no route to probe, so its heartbeat is the only proof it is running. An idle
consumer is healthy however old its last heartbeat is.

## Queues

The **Queue backlog** panel shows the lazy-delta queue and its dead-letter queue: messages waiting,
their size and the age of the oldest. The figures come from the queues' own metrics.

- A backlog in the delta queue is normal while deltas are being encoded.
- Any message in the dead-letter queue is Degraded. It failed every retry (three) and waits for a
  decision. See [Operating](/docs/admin/kek/) for how lazy deltas are run and turned off.
- A queue whose metrics could not be read is Degraded, with the reason.

## Storage and indexes

- **D1 size** is the database's size as D1 reports it after a read.
- **R2 committed** is the sum of every committed object in the blob store, by kind. Uploads still
  in staging expire after a day and are not counted.
- **Required indexes** compares the database with the indexes this build needs. Each missing
  index is listed by name and the section is Degraded. The cause is almost always a migration that
  has not been applied: check [Platform → Deployment](/docs/admin/deploy/).

## Store connectors

One row per store connector, aggregated across every product that uses it: how many products
configured it, how many store objects it tracks, its last poll, its last webhook and the webhook
deliveries that failed in the last 24 hours. A connector no product uses reads **Not configured**.
Failed deliveries, or a failed poll step, make the section Degraded. Store credentials are never
shown. See [Store connections](/docs/admin/store-connections/).

## Bindings and delta refusals

**Bindings** probes D1, KV and R2 with a read that cannot find anything, and shows how long each
took. A bound D1, KV or R2 that does not answer is Failed. The update-health and email bindings are
shown as present or not bound.

**Delta refusals** counts the pairs the consumer declined to encode in the last 7 days, by reason.
Refusals are expected for pairs that are too large or not compressible, and do not change a
section's state.

## What the page does not show

Request and error rates, CPU time and anything else only Cloudflare can see are not on this page.
A failure that never reaches the Worker's code, such as a CPU-limit kill, also leaves no row here.
Use Cloudflare's own dashboards for those.
