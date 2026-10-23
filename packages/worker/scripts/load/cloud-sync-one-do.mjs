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
};

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
    for (const l of renderPlan(opts, p)) out(l);
    return { dryRun: true, plan: p };
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
