/**
 * The self-publish dry run (F-10 automation, owner decision 2026-10-04): the whole automatic
 * publishing pipeline of OUR SDKs, end to end, against a local Worker. Nothing here reaches a
 * deployed environment or any public registry.
 *
 *   pnpm --filter @polaris-key/worker registry:self-publish [-- --rounds main,tag] [--tag v0.9.0]
 *        [--only npm,pypi,swift,maven,godot,oci] [--keep]
 *
 * Each ROUND is one CI run of publish-sdks.yml: `main` (a push to main) and `tag` (a v* tag,
 * default the patch after the newest real tag). For each round, in one local state:
 *
 *   1. the version, derived by tools/sdk-version.mjs exactly as CI derives it (git for main);
 *   2. every SDK stamped in place with that version (restored afterwards, whatever happens) and
 *      built into the files CI uploads: `pnpm pack` per npm package, `uv build` (wheel + sdist),
 *      `sdks/swift/tools/sign-registry-release.sh` signed by a THROWAWAY CA made for this run,
 *      `./gradlew publishAllPublicationsToLocalRepository`, `sdks/godot/tools/package.py`, and a
 *      multi-arch OCI layout from packages/cli/image (docker buildx);
 *   3. the deploy hook, through `scripts/register-platform.mjs`, the script deploy.yml runs,
 *      with a fake GitHub OIDC token for deploy.yml (twice: the second run must change nothing);
 *   4. every package published with the CLI's own `publishPackage` (what `pkey release publish`
 *      and the polaris-key/publish Action run), with a fake OIDC token for publish-package.yml in
 *      the `package-registry` environment: the real token exchange against the trusted publisher
 *      the hook registered, the upload ticket, the dry-run submit, the uploads and the submit;
 *   5. tools/feed-drift.mjs, the drift job's check, over HTTP;
 *   6. each SDK installed back from the local feed with its real client: npm, uv (pip
 *      protocol), SwiftPM (signature verified against the throwaway root, then built and run),
 *      Gradle, the Godot feed's editor API plus a real Godot clean install, and crane plus
 *      `docker run` for the image.
 *
 * Local stand-ins, and only these: GitHub's OIDC issuer (a local RSA key whose JWKS is seeded into
 * the Worker's KV cache, where the Worker looks before fetching GitHub's), and R2's S3 endpoint
 * (the uploads the CLI sends to `<account>.r2.cloudflarestorage.com` are caught in-process, then
 * written into the local bucket at their staging keys while `wrangler dev` is briefly stopped,
 * because local R2 has no S3 API). Everything else is the real code over real HTTP.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { getPlatformProxy } from "wrangler";
import { publishPackage } from "../../../cli/src/package/publish.ts";
import { registerPlatform } from "../register-platform.mjs";
import { seed } from "./seed.mjs";
import { WORKER, WRANGLER } from "./lib.mjs";
import {
  deriveVersion,
  gitDescribe,
  nextVersion,
  publicPackageJsons,
  STAMP_TARGETS,
  stampVersions,
  type DerivedVersion,
} from "../../../../tools/sdk-version.mjs";
import {
  checkDrift,
  packageDeliverables,
  type PackageDeliverable,
} from "../../../../tools/feed-drift.mjs";

const ROOT = join(WORKER, "..", "..");
const OWNER = "polaris-key";
const REPO = "vladzaharia/polaris-key";
const REPO_ID = "1278490640";
const OWNER_ID = "79390";
const ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_URL = "https://oidc.self-publish.invalid/token";
const R2_ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "polaris-key-blobs-registry-clients";
const TEST_KEK = Buffer.alloc(32).toString("base64");

// ── Arguments ───────────────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const ROUNDS = (arg("--rounds") ?? "main,tag").split(",").filter(Boolean);
const ONLY = (arg("--only") ?? "").split(",").filter(Boolean);
const KEEP = process.argv.includes("--keep");
const wants = (eco: string) => !ONLY.length || ONLY.includes(eco);

// ── Small helpers ───────────────────────────────────────────────────────────────────────────

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): void {
  execFileSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...opts.env },
  });
}
function out(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...opts.env },
  }).trim();
}
const log = (m: string) => console.log(`\n── self-publish: ${m}`);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ── 1–2. Version, stamp, build ──────────────────────────────────────────────────────────────

/** The files `stampVersions` writes, restored from git after every build. */
function stampedFiles(): string[] {
  return [...STAMP_TARGETS.map((t) => t.file), ...publicPackageJsons(ROOT)];
}

function restoreStamps(): void {
  sh("git", ["checkout", "--", ...stampedFiles()]);
}

/** A throwaway CA (EC P-256 root, codeSigning leaf), as clients/swift.seed.mjs makes one. */
function throwawayCa(dir: string): {
  env: Record<string, string>;
  trusted: string;
} {
  mkdirSync(dir, { recursive: true });
  const ossl = (...a: string[]) => sh("openssl", a, { cwd: dir });
  ossl(
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    "root.key",
  );
  ossl(
    "req",
    "-x509",
    "-new",
    "-key",
    "root.key",
    "-sha256",
    "-days",
    "2",
    "-subj",
    "/CN=Polaris Key self-publish throwaway root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-out",
    "root.pem",
  );
  ossl(
    "ecparam",
    "-name",
    "prime256v1",
    "-genkey",
    "-noout",
    "-out",
    "leaf.key",
  );
  ossl(
    "req",
    "-new",
    "-key",
    "leaf.key",
    "-subj",
    "/CN=Polaris Key self-publish signer/O=Polaris Key test",
    "-out",
    "leaf.csr",
  );
  writeFileSync(
    join(dir, "leaf.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n",
  );
  ossl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "root.pem",
    "-CAkey",
    "root.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    "leaf.ext",
    "-out",
    "leaf.pem",
  );
  ossl("x509", "-in", "leaf.pem", "-outform", "DER", "-out", "leaf.der");
  ossl("x509", "-in", "root.pem", "-outform", "DER", "-out", "root.der");
  mkdirSync(join(dir, "trusted"));
  cpSync(join(dir, "root.der"), join(dir, "trusted", "root.der"));
  const b64 = (f: string) => readFileSync(join(dir, f)).toString("base64");
  // The three CI secrets, in the shapes sign-registry-release.sh reads.
  return {
    env: {
      SWIFT_REGISTRY_SIGNING_KEY: b64("leaf.key"),
      SWIFT_REGISTRY_SIGNING_CERT: b64("leaf.der"),
      SWIFT_REGISTRY_CERT_CHAIN: b64("root.der"),
    },
    trusted: join(dir, "trusted"),
  };
}

const ANDROID_HOME =
  process.env.ANDROID_HOME ?? join(homedir(), "Library", "Android", "sdk");

/** Build every SDK's publishable files for `v` into `stage/<ecosystem>/`. */
function buildAll(
  v: DerivedVersion,
  stage: string,
  ca: { env: Record<string, string> },
): void {
  const dirty = out("git", ["status", "--porcelain", "--", ...stampedFiles()]);
  if (dirty)
    throw new Error(
      `commit or stash these first; the stamp rewrites them:\n${dirty}`,
    );
  stampVersions(ROOT, { version: v.version, pep440: v.pep440 });
  try {
    if (wants("npm"))
      for (const f of publicPackageJsons(ROOT)) {
        const name = (
          JSON.parse(readFileSync(join(ROOT, f), "utf8")) as { name: string }
        ).name;
        const short = name.slice("@polaris-key/".length);
        sh("pnpm", [
          "--filter",
          name,
          "pack",
          "--pack-destination",
          join(stage, "npm", short),
        ]);
      }
    if (wants("pypi"))
      sh("uv", [
        "build",
        "--sdist",
        "--wheel",
        "--out-dir",
        join(stage, "pypi"),
        "sdks/python",
      ]);
    if (wants("swift"))
      sh(
        "bash",
        [
          "sdks/swift/tools/sign-registry-release.sh",
          v.version,
          join(stage, "swift"),
          join(stage, "swift-keys"),
        ],
        { env: ca.env },
      );
    if (wants("maven")) {
      rmSync(join(ROOT, "sdks", "kotlin", "build", "repo"), {
        recursive: true,
        force: true,
      });
      sh(
        "mise",
        [
          "exec",
          "java@temurin-17",
          "--",
          "./gradlew",
          "--no-daemon",
          "-q",
          "publishAllPublicationsToLocalRepository",
        ],
        { cwd: join(ROOT, "sdks", "kotlin"), env: { ANDROID_HOME } },
      );
      cpSync(
        join(ROOT, "sdks", "kotlin", "build", "repo"),
        join(stage, "maven"),
        { recursive: true },
      );
    }
    if (wants("godot"))
      sh("python3", [
        "sdks/godot/tools/package.py",
        "--tag",
        `godot-v${v.version}`,
        "--allow-dirty",
        "--out",
        join(stage, "godot"),
      ]);
    if (wants("oci")) {
      try {
        out("docker", ["buildx", "inspect", "pkey-self-publish"]);
      } catch {
        sh("docker", [
          "buildx",
          "create",
          "--name",
          "pkey-self-publish",
          "--driver",
          "docker-container",
        ]);
      }
      sh(
        "docker",
        [
          "buildx",
          "build",
          "--builder",
          "pkey-self-publish",
          "--platform",
          "linux/amd64,linux/arm64",
          "--build-context",
          "action=actions/publish",
          "--build-arg",
          `VERSION=${v.version}`,
          "--provenance=false",
          "--sbom=false",
          "--output",
          `type=oci,dest=${join(stage, "oci")},tar=false,rewrite-timestamp=true`,
          "packages/cli/image",
        ],
        {
          env: { SOURCE_DATE_EPOCH: out("git", ["log", "-1", "--format=%ct"]) },
        },
      );
      rmSync(join(stage, "oci", "ingest"), { recursive: true, force: true });
    }
  } finally {
    restoreStamps();
  }
}

// ── 3–4. The local Worker, the fake OIDC issuer and the S3 stand-in ─────────────────────────

interface Ctx {
  state: string;
  port: number;
  /** The console host (the API); `localhost`, so it is NOT the registry host. */
  api: string;
  /** The registry host (PKG_ORIGIN). */
  registry: string;
  key: { privateKey: KeyLike };
  dev: ChildProcess | null;
}

async function startWorker(ctx: Ctx): Promise<void> {
  const assets = join(ctx.state, "assets");
  mkdirSync(assets, { recursive: true });
  const vars: Record<string, string> = {
    PKG_ORIGIN: ctx.registry,
    PLATFORM_REPOSITORY: REPO,
    PLATFORM_REPOSITORY_ID: REPO_ID,
    PLATFORM_REPOSITORY_OWNER_ID: OWNER_ID,
    PLATFORM_KEK: TEST_KEK,
    KEY_HASH_PEPPER: "self-publish-pepper",
    R2_ACCOUNT_ID: R2_ACCOUNT,
    R2_PARENT_ACCESS_KEY_ID: "self-publish-access-key",
    R2_PARENT_SECRET_ACCESS_KEY: "self-publish-secret",
    BLOBS_BUCKET_NAME: BUCKET,
  };
  ctx.dev = spawn(
    WRANGLER,
    [
      "dev",
      "--env",
      "test",
      "--ip",
      "127.0.0.1",
      "--port",
      String(ctx.port),
      "--persist-to",
      ctx.state,
      "--assets",
      assets,
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      detached: true,
    },
  );
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${ctx.registry}/v2/`)).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("the local Worker did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function stopWorker(ctx: Ctx): Promise<void> {
  const dev = ctx.dev;
  ctx.dev = null;
  if (!dev?.pid) return;
  const exited = new Promise((r) => dev.once("exit", r));
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}

/** Bindings on the local state, while the Worker is stopped. */
async function withBindings<T>(
  ctx: Ctx,
  fn: (env: { HOT: KVNamespace; BLOBS: R2Bucket }) => Promise<T>,
): Promise<T> {
  const proxy = await getPlatformProxy<{ HOT: KVNamespace; BLOBS: R2Bucket }>({
    configPath: join(WORKER, "wrangler.toml"),
    environment: "test",
    persist: { path: join(ctx.state, "v3") },
  });
  try {
    return await fn(proxy.env);
  } finally {
    await proxy.dispose();
  }
}

/** A GitHub Actions OIDC token for `workflow` at `ref` in `environment`, for `audience`. */
let jti = 0;
async function oidc(
  ctx: Ctx,
  o: { workflow: string; ref: string; environment: string; audience: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: `repo:${REPO}:environment:${o.environment}`,
    repository: REPO,
    repository_id: REPO_ID,
    repository_owner_id: OWNER_ID,
    job_workflow_ref: `${REPO}/${o.workflow}@${o.ref}`,
    ref: o.ref,
    ref_type: o.ref.startsWith("refs/tags/") ? "tag" : "branch",
    ref_protected: "true",
    environment: o.environment,
    runner_environment: "github-hosted",
    event_name: "push",
    run_id: String(4200 + jti),
  })
    .setProtectedHeader({ alg: "RS256", kid: "self-publish" })
    .setIssuer(ISSUER)
    .setAudience(o.audience)
    .setIssuedAt(now - 5)
    .setExpirationTime(now + 600)
    .setJti(`self-publish-${process.pid}-${++jti}`)
    .sign(ctx.key.privateKey);
}

/** The fake OIDC endpoint, answering what Actions' ACTIONS_ID_TOKEN_REQUEST_URL answers. */
function oidcFetch(
  ctx: Ctx,
  claims: { workflow: string; ref: string; environment: string },
): (url: string) => Promise<Response | null> {
  return async (url) => {
    if (!url.startsWith(OIDC_URL)) return null;
    const audience = new URL(url).searchParams.get("audience") ?? "";
    return new Response(
      JSON.stringify({ value: await oidc(ctx, { ...claims, audience }) }),
    );
  };
}

// ── The round ───────────────────────────────────────────────────────────────────────────────

interface Published {
  id: string;
  ok: boolean;
  detail: string;
}

/** Publish every package of `deliverables`, all at once, through the CLI's `publishPackage`. */
async function publishAll(
  ctx: Ctx,
  v: DerivedVersion,
  ref: string,
  stage: string,
  deliverables: PackageDeliverable[],
): Promise<Published[]> {
  const issuer = oidcFetch(ctx, {
    workflow: ".github/workflows/publish-package.yml",
    ref,
    environment: "package-registry",
  });
  // The S3 stand-in: what the CLI PUTs to R2, by staging key (the ticket's prefix).
  const spool = new Map<string, Uint8Array>();
  // The barrier: every final submit waits until each package has uploaded, then the Worker is
  // stopped, the spool written into the local bucket, and the Worker started again.
  let waiting = 0;
  let settled = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let flushing: Promise<void> | null = null;
  const maybeFlush = () => {
    if (flushing || waiting + settled < deliverables.length) return;
    flushing = (async () => {
      await stopWorker(ctx);
      await withBindings(ctx, async (env) => {
        for (const [key, bytes] of spool)
          await env.BLOBS.put(key, bytes, { sha256: sha256(bytes) });
      });
      console.log(
        `self-publish: ${spool.size} uploaded objects written to the local bucket`,
      );
      await startWorker(ctx);
      release();
    })();
  };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const token = await issuer(url);
    if (token) return token;
    const s3 =
      /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/([^/]+)\/(.+)$/.exec(
        url,
      );
    if (s3) {
      if (init?.method !== "PUT" || s3[1] !== BUCKET)
        return new Response("not allowed", { status: 403 });
      const bytes = new Uint8Array(
        await new Response(init.body as BodyInit).arrayBuffer(),
      );
      const want = (init.headers as Record<string, string>)[
        "x-amz-checksum-sha256"
      ];
      if (Buffer.from(sha256(bytes), "hex").toString("base64") !== want)
        return new Response("BadDigest", { status: 400 });
      spool.set(decodeURIComponent(s3[2]!), bytes);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${sha256(bytes)}"` },
      });
    }
    if (url.endsWith("/release/publish/submit") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { dryRun?: boolean };
      if (!body.dryRun) {
        waiting++;
        maybeFlush();
        await gate;
      }
    }
    return fetch(input, init);
  }) as typeof fetch;

  const dirOf = (d: PackageDeliverable): string => {
    if (d.ecosystem === "npm")
      return join(stage, "npm", d.name.slice("@polaris-key/".length));
    return join(stage, d.ecosystem);
  };
  const ciEnv = {
    ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "self-publish-request",
    GITHUB_SHA: out("git", ["rev-parse", "HEAD"]),
  };
  const quiet = { write: () => true };
  return Promise.all(
    deliverables.map(async (d): Promise<Published> => {
      try {
        const r = await publishPackage({
          cwd: ROOT,
          product: OWNER,
          deliverable: d.id,
          version: d.ecosystem === "pypi" ? v.pep440 : v.version,
          channel: v.channel,
          dir: dirOf(d),
          baseUrl: ctx.api,
          env: ciEnv,
          stdout: quiet,
          stderr: quiet,
          fetchImpl,
        });
        return {
          id: d.id,
          ok: true,
          detail: `${r.releaseId} ${String(r.server?.outcome)} (${r.uploaded.length} uploaded, ${r.skipped.length} already stored)`,
        };
      } catch (e) {
        return {
          id: d.id,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        };
      } finally {
        settled++;
        maybeFlush();
      }
    }),
  );
}

// ── 6. The clients ──────────────────────────────────────────────────────────────────────────

type Check = { client: string; ok: boolean; detail: string };

function attempt(client: string, fn: () => string): Check {
  try {
    return { client, ok: true, detail: fn() };
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer | string };
    return {
      client,
      ok: false,
      detail: (err.message ?? String(e)).split("\n").slice(0, 6).join(" | "),
    };
  }
}

function clients(
  ctx: Ctx,
  v: DerivedVersion,
  work: string,
  trusted: string,
): Check[] {
  const reg = ctx.registry;
  const checks: Check[] = [];
  const dir = (n: string) => {
    const d = join(work, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const expect = (what: string, got: string, want: string) => {
    if (got !== want)
      throw new Error(
        `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      );
    return `${what} = ${got}`;
  };

  if (wants("npm"))
    checks.push(
      attempt("npm", () => {
        const d = dir("npm");
        writeFileSync(
          join(d, ".npmrc"),
          `@polaris-key:registry=${reg}/npm/${OWNER}/\n`,
        );
        writeFileSync(
          join(d, "package.json"),
          '{"name":"consumer","private":true,"type":"module"}\n',
        );
        // A main build installs by its dist-tag, a release by `latest` (no tag at all).
        const spec = v.kind === "main" ? "@main" : "";
        sh(
          "npm",
          [
            "install",
            "--no-audit",
            "--no-fund",
            `@polaris-key/node${spec}`,
            `@polaris-key/cli${spec}`,
          ],
          { cwd: d },
        );
        const sdk = out(
          "node",
          [
            "-e",
            "import('@polaris-key/node').then((m) => console.log(m.SDK_VERSION))",
          ],
          { cwd: d },
        );
        const core = (
          JSON.parse(
            readFileSync(
              join(
                d,
                "node_modules",
                "@polaris-key",
                "client-core",
                "package.json",
              ),
              "utf8",
            ),
          ) as { version: string }
        ).version;
        const cli = (
          JSON.parse(
            readFileSync(
              join(d, "node_modules", "@polaris-key", "cli", "package.json"),
              "utf8",
            ),
          ) as { version: string }
        ).version;
        return [
          expect("@polaris-key/node SDK_VERSION", sdk, v.version),
          expect("its client-core", core, v.version),
          expect("@polaris-key/cli", cli, v.version),
        ].join("; ");
      }),
    );

  if (wants("pypi"))
    checks.push(
      attempt("uv (pip protocol)", () => {
        const d = dir("pypi");
        sh("uv", ["venv", "-q", "--python", "3.12", join(d, "venv")]);
        // Our feed first (uv's first-index strategy: polaris-key comes from it), PyPI for the
        // dependencies (cryptography, httpx, zstandard).
        sh("uv", [
          "pip",
          "install",
          "-q",
          "--python",
          join(d, "venv", "bin", "python"),
          "--index-url",
          "https://pypi.org/simple",
          "--extra-index-url",
          `${reg}/pypi/${OWNER}/simple/`,
          `polaris-key==${v.pep440}`,
        ]);
        const got = out(join(d, "venv", "bin", "python"), [
          "-c",
          "import polaris_key; print(polaris_key.__version__)",
        ]);
        return expect("polaris_key.__version__", got, v.pep440);
      }),
    );

  if (wants("swift"))
    checks.push(
      attempt("SwiftPM", () => {
        const d = dir("swift");
        mkdirSync(join(d, "Sources", "Consumer"), { recursive: true });
        writeFileSync(
          join(d, "Package.swift"),
          `// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(\n  name: "Consumer",\n  platforms: [.macOS(.v14)],\n  dependencies: [.package(id: "polaris-key.PolarisKey", exact: "${v.version}")],\n  targets: [.executableTarget(name: "Consumer", dependencies: [.product(name: "PolarisKeyCore", package: "polaris-key.PolarisKey")])]\n)\n`,
        );
        writeFileSync(
          join(d, "Sources", "Consumer", "main.swift"),
          "import PolarisKeyCore\nprint(POLARIS_SDK_VERSION)\n",
        );
        mkdirSync(join(d, ".swiftpm", "configuration"), { recursive: true });
        writeFileSync(
          join(d, ".swiftpm", "configuration", "registries.json"),
          JSON.stringify({
            authentication: {},
            registries: {
              "polaris-key": {
                supportsAvailability: false,
                url: `${reg}/swift/${OWNER}`,
              },
            },
            security: {
              default: {
                signing: {
                  onUnsigned: "error",
                  onUntrustedCertificate: "error",
                  trustedRootCertificatesPath: trusted,
                  includeDefaultTrustedRootCertificates: false,
                  validationChecks: {
                    certificateExpiration: "enabled",
                    certificateRevocation: "disabled",
                  },
                },
              },
            },
            version: 1,
          }),
        );
        const iso = [
          "--cache-path",
          join(d, "cache"),
          "--config-path",
          join(d, "config"),
          "--security-path",
          join(d, "security"),
          "--scratch-path",
          join(d, ".build"),
        ];
        sh("swift", [
          "build",
          "--package-path",
          d,
          ...iso,
          "--product",
          "Consumer",
        ]);
        const got = out(join(d, ".build", "debug", "Consumer"), []);
        return `signature verified against the throwaway root; ${expect("POLARIS_SDK_VERSION", got, v.version)}`;
      }),
    );

  if (wants("maven"))
    checks.push(
      attempt("Gradle", () => {
        const d = dir("maven");
        writeFileSync(
          join(d, "settings.gradle.kts"),
          'rootProject.name = "consumer"\n',
        );
        writeFileSync(
          join(d, "build.gradle.kts"),
          `plugins { java }\nrepositories {\n  exclusiveContent {\n    forRepository { maven { url = uri("${reg}/maven/${OWNER}/"); isAllowInsecureProtocol = true } }\n    filter { includeGroup("im.plrs.key") }\n  }\n  mavenCentral()\n}\ndependencies { implementation("im.plrs.key:polaris-key-sdk:${v.version}") }\ntasks.register("resolved") {\n  val files = configurations.runtimeClasspath\n  doLast { files.get().resolvedConfiguration.resolvedArtifacts.filter { it.moduleVersion.id.group == "im.plrs.key" }.forEach { println(it.moduleVersion.id.name + ":" + it.moduleVersion.id.version) } }\n}\n`,
        );
        const lines = out(
          "mise",
          [
            "exec",
            "java@temurin-17",
            "--",
            "gradle",
            "-q",
            "--no-daemon",
            "resolved",
          ],
          { cwd: d },
        )
          .split("\n")
          .filter((l) => l.startsWith("polaris-key-"));
        if (lines.length < 8)
          throw new Error(`resolved only ${lines.join(", ")}`);
        for (const l of lines)
          expect(l.split(":")[0]!, l.split(":")[1]!, v.version);
        return `${lines.length} im.plrs.key artifacts at ${v.version} (${lines.map((l) => l.split(":")[0]).join(", ")})`;
      }),
    );

  if (wants("godot"))
    checks.push(
      attempt("Godot", () => {
        const d = dir("godot");
        const api = `${reg}/godot/${OWNER}/asset-library/api`;
        const search = JSON.parse(
          out("curl", ["-fsS", `${api}/asset?godot_version=4.6`]),
        ) as { result: { asset_id: string; version_string: string }[] };
        const hit =
          search.result.find((r) => r.version_string === v.version) ??
          search.result[0];
        if (!hit) throw new Error("the 4.6 Asset Library API lists no addon");
        const asset = JSON.parse(
          out("curl", ["-fsS", `${api}/asset/${hit.asset_id}`]),
        ) as {
          download_url: string;
          download_hash: string;
          version_string: string;
        };
        const releases = JSON.parse(
          out("curl", [
            "-fsS",
            `${reg}/godot/${OWNER}/store/api/v1/releases/${OWNER}/polaris_key/`,
          ]),
        ) as { version: string }[];
        const zip = join(d, "addon.zip");
        sh("curl", ["-fsS", "-o", zip, asset.download_url]);
        if (sha256(readFileSync(zip)) !== asset.download_hash)
          throw new Error("the zip does not hash to download_hash");
        // A real clean install: the editor imports the addon, enables the plugin, runs the project
        // and checks SDK_VERSION (the stamped one) and the autoload.
        sh("bash", ["sdks/godot/tools/smoke_install.sh", zip], {
          env: { GODOT_BIN: process.env.GODOT_BIN ?? "godot" },
        });
        const listed = releases.map((r) => r.version);
        if (!listed.includes(v.version))
          throw new Error(`the 4.7 Asset Store API lists ${listed.join(", ")}`);
        return `${expect(v.kind === "main" ? "a 4.6 listing" : "the 4.6 listing", asset.version_string, v.kind === "main" ? asset.version_string : v.version)}; 4.7 lists ${v.version}; download_hash verified; Godot ${out("godot", ["--version"])} clean install passed`;
      }),
    );

  if (wants("oci"))
    checks.push(
      attempt("crane + docker", () => {
        const d = dir("oci");
        const host = new URL(reg).host;
        const ref = `${host}/${OWNER}/pkey:${v.version}`;
        const crane = (...a: string[]) =>
          out("go", [
            "run",
            "github.com/google/go-containerregistry/cmd/crane@v0.20.6",
            ...a,
          ]);
        const platforms =
          (
            JSON.parse(crane("manifest", "--insecure", ref)) as {
              manifests?: { platform: { architecture: string } }[];
            }
          ).manifests?.map((m) => m.platform.architecture) ?? [];
        if (!platforms.includes("amd64") || !platforms.includes("arm64"))
          throw new Error(`the index lists ${platforms.join(", ")}`);
        const channel = v.channel === "stable" ? "latest" : v.channel;
        const tags = crane("ls", "--insecure", `${host}/${OWNER}/pkey`).split(
          "\n",
        );
        if (!tags.includes(channel))
          throw new Error(`no ${channel} tag (tags: ${tags.join(", ")})`);
        const arch = process.arch === "arm64" ? "arm64" : "amd64";
        const tar = join(d, "pkey.tar");
        crane("pull", "--insecure", "--platform", `linux/${arch}`, ref, tar);
        const loaded = out("docker", ["load", "-i", tar]);
        const image = /Loaded image(?: ID)?: (\S+)/.exec(loaded)?.[1];
        if (!image) throw new Error(`docker load: ${loaded}`);
        const label = out("docker", [
          "image",
          "inspect",
          "-f",
          '{{ index .Config.Labels "org.opencontainers.image.version" }}',
          image,
        ]);
        const help = out("docker", ["run", "--rm", image, "--help"]);
        if (!/pkey/i.test(help))
          throw new Error("the image's pkey did not answer --help");
        return `index linux/amd64 + linux/arm64, tag ${channel}; ${expect("image version label", label, v.version)}; docker run pkey --help ok`;
      }),
    );
  return checks;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "pkey-self-publish-"));
  const key = await generateKeyPair("RS256");
  const ctx: Ctx = {
    state,
    port,
    api: `http://localhost:${port}`,
    registry: `http://127.0.0.1:${port}`,
    key,
    dev: null,
  };
  const ca = throwawayCa(join(state, "ca"));
  const deliverables = packageDeliverables(ROOT).filter((d) =>
    wants(d.ecosystem),
  );
  const report: string[] = [];
  let failed = 0;
  try {
    // A fresh local state: every migration (seed.mjs also adds its unrelated fixture owner), and
    // the fake issuer's JWKS in the KV cache the Worker reads before fetching GitHub's.
    await seed(state);
    const jwk = {
      ...(await exportJWK(key.publicKey)),
      kid: "self-publish",
      alg: "RS256",
    };
    await withBindings(ctx, async (env) => {
      await env.HOT.put(
        "gh:oidc:jwks",
        JSON.stringify({
          keys: [jwk],
          fetchedAt: Math.floor(Date.now() / 1000) + 7200,
        }),
      );
    });
    await startWorker(ctx);

    const real = gitDescribe(ROOT);
    for (const round of ROUNDS) {
      const ref =
        round === "main"
          ? "refs/heads/main"
          : `refs/tags/${arg("--tag") ?? `v${nextVersion(real.latestTag)}`}`;
      const v = deriveVersion({
        ref,
        ...(round === "main" ? real : { latestTag: null, distance: 0 }),
      });
      log(
        `round ${round}: ${ref} → ${v.version} (PyPI ${v.pep440}), channel ${v.channel}`,
      );
      report.push(
        `round ${round}: ${ref} → ${v.version} (PyPI ${v.pep440}), channel ${v.channel}`,
      );

      const stage = join(state, `stage-${round}`);
      log("stamp and build every SDK");
      buildAll(v, stage, ca);
      if (out("git", ["status", "--porcelain", "--", ...stampedFiles()]))
        throw new Error("the stamp was not restored");

      log(
        "register the platform packages (scripts/register-platform.mjs, the deploy hook)",
      );
      const deployIssuer = oidcFetch(ctx, {
        workflow: ".github/workflows/deploy.yml",
        ref:
          round === "main" ? `refs/tags/v${nextVersion(real.latestTag)}` : ref,
        environment: "production",
      });
      const hookFetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) =>
        (await deployIssuer(String(input))) ??
        fetch(input, init)) as typeof fetch;
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      };
      for (const pass of [1, 2]) {
        const r = await registerPlatform({
          origin: ctx.api,
          root: ROOT,
          env,
          fetchImpl: hookFetch,
          out: { write: () => true },
        });
        const line = `deploy hook pass ${pass}: created=${r.created} packages=${r.packages.length} publisher=${r.publisher?.workflow}@${r.publisher?.environment} changed=${r.publisherChanged}`;
        console.log(line);
        report.push(`  ${line}`);
        if (pass === 2 && (r.created || r.publisherChanged))
          throw new Error("the second registration changed something");
      }

      log(
        `publish ${deliverables.length} packages (the CLI's publishPackage, trusted publishing)`,
      );
      const published = await publishAll(ctx, v, ref, stage, deliverables);
      for (const p of published) {
        const line = `${p.ok ? "ok  " : "FAIL"} publish ${p.id}: ${p.detail}`;
        console.log(line);
        report.push(`  ${line}`);
        if (!p.ok) failed++;
      }

      log("drift check (tools/feed-drift.mjs)");
      const problems = await checkDrift({
        origin: ctx.registry,
        owner: OWNER,
        root: ROOT,
        expected: { version: v.version, pep440: v.pep440, channel: v.channel },
        timeoutSec: 120,
        only: ONLY,
        log: (m) => console.log(m),
      });
      for (const d of deliverables) {
        const p = problems.get(d.id);
        const line = p
          ? `FAIL drift ${d.id}: ${p.join("; ")}`
          : `ok   drift ${d.id}`;
        if (p) failed++;
        report.push(`  ${line}`);
      }
      console.log(
        problems.size
          ? `drift: ${problems.size} packages behind`
          : "drift: none",
      );

      log("install each SDK back with its real client");
      for (const c of clients(
        ctx,
        v,
        join(state, `clients-${round}`),
        ca.trusted,
      )) {
        const line = `${c.ok ? "ok  " : "FAIL"} client ${c.client}: ${c.detail}`;
        console.log(line);
        report.push(`  ${line}`);
        if (!c.ok) failed++;
      }
    }
  } finally {
    await stopWorker(ctx);
    if (out("git", ["status", "--porcelain", "--", ...stampedFiles()]))
      restoreStamps();
    if (KEEP) console.log(`state kept at ${state}`);
    else rmSync(state, { recursive: true, force: true });
  }
  console.log(`\n══ self-publish report ══\n${report.join("\n")}`);
  if (failed) {
    console.error(`\nself-publish: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log("\nself-publish green");
}

if (!existsSync(join(ROOT, ".pkey", "release.yaml")))
  throw new Error("run from the monorepo");
await main();
