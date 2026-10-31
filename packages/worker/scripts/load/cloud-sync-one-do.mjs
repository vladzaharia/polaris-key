#!/usr/bin/env node
/**
 * One-object load test for Cloud Sync (U-05.18; plans/U-05-slices.md L15).
 *
 *   PKEY_LOAD_DEVICES='[{"deviceId":"…","token":"…"}, …]' \
 *   CF_ACCOUNT_ID=… CF_ANALYTICS_TOKEN=… \
 *   node packages/worker/scripts/load/cloud-sync-one-do.mjs \
 *     --base-url https://key.plrs.im --product <slug> [--devices 3] [--duration-s 60] \
 *     [--pushes-per-min 60] [--batch 100] [--pull-every-s 10] [--key-prefix load.key] [--dry-run]
 *
 * Every device is a paired device of ONE signed-in subject, so every request lands on the same
 * Durable Object. Each device pushes `--pushes-per-min` times a minute in `--batch`-mutation
 * batches and pulls every `--pull-every-s` seconds. The tokens come from the environment, never
 * argv, and are never printed.
 *
 * The summary reads the `Server-Timing` meter the Worker puts on each push and pull answer
 * (`src/services/sync/handlers/meter.ts`): rows read and written per operation, plus the
 * client-side p50 and p95 latency and the 429 count. Billable duration comes from the Cloudflare
 * GraphQL Analytics API (`durableObjectsPeriodicGroups.activeTime`) when `CF_ACCOUNT_ID` and
 * `CF_ANALYTICS_TOKEN` are set; Analytics lags, so the query waits `--analytics-delay-s`.
 *
 * Worst-case scenarios (OS-9; off unless `--scenario` is given; each needs `--collection`, a
 * collection of the product's catalog with the matching policy, and runs on device 1 alone):
 *
 *   --scenario merge-record   100 setField mutations against one `merge` record filled to
 *                             `--cells` live (default 1450) and `--removed` removed (256) cells
 *   --scenario union-record   100 add mutations against one `union` record of `--elements`
 *                             (default 500) elements with `--tags` (8) tags each
 *   --scenario merge-parked   one account merge into a survivor that holds `--parked` (64) parked
 *                             copies. The merge itself is a portal step (/api/me/link): the script
 *                             seeds both accounts, waits for you at two prompts, and reports the
 *                             Analytics window around the second join. Device 1 of PKEY_LOAD_DEVICES
 *                             is the survivor; PKEY_LOAD_ABSORBED_DEVICES holds the two accounts
 *                             that are joined into it (the collection is a `revision` one).
 *
 * The record scenarios fill the record, wait `--quiet-s` (90) so the fill leaves the Analytics
 * window, then send `--repeats` (5) measured pushes and report per push: wall time, rows read (the
 * Server-Timing meter), and DO CPU time and rows read from GraphQL Analytics (the window's total
 * divided by the pushes; CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN, as for the steady run). Analytics
 * is account-wide, so run on a quiet account. A record whose entries exceed its 64 KiB budget stops
 * filling at the budget; the report says how many cells or elements it reached.
 *
 *   node packages/worker/scripts/load/cloud-sync-one-do.mjs --base-url … --product <slug> \
 *     --scenario merge-record --collection <merge-collection> [--cells 1450] [--removed 256]
 *   … --scenario union-record --collection <union-collection> [--elements 500] [--tags 8]
 *   … --scenario merge-parked --collection <revision-collection> [--parked 64]
 *
 * `--dry-run` prints the plan and makes no network call. Running this against production is an
 * owner step (docs: Operate → Platform → runbook → Load-test Cloud Sync).
 */

import { pathToFileURL } from "node:url";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** A Durable Object bills duration at 128 MB. */
const DO_GB = 128 / 1024;

const DEFAULTS = {
  baseUrl: "",
  product: "",
  devices: 3,
  durationS: 60,
  pushesPerMin: 60,
  batch: 100,
  pullEveryS: 10,
  keyPrefix: "load.key",
  analyticsDelayS: 120,
  dryRun: false,
  scenario: "steady",
  collection: "",
  cells: 1450,
  removed: 256,
  elements: 500,
  tags: 8,
  repeats: 5,
  quietS: 90,
  parked: 64,
};

export const SCENARIOS = [
  "steady",
  "merge-record",
  "union-record",
  "merge-parked",
];

const FLAGS = {
  "--base-url": ["baseUrl", String],
  "--product": ["product", String],
  "--devices": ["devices", Number],
  "--duration-s": ["durationS", Number],
  "--pushes-per-min": ["pushesPerMin", Number],
  "--batch": ["batch", Number],
  "--pull-every-s": ["pullEveryS", Number],
  "--key-prefix": ["keyPrefix", String],
  "--analytics-delay-s": ["analyticsDelayS", Number],
  "--scenario": ["scenario", String],
  "--collection": ["collection", String],
  "--cells": ["cells", Number],
  "--removed": ["removed", Number],
  "--elements": ["elements", Number],
  "--tags": ["tags", Number],
  "--repeats": ["repeats", Number],
  "--quiet-s": ["quietS", Number],
  "--parked": ["parked", Number],
};

/** Parses argv into options. Throws on an unknown flag or a bad value. */
export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    const spec = FLAGS[a];
    if (!spec) throw new Error(`unknown option ${a}`);
    const raw = argv[++i];
    if (raw === undefined) throw new Error(`${a} needs a value`);
    const v = spec[1](raw);
    if (spec[1] === Number && (!Number.isFinite(v) || v <= 0))
      throw new Error(`${a} must be a positive number`);
    opts[spec[0]] = v;
  }
  if (!opts.baseUrl) throw new Error("--base-url is required");
  if (!/^https?:\/\//.test(opts.baseUrl))
    throw new Error("--base-url must start with http:// or https://");
  if (!/^[a-z0-9-]+$/.test(opts.product))
    throw new Error("--product is required (a product slug)");
  if (opts.batch > 100)
    throw new Error("--batch is at most 100 (the wire cap)");
  if (!SCENARIOS.includes(opts.scenario))
    throw new Error(`--scenario is one of ${SCENARIOS.join(", ")}`);
  if (
    opts.scenario !== "steady" &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(opts.collection)
  )
    throw new Error(
      "--collection is required for a scenario (a collection name)",
    );
  if (opts.tags > 64) throw new Error("--tags is at most 64");
  return opts;
}

/** The devices from `PKEY_LOAD_DEVICES`, first `n` of them. Never echoes a token. */
export function readDevices(env, n) {
  const raw = env.PKEY_LOAD_DEVICES;
  if (!raw) throw new Error("PKEY_LOAD_DEVICES is not set");
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("PKEY_LOAD_DEVICES is not valid JSON");
  }
  if (
    !Array.isArray(list) ||
    list.some(
      (d) =>
        !d || typeof d.deviceId !== "string" || typeof d.token !== "string",
    )
  )
    throw new Error(
      'PKEY_LOAD_DEVICES must be [{"deviceId": "…", "token": "…"}, …]',
    );
  if (list.length < n)
    throw new Error(
      `--devices ${n} but PKEY_LOAD_DEVICES holds ${list.length}`,
    );
  return list.slice(0, n);
}

/** What a run will do, as plain numbers. */
export function plan(opts) {
  const pushIntervalMs = 60_000 / opts.pushesPerMin;
  const pushesPerDevice = Math.floor((opts.durationS * 1000) / pushIntervalMs);
  const pullsPerDevice = Math.floor(opts.durationS / opts.pullEveryS);
  return {
    devices: opts.devices,
    durationS: opts.durationS,
    pushIntervalMs,
    pushesPerDevice,
    pullsPerDevice,
    totalPushes: pushesPerDevice * opts.devices,
    totalPulls: pullsPerDevice * opts.devices,
    totalMutations: pushesPerDevice * opts.devices * opts.batch,
    batch: opts.batch,
  };
}

/** `sync;desc="push";dur=12.4, mut;desc="100", rr;desc="340", rw;desc="212"` → numbers, or null. */
export function parseServerTiming(h) {
  if (typeof h !== "string") return null;
  const m =
    /^sync;desc="(push|pull)";dur=([0-9.]+), mut;desc="(\d+)", rr;desc="(\d+)", rw;desc="(\d+)"$/.exec(
      h,
    );
  if (!m) return null;
  return {
    op: m[1],
    durMs: Number(m[2]),
    mutations: Number(m[3]),
    rowsRead: Number(m[4]),
    rowsWritten: Number(m[5]),
  };
}

/** Nearest-rank percentile of an unsorted list; `null` for an empty one. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

/** Folds the per-request samples into the report. A sample is `{op, status, ms, meter|null}`. */
export function summarise(samples) {
  const out = {
    ops: {},
    rateLimited: 0,
    failures: 0,
    requests: samples.length,
  };
  for (const s of samples) {
    if (s.status === 429) out.rateLimited++;
    else if (s.status === 0 || s.status >= 500) out.failures++;
    const o = (out.ops[s.op] ??= {
      requests: 0,
      ok: 0,
      ms: [],
      metered: 0,
      rowsRead: 0,
      rowsWritten: 0,
      mutations: 0,
    });
    o.requests++;
    if (s.status >= 200 && s.status < 300) o.ok++;
    o.ms.push(s.ms);
    if (s.meter) {
      o.metered++;
      o.rowsRead += s.meter.rowsRead;
      o.rowsWritten += s.meter.rowsWritten;
      o.mutations += s.meter.mutations;
    }
  }
  for (const o of Object.values(out.ops)) {
    o.p50Ms = percentile(o.ms, 50);
    o.p95Ms = percentile(o.ms, 95);
    o.meanRowsRead = o.metered ? o.rowsRead / o.metered : null;
    o.meanRowsWritten = o.metered ? o.rowsWritten / o.metered : null;
    delete o.ms;
  }
  return out;
}

const QUERY = `query ($account: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to }) {
      sum { activeTime }
    }
  } }
}`;

/** Billable duration for the window from GraphQL Analytics. Never throws; never prints the token. */
export async function billableDuration(env, fromIso, toIso, fetchFn) {
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_ANALYTICS_TOKEN;
  if (!account || !token)
    return { skipped: "CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set" };
  try {
    const res = await fetchFn(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { account, from: fromIso, to: toIso },
      }),
    });
    if (!res.ok) return { error: `GraphQL answered ${res.status}` };
    const body = await res.json();
    if (body.errors?.length)
      return {
        error: `GraphQL: ${String(body.errors[0]?.message ?? "error")}`,
      };
    const groups =
      body.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups;
    if (!Array.isArray(groups))
      return { error: "GraphQL: no groups in the answer" };
    const activeUs = groups.reduce((n, g) => n + (g.sum?.activeTime ?? 0), 0);
    return {
      activeTimeMs: activeUs / 1000,
      gbSeconds: (activeUs / 1e6) * DO_GB,
    };
  } catch (e) {
    return {
      error: `GraphQL request failed: ${e instanceof Error ? e.name : "error"}`,
    };
  }
}

const HLC = (ms) => `${ms.toString(16).padStart(12, "0")}:0000`;
const clientIdFor = (i) => `c_${String(i).padStart(22, "L")}`;

/** One device's loop: pushes on a fixed interval, pulls on another, until `endAt`. */
async function runDevice({
  opts,
  device,
  index,
  fetchFn,
  now,
  sleep,
  samples,
  endAt,
}) {
  const base = `${opts.baseUrl.replace(/\/$/, "")}/${opts.product}/sync`;
  const headers = {
    authorization: `Bearer ${device.token}`,
    "x-pkey-device": device.deviceId,
  };
  const clientId = clientIdFor(index);
  let cursor = 0;
  let mutationId = 1;
  let nextPull = now() + opts.pullEveryS * 1000;
  const interval = 60_000 / opts.pushesPerMin;
  let nextPush = now();
  const timed = async (op, url, init) => {
    const t0 = now();
    let status = 0;
    let meter = null;
    let body = null;
    try {
      const res = await fetchFn(url, {
        ...init,
        headers: { ...headers, ...init.headers },
      });
      status = res.status;
      meter = parseServerTiming(res.headers.get("server-timing"));
      if (status === 200) body = await res.json().catch(() => null);
    } catch {
      status = 0;
    }
    samples.push({ op, status, ms: now() - t0, meter });
    return body;
  };
  while (now() < endAt) {
    if (now() >= nextPull) {
      const q = `?cursor=${cursor}&clientId=${clientId}`;
      const b = await timed("pull", `${base}${q}`, {
        method: "GET",
        headers: {},
      });
      if (b && Number.isSafeInteger(b.cursor)) cursor = b.cursor;
      nextPull += opts.pullEveryS * 1000;
    } else if (now() >= nextPush) {
      const mutations = [];
      for (let k = 0; k < opts.batch; k++) {
        mutations.push({
          mutationId: mutationId++,
          target: { setting: `${opts.keyPrefix}.${k % 50}`, scope: "user" },
          op: "set",
          value: mutationId,
          editedHlc: HLC(now()),
        });
      }
      const b = await timed("push", `${base}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, cursor, mutations }),
      });
      if (b && Number.isSafeInteger(b.cursor)) cursor = b.cursor;
      nextPush += interval;
    } else {
      await sleep(Math.max(1, Math.min(nextPush, nextPull) - now()));
    }
  }
}

const USAGE_QUERY = `query ($account: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to }) {
      sum { activeTime cpuTime rowsRead rowsWritten }
    }
  } }
}`;

/**
 * DO CPU time and rows for a window from GraphQL Analytics (`cpuTime` is in microseconds). Never
 * throws and never prints the token. A schema without these fields answers `error`; the caller
 * then still has the Server-Timing meter.
 */
export async function windowUsage(env, fromIso, toIso, fetchFn) {
  const account = env.CF_ACCOUNT_ID;
  const token = env.CF_ANALYTICS_TOKEN;
  if (!account || !token)
    return { skipped: "CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set" };
  try {
    const res = await fetchFn(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: { account, from: fromIso, to: toIso },
      }),
    });
    if (!res.ok) return { error: `GraphQL answered ${res.status}` };
    const body = await res.json();
    if (body.errors?.length)
      return {
        error: `GraphQL: ${String(body.errors[0]?.message ?? "error")}`,
      };
    const groups =
      body.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups;
    if (!Array.isArray(groups))
      return { error: "GraphQL: no groups in the answer" };
    const total = (k) => groups.reduce((n, g) => n + (g.sum?.[k] ?? 0), 0);
    return {
      activeTimeMs: total("activeTime") / 1000,
      cpuTimeMs: total("cpuTime") / 1000,
      rowsRead: total("rowsRead"),
      rowsWritten: total("rowsWritten"),
    };
  } catch (e) {
    return {
      error: `GraphQL request failed: ${e instanceof Error ? e.name : "error"}`,
    };
  }
}

/** A fresh client id (`c_` and 22 characters), so a rerun never collides on mutationId. */
const randomClientId = (rand = Math.random) => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c_";
  for (let i = 0; i < 22; i++) id += abc[Math.floor(rand() * abc.length)];
  return id;
};

/** What a scenario will do, as plain numbers (the dry run prints it). */
export function scenarioPlan(opts) {
  if (opts.scenario === "merge-record") {
    const fillPushes = Math.ceil((opts.cells + 2 * opts.removed) / 100);
    return {
      fillPushes,
      measuredPushes: opts.repeats,
      lines: [
        `fill: one merge record in ${opts.collection} to ${opts.cells} live and ${opts.removed} removed cells (${fillPushes} pushes of up to 100 setField/removeField)`,
        `measure: ${opts.repeats} pushes of 100 setField mutations over live cells, after ${opts.quietS} s of quiet`,
      ],
    };
  }
  if (opts.scenario === "union-record") {
    const fillPushes = Math.ceil((opts.elements * opts.tags) / 100);
    return {
      fillPushes,
      measuredPushes: opts.repeats,
      lines: [
        `fill: one union record in ${opts.collection} with ${opts.elements} elements of ${opts.tags} tags each (${fillPushes} pushes of up to 100 add)`,
        `measure: ${opts.repeats} pushes of 100 add mutations over existing elements (tags grow by one a push), after ${opts.quietS} s of quiet`,
      ],
    };
  }
  return {
    fillPushes: Math.ceil(opts.parked / 100) * 3,
    measuredPushes: 0,
    lines: [
      `seed: ${opts.parked} revision records in ${opts.collection} on the survivor and on each of two absorbed accounts, with the same ids`,
      "prompt 1: join the first absorbed account into the survivor in the portal (primes the survivor's parked copies)",
      "prompt 2: join the second absorbed account (measured); the report covers the Analytics window around it",
    ],
  };
}

/** A pusher for one device: serial pushes of one record scenario, 429-aware, token never printed. */
function makePusher({ opts, device, fetchFn, now, sleep, clientId }) {
  const base = `${opts.baseUrl.replace(/\/$/, "")}/${opts.product}/sync`;
  let cursor = 0;
  let mutationId = 1;
  return async function push(mutations, { measured = false } = {}) {
    const stamped = mutations.map((m) => ({ ...m, mutationId: mutationId++ }));
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = now();
      const res = await fetchFn(`${base}/ops`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${device.token}`,
          "x-pkey-device": device.deviceId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientId, cursor, mutations: stamped }),
      });
      const wallMs = now() - t0;
      if (res.status === 429) {
        const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status !== 200) throw new Error(`push answered ${res.status}`);
      const body = await res.json();
      if (Number.isSafeInteger(body.cursor)) cursor = body.cursor;
      const results = Array.isArray(body.results) ? body.results : [];
      const rejected = results.filter((r) => r.status === "rejected");
      return {
        wallMs,
        meter: parseServerTiming(res.headers.get("server-timing")),
        results,
        rejectedCode: rejected[0]?.code ?? null,
        measured,
      };
    }
    throw new Error("push kept answering 429");
  };
}

const HLC_BASE = (now) => now();

/** Fills a record and returns how far it got; stops cleanly at the record budget. */
async function fillMerge(push, opts, record, now) {
  let hlc = HLC_BASE(now) - 3_600_000;
  const cell = (i) => `f${i.toString(36)}`;
  let live = 0;
  let removed = 0;
  let stopped = null;
  const send = async (muts) => {
    const r = await push(muts);
    const bad = r.results.findIndex((x) => x.status === "rejected");
    return { r, ok: bad === -1 ? muts.length : bad, bad: r.rejectedCode };
  };
  while (live < opts.cells && !stopped) {
    const muts = [];
    for (let k = 0; k < 100 && live + muts.length < opts.cells; k++)
      muts.push({
        target: { record },
        op: "setField",
        field: cell(live + muts.length),
        value: 0,
        editedHlc: formatHlcMs(hlc++),
      });
    const { ok, bad } = await send(muts);
    live += ok;
    if (bad) stopped = bad;
  }
  // Removed cells: set then remove, so each is a tombstone the record keeps (at most 256).
  for (let i = 0; i < opts.removed && !stopped; i += 50) {
    const muts = [];
    for (let k = i; k < Math.min(i + 50, opts.removed); k++) {
      const field = `x${k.toString(36)}`;
      muts.push({
        target: { record },
        op: "setField",
        field,
        value: 0,
        editedHlc: formatHlcMs(hlc++),
      });
      muts.push({
        target: { record },
        op: "removeField",
        field,
        editedHlc: formatHlcMs(hlc++),
      });
    }
    const { ok, bad } = await send(muts);
    removed += Math.floor(ok / 2);
    if (bad) stopped = bad;
  }
  return { live, removed, stopped, hlc };
}

/** `HLC` as the wire writes it: 12 hex digits of ms, `:`, a 4-digit counter. */
function formatHlcMs(ms) {
  return `${Math.floor(ms).toString(16).padStart(12, "0")}:0000`;
}

async function fillUnion(push, opts, record) {
  const el = (i) => `e${i.toString(36)}`;
  let added = 0;
  let stopped = null;
  const pending = [];
  for (let t = 0; t < opts.tags; t++)
    for (let i = 0; i < opts.elements; i++) pending.push(el(i));
  for (let i = 0; i < pending.length && !stopped; i += 100) {
    const muts = pending.slice(i, i + 100).map((element) => ({
      target: { record },
      op: "add",
      element,
    }));
    const r = await push(muts);
    const bad = r.results.findIndex((x) => x.status === "rejected");
    added += bad === -1 ? muts.length : bad;
    if (bad !== -1) stopped = r.rejectedCode;
  }
  return { adds: added, expected: pending.length, stopped };
}

const cpuPerPush = (u, n) =>
  u && u.cpuTimeMs !== undefined && n > 0 ? u.cpuTimeMs / n : null;

/** The record scenarios (merge-record, union-record). Returns the per-push report. */
async function runRecordScenario(opts, env, io) {
  const { out, fetchFn, now, sleep } = io;
  const device = readDevices(env, 1)[0];
  const push = makePusher({
    opts,
    device,
    fetchFn,
    now,
    sleep,
    clientId: randomClientId(io.rand),
  });
  const record = [opts.collection, `load${now().toString(36)}`];
  const isMerge = opts.scenario === "merge-record";
  out(`filling ${record[0]}/${record[1]} (${opts.scenario})`);
  const fill = isMerge
    ? await fillMerge(push, opts, record, now)
    : await fillUnion(push, opts, record);
  out(
    isMerge
      ? `filled: ${fill.live} live and ${fill.removed} removed cells${fill.stopped ? ` (stopped: ${fill.stopped})` : ""}`
      : `filled: ${fill.adds} of ${fill.expected} adds${fill.stopped ? ` (stopped: ${fill.stopped})` : ""}`,
  );
  const live = isMerge ? fill.live : opts.elements;
  out(`waiting ${opts.quietS} s so the fill leaves the Analytics window`);
  await sleep(opts.quietS * 1000);
  const startedAt = now();
  let hlc = isMerge ? fill.hlc + 1_000_000 : 0;
  const measured = [];
  for (let n = 0; n < opts.repeats; n++) {
    const muts = [];
    for (let k = 0; k < 100; k++) {
      if (isMerge)
        muts.push({
          target: { record },
          op: "setField",
          field: `f${(k % Math.max(1, live)).toString(36)}`,
          value: n + 1,
          editedHlc: formatHlcMs(hlc++),
        });
      else
        muts.push({
          target: { record },
          op: "add",
          element: `e${(k % opts.elements).toString(36)}`,
        });
    }
    const r = await push(muts, { measured: true });
    measured.push({
      wallMs: r.wallMs,
      rowsRead: r.meter?.rowsRead ?? null,
      rowsWritten: r.meter?.rowsWritten ?? null,
      rejected: r.rejectedCode,
    });
    out(
      `push ${n + 1}/${opts.repeats}: ${fmt(r.wallMs)} ms wall, rows read ${r.meter?.rowsRead ?? "n/a"}, rows written ${r.meter?.rowsWritten ?? "n/a"}${r.rejectedCode ? `, rejected ${r.rejectedCode}` : ""}`,
    );
  }
  const endedAt = now();
  let usage = { skipped: "CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set" };
  if (env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN) {
    out(`waiting ${opts.analyticsDelayS} s for Analytics`);
    await sleep(opts.analyticsDelayS * 1000);
    usage = await windowUsage(
      env,
      new Date(startedAt).toISOString(),
      new Date(endedAt + 60_000).toISOString(),
      fetchFn,
    );
  }
  const lines = renderScenarioReport(opts, fill, measured, usage);
  for (const l of lines) out(l);
  return { fill, measured, usage };
}

export function renderScenarioReport(opts, fill, measured, usage) {
  const n = measured.length;
  const lines = [
    `scenario ${opts.scenario}: ${n} measured pushes of 100 mutations`,
  ];
  const wall = measured.map((m) => m.wallMs);
  const rr = measured.map((m) => m.rowsRead).filter((v) => v !== null);
  lines.push(
    `wall time: p50 ${fmt(percentile(wall, 50))} ms, max ${fmt(Math.max(...wall))} ms`,
    `rows read per push (Server-Timing): ${rr.length ? `min ${Math.min(...rr)}, max ${Math.max(...rr)}` : "n/a"}`,
  );
  if (usage.skipped)
    lines.push(`DO CPU and rows (Analytics): skipped (${usage.skipped})`);
  else if (usage.error)
    lines.push(`DO CPU and rows (Analytics): unavailable (${usage.error})`);
  else
    lines.push(
      `DO CPU per push (Analytics window / ${n}): ${fmt(cpuPerPush(usage, n))} ms; rows read per push: ${fmt(usage.rowsRead / n)}; ` +
        `active ${fmt(usage.activeTimeMs)} ms in the window (account-wide; run on a quiet account)`,
    );
  if (fill.stopped) lines.push(`note: the fill stopped at ${fill.stopped}`);
  return lines;
}

/** merge-parked: seeds, prompts, and reports the window around the measured join. */
async function runParkedScenario(opts, env, io) {
  const { out, fetchFn, now, sleep } = io;
  const prompt = io.prompt ?? defaultPrompt;
  const survivor = readDevices(env, 1)[0];
  const absorbed = readAbsorbed(env);
  const ids = Array.from({ length: opts.parked }, (_, i) => `load-park-${i}`);
  const seed = async (device, value) => {
    const push = makePusher({
      opts,
      device,
      fetchFn,
      now,
      sleep,
      clientId: randomClientId(io.rand),
    });
    for (let i = 0; i < ids.length; i += 100) {
      const r = await push(
        ids.slice(i, i + 100).map((id) => ({
          target: { record: [opts.collection, id] },
          op: "set",
          value,
        })),
      );
      if (r.rejectedCode) throw new Error(`seed rejected: ${r.rejectedCode}`);
    }
  };
  out("seeding the survivor and the first absorbed account");
  await seed(survivor, { side: "survivor" });
  await seed(absorbed[0], { side: "absorbed-1" });
  await prompt(
    "Join the FIRST absorbed account into the survivor in the portal (priming merge). Press Enter when it is done.",
  );
  out("seeding the second absorbed account");
  await seed(absorbed[1], { side: "absorbed-2" });
  await prompt(
    "Next is the measured merge. Press Enter to start the window, then join the SECOND absorbed account into the survivor.",
  );
  const startedAt = now();
  await prompt("Press Enter as soon as the join is confirmed.");
  const endedAt = now();
  let usage = { skipped: "CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set" };
  if (env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN) {
    out(`waiting ${opts.analyticsDelayS} s for Analytics`);
    await sleep(opts.analyticsDelayS * 1000);
    usage = await windowUsage(
      env,
      new Date(startedAt).toISOString(),
      new Date(endedAt + 60_000).toISOString(),
      fetchFn,
    );
  }
  const lines = [
    `scenario merge-parked: window ${((endedAt - startedAt) / 1000).toFixed(0)} s, survivor held ${opts.parked} parked copies`,
  ];
  if (usage.skipped)
    lines.push(`DO CPU and rows (Analytics): skipped (${usage.skipped})`);
  else if (usage.error)
    lines.push(`DO CPU and rows (Analytics): unavailable (${usage.error})`);
  else
    lines.push(
      `window total: DO CPU ${fmt(usage.cpuTimeMs)} ms, rows read ${usage.rowsRead}, rows written ${usage.rowsWritten}, active ${fmt(usage.activeTimeMs)} ms (account-wide; the join is the only sync work in the window on a quiet account)`,
    );
  for (const l of lines) out(l);
  return { usage };
}

/** The absorbed accounts' devices from `PKEY_LOAD_ABSORBED_DEVICES` (two of them). */
export function readAbsorbed(env) {
  const raw = env.PKEY_LOAD_ABSORBED_DEVICES;
  if (!raw) throw new Error("PKEY_LOAD_ABSORBED_DEVICES is not set");
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error("PKEY_LOAD_ABSORBED_DEVICES is not valid JSON");
  }
  if (
    !Array.isArray(list) ||
    list.length < 2 ||
    list.some(
      (d) =>
        !d || typeof d.deviceId !== "string" || typeof d.token !== "string",
    )
  )
    throw new Error(
      'PKEY_LOAD_ABSORBED_DEVICES must hold two devices: [{"deviceId": "…", "token": "…"}, …]',
    );
  return list.slice(0, 2);
}

async function defaultPrompt(message) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`${message}\n`);
  rl.close();
}

const fmt = (n) =>
  n === null || n === undefined ? "n/a" : Number(n).toFixed(1);

/** The report as text lines. */
export function renderReport(p, summary, billable) {
  const lines = [
    `requests: ${summary.requests}  429s: ${summary.rateLimited}  failures: ${summary.failures}`,
  ];
  for (const [op, o] of Object.entries(summary.ops))
    lines.push(
      `${op}: ${o.requests} requests (${o.ok} ok), p50 ${fmt(o.p50Ms)} ms, p95 ${fmt(o.p95Ms)} ms, ` +
        `rows read ${o.rowsRead} (mean ${fmt(o.meanRowsRead)}), rows written ${o.rowsWritten} ` +
        `(mean ${fmt(o.meanRowsWritten)}), metered ${o.metered}/${o.requests}`,
    );
  if (billable.skipped)
    lines.push(`billable duration: skipped (${billable.skipped})`);
  else if (billable.error)
    lines.push(`billable duration: unavailable (${billable.error})`);
  else
    lines.push(
      `billable duration: ${fmt(billable.activeTimeMs)} ms active, ${billable.gbSeconds.toFixed(4)} GB-s ` +
        `(account-wide Durable Object activity in the window; run on a quiet account)`,
    );
  lines.push(`planned ${p.totalPushes} pushes and ${p.totalPulls} pulls`);
  return lines;
}

export function renderPlan(opts, p) {
  return [
    "Cloud Sync one-object load test (dry run: no network call)",
    `target: ${opts.baseUrl.replace(/\/$/, "")}/${opts.product}/sync (one subject, one Durable Object)`,
    `devices: ${p.devices}, duration: ${p.durationS} s`,
    `each device: ${opts.pushesPerMin} pushes a minute (one every ${p.pushIntervalMs} ms) of ${p.batch} mutations, a pull every ${opts.pullEveryS} s`,
    `total: ${p.totalPushes} pushes, ${p.totalPulls} pulls, ${p.totalMutations} mutations`,
    `keys: ${opts.keyPrefix}.0 to ${opts.keyPrefix}.49 (the product's catalog must accept them)`,
    "tokens: read from PKEY_LOAD_DEVICES, never printed",
    `billable duration: ${opts.analyticsDelayS} s after the run, via GraphQL Analytics when CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are set`,
  ];
}

/** The entry point; every effect is injectable so a test runs it with none. */
export async function main(argv, env, io = {}) {
  const out = io.out ?? ((l) => process.stdout.write(`${l}\n`));
  const fetchFn = io.fetch ?? globalThis.fetch;
  const now = io.now ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const opts = parseArgs(argv);
  const p = plan(opts);
  if (opts.dryRun) {
    if (opts.scenario !== "steady") {
      const sp = scenarioPlan(opts);
      out("Cloud Sync worst-case scenario (dry run: no network call)");
      out(
        `target: ${opts.baseUrl.replace(/\/$/, "")}/${opts.product}/sync, scenario ${opts.scenario}`,
      );
      for (const l of sp.lines) out(l);
      out("tokens: read from the environment, never printed");
      return { dryRun: true, plan: sp };
    }
    for (const l of renderPlan(opts, p)) out(l);
    return { dryRun: true, plan: p };
  }
  if (opts.scenario !== "steady") {
    const scenarioIo = {
      out,
      fetchFn,
      now,
      sleep,
      rand: io.rand,
      prompt: io.prompt,
    };
    return opts.scenario === "merge-parked"
      ? { dryRun: false, ...(await runParkedScenario(opts, env, scenarioIo)) }
      : { dryRun: false, ...(await runRecordScenario(opts, env, scenarioIo)) };
  }
  const devices = readDevices(env, opts.devices);
  const samples = [];
  const startedAt = now();
  const endAt = startedAt + opts.durationS * 1000;
  out(
    `running ${p.devices} devices for ${p.durationS} s against ${opts.product}`,
  );
  await Promise.all(
    devices.map((device, index) =>
      runDevice({ opts, device, index, fetchFn, now, sleep, samples, endAt }),
    ),
  );
  const summary = summarise(samples);
  let billable = { skipped: "CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set" };
  if (env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN) {
    out(`waiting ${opts.analyticsDelayS} s for Analytics`);
    await sleep(opts.analyticsDelayS * 1000);
    billable = await billableDuration(
      env,
      new Date(startedAt).toISOString(),
      new Date(now()).toISOString(),
      fetchFn,
    );
  }
  for (const l of renderReport(p, summary, billable)) out(l);
  return { dryRun: false, plan: p, summary, billable };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : "failed"}\n`);
    process.exit(1);
  });
}
