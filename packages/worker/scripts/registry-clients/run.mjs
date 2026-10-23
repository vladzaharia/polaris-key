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
 *      request the clients make arrives on the registry host (`core/registry/registryHost.ts`);
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
 * SERVICE TOKENS IN `--auth` (F-33b.6): the header token is a `pkeyci_` service token
 * (`packages:read`, a static `ci_tokens` row, what the console's Keys area mints), not an owner
 * `pkeyr_`: no console can mint one any more. One legacy owner `pkeyr_` read row is seeded too, and
 * `proveLegacy` checks it still reads until it expires. The Godot editor's URL token stays a
 * `pkeyr_` (a CI token cannot ride a URL).
 *
 * PERSONAL TOKEN (`--person`, F-33b.6): one `pkeyp_` over two owners. Seeds owners `acme` and
 * `bolt` (OCI and Swift feeds, `licensed`) and `cove`, an account with a usable licence in acme and
 * bolt and none in cove, and mints one `packages:read` personal token for it through
 * `core/accounts/personalTokens.ts` (`person/seed.ts`). Runs `clients/person-*.sh` (default: both;
 * `--client docker` and `--client swift` name them) with PKEY_PERSON_TOKEN. Excludes `--auth`.
 *
 * NATIVE PUBLISH (F-22): every run also declares four package deliverables to publish
 * (`seedPublish`: `@<owner>/published` on npm, `polaris-smoke-published` on PyPI,
 * `smoke.PublishedKit` on Swift, `im.plrs.fixture:published` and `:published-gradle` on Maven) and
 * mints an owner-bound publish token into the local D1, handed to every client as
 * PKEY_REGISTRY_PUBLISH_TOKEN. The publish clients (`npm-publish`, `twine`, `swift-publish`,
 * `maven-publish`, `gradle-publish`) publish with the native tool, then install what they
 * published from the feed.
 *
 * PUSH (F-23): the `oci-push-*` clients push with PKEY_REGISTRY_PUSH_TOKEN, an owner-bound
 * `publish` token minted into the local D1 in both modes, to the repositories `seeds/oci.ts`
 * declares for pushes (`tools/pushed`, `tools/conformance`).
 *
 * F-02 ships one smoke client, `curl`; F-04 to F-09 add their ecosystem's clients (npm, pnpm,
 * yarn, bun, pip, uv, poetry, SwiftPM, Gradle, Maven, docker, crane, GodotEnv; F-30: Cargo;
 * F-31's go) as further
 * `clients/*.sh` and matrix rows in `.github/workflows/registry-clients.yml`. Nothing here
 * reaches a deployed environment.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
import { FIXTURE_OWNER, seed, seedOwner } from "./seed.mjs";

const CLIENTS = join(WORKER, "scripts", "registry-clients", "clients");
const SEEDS = join(WORKER, "scripts", "registry-clients", "seeds");
const PERSON_DIR = join(WORKER, "scripts", "registry-clients", "person");

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
const person = process.argv.includes("--person");
if (auth && person) {
  console.error("--auth and --person are separate runs");
  process.exit(2);
}
/** F-33b.6: the owners of a `--person` run. The account holds a licence in the first two. */
const PERSON_OWNERS = ["acme", "bolt", "cove"];
const PERSON_HOLDS = ["acme", "bolt"];
/** F-21: the pull-token key and the pepper the tokens below are hashed under (local only). */
const REGISTRY_TOKEN_KEY = randomBytes(32).toString("base64");
const KEY_HASH_PEPPER = randomBytes(16).toString("hex");
const b64url = (b) => b.toString("base64url");
/** F-33b.6: the service token (`pkeyci_`, `packages:read`) every `--auth` client sends. */
const HEADER_TOKEN = `pkeyci_${b64url(randomBytes(32))}`;
/** F-33b.6: a legacy owner `pkeyr_` read token, kept to prove it works until it expires. */
const LEGACY_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;
const URL_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;
const PUBLISH_TOKEN = `pkeyr_${b64url(randomBytes(32))}`;

/** F-22: the deliverables the publish clients publish, and an owner-bound publish token. */
function seedPublish(persistTo) {
  const now = Math.floor(Date.now() / 1000);
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const hash = createHmac("sha256", KEY_HASH_PEPPER)
    .update(PUBLISH_TOKEN)
    .digest("hex");
  const declared = [
    ["npm.published", "npm", `@${FIXTURE_OWNER}/published`],
    ["pypi.published", "pypi", "polaris-smoke-published"],
    ["swift.published", "swift", "smoke.PublishedKit"],
    ["maven.published", "maven", "im.plrs.fixture:published"],
    ["maven.published-gradle", "maven", "im.plrs.fixture:published-gradle"],
  ];
  const feeds = [
    ["npm", { scope: `@${FIXTURE_OWNER}` }, {}],
    ["pypi", { prefixes: ["polaris-smoke"] }, {}],
    ["swift", { scope: "smoke" }, { requireSigned: true }],
    ["maven", { groupPrefixes: ["im.plrs.fixture"] }, {}],
  ];
  const sql = [
    `INSERT OR IGNORE INTO dist_registry_owners (product, enabled, updated_at) VALUES (${q(FIXTURE_OWNER)}, 1, ${now});`,
    ...feeds.map(
      ([eco, ns, ext]) =>
        `INSERT OR IGNORE INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, ext_json, updated_at)
         VALUES (${q(FIXTURE_OWNER)}, ${q(eco)}, 1, 'public', ${q(JSON.stringify(ns))}, 52428800, ${q(JSON.stringify(ext))}, ${now});`,
    ),
    ...declared.flatMap(([id, eco, name]) => [
      `INSERT OR REPLACE INTO release_deliverables (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at, ecosystem, package_name)
       VALUES (${q(FIXTURE_OWNER)}, ${q(id)}, 'package', NULL, ${q(JSON.stringify({ kind: "package", id, ecosystem: eco, name, artifacts: { files: { match: "*" } } }))}, 'manifest', ${now}, ${now}, ${q(eco)}, ${q(name)});`,
      `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
       VALUES (${q(FIXTURE_OWNER)}, ${q(id)}, 'public', NULL, 'manifest', ${now});`,
    ]),
    `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json,
       ecosystems_json, binding, license_id, presentation, created_by, created_at, expires_at)
     VALUES (${q(FIXTURE_OWNER)}, 'rtok_harness_publish', '${hash}', '${PUBLISH_TOKEN.slice(-4)}',
       'harness publish', '["publish","read"]', '["maven","npm","pypi","swift"]', 'owner', NULL,
       'header', 'admin:harness', ${now}, ${now + 86_400});`,
  ].join("\n");
  const file = join(persistTo, "registry-clients-publish.sql");
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

/**
 * Switch the owner's feeds to `authenticated` and mint the tokens into the local D1: the service
 * token (a static `ci_tokens` row with `packages:read`, as `issueStaticCiToken` writes it), a legacy
 * owner `pkeyr_` read row and the Godot editor's URL token.
 */
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
    `INSERT INTO ci_tokens (token_hash, token_id, product, kind, scopes_json, subject, label, jti,
       issued_at, expires_at, revoked_at, created_by)
     VALUES ('${hash(HEADER_TOKEN)}', 'cit_harness_service', '${FIXTURE_OWNER}', 'static',
       '["packages:read"]', 'static:cit_harness_service', 'harness service token', NULL, ${now},
       ${now + 86_400}, NULL, 'admin:harness');`,
    row("rtok_harness_legacy", LEGACY_TOKEN, "NULL", "header"),
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

/**
 * The `--person` seed (F-33b.6): the three owners' product rows, their OCI and Swift packages
 * (for the selected clients), every feed of the three switched to `licensed`, then the account,
 * its licences and its personal token (`person/seed.ts`), written to `<state>/person.token`.
 */
function seedPerson(persistTo, selected) {
  const sh = (cmd, args, env = {}) => {
    const r = spawnSync(cmd, args, {
      cwd: WORKER,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
        ...env,
      },
    });
    if (r.status !== 0)
      throw new Error(`${cmd} ${args[0]} failed (exit ${r.status})`);
  };
  for (const o of PERSON_OWNERS) seedOwner(persistTo, o, o);
  if (selected.includes("person-docker"))
    for (const o of PERSON_OWNERS)
      sh(TSX, [
        join(SEEDS, "oci.ts"),
        "--persist-to",
        persistTo,
        "--owner",
        o,
        "--light",
      ]);
  if (selected.includes("person-swift"))
    for (const o of PERSON_OWNERS)
      sh(process.execPath, [join(CLIENTS, "swift.seed.mjs")], {
        STATE: persistTo,
        OWNER: o,
        SCOPE: o,
        SWIFT_DIR: `swift-${o}`,
        SWIFT_VERSIONS: "1.0.0",
      });
  const file = join(persistTo, "registry-clients-person.sql");
  writeFileSync(
    file,
    `UPDATE dist_registry_feeds SET access_mode = 'licensed' WHERE product IN (${PERSON_OWNERS.map((o) => `'${o}'`).join(", ")});`,
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
  sh(
    TSX,
    [
      join(PERSON_DIR, "seed.ts"),
      "--persist-to",
      persistTo,
      "--out",
      join(persistTo, "person.token"),
      "--holds",
      PERSON_HOLDS.join(","),
    ],
    { KEY_HASH_PEPPER },
  );
}

/** One path per ecosystem that a non-public feed must refuse without a token. */
const PROBES = {
  npm: (o) => `/npm/${o}/@${o}%2fhello`,
  pypi: (o) => `/pypi/${o}/simple/`,
  swift: (o) => `/swift/${o}/identifiers?url=https%3A%2F%2Fexample.com%2Fx`,
  maven: (o) => `/maven/${o}/im/plrs/fixture/demo/maven-metadata.xml`,
  oci: (o) => `/v2/${o}/tools/smoke/tags/list`,
  godot: (o) => `/godot/${o}/index.json`,
  cargo: (o) => `/cargo/${o}/config.json`,
  go: (o) => `/go/${o}/go.plrs.test/smoke/@v/list`,
};

/** The ecosystem a client exercises (its family's prefix), or null for the smoke client. */
function ecosystemOf(client) {
  const family = client.split("-")[0];
  if (["npm", "pnpm", "yarn", "bun"].includes(family)) return "npm";
  if (["pip", "uv", "poetry", "twine"].includes(family)) return "pypi";
  if (["gradle8", "gradle9", "gradle", "maven"].includes(family))
    return "maven";
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

/**
 * F-33b.6: owner `pkeyr_` read tokens are retired at mint, and a row minted before keeps working
 * until it expires. Both credentials read one non-public path per selected ecosystem; the legacy
 * one is checked once, with the service token beside it, so a break names which side broke.
 */
async function proveLegacy(selected) {
  let bad = 0;
  const ecosystems = new Set(selected.map(ecosystemOf).filter(Boolean));
  const probe = ["npm", "pypi", "maven", "godot", "cargo", "go"].find((e) =>
    ecosystems.has(e),
  );
  if (!probe) return 0;
  for (const [label, token] of [
    ["service token (pkeyci_)", HEADER_TOKEN],
    ["legacy owner token (pkeyr_)", LEGACY_TOKEN],
  ]) {
    const res = await fetch(`${origin}${PROBES[probe](FIXTURE_OWNER)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 200 || res.status === 404)
      console.log(`ok   ${probe}: ${label} is accepted (${res.status})`);
    else {
      console.error(`FAIL ${probe}: ${label} answered ${res.status}`);
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
// F-33b.6: `person-*` clients run only under `--person`, and nothing else does; `--client docker`
// and `--client swift` name them there.
const isPersonClient = (c) => c.startsWith("person-");
const wanted = argValues("--client").map((c) =>
  person && available.includes(`person-${c}`) ? `person-${c}` : c,
);
const clients = wanted.length
  ? wanted
  : available.filter((c) => isPersonClient(c) === person);
for (const c of clients)
  if (isPersonClient(c) !== person) {
    console.error(
      isPersonClient(c)
        ? `${c} needs --person`
        : `${c} does not run under --person (use person-docker or person-swift)`,
    );
    process.exit(2);
  }
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
  seedPublish(state);
  if (auth) seedAuth(state);
  if (person) seedPerson(state, clients);
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
    console.log("\n── the legacy owner token still reads ──");
    failed += await proveLegacy(clients);
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
        PKEY_REGISTRY_PUBLISH_TOKEN: PUBLISH_TOKEN,
        PKEY_REGISTRY_PUSH_TOKEN: PUSH_TOKEN,
        ...(auth
          ? {
              PKEY_REGISTRY_TOKEN: HEADER_TOKEN,
              PKEY_REGISTRY_URL_TOKEN: URL_TOKEN,
              CURL_HOME: curlHome,
              REGISTRY_AUTH: "1",
            }
          : {}),
        ...(person
          ? {
              PKEY_PERSON_TOKEN: readFileSync(
                join(state, "person.token"),
                "utf8",
              ).trim(),
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
  `\nregistry clients green${auth ? " (authenticated feeds)" : person ? " (personal token, two owners)" : ""}: ${clients.join(", ")}`,
);
