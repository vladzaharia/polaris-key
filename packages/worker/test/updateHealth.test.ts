/**
 * P6-03 — update outcome events on `POST /<p>/devices/report` (`updates`) and their counters
 * (`core/updateHealth.ts`, `src/updateHealthDo.ts`).
 *
 * Pinned here: the allowlist keeps valid events and drops malformed ones and unknown events;
 * the same report retried counts nothing twice; the 16 KiB cap still holds; counting fails open;
 * the object counts distinct devices, folds excess (outlet, channel) pairs into overflow, reads a
 * window and sweeps itself; and the event names are exactly `enums.json`'s `updateEvent`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct } from "./seed.js";
import {
  asNamespace,
  makeUpdateHealthNamespace,
  type UpdateHealthNamespaceMock,
} from "./updateHealthMock.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleRegister } from "../src/core/register.js";
import { handleReport } from "../src/core/devices.js";
import { SERVICES } from "../src/mount.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  boundedUpdates,
  countsFor,
  MAX_UPDATE_EVENTS,
  readUpdateHealth,
  recordUpdateEvents,
  UPDATE_EVENTS,
} from "../src/core/updateHealth.js";
import {
  MAX_PAIRS,
  OVERFLOW_CHANNEL,
  OVERFLOW_OUTLET,
  RETENTION_SECONDS,
} from "../src/updateHealthDo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

interface World {
  db: SqliteDb;
  env: Env;
  product: Product;
  ns: UpdateHealthNamespaceMock;
}

async function world(bind = true): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  const ns = makeUpdateHealthNamespace();
  if (bind) env.UPDATE_HEALTH = asNamespace(ns);
  await seedProduct(db, "djdl");
  await setServices(
    db,
    "djdl",
    serializeServices({
      services: {
        license: { enabled: false },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  const product = (await loadProduct(env, db, "djdl"))!;
  return { db, env, product, ns };
}

async function token(w: World, device = DEVICE): Promise<string> {
  const res = await handleRegister(
    mkReq("POST", { "x-pkey-device": device }),
    w.env,
    w.db,
    w.product,
    NOW,
    SERVICES,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-1",
    event: "update_applied",
    deliverable: "app",
    release: "v1.4.0",
    fromRelease: "v1.3.0",
    outlet: "direct",
    channel: "stable",
    at: NOW - 60,
    ...over,
  };
}

async function report(
  w: World,
  tok: string,
  body: unknown,
  now = NOW,
): Promise<Response> {
  return handleReport(
    mkReq("POST", { authorization: `Bearer ${tok}` }, body),
    w.env,
    w.db,
    w.product,
    now,
  );
}

async function read(w: World, release = "v1.4.0", windowHours = 24, now = NOW) {
  const r = await readUpdateHealth(w.env, {
    product: "djdl",
    deliverable: "app",
    release,
    windowHours,
    now,
  });
  expect(r).not.toBeNull();
  return r!;
}

async function storedUpdates(w: World, device = DEVICE): Promise<unknown> {
  const row = await w.db.first<{ reported_json: string | null }>(
    "SELECT reported_json FROM devices WHERE product = ? AND device_id = ?",
    "djdl",
    device,
  );
  return (JSON.parse(row?.reported_json ?? "{}") as { updates?: unknown })
    .updates;
}

describe("the updateEvent vocabulary", () => {
  it("is exactly conformance/parity/enums.json's updateEvent, in order", () => {
    const enums = JSON.parse(
      readFileSync(
        join(HERE, "..", "..", "..", "conformance", "parity", "enums.json"),
        "utf8",
      ),
    ) as { enums: Array<{ name: string; values: string[] }> };
    const updateEvent = enums.enums.find((e) => e.name === "updateEvent");
    expect(updateEvent?.values).toEqual([...UPDATE_EVENTS]);
  });
});

describe("boundedUpdates: the strict allowlist", () => {
  it("keeps a valid entry and strips unknown fields", () => {
    expect(boundedUpdates([{ ...event(), extra: "x", hwid: "abc" }])).toEqual([
      event(),
    ]);
  });

  it("drops unknown events and every malformed entry, keeping the rest", () => {
    const bad = [
      event({ event: "update_exploded" }),
      event({ eventId: "" }),
      event({ eventId: "has space" }),
      event({ eventId: "x".repeat(65) }),
      event({ deliverable: "App" }),
      event({ release: "v1|4" }),
      event({ outlet: "Direct" }),
      event({ channel: "-stable" }),
      event({ at: "1700000000" }),
      event({ at: 1.5 }),
      event({ at: -1 }),
      event({ fromRelease: 7 }),
      event({ packSetId: "a b" }),
      event({ code: "x".repeat(65) }),
      "update_applied",
      null,
      [event()],
    ];
    const good = event({ eventId: "keep" });
    // Two batches, so every bad entry is inside the 16-entry read window.
    expect(boundedUpdates([...bad.slice(0, 9), good])).toEqual([good]);
    expect(boundedUpdates([good, ...bad.slice(9)])).toEqual([good]);
  });

  it("reads at most 16 entries, and drops a non-array", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      event({ eventId: `e${i}` }),
    );
    expect(boundedUpdates(many)).toHaveLength(MAX_UPDATE_EVENTS);
    expect(boundedUpdates({ 0: event() })).toBeUndefined();
    expect(boundedUpdates("nope")).toBeUndefined();
  });
});

describe("POST /devices/report with updates", () => {
  it("counts valid events once even when the same report is retried", async () => {
    const w = await world();
    const tok = await token(w);
    const body = {
      appVersion: "1.4.0",
      updates: [
        event({ eventId: "o1", event: "update_offered" }),
        event({ eventId: "d1", event: "update_downloaded" }),
        event({ eventId: "a1", event: "update_applied" }),
      ],
    };
    for (let i = 0; i < 3; i++)
      expect((await report(w, tok, body)).status).toBe(200);
    const r = await read(w);
    const devices = countsFor(r.counts, "direct", "stable");
    const events = countsFor(r.counts, "direct", "stable", "events");
    expect(devices).toMatchObject({
      update_offered: 1,
      update_downloaded: 1,
      update_applied: 1,
      update_reverted: 0,
    });
    expect(events).toMatchObject({
      update_offered: 1,
      update_downloaded: 1,
      update_applied: 1,
    });
    // One object for the one release named, called once per report.
    expect(new Set(w.ns.calls)).toEqual(new Set(["djdl|app|v1.4.0"]));
  });

  it("drops malformed entries and unknown events from the snapshot and the counters", async () => {
    const w = await world();
    const tok = await token(w);
    const res = await report(w, tok, {
      updates: [
        event({ eventId: "ok", event: "update_reverted", code: "boot_failed" }),
        event({ eventId: "bad", event: "update_teleported" }),
        event({ eventId: "bad2", outlet: 42 }),
        { eventId: "bad3" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await storedUpdates(w)).toEqual([
      event({ eventId: "ok", event: "update_reverted", code: "boot_failed" }),
    ]);
    const r = await read(w);
    expect(r.counts).toEqual([
      {
        outlet: "direct",
        channel: "stable",
        event: "update_reverted",
        events: 1,
        devices: 1,
      },
    ]);
  });

  it("drops a non-array updates key and still stores the rest of the report", async () => {
    const w = await world();
    const tok = await token(w);
    expect(
      (await report(w, tok, { appVersion: "1.4.0", updates: { a: 1 } })).status,
    ).toBe(200);
    expect(await storedUpdates(w)).toBeUndefined();
    expect(w.ns.calls).toEqual([]);
  });

  it("still refuses a body over 16 KiB, whatever it carries, and counts nothing", async () => {
    const w = await world();
    const tok = await token(w);
    const res = await report(w, tok, {
      updates: [event()],
      pad: "x".repeat(16 * 1024),
    });
    expect(res.status).toBe(413);
    expect(w.ns.calls).toEqual([]);
  });

  it("counts distinct devices: one device's many events move devices by one", async () => {
    const w = await world();
    const t1 = await token(w, DEVICE);
    const t2 = await token(w, DEVICE_2);
    await report(w, t1, {
      updates: Array.from({ length: 5 }, (_, i) =>
        event({ eventId: `r${i}`, event: "update_reverted" }),
      ),
    });
    await report(w, t2, {
      updates: [event({ eventId: "r0", event: "update_reverted" })],
    });
    const r = await read(w);
    expect(countsFor(r.counts, "direct", "stable").update_reverted).toBe(2);
    expect(
      countsFor(r.counts, "direct", "stable", "events").update_reverted,
    ).toBe(6);
  });

  it("dedupes per device: another device's same eventId is its own event", async () => {
    const w = await world();
    const t1 = await token(w, DEVICE);
    const t2 = await token(w, DEVICE_2);
    await report(w, t1, { updates: [event({ eventId: "same" })] });
    await report(w, t2, { updates: [event({ eventId: "same" })] });
    const r = await read(w);
    expect(countsFor(r.counts, "direct", "stable").update_applied).toBe(2);
  });

  it("splits events across releases: one object per (deliverable, release)", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: [
        event({ eventId: "a", release: "v1.4.0" }),
        event({ eventId: "b", release: "v1.5.0" }),
        event({ eventId: "c", deliverable: "levels", release: "p-1" }),
      ],
    });
    expect([...w.ns.instances.keys()].sort()).toEqual([
      "djdl|app|v1.4.0",
      "djdl|app|v1.5.0",
      "djdl|levels|p-1",
    ]);
  });

  it("counts a future event as now and drops one older than retention", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: [
        event({ eventId: "future", at: NOW + 10 * 86400 }),
        event({ eventId: "ancient", at: NOW - RETENTION_SECONDS - 3600 }),
      ],
    });
    const r = await read(w, "v1.4.0", 1);
    expect(
      countsFor(r.counts, "direct", "stable", "events").update_applied,
    ).toBe(1);
  });

  it("fails open: a failing object or no binding still answers 200 and stores the snapshot", async () => {
    const w = await world();
    const tok = await token(w);
    w.ns.failing = true;
    expect((await report(w, tok, { updates: [event()] })).status).toBe(200);
    expect(await storedUpdates(w)).toEqual([event()]);
    expect(
      await readUpdateHealth(w.env, {
        product: "djdl",
        deliverable: "app",
        release: "v1.4.0",
        windowHours: 6,
        now: NOW,
      }),
    ).toBeNull();
    // A later retry, once the object answers, counts it then — once.
    w.ns.failing = false;
    await report(w, tok, { updates: [event()] });
    await report(w, tok, { updates: [event()] });
    expect(
      countsFor((await read(w)).counts, "direct", "stable").update_applied,
    ).toBe(1);

    const unbound = await world(false);
    const t = await token(unbound);
    expect((await report(unbound, t, { updates: [event()] })).status).toBe(200);
    expect(await storedUpdates(unbound)).toEqual([event()]);
    expect(
      await recordUpdateEvents(
        unbound.env,
        "djdl",
        DEVICE,
        [event() as never],
        NOW,
      ),
    ).toBe(0);
  });
});

describe("UpdateHealthDO", () => {
  it("reads only the window asked for", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: [
        event({ eventId: "old", at: NOW - 10 * 3600 }),
        event({ eventId: "new", at: NOW - 60 }),
      ],
    });
    const last2h = await read(w, "v1.4.0", 2);
    expect(
      countsFor(last2h.counts, "direct", "stable", "events").update_applied,
    ).toBe(1);
    const last24h = await read(w, "v1.4.0", 24);
    expect(
      countsFor(last24h.counts, "direct", "stable", "events").update_applied,
    ).toBe(2);
  });

  it("folds (outlet, channel) pairs past the cap into overflow", async () => {
    const w = await world();
    const name = "djdl|app|v1.4.0";
    const events = Array.from({ length: MAX_PAIRS + 3 }, (_, i) => ({
      eventId: `p${i}`,
      event: "update_applied",
      outlet: `o${i}`,
      channel: "stable",
      at: NOW,
    }));
    const obj = w.ns.instance(name).obj;
    for (let i = 0; i < events.length; i += 16) {
      await obj.fetch(
        new Request("https://x/record", {
          method: "POST",
          body: JSON.stringify({
            op: "record",
            now: NOW,
            deviceId: DEVICE,
            events: events.slice(i, i + 16),
          }),
        }),
      );
    }
    const r = await read(w);
    const outlets = new Set(r.counts.map((c) => c.outlet));
    expect(outlets.size).toBe(MAX_PAIRS + 1);
    const overflow = r.counts.find((c) => c.outlet === OVERFLOW_OUTLET);
    expect(overflow).toMatchObject({ channel: OVERFLOW_CHANNEL, events: 3 });
  });

  it("refuses a malformed request and ignores malformed events", async () => {
    const w = await world();
    const obj = w.ns.instance("djdl|app|v1.4.0").obj;
    expect(
      (
        await obj.fetch(
          new Request("https://x", { method: "POST", body: "nope" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await obj.fetch(
          new Request("https://x", { method: "POST", body: '{"op":"drop"}' }),
        )
      ).status,
    ).toBe(400);
    const res = await obj.fetch(
      new Request("https://x", {
        method: "POST",
        body: JSON.stringify({
          op: "record",
          now: NOW,
          deviceId: DEVICE,
          events: [
            {
              eventId: "a|b",
              event: "update_applied",
              outlet: "direct",
              channel: "stable",
              at: NOW,
            },
          ],
        }),
      }),
    );
    expect(await res.json()).toEqual({ counted: 0 });
  });

  it("arms a sweep, deletes what is past retention, and empties itself", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, { updates: [event()] });
    const inst = w.ns.instance("djdl|app|v1.4.0");
    expect(inst.storage.alarm).not.toBeNull();
    expect(inst.storage.m.size).toBeGreaterThan(0);

    // The alarm reads the wall clock: a sweep "now" keeps everything recorded at NOW only
    // until RETENTION_SECONDS have passed.
    const realNow = Date.now;
    try {
      Date.now = () => (NOW + 60) * 1000;
      await inst.obj.alarm();
      expect([...inst.storage.m.keys()].some((k) => k.startsWith("h|"))).toBe(
        true,
      );
      Date.now = () => (NOW + RETENTION_SECONDS + 2 * 86400) * 1000;
      await inst.obj.alarm();
      expect(inst.storage.m.size).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});
