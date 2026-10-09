/**
 * The shared capped body reader, the limit clamps, the sweep cursors and the IN-list
 * helper, plus the
 * recurrence lint: no bare `req.text()` / `.json()` / `.arrayBuffer()` in route code.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BodyTooLargeError,
  readBodyBytes,
  readBodyText,
} from "../src/core/cappedBody.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import {
  readDeviceBody,
  deviceMetadata,
  touchDeviceMetadata,
} from "../src/core/devices.js";
import { listAudit, type DeviceRow } from "../src/repo.js";
import { handleActivity } from "../src/admin/handlers/activity.js";
import { RateLimitDO } from "../src/rateLimitDo.js";
import { SingleUseDO } from "../src/singleUseDo.js";
import { jsonList, jsonListArg } from "../src/core/sqlIn.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { StorageMock } from "./updateHealthMock.js";

const CHUNK = 64 * 1024;

/** A chunked body of `total` bytes that records how many bytes the consumer pulled. */
function chunkedRequest(total: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (state.pulled >= total) return ctrl.close();
      ctrl.enqueue(new Uint8Array(CHUNK).fill(0x61));
      state.pulled += CHUNK;
    },
  });
  const req = new Request("https://key.plrs.im/x", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { req, state };
}

describe("readBodyBytes / readBodyText", () => {
  it("rejects a chunked body at the cap without pulling the rest", async () => {
    const { req, state } = chunkedRequest(64 * 1024 * 1024);
    await expect(readBodyBytes(req, 100 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(state.pulled).toBeLessThanOrEqual(100 * 1024 + 4 * CHUNK);
  });

  it("rejects a declared oversize length up front and reads a body within the cap", async () => {
    const big = new Request("https://key.plrs.im/x", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: "x",
    });
    await expect(readBodyText(big, 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    const ok = new Request("https://key.plrs.im/x", {
      method: "POST",
      body: "héllo",
    });
    expect(await readBodyText(ok, 64)).toBe("héllo");
    expect(await readBodyText(new Request("https://key.plrs.im/x"), 64)).toBe(
      "",
    );
  });
});

describe("chunked bodies are cut at the cap", () => {
  it("the GitHub webhook answers 413 before HMAC, pulling a bounded amount", async () => {
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_WEBHOOK_SECRET = "s";
    const { req, state } = chunkedRequest(64 * 1024 * 1024, {
      "x-hub-signature-256": "sha256=00",
    });
    const res = await handleGithubWebhook(req, env, makeTestDb(), NOW);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThan(6 * 1024 * 1024 + 4 * CHUNK);
  });

  it("the device/enroll/register body reader treats an oversize chunked body as absent", async () => {
    const { req, state } = chunkedRequest(64 * 1024 * 1024);
    expect(await readDeviceBody(req)).toEqual({
      fingerprint: null,
      label: null,
    });
    expect(state.pulled).toBeLessThan(4 * 1024 + 4 * CHUNK);
  });
});

describe("activity limit is an integer in 1..200", () => {
  it("listAudit never runs unbounded or with a fractional limit", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    for (let i = 0; i < 300; i++)
      await db.run(
        `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
           target_kind, target_id, parent_id, summary)
         VALUES ('acme', ?, ?, 'u', 'U', NULL, 'a', 'product', 'acme', NULL, 's')`,
        `aud_${String(i).padStart(4, "0")}`,
        i,
      );
    expect((await listAudit(db, "acme", { limit: -1 })).length).toBe(1);
    expect((await listAudit(db, "acme", { limit: 0.5 })).length).toBe(1);
    expect((await listAudit(db, "acme", { limit: 1e9 })).length).toBe(200);
    expect((await listAudit(db, "acme", { limit: NaN })).length).toBe(50);
    for (const q of ["-1", "2.5", "abc", "1e9"]) {
      const res = await handleActivity(
        new Request(`https://x/activity?limit=${q}`),
        db,
        "acme",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("device metadata is capped and unchanged touches are skipped", () => {
  it("caps client-supplied header text", () => {
    const m = deviceMetadata(
      new Request("https://x/", {
        headers: { "user-agent": "u".repeat(5000) },
      }),
    );
    expect(m.userAgent?.length).toBe(128);
  });

  it("does not rewrite a row whose metadata is unchanged and fresh", async () => {
    const run = vi.fn(async () => undefined);
    const db = { run, first: async () => null, all: async () => [] } as never;
    const device = {
      product: "p",
      device_id: "d",
      last_seen: NOW,
      ua: "ua",
      platform: null,
      arch: null,
      app_version: null,
      sdk_name: null,
      sdk_version: null,
    } as unknown as DeviceRow;
    const meta = {
      userAgent: "ua",
      platform: null,
      arch: null,
      appVersion: null,
      sdkName: null,
      sdkVersion: null,
    };
    await touchDeviceMetadata(db, device, meta, NOW + 10);
    expect(run).not.toHaveBeenCalled();
    await touchDeviceMetadata(db, device, meta, NOW + 3600);
    expect(run).toHaveBeenCalled();
  });
});

describe("the alarm sweeps walk the whole key space", () => {
  it("RateLimitDO reaches stale counters behind a full batch of live ones", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const storage = new StorageMock();
    const obj = new RateLimitDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const live = { window: 1, count: 1, expiresAt: NOW + 1_000_000 };
    for (let i = 0; i < 2000; i++)
      storage.m.set(`a:${String(i).padStart(5, "0")}`, live);
    storage.m.set("z:stale", { window: 1, count: 1, expiresAt: 1 });
    await obj.alarm();
    await obj.alarm();
    expect(storage.m.has("z:stale")).toBe(false);
    expect(storage.m.size).toBe(2000);
    vi.useRealTimers();
  });

  it("SingleUseDO reaches expired records behind a full batch of live ones", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const storage = new StorageMock();
    const obj = new SingleUseDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    for (let i = 0; i < 2000; i++)
      storage.m.set(`a${String(i).padStart(5, "0")}`, {
        v: "x",
        exp: NOW * 1000 + 1e9,
        n: 0,
      });
    storage.m.set("zz", { v: "x", exp: 1, n: 0 });
    await obj.alarm();
    await obj.alarm();
    expect(storage.m.has("zz")).toBe(false);
    vi.useRealTimers();
  });
});

describe("IN lists bind one parameter", () => {
  it("matches more than 100 values", async () => {
    const db = makeTestDb();
    const vals = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const rows = await db.all<{ value: string }>(
      `SELECT value FROM json_each(?) WHERE value IN ${jsonList()}`,
      jsonListArg(vals),
      jsonListArg(vals.slice(0, 150)),
    );
    expect(rows.length).toBe(150);
  });
});

describe("recurrence lint: no bare body reads in route code", () => {
  const SRC = join(__dirname, "..", "src");
  // Worker-to-Durable-Object calls: the caller is this Worker, never a client.
  const INTERNAL = new Set([
    "core/cappedBody.ts",
    "rateLimitDo.ts",
    "singleUseDo.ts",
    "updateHealthDo.ts",
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  it("uses readBodyText / readBodyJson / readBodyBytes", () => {
    const bare =
      /\b(?:req|request)\.(?:text|json|arrayBuffer|formData|blob)\(|\.req\.(?:text|json|arrayBuffer|formData|blob)\(|\.raw\.(?:text|json|arrayBuffer)\(/;
    const offenders = walk(SRC)
      .filter((f) => !INTERNAL.has(f.slice(SRC.length + 1)))
      .filter((f) => bare.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
