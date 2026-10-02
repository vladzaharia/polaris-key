/**
 * P6-03 — update outcome events on `POST /<p>/devices/report` (`updates`) and their counters
 * (`core/updateHealth.ts`, `src/updateHealthDo.ts`).
 *
 * Pinned here: the allowlist keeps valid events and drops malformed ones and unknown events;
 * the same report retried counts nothing twice; the 16 KiB cap still holds; counting fails open;
 * undeclared outlets and channels land in one `unknown` bucket; the object counts distinct
 * devices, caps what one device can count or introduce, reads a window page by page and sweeps
 * itself with a resumable cursor; and the event names are exactly `enums.json`'s `updateEvent`.
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
  MAX_REPORT_GROUPS,
  readUpdateHealth,
  recordUpdateEvents,
  staticScope,
  UPDATE_EVENTS,
} from "../src/core/updateHealth.js";
import {
  MAX_DEVICE_EVENTS,
  MAX_DEVICE_PAIRS,
  SWEEP_BATCH,
  SWEEP_RESUME_MS,
  UNKNOWN,
  RETENTION_SECONDS,
} from "../src/updateHealthDo.js";
import type { Env } from "../src/env.js";
import type { ServiceHooks } from "../src/core/hooks.js";
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

/** The product's declarations as the hooks answer them: outlets `direct` and `play`, channels
 *  `stable` and `beta`. (This suite's product runs neither Distribution nor Release; the real
 *  hooks are exercised in autoHalt.test.ts.) */
const HOOKS = {
  delivery: () => ({
    outlets: async () => [{ outletId: "direct" }, { outletId: "play" }],
  }),
  releaseCatalog: () => ({
    knownChannels: async () => ["stable", "beta"],
    // Release knows v1.4.0 and v1.5.0 of the app, sixteen more app releases, and pack p-1.
    releases: async (deliverable: string) =>
      (deliverable === "app"
        ? [
            "v1.4.0",
            "v1.5.0",
            ...Array.from({ length: 16 }, (_, i) => `v2.${i}.0`),
          ]
        : deliverable === "levels"
          ? ["p-1"]
          : []
      ).map((releaseId) => ({ releaseId })),
  }),
  outletCapabilities: async () => null,
} as unknown as ServiceHooks;

const SCOPE = staticScope({
  outlets: ["direct", "play"],
  channels: ["stable", "beta"],
  releases: ["app|v1.4.0"],
});

function record(w: World, device: string, events: unknown[]) {
  return w.ns.instance("djdl|app|v1.4.0").obj.fetch(
    new Request("https://x/record", {
      method: "POST",
      body: JSON.stringify({
        op: "record",
        now: NOW,
        deviceId: device,
        events,
      }),
    }),
  );
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
    HOOKS,
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

  it("splits events across releases: one object per (deliverable, release), at most two", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: [
        event({ eventId: "a", release: "v1.4.0" }),
        event({ eventId: "c", deliverable: "levels", release: "p-1" }),
        event({ eventId: "b", release: "v1.5.0" }),
      ],
    });
    expect([...w.ns.instances.keys()].sort()).toEqual([
      "djdl|app|v1.4.0",
      "djdl|levels|p-1",
    ]);
  });

  it("an unknown release counts nothing and creates no object", async () => {
    const w = await world();
    const tok = await token(w);
    expect(
      (
        await report(w, tok, {
          updates: [
            event({ eventId: "a", release: "v9.9.9" }),
            event({ eventId: "b", deliverable: "nopack", release: "x-1" }),
          ],
        })
      ).status,
    ).toBe(200);
    expect(w.ns.instances.size).toBe(0);
    expect(w.ns.calls).toEqual([]);
    expect(
      await recordUpdateEvents(
        w.env,
        "djdl",
        DEVICE,
        [event({ release: "v9.9.9" }) as never],
        NOW,
        SCOPE,
      ),
    ).toBe(0);
    expect(w.ns.instances.size).toBe(0);
  });

  it("a report naming 16 distinct real releases touches at most two objects", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: Array.from({ length: 16 }, (_, i) =>
        event({ eventId: `r${i}`, release: `v2.${i}.0` }),
      ),
    });
    expect(w.ns.instances.size).toBe(MAX_REPORT_GROUPS);
    expect(new Set(w.ns.calls).size).toBe(MAX_REPORT_GROUPS);
    expect([...w.ns.instances.keys()].sort()).toEqual([
      "djdl|app|v2.0.0",
      "djdl|app|v2.1.0",
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
        SCOPE,
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

  it("counts an undeclared outlet or unknown channel in one unknown bucket", async () => {
    const w = await world();
    const tok = await token(w);
    await report(w, tok, {
      updates: [
        event({ eventId: "a", outlet: "steam" }),
        event({ eventId: "b", channel: "nightly" }),
        event({ eventId: "c" }),
      ],
    });
    const r = await read(w);
    expect(countsFor(r.counts, "direct", "stable").update_applied).toBe(1);
    expect(countsFor(r.counts, UNKNOWN, UNKNOWN, "events").update_applied).toBe(
      2,
    );
    expect(new Set(r.counts.map((c) => c.outlet))).toEqual(
      new Set(["direct", UNKNOWN]),
    );
  });

  it("32 invented pairs from one device cannot crowd out the real pair", async () => {
    const w = await world();
    const tok = await token(w);
    // Through the report: every invented outlet is undeclared, so all land in `unknown`.
    for (let i = 0; i < 32; i += 16)
      await report(w, tok, {
        updates: Array.from({ length: 16 }, (_, k) =>
          event({ eventId: `x${i + k}`, outlet: `bogus${i + k}` }),
        ),
      });
    // Straight at the object (declared-looking pairs): one device introduces at most 8.
    await record(
      w,
      DEVICE_2,
      Array.from({ length: 12 }, (_, k) => ({
        eventId: `y${k}`,
        event: "update_applied",
        outlet: `o${k}`,
        channel: "stable",
        at: NOW,
      })),
    );
    // Genuine traffic on the real pair, from other devices, is counted in full.
    for (let d = 0; d < 5; d++)
      await record(w, `GENUINE${d}`, [
        {
          eventId: "g",
          event: "update_reverted",
          outlet: "direct",
          channel: "stable",
          at: NOW,
        },
      ]);
    const r = await read(w);
    expect(countsFor(r.counts, "direct", "stable").update_reverted).toBe(5);
    const own = new Set(
      r.counts.filter((c) => c.outlet.startsWith("o")).map((c) => c.outlet),
    );
    expect(own.size).toBe(MAX_DEVICE_PAIRS);
    expect(countsFor(r.counts, UNKNOWN, UNKNOWN, "events").update_applied).toBe(
      32 + 12 - MAX_DEVICE_PAIRS,
    );
  });

  it("counts at most 64 events per device per release, then nothing", async () => {
    const w = await world();
    const many = Array.from({ length: 80 }, (_, k) => ({
      eventId: `e${k}`,
      event: "update_offered",
      outlet: "direct",
      channel: "stable",
      at: NOW,
    }));
    let counted = 0;
    for (let i = 0; i < many.length; i += 16)
      counted += (
        (await (await record(w, DEVICE, many.slice(i, i + 16))).json()) as {
          counted: number;
        }
      ).counted;
    expect(counted).toBe(MAX_DEVICE_EVENTS);
    const r = await read(w);
    expect(
      countsFor(r.counts, "direct", "stable", "events").update_offered,
    ).toBe(MAX_DEVICE_EVENTS);
    const dev = await w.ns
      .instance("djdl|app|v1.4.0")
      .storage.get<{ ids: string[] }>(`v|${DEVICE}`);
    expect(dev?.ids).toHaveLength(MAX_DEVICE_EVENTS);
  });

  it("sums every page of a long read", async () => {
    const w = await world();
    const inst = w.ns.instance("djdl|app|v1.4.0");
    // 2500 buckets in the window: more than one read page.
    const base = Math.floor(NOW / 3600) - 500;
    for (let h = 0; h < 500; h++)
      for (const e of [
        "update_offered",
        "update_downloaded",
        "update_applied",
        "update_confirmed",
        "update_reverted",
      ])
        await inst.storage.put(
          `h|${String(base + h).padStart(8, "0")}|direct|stable|${e}`,
          { events: 1, devices: 1 },
        );
    const r = await read(w, "v1.4.0", 501);
    expect(r.truncated).toBe(false);
    expect(countsFor(r.counts, "direct", "stable").update_reverted).toBe(500);
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
  it("sweeps a stale record behind more than 2000 young ones that sort first", async () => {
    const w = await world();
    const inst = w.ns.instance("djdl|app|v1.4.0");
    const sweepAt = NOW + RETENTION_SECONDS + 86400;
    for (let i = 0; i < SWEEP_BATCH + 300; i++)
      await inst.storage.put(`v|a${String(i).padStart(6, "0")}`, {
        last: sweepAt - 60,
        ids: ["x"],
        pairs: [],
        seen: [],
      });
    await inst.storage.put("v|zzzz", {
      last: NOW,
      ids: ["x"],
      pairs: [],
      seen: [],
    });
    await inst.storage.put(
      `h|${String(Math.floor(NOW / 3600)).padStart(8, "0")}|direct|stable|update_applied`,
      { events: 1, devices: 1 },
    );
    const realNow = Date.now;
    try {
      Date.now = () => sweepAt * 1000;
      await inst.obj.alarm();
    } finally {
      Date.now = realNow;
    }
    expect(await inst.storage.get("v|zzzz")).toBeUndefined();
    expect([...inst.storage.m.keys()].some((k) => k.startsWith("h|"))).toBe(
      false,
    );
    expect(await inst.storage.get("v|a000000")).toBeDefined();
    expect(inst.storage.m.size).toBe(SWEEP_BATCH + 300);
  });

  it("resumes from its cursor within a minute when the time budget runs out", async () => {
    const w = await world();
    const inst = w.ns.instance("djdl|app|v1.4.0");
    const sweepAt = NOW + RETENTION_SECONDS + 86400;
    for (let i = 0; i < SWEEP_BATCH * 2 + 10; i++)
      await inst.storage.put(`v|a${String(i).padStart(6, "0")}`, {
        last: NOW,
        ids: ["x"],
        pairs: [],
        seen: [],
      });
    const realNow = Date.now;
    let clock = sweepAt * 1000;
    try {
      // Every clock read advances 4 s, so the 10 s budget lasts about one page.
      Date.now = () => (clock += 4000);
      await inst.obj.alarm();
      expect(await inst.storage.get("meta|sweep")).toBeDefined();
      expect(inst.storage.alarm! - clock).toBeLessThanOrEqual(SWEEP_RESUME_MS);
      expect(inst.storage.m.size).toBeGreaterThan(1);
      for (let n = 0; n < 10 && inst.storage.m.size > 0; n++)
        await inst.obj.alarm();
    } finally {
      Date.now = realNow;
    }
    expect(inst.storage.m.size).toBe(0);
  });
});
