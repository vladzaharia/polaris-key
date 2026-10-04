#!/usr/bin/env node
/**
 * The registry-client harness (F-02, plans/F-01.md §6.8): stand up a seeded local Worker on the
 * registry host and run real clients against it.
 *
 *   node scripts/registry-clients/run.mjs [--client <name>]... [--port <n>]
 *
 *   1. a fresh local state directory (D1, R2, KV) under the OS temp dir;
 *   2. `seed.mjs`: every migration, then the fixture owner;
 *   3. `wrangler dev --env test` on 127.0.0.1, with PKG_ORIGIN naming that address, so every
 *      request the clients make arrives on the registry host (`core/registryHost.ts`);
 *   4. each client in `clients/<name>.sh` (default: all of them), with REGISTRY (the origin)
 *      and OWNER (the fixture owner) in its environment; a non-zero exit fails the run.
 *
 * F-02 ships one smoke client, `curl`. F-04 to F-09 add their ecosystem's clients (npm, pip,
 * SwiftPM, Gradle, docker, GodotEnv) as further `clients/*.sh` and matrix rows in
 * `.github/workflows/registry-clients.yml`. Nothing here reaches a deployed environment.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER, WRANGLER, argValue, argValues } from "./lib.mjs";
import { FIXTURE_OWNER, seed } from "./seed.mjs";

const CLIENTS = join(WORKER, "scripts", "registry-clients", "clients");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`registry host did not answer ${url} within ${ms / 1000}s`);
}

const port = Number(argValue("--port") ?? (await freePort()));
const origin = `http://127.0.0.1:${port}`;
const available = readdirSync(CLIENTS)
  .filter((f) => f.endsWith(".sh"))
  .map((f) => f.slice(0, -3))
  .sort();
const wanted = argValues("--client");
const clients = wanted.length ? wanted : available;
for (const c of clients)
  if (!available.includes(c)) {
    console.error(`unknown client "${c}" (have: ${available.join(", ")})`);
    process.exit(2);
  }

const state = mkdtempSync(join(tmpdir(), "pkey-registry-clients-"));
const assets = join(state, "assets");
mkdirSync(assets);
let dev = null;
let failed = 0;
try {
  seed(state);
  dev = spawn(
    WRANGLER,
    [
      "dev",
      "--env",
      "test",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      // The console and docs bundles are irrelevant on the registry host: an empty assets root
      // keeps the harness independent of the admin and docs builds.
      "--assets",
      assets,
      "--var",
      `PKG_ORIGIN:${origin}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      detached: true,
    },
  );
  await waitFor(`${origin}/v2/`, 120_000);
  for (const client of clients) {
    console.log(`\n── registry client: ${client} ──`);
    const r = spawnSync("bash", [join(CLIENTS, `${client}.sh`)], {
      stdio: "inherit",
      env: { ...process.env, REGISTRY: origin, OWNER: FIXTURE_OWNER },
    });
    if (r.status !== 0) {
      failed++;
      console.error(`registry client ${client}: FAILED (exit ${r.status})`);
    } else console.log(`registry client ${client}: ok`);
  }
} finally {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(state, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log(`\nregistry clients green: ${clients.join(", ")}`);
