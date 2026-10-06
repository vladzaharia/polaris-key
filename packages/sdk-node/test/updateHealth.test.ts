// @pkey-feature devices.report update.decide
// SDK parity pass §3.13 (P6-03): the persisted update-health journal, the report's `updates`,
// `gate` and `outlet`, and update_offered from decide().

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordHash } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import {
  MAX_UPDATE_EVENTS_PER_REPORT,
  UpdateJournal,
} from "../src/update/journal.js";
import { json, seededClient, signedLicense } from "./parityFixtures.js";
import {
  BASE,
  feedPayload,
  fakeWorker,
  MemStore,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  recordPayload,
  signFeed,
  signRecord,
  V4_SERVICES,
} from "./updateFixtures.js";

afterEach(() => vi.useRealTimers());

function journal(dir = mkdtempSync(join(tmpdir(), "pkey-journal-"))) {
  return new UpdateJournal({
    stateDir: dir,
    outlet: () => "direct",
    channel: () => "stable",
    now: () => 1_700_000_000,
  });
}

describe("update-health journal", () => {
  it("records entries in the Worker's boundedUpdates shape and persists them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-journal-"));
    const j = journal(dir);
    const e = await j.record("update_downloaded", {
      release: "1.5.0",
      fromRelease: "1.4.0",
    });
    expect(e).toEqual({
      eventId: expect.stringMatching(/^[0-9a-f]{16}-update_downloaded$/),
      event: "update_downloaded",
      deliverable: "app",
      release: "1.5.0",
      fromRelease: "1.4.0",
      outlet: "direct",
      channel: "stable",
      at: 1_700_000_000,
    });
    // A fresh journal over the same directory sees it: it survives a restart.
    expect(await journal(dir).all()).toEqual([e]);
  });

  it("refuses a malformed event instead of sending it for the Worker to drop", async () => {
    const j = journal();
    expect(
      await j.record("update_applied", { release: "has space" }),
    ).toBeNull();
    expect(
      await j.record("update_applied", { release: "1.0", deliverable: "Bad" }),
    ).toBeNull();
    expect(await j.all()).toEqual([]);
  });

  it("a report carries at most 16, oldest first, and markSent drops only those", async () => {
    const j = journal();
    for (let i = 0; i < 20; i += 1)
      await j.record("update_offered", { release: `1.${i}.0` });
    const first = await j.pending();
    expect(first).toHaveLength(MAX_UPDATE_EVENTS_PER_REPORT);
    expect(first[0]!.release).toBe("1.0.0");
    await j.markSent(first.map((e) => e.eventId));
    const rest = await j.all();
    expect(rest.map((e) => e.release)).toEqual([
      "1.16.0",
      "1.17.0",
      "1.18.0",
      "1.19.0",
    ]);
  });
});

describe("devices/report carries updates, gate and outlet", () => {
  it("sends the pending events and marks them sent once accepted", async () => {
    let accept = false;
    const bodies: Record<string, unknown>[] = [];
    const { client } = await seededClient({
      license: await signedLicense({ pro: true }),
      routes: {
        "POST /djdl/devices/report": (req) => {
          bodies.push(JSON.parse(req.body ?? "{}"));
          return accept ? json({ ok: true }) : json({}, 500);
        },
      },
    });
    await client.update.journal.record("update_confirmed", {
      release: "1.2.3",
    });
    expect(await client.devices.report()).toBe(false);
    expect(bodies[0]!.gate).toEqual({ status: "ok" });
    expect(bodies[0]!.updates).toHaveLength(1);
    // Refused: the event waits for the next report.
    expect(await client.update.journal.all()).toHaveLength(1);
    accept = true;
    expect(await client.devices.report()).toBe(true);
    expect(bodies[1]!.updates).toEqual(bodies[0]!.updates);
    expect(await client.update.journal.all()).toEqual([]);
    // Nothing pending: the key is omitted.
    await client.devices.report();
    expect(bodies[2]).not.toHaveProperty("updates");
  });
});

describe("decide() records update_offered once per release", () => {
  it("journals the offered release with the running version as fromRelease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_100 * 1000);
    const recordJws = await signRecord(recordPayload());
    const hash = await recordHash(recordJws);
    const feedJws = await signFeed(
      feedPayload({ seq: 9, issuedAt: 1_700_000_000, sha256: hash }),
    );
    const worker = fakeWorker({
      feeds: () => feedJws,
      records: { [hash]: recordJws },
    });
    const state = mkdtempSync(join(tmpdir(), "pkey-offered-"));
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.4.0",
      trust: { pinnedKeys: PINS },
      store: new MemStore("dev_offered"),
      fetchImpl: worker.fetch,
      requestTimeoutMs: 0,
      stateDir: state,
      expectedServices: [...V4_SERVICES] as never,
      update: {
        pinnedReleaseKeys: RELEASE_KEYS,
        outlet: "direct",
        platform: "macos",
        arch: "arm64",
      },
    });
    const check = await client.update.decide();
    expect(check.decision.action).toBe("binary");
    await client.update.decide();
    const events = await client.update.journal.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "update_offered",
      release: "1.5.0",
      fromRelease: "1.4.0",
      outlet: "direct",
      channel: "stable",
    });
  });
});
