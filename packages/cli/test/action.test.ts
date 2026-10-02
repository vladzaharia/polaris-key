/**
 * P2-06 — the `polaris-key/publish` Action entry, the standalone bundle and its freshness gate,
 * `pkey manifest schemas`, and the SigV4 signer against AWS's published examples.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTION_INPUTS,
  actionInput,
  ensureZstd,
  isActionInvocation,
  pinsInput,
  runAction,
} from "../src/action.js";
import { runPkey, signV4 } from "../src/index.js";
import {
  actionsEnv,
  BASE,
  capture,
  cleanup,
  fakeServer,
  instant,
  json,
  repo,
  SLUG,
  tempDir,
} from "./publishFixture.js";

const run = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgDir, "..", "..");

afterEach(cleanup);

function inputs(over: Record<string, string> = {}) {
  const raw: Record<string, string> = {
    product: SLUG,
    deliverable: "app",
    version: "",
    tag: "v0.3.0",
    channel: "",
    dir: "dist",
    source: "r2",
    meta: "",
    "base-url": BASE,
    "dry-run": "false",
    ...over,
  };
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
  );
}

describe("the Action entry", () => {
  it("is chosen only with no argv, inside Actions, with the product input", () => {
    const env = { GITHUB_ACTIONS: "true", INPUT_PRODUCT: SLUG };
    expect(isActionInvocation([], env)).toBe(true);
    expect(isActionInvocation(["validate"], env)).toBe(false);
    expect(isActionInvocation([], { GITHUB_ACTIONS: "true" })).toBe(false);
    expect(isActionInvocation([], { INPUT_PRODUCT: SLUG })).toBe(false);
    // GitHub upper-cases names and keeps hyphens; an unset input arrives as "".
    expect(actionInput({ "INPUT_BASE-URL": " https://x " }, "base-url")).toBe(
      "https://x",
    );
    expect(actionInput({ INPUT_CHANNEL: "" }, "channel")).toBeUndefined();
  });

  it("publishes from its inputs and writes release-id and outcome to $GITHUB_OUTPUT", async () => {
    const cwd = await repo();
    const output = path.join(cwd, "gh_output");
    await writeFile(output, "");
    const server = fakeServer();
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv({ GITHUB_OUTPUT: output }), ...inputs() },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "release-id=v0.3.0\noutcome=created\n",
    );
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(8);
  });

  it("dry-run: true uploads nothing", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv(), ...inputs({ "dry-run": "true" }) },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code).toBe(0);
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(
      (server.to("/publish/submit")[0]!.body as { dryRun: boolean }).dryRun,
    ).toBe(true);
  });

  it("a refusal is an ::error:: annotation and exit 1, so the job fails", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/token", () =>
      json(
        {
          error: "forbidden",
          reason: "policy_mismatch",
          claim: "environment",
          message: "no",
        },
        403,
      ),
    );
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv(), ...inputs() },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code).toBe(1);
    expect(io.out()).toMatch(
      /^::error title=pkey release publish::Exchanging the GitHub OIDC token failed \(403 policy_mismatch\).*%0A {2}failing claim: environment/m,
    );
    expect(io.err()).toContain("policy_mismatch");
  });

  it("refuses a dry-run input that is not true or false", async () => {
    const cwd = await repo();
    const io = capture();
    const code = await runAction({
      env: { ...actionsEnv(), ...inputs({ "dry-run": "yes" }) },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err()).toContain("dry-run must be true or false");
  });
});

describe("pkey manifest schemas", () => {
  it("vendors every published .pkey/ schema into --out", async () => {
    const cwd = await tempDir();
    const io = capture();
    const code = await runPkey(["manifest", "schemas", "--out", "vendor"], {
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const source = path.join(repoRoot, "packages/shared-manifest/schemas/v1");
    const expected = (await readdir(source)).sort();
    expect((await readdir(path.join(cwd, "vendor"))).sort()).toEqual(expected);
    for (const name of expected)
      expect(await readFile(path.join(cwd, "vendor", name), "utf8")).toBe(
        await readFile(path.join(source, name), "utf8"),
      );
  });
});

describe("the standalone bundle", () => {
  it("bundle:action --check passes on a fresh bundle and fails on a stale one", async () => {
    const dir = await tempDir();
    const out = path.join(dir, "index.js");
    const script = path.join(pkgDir, "scripts/bundle-action.mjs");
    await run(process.execPath, [script, "--out", out]);
    await run(process.execPath, [script, "--check", "--out", out]);
    await writeFile(out, `${await readFile(out, "utf8")}\n// edited by hand\n`);
    await expect(
      run(process.execPath, [script, "--check", "--out", out]),
    ).rejects.toMatchObject({ code: 1 });
    // The bundle runs as a standalone pkey, schemas inlined.
    const vendored = path.join(dir, "vendor");
    const { stdout } = await run(
      process.execPath,
      [out, "manifest", "schemas", "--out", vendored],
      { cwd: dir },
    );
    expect(stdout).toContain("Wrote 5 schemas");
    const help = await run(process.execPath, [out, "help"]);
    expect(help.stdout).toContain("pkey release publish");
  }, 60_000);

  // The Action runs its COMMITTED dist/index.js. A bare `dist/` in the root .gitignore once
  // swallowed it: the bundle existed only in the author's checkout, `--check` passed there and
  // failed on every clean clone, and `uses: …/actions/publish@<sha>` had no entry point. Pin that
  // git does not ignore the bundle's path, and that action.yml points at that path.
  it("the bundle path is not git-ignored and is the Action's entry point", async () => {
    const bundle = "actions/publish/dist/index.js";
    const ignored = await run("git", ["check-ignore", "-q", bundle], {
      cwd: repoRoot,
    }).then(
      () => true,
      (err: { code?: number }) => {
        // 1 = not ignored. Anything else (128: no git checkout) is surfaced, not passed.
        if (err.code === 1) return false;
        throw err;
      },
    );
    expect(
      ignored,
      `${bundle} is git-ignored, so the Action would ship without it`,
    ).toBe(false);
    const actionYml = await readFile(
      path.join(repoRoot, "actions/publish/action.yml"),
      "utf8",
    );
    expect(actionYml).toMatch(/^\s+main:\s*dist\/index\.js\s*$/m);
  });
});

describe("the Action's pack inputs (P4-03)", () => {
  it("declares exactly the inputs the entry reads, in order", async () => {
    const yml = await readFile(
      path.join(repoRoot, "actions/publish/action.yml"),
      "utf8",
    );
    const block = yml.slice(
      yml.indexOf("\ninputs:\n"),
      yml.indexOf("\noutputs:\n"),
    );
    const names = [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
    expect(names).toEqual([...ACTION_INPUTS]);
  });

  it("splits pins on whitespace and commas", () => {
    expect(pinsInput(undefined)).toEqual([]);
    expect(pinsInput("a.b@1.0.0, c.d@2.0.0\ne.f@3")).toEqual([
      "a.b@1.0.0",
      "c.d@2.0.0",
      "e.f@3",
    ]);
  });

  it("installs zstd with apt-get update then install when it is missing or old, and fails with the minimum otherwise", () => {
    const out = { write: () => true };
    // Missing, then present after the install: fixed argv, no shell.
    const calls: string[][] = [];
    let installed = false;
    ensureZstd({
      stdout: out,
      platform: "linux",
      exec: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === "zstd") {
          if (!installed) throw new Error("ENOENT");
          return "*** Zstandard CLI (64-bit) v1.5.5, by Yann Collet ***";
        }
        if (args.includes("install")) installed = true;
        return "";
      },
    });
    expect(calls).toEqual([
      ["zstd", "-V"],
      ["sudo", "-n", "apt-get", "update", "-q"],
      ["sudo", "-n", "apt-get", "install", "-y", "-q", "zstd"],
      ["zstd", "-V"],
    ]);
    // apt still gives an old version.
    expect(() =>
      ensureZstd({
        stdout: out,
        platform: "linux",
        exec: (cmd) => (cmd === "zstd" ? "v1.4.8" : ""),
      }),
    ).toThrow(/needs zstd ≥ 1\.5\.5; apt-get installed 1\.4\.8/);
    // apt-get fails.
    expect(() =>
      ensureZstd({
        stdout: out,
        platform: "linux",
        exec: (cmd) => {
          throw new Error(`${cmd} failed`);
        },
      }),
    ).toThrow(/needs zstd ≥ 1\.5\.5, and installing it with apt-get failed/);
    // Not Linux: no install attempt.
    const mac: string[] = [];
    expect(() =>
      ensureZstd({
        stdout: out,
        platform: "darwin",
        exec: (cmd) => (mac.push(cmd), "v1.5.2"),
      }),
    ).toThrow(/needs zstd ≥ 1\.5\.5; this runner has 1\.5\.2/);
    expect(mac).toEqual(["zstd"]);
  });

  it("installs zstd only when it is missing", () => {
    const calls: string[] = [];
    const out = { write: () => true };
    ensureZstd({ stdout: out, exec: (cmd) => (calls.push(cmd), "v1.5.7") });
    expect(calls).toEqual(["zstd"]);
  });
});

describe("SigV4", () => {
  // AWS's published examples ("Authenticating Requests: Using the Authorization Header",
  // Amazon S3 API reference), credentials AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/....
  const creds = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  };

  it("matches AWS's GET Object example", () => {
    expect(
      signV4({
        ...creds,
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: {
          range: "bytes=0-9",
          "x-amz-content-sha256":
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "x-amz-date": "20130524T000000Z",
        },
        payloadHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches AWS's PUT Object example (a path segment that needs encoding)", () => {
    expect(
      signV4({
        ...creds,
        method: "PUT",
        url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
        headers: {
          date: "Fri, 24 May 2013 00:00:00 GMT",
          "x-amz-date": "20130524T000000Z",
          "x-amz-storage-class": "REDUCED_REDUNDANCY",
          "x-amz-content-sha256":
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
        },
        payloadHash:
          "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
});
