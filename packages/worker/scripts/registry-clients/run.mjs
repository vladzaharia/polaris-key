#!/usr/bin/env node
/**
 * The registry-client harness (F-02, plans/F-01.md §6.8): stand up a seeded local Worker on the
 * registry host and run real clients against it.
 *
 *   node scripts/registry-clients/run.mjs [--client <name>]... [--port <n>]
 *
 *   1. a fresh local state directory (D1, R2, KV) under the OS temp dir;
 *   2. `seed.mjs`: every migration, the fixture owner, then each `fixtures/<ecosystem>.mjs`
 *      (`seedFixture(ctx)` from seed.mjs, `seedWithBindings(env, ctx)` from `fixtures.mjs`), every
 *      `seeds/*.ts`, and each selected client's own seed (see below);
 *   3. `wrangler dev --env test` on 127.0.0.1, with PKG_ORIGIN naming that address, so every
 *      request the clients make arrives on the registry host (`core/registryHost.ts`);
 *   4. each client in `clients/<name>.sh` (default: all of them), with REGISTRY (the origin),
 *      OWNER (the fixture owner) and STATE in its environment; a non-zero exit fails the run.
 *      A client's `clients/<name>.seed.mjs` (or its family's, `swift-linux` → `swift`) runs
 *      after step 2, before the Worker starts, to publish that ecosystem's fixtures.
 *
 * A client may bring its ecosystem's fixture as `clients/<name>.seed.mjs` (or its family's,
 * `swift-compat` → `swift.seed.mjs`), a script run with STATE and OWNER in its environment after
 * step 2 and before `wrangler dev` opens the state (F-05's PyPI clients share `pypi-fixture.mjs`,
 * which seeds once per state directory).
 *
 * AUTHENTICATED MODE (F-21, plans/F-20.md §9): `--auth` switches every feed of the fixture owner
 * to `authenticated` and mints two registry tokens straight into the local D1 (an owner-bound
 * header token and a Godot editor URL token), then checks that each ecosystem refuses a request
 * without a token (401) before running the clients with PKEY_REGISTRY_TOKEN and
 * PKEY_REGISTRY_URL_TOKEN in their environment. Each client configures its tool's native
 * credential from them; every `curl` a client makes sends the header token (a `.curlrc` under
 * CURL_HOME). Both modes set REGISTRY_TOKEN_KEY, as production does, so `GET /v2/` answers the
 * Bearer challenge and OCI clients always run the token dance.
 *
 * PUSH (F-23): the `oci-push-*` clients push with PKEY_REGISTRY_PUSH_TOKEN, an owner-bound
 * `publish` token minted into the local D1 in both modes, to the repositories `seeds/oci.ts`
 * declares for pushes (`tools/pushed`, `tools/conformance`).
 *
 * F-02 ships one smoke client, `curl`; F-04 to F-09 add their ecosystem's clients (npm, pnpm,
 * yarn, bun, pip, uv, poetry, SwiftPM, Gradle, Maven, docker, crane, GodotEnv) as further
 * `clients/*.sh` and matrix rows in `.github/workflows/registry-clients.yml`. Nothing here
 * reaches a deployed environment.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TSX,
  WORKER,
  WRANGLER,
  argValue,
  argValues,
  wrangler,
} from "./lib.mjs";
import { seedFixtures } from "./fixtures.mjs";
import { FIXTURE_OWNER, seed } from "./seed.mjs";

const CLIENTS = join(WORKER, "scripts", "registry-clients", "clients");
const SEEDS = join(WORKER, "scripts", "registry-clients", "seeds");

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

const auth = process.argv.includes("--auth");
/** F-21: the pull-token key and the pepper the tokens below are hashed under (local only). */
const REGISTRY_TOKEN_KEY = randomBytes(32).toString("base64");
const KEY_HASH_PEPPER = randomBytes(16).toString("hex");
const b64url = (b) => b.toString("base64url");
const HEADER_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;
const URL_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;
/** F-23: an owner-bound push token (`publish`, OCI only), minted in BOTH modes: a push always
 *  needs a credential, whatever the feed's read access. */
const PUSH_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;

/** Mint the push token into the local D1 (both modes). */
function seedPush(persistTo) {
  const now = Math.floor(Date.now() / 1000);
  const hash = createHmac("sha256", KEY_HASH_PEPPER)
    .update(PUSH_TOKEN)
    .digest("hex");
  const file = join(persistTo, "registry-clients-push.sql");
  writeFileSync(
    file,
    `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json,
       ecosystems_json, binding, license_id, presentation, created_by, created_at, expires_at)
     VALUES ('${FIXTURE_OWNER}', 'rtok_harness_push', '${hash}', '${PUSH_TOKEN.slice(-4)}',
       'rtok_harness_push', '["publish","read"]', '["oci"]', 'owner', NULL, 'header',
       'admin:harness', ${now}, ${now + 86_400});`,
  );
  wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--env",
    "test",
    "--persist-to",
    persistTo,
    "--file",
    file,
  ]);
}

/** Switch the owner's feeds to `authenticated` and mint the two tokens into the local D1. */
function seedAuth(persistTo) {
  const now = Math.floor(Date.now() / 1000);
  const hash = (t) =>
    createHmac("sha256", KEY_HASH_PEPPER).update(t).digest("hex");
  const row = (id, token, eco, presentation) =>
    `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json,
       ecosystems_json, binding, license_id, presentation, created_by, created_at, expires_at)
     VALUES ('${FIXTURE_OWNER}', '${id}', '${hash(token)}', '${token.slice(-4)}', '${id}',
       '["read"]', ${eco}, 'owner', NULL, '${presentation}', 'admin:harness', ${now},
       ${now + 86_400});`;
  const sql = [
    `UPDATE dist_registry_feeds SET access_mode = 'authenticated' WHERE product = '${FIXTURE_OWNER}';`,
    row("rtok_harness", HEADER_TOKEN, "NULL", "header"),
    row("rtok_harness_url", URL_TOKEN, `'["godot"]'`, "url"),
  ].join("\n");
  const file = join(persistTo, "registry-clients-auth.sql");
  writeFileSync(file, sql);
  wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--env",
    "test",
    "--persist-to",
    persistTo,
    "--file",
    file,
  ]);
}

/** One path per ecosystem that a non-public feed must refuse without a token. */
const PROBES = {
  npm: (o) => `/npm/${o}/@${o}%2fhello`,
  pypi: (o) => `/pypi/${o}/simple/`,
  swift: (o) => `/swift/${o}/identifiers?url=https%3A%2F%2Fexample.com%2Fx`,
  maven: (o) => `/maven/${o}/im/plrs/fixture/demo/maven-metadata.xml`,
  oci: (o) => `/v2/${o}/tools/smoke/tags/list`,
  godot: (o) => `/godot/${o}/index.json`,
};

/** The ecosystem a client exercises (its family's prefix), or null for the smoke client. */
function ecosystemOf(client) {
  const family = client.split("-")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(family)) return "npm";
  if (["pip", "uv", "poetry"].includes(family)) return "pypi";
  if (["gradle8", "gradle9", "maven"].includes(family)) return "maven";
  return family in PROBES ? family : null;
}

async function probeRefusals(selected) {
  let bad = 0;
  const ecosystems = new Set(selected.map(ecosystemOf).filter(Boolean));
  for (const [eco, path] of Object.entries(PROBES)) {
    if (!ecosystems.has(eco)) continue;
    const res = await fetch(`${origin}${path(FIXTURE_OWNER)}`);
    const challenge = res.headers.get("www-authenticate") ?? "";
    const want = eco === "oci" ? /^Bearer realm=/ : /^Basic realm=/;
    if (res.status === 401 && want.test(challenge))
      console.log(
        `ok   ${eco}: 401 without a token (${challenge.split(" ")[0]})`,
      );
    else {
      console.error(
        `FAIL ${eco}: ${res.status} without a token (${challenge})`,
      );
      bad++;
    }
  }
  return bad;
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
  await seed(state);
  await seedFixtures(state, FIXTURE_OWNER);
  // Per-ecosystem seeds (F-08 onward): every `seeds/*.ts`, run with tsx against the same state
  // directory before the Worker starts, so it serves what they published.
  for (const file of readdirSync(SEEDS)
    .filter((f) => f.endsWith(".ts"))
    .sort()) {
    const r = spawnSync(TSX, [join(SEEDS, file), "--persist-to", state], {
      cwd: WORKER,
      stdio: "inherit",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
    if (r.status !== 0)
      throw new Error(`seed ${file} failed (exit ${r.status})`);
  }
  // Per-client fixtures (F-05 onwards): `clients/<client>.seed.{mjs,ts}`, or the seed of the
  // client's family (`swift-compat` → `swift.seed.mjs`), each run once before the Worker starts,
  // so it has the local D1 and R2 to itself. A `.mjs` seed is a script with STATE (the state
  // directory) and OWNER in its environment; a `.ts` seed runs under tsx with `--persist-to` and
  // `--origin` (it imports the Worker's TypeScript sources).
  const seeded = new Set();
  for (const client of clients) {
    const seedFile = [client, client.split("-")[0]]
      .flatMap((n) => [`${n}.seed.mjs`, `${n}.seed.ts`])
      .map((f) => join(CLIENTS, f))
      .find((f) => existsSync(f));
    if (!seedFile || seeded.has(seedFile)) continue;
    seeded.add(seedFile);
    console.log(`\n── registry client seed: ${client} ──`);
    const r = seedFile.endsWith(".ts")
      ? spawnSync(TSX, [seedFile, "--persist-to", state, "--origin", origin], {
          cwd: WORKER,
          stdio: "inherit",
        })
      : spawnSync(process.execPath, [seedFile], {
          cwd: WORKER,
          stdio: "inherit",
          env: { ...process.env, STATE: state, OWNER: FIXTURE_OWNER },
        });
    if (r.status !== 0)
      throw new Error(`seed ${seedFile} failed (exit ${r.status})`);
  }
  if (auth) seedAuth(state);
  if (clients.some((c) => c.startsWith("oci-push"))) seedPush(state);
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
      "--var",
      `REGISTRY_TOKEN_KEY:${REGISTRY_TOKEN_KEY}`,
      "--var",
      `KEY_HASH_PEPPER:${KEY_HASH_PEPPER}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      detached: true,
    },
  );
  // The landing page: `/v2/` answers the Bearer challenge once REGISTRY_TOKEN_KEY is set.
  await waitFor(`${origin}/`, 120_000);
  const curlHome = join(state, "curl-home");
  if (auth) {
    console.log("\n── authenticated feeds: refusals without a token ──");
    failed += await probeRefusals(clients);
    mkdirSync(curlHome);
    writeFileSync(
      join(curlHome, ".curlrc"),
      `header = "Authorization: Bearer ${HEADER_TOKEN}"\n`,
    );
  }
  for (const client of clients) {
    console.log(`\n── registry client: ${client} ──`);
    const r = spawnSync("bash", [join(CLIENTS, `${client}.sh`)], {
      stdio: "inherit",
      env: {
        ...process.env,
        REGISTRY: origin,
        OWNER: FIXTURE_OWNER,
        STATE: state,
        PKEY_REGISTRY_PUSH_TOKEN: PUSH_TOKEN,
        ...(auth
          ? {
              PKEY_REGISTRY_TOKEN: HEADER_TOKEN,
              PKEY_REGISTRY_URL_TOKEN: URL_TOKEN,
              CURL_HOME: curlHome,
              REGISTRY_AUTH: "1",
            }
          : {}),
      },
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
console.log(
  `\nregistry clients green${auth ? " (authenticated feeds)" : ""}: ${clients.join(", ")}`,
);
