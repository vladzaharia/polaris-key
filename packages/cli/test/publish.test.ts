/**
 * P2-06 — `pkey release publish`, `pkey auth github-oidc` and the channel commands against a fake
 * Polaris Key, a fake Actions OIDC endpoint and a fake R2. The real Worker is driven by
 * `packages/worker/test/publishE2e.test.ts`.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashFile,
  matchArtifacts,
  publishRelease,
  readMeta,
  runPkey,
  scanDir,
} from "../src/index.js";
import { parseManifest } from "@polaris-key/manifest";
import {
  actionsEnv,
  BASE,
  bytesOf,
  capture,
  CI_TOKEN,
  cleanup,
  COMMIT,
  exportFiles,
  fakeServer,
  instant,
  json,
  OIDC_URL,
  RELEASE_YAML,
  repo,
  SECRET_KEY,
  SESSION_TOKEN,
  sha,
  SLUG,
  tempDir,
  TICKET,
} from "./publishFixture.js";

afterEach(cleanup);

function entries() {
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "Diceroll",
      modules: { release: { enabled: true } },
    }),
    schema: JSON.stringify({ schemaVersion: 1, catalog: [] }),
    release: RELEASE_YAML,
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!.artifacts;
}

function publishArgs(extra: string[] = []) {
  return [
    "release",
    "publish",
    "--product",
    SLUG,
    "--tag",
    "v0.3.0",
    "--dir",
    "dist",
    "--base-url",
    BASE,
    ...extra,
  ];
}

async function run(
  cwd: string,
  argv: string[],
  server = fakeServer(),
  env = actionsEnv(),
) {
  const io = capture();
  const code = await runPkey(argv, {
    cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    env,
    fetchImpl: server.fetchImpl,
    sleep: instant,
  });
  return { code, out: io.out(), err: io.err(), server };
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────

describe("matching files to the artifact map", () => {
  it("matches one file per entry, recursively, and picks up .sig and .sha256 sidecars", async () => {
    const cwd = await repo();
    const res = matchArtifacts(
      await scanDir(path.join(cwd, "dist")),
      entries(),
    );
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.builds.map((b) => b.entry.id)).toEqual([
      "macos",
      "windows",
      "linux",
      "android",
      "ios",
      "web",
    ]);
    const mac = res.builds[0]!;
    expect(mac.files.map((f) => [f.name, f.role])).toEqual([
      ["Diceroll-0.3.0-macos.zip", "payload"],
      ["Diceroll-0.3.0-macos.zip.sig", "signature"],
      ["Diceroll-0.3.0-macos.zip.sha256", "checksum"],
    ]);
  });

  it("an entry matching no file is a warning and its build is omitted", async () => {
    const files = exportFiles();
    delete files["ios/Diceroll-0.3.0.ipa"];
    const cwd = await repo(files);
    const res = matchArtifacts(
      await scanDir(path.join(cwd, "dist")),
      entries(),
    );
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([
      "artifacts entry ios (Diceroll-*.ipa) matched no file; build ios is omitted.",
    ]);
    expect(res.builds.map((b) => b.entry.id)).not.toContain("ios");
  });

  it("an entry matching two files is an error", async () => {
    const files = exportFiles();
    files["android/Diceroll-0.3.0-debug.apk"] = bytesOf(10, 9);
    const cwd = await repo(files);
    const res = matchArtifacts(
      await scanDir(path.join(cwd, "dist")),
      entries(),
    );
    expect(res.errors).toEqual([
      "artifacts entry android (Diceroll-*.apk) matches 2 files: Diceroll-0.3.0-debug.apk, Diceroll-0.3.0.apk. Exactly one file may play a build's payload.",
    ]);
  });

  it("a sidecar never matches an entry itself, and no match at all is an error", async () => {
    const cwd = await repo({
      "Diceroll-x.zip": bytesOf(5, 1),
      "Diceroll-x.zip.sha256": bytesOf(5, 2),
    });
    const greedy = [{ ...entries()[0]!, match: "Diceroll-*" }];
    const res = matchArtifacts(await scanDir(path.join(cwd, "dist")), greedy);
    expect(res.errors).toEqual([]);
    expect(res.builds[0]!.files.map((f) => f.role)).toEqual([
      "payload",
      "checksum",
    ]);
    const none = matchArtifacts([], entries());
    expect(none.errors).toEqual([
      "No file under --dir matches any artifacts entry; nothing to publish.",
    ]);
  });

  it("a file matched by two entries is an error", async () => {
    const cwd = await repo({ "Diceroll-1-web.zip": bytesOf(5, 1) });
    const two = [
      { ...entries()[5]! },
      { ...entries()[0]!, id: "also", match: "Diceroll-*.zip" },
    ];
    const res = matchArtifacts(await scanDir(path.join(cwd, "dist")), two);
    expect(res.errors).toEqual([
      "Diceroll-1-web.zip matches both artifacts entries web and also; a file belongs to one build.",
    ]);
  });
});

// ── Hashing and --meta ───────────────────────────────────────────────────────────────────────

describe("hashing and --meta", () => {
  it("hashes a multi-chunk file by streaming and agrees with a one-shot digest", async () => {
    const dir = await tempDir();
    const bytes = bytesOf(1_000_003, 3); // ~15 read chunks of 64 KiB
    const file = path.join(dir, "big.bin");
    await writeFile(file, bytes);
    expect(await hashFile(file)).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  });

  it("reads build numbers, minOS and requires; refuses unknown builds and fields", async () => {
    const dir = await tempDir();
    const ids = entries().map((e) => e.id);
    const good = path.join(dir, "builds.json");
    await writeFile(
      good,
      JSON.stringify({
        android: { buildNumber: 31, minOS: "8.0", requires: { contentApi: 3 } },
        ios: { buildNumber: "31.1" },
      }),
    );
    expect(await readMeta(good, ids)).toEqual({
      android: { buildNumber: "31", minOS: "8.0", requires: { contentApi: 3 } },
      ios: { buildNumber: "31.1" },
    });
    const bad = path.join(dir, "bad.json");
    await writeFile(
      bad,
      JSON.stringify({
        andriod: { buildNumber: "1" },
        ios: { build: 1, minOS: 17 },
      }),
    );
    await expect(readMeta(bad, ids)).rejects.toThrow(
      /andriod is not an artifacts entry[\s\S]*ios\.build is not one of[\s\S]*ios\.minOS must be a string/,
    );
  });
});

// ── The publish ──────────────────────────────────────────────────────────────────────────────

describe("pkey release publish", () => {
  it("exchanges OIDC, uploads what is missing with a checksummed SigV4 PUT, and submits the descriptor", async () => {
    const cwd = await repo();
    const meta = path.join(cwd, "builds.json");
    await writeFile(meta, JSON.stringify({ android: { buildNumber: 31 } }));
    const server = fakeServer();
    const files = exportFiles();
    const windows = files["windows/Diceroll-0.3.0-windows.zip"]!;
    server.present.add(sha(windows)); // already held by the product
    const { code, out, err } = await run(
      cwd,
      publishArgs(["--channel", "beta", "--meta", "builds.json"]),
      server,
    );
    expect(err).toBe("");
    expect(code).toBe(0);

    // The OIDC token was requested for the product's audience, with the job's bearer.
    const oidc = server.to("oidc.actions.example");
    expect(oidc).toHaveLength(1);
    expect(new URL(oidc[0]!.url).searchParams.get("audience")).toBe(
      `${BASE}/${SLUG}/release/publish`,
    );
    expect(oidc[0]!.headers.authorization).toBe(
      "bearer actions-request-bearer",
    );
    expect(server.to("/publish/token")[0]!.body).toEqual({
      token: "h.oidc-1.s",
    });

    // The ticket covers every distinct file.
    const uploads = server.to("/publish/uploads")[0]!;
    expect(uploads.headers.authorization).toBe(`Bearer ${CI_TOKEN}`);
    expect((uploads.body as { objects: unknown[] }).objects).toHaveLength(8);

    // Seven PUTs (eight files, one present), each single-part with the checksum and session token.
    const puts = server.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(7);
    for (const p of puts) {
      const digest = Buffer.from(
        p.headers["x-amz-checksum-sha256"]!,
        "base64",
      ).toString("hex");
      expect(sha(p.bytes!)).toBe(digest);
      expect(p.headers["x-amz-content-sha256"]).toBe(digest);
      expect(p.headers["content-length"]).toBe(String(p.bytes!.length));
      expect(p.headers["x-amz-security-token"]).toBe(SESSION_TOKEN);
      expect(p.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=parent-akid\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
      );
      expect(new URL(p.url).pathname).toBe(
        `/polaris-key-blobs/staging/${SLUG}/t1/${digest}`,
      );
    }
    expect(puts.map((p) => sha(p.bytes!))).not.toContain(sha(windows));
    expect(server.r2.size).toBe(7);

    // The descriptor.
    const submit = server.to("/publish/submit")[0]!.body as Record<string, any>;
    expect(submit.ticket).toBe(TICKET);
    expect(submit.dryRun).toBeUndefined();
    const d = submit.descriptor;
    expect(d).toMatchObject({
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "app",
      kind: "app",
      version: "0.3.0",
      tag: "v0.3.0",
      channel: "beta",
      provenance: {
        commit: COMMIT,
        workflowRun:
          "https://github.com/vladzaharia/diceroll/actions/runs/4242",
      },
    });
    expect(d.seq).toBeUndefined(); // the Worker assigns it; a re-run stays the same descriptor
    expect(d.builds.map((b: any) => b.id)).toEqual([
      "macos",
      "windows",
      "linux",
      "android",
      "ios",
      "web",
    ]);
    const android = d.builds.find((b: any) => b.id === "android");
    expect(android).toMatchObject({
      platform: "android",
      arch: "arm64",
      format: "apk",
      buildNumber: "31",
    });
    const mac = d.builds[0];
    expect(mac.artifacts.map((a: any) => a.role)).toEqual([
      "payload",
      "signature",
      "checksum",
    ]);
    const macBytes = files["macos/Diceroll-0.3.0-macos.zip"]!;
    expect(mac.artifacts[0]).toEqual({
      name: "Diceroll-0.3.0-macos.zip",
      role: "payload",
      sha256: sha(macBytes),
      size: macBytes.length,
      locations: [{ provider: "r2", key: `blobs/sha256/${sha(macBytes)}` }],
    });
    expect(out).toContain("Uploaded 7 objects; 1 already stored");
    expect(out).toContain("Published v0.3.0 (created)");
  });

  it("masks the CI token, the ticket and the temporary credentials, and never prints them otherwise", async () => {
    const cwd = await repo();
    const { code, out, err } = await run(cwd, publishArgs());
    expect(code).toBe(0);
    for (const secret of [CI_TOKEN, TICKET, SECRET_KEY, SESSION_TOKEN]) {
      expect(out).toContain(`::add-mask::${secret}\n`);
      const unmasked = out
        .split("\n")
        .filter((l) => l.includes(secret) && !l.startsWith("::add-mask::"));
      expect(unmasked).toEqual([]);
      expect(err).not.toContain(secret);
    }
    // The token is masked before anything is done with it.
    expect(out.indexOf(`::add-mask::${CI_TOKEN}`)).toBeLessThan(
      out.indexOf("::add-mask::" + TICKET),
    );
  });

  it("outside Actions, no ::add-mask:: is printed (it would print the secret)", async () => {
    const cwd = await repo();
    const { code, out } = await run(cwd, publishArgs(), fakeServer(), {
      PKEY_CI_TOKEN: CI_TOKEN,
    });
    expect(code).toBe(0);
    expect(out).not.toContain("::add-mask::");
    expect(out).not.toContain(CI_TOKEN);
  });

  it("--dry-run prints the descriptor and the server's verdict, and uploads and writes nothing", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const { code, out } = await run(cwd, publishArgs(["--dry-run"]), server);
    expect(code).toBe(0);
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(server.r2.size).toBe(0);
    const submits = server.to("/publish/submit");
    expect(submits).toHaveLength(1);
    expect((submits[0]!.body as { dryRun: boolean }).dryRun).toBe(true);
    expect(out).toContain('"descriptorVersion": 1');
    expect(out).toContain("Local validation: ok");
    expect(out).toContain("Server validation: ok — would be created as v0.3.0");
    expect(out).toContain("Dry run: nothing uploaded, nothing written.");
  });

  it("--dry-run with no CI credential validates locally and calls nothing", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const { code, out } = await run(
      cwd,
      publishArgs(["--dry-run"]),
      server,
      {},
    );
    expect(code).toBe(0);
    expect(server.calls).toEqual([]);
    expect(out).toContain("Local validation: ok");
    expect(out).toContain("Server validation: skipped (No CI credential.");
  });

  it("refuses a descriptor that does not validate locally, before any network call", async () => {
    const cwd = await repo();
    const server = fakeServer();
    // The version does not fit the semver scheme.
    const { code, err } = await run(
      cwd,
      [
        "release",
        "publish",
        "--product",
        SLUG,
        "--version",
        "0.3",
        "--dir",
        "dist",
        "--base-url",
        BASE,
      ],
      server,
    );
    expect(code).toBe(1);
    expect(err).toContain("/version invalid_version_for_scheme");
    expect(server.calls).toEqual([]);
  });

  it("refuses a --product that is not the manifest's", async () => {
    const cwd = await repo();
    const { code, err } = await run(cwd, [
      "release",
      "publish",
      "--product",
      "other",
      "--tag",
      "v0.3.0",
      "--dir",
      "dist",
    ]);
    expect(code).toBe(1);
    expect(err).toContain(
      "--product other does not match .pkey/product's slug diceroll.",
    );
  });

  it("a policy refusal is printed with its reason and claim, and exits non-zero", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/token", () =>
      json(
        {
          error: "forbidden",
          message: "the token does not satisfy the publisher policy",
          reason: "policy_mismatch",
          claim: "ref_protected",
        },
        403,
      ),
    );
    const { code, err } = await run(cwd, publishArgs(), server);
    expect(code).toBe(1);
    expect(err).toContain(
      "Exchanging the GitHub OIDC token failed (403 policy_mismatch)",
    );
    expect(err).toContain("the token does not satisfy the publisher policy");
    expect(err).toContain("failing claim: ref_protected");
    expect(err).toContain("ruleset");
    expect(server.to("/publish/uploads")).toEqual([]);
  });

  it("a descriptor refusal prints the validator's findings and exits non-zero", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/submit", () =>
      json(
        {
          error: "bad_request",
          reason: "invalid_descriptor",
          message: "the descriptor does not validate",
          errors: [
            {
              path: "/channel",
              code: "unknown_channel",
              message: "channel nope is not declared",
            },
          ],
        },
        400,
      ),
    );
    const { code, err } = await run(cwd, publishArgs(), server);
    expect(code).toBe(1);
    expect(err).toContain(
      "Submitting the release failed (400 invalid_descriptor)",
    );
    expect(err).toContain(
      "/channel unknown_channel: channel nope is not declared",
    );
    expect(server.to("/publish/submit")).toHaveLength(1); // final: not retried
  });

  it("--source github uploads nothing and locates every file on the tagged release", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const { code } = await run(
      cwd,
      publishArgs(["--source", "github"]),
      server,
    );
    expect(code).toBe(0);
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
    const d = (server.to("/publish/submit")[0]!.body as Record<string, any>)
      .descriptor;
    for (const b of d.builds)
      for (const a of b.artifacts)
        expect(a.locations).toEqual([{ provider: "github", asset: a.name }]);
  });
});

// ── Retries ──────────────────────────────────────────────────────────────────────────────────

describe("retries", () => {
  it("a 429 rate_limited on /token backs off and retries with a FRESH OIDC token", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/token", () =>
      json({ error: "rate_limited", reason: "rate_limited" }, 429),
    );
    const { code, err } = await run(cwd, publishArgs(), server);
    expect(code).toBe(0);
    expect(server.to("oidc.actions.example")).toHaveLength(2);
    expect(
      server
        .to("/publish/token")
        .map((c) => (c.body as { token: string }).token),
    ).toEqual(["h.oidc-1.s", "h.oidc-2.s"]);
    expect(err).toContain("is retryable; attempt 2 of 4");
  });

  it("a submit refusal with retryable: true is sent again; the release lands", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/submit", () =>
      json(
        {
          error: "bad_request",
          reason: "release_exists",
          message:
            "v0.3.0 changed while this descriptor was being checked; submit it again.",
          retryable: true,
        },
        409,
      ),
    );
    const { code, out } = await run(cwd, publishArgs(), server);
    expect(code).toBe(0);
    expect(server.to("/publish/submit")).toHaveLength(2);
    expect(out).toContain("Published v0.3.0 (created)");
  });

  it("promote_failed (retryable) is retried; a refusal without the flag is final", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script(
      "/submit",
      () =>
        json(
          { error: "bad_request", reason: "promote_failed", retryable: true },
          409,
        ),
      () =>
        json(
          {
            error: "bad_request",
            reason: "release_exists",
            message: "already ingested from a different descriptor",
          },
          409,
        ),
    );
    const { code, err } = await run(cwd, publishArgs(), server);
    expect(code).toBe(1);
    expect(server.to("/publish/submit")).toHaveLength(2);
    expect(err).toContain("(409 release_exists)");
  });

  it("gives up after the attempt budget on a retryable refusal", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const retry = () =>
      json(
        { error: "bad_request", reason: "promote_failed", retryable: true },
        409,
      );
    server.script("/submit", retry, retry, retry, retry);
    const { code, err } = await run(cwd, publishArgs(), server);
    expect(code).toBe(1);
    expect(server.to("/publish/submit")).toHaveLength(4);
    expect(err).toContain("409 promote_failed");
  });

  it("a transient S3 failure is retried; a 403 is not", async () => {
    const cwd = await repo({ "web/Diceroll-0.3.0-web.zip": bytesOf(100, 1) });
    const server = fakeServer();
    server.script("put", () => new Response("slow down", { status: 503 }));
    expect((await run(cwd, publishArgs(), server)).code).toBe(0);
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect(server.r2.size).toBe(1);

    const denied = fakeServer();
    denied.script(
      "put",
      () => new Response("<Code>AccessDenied</Code>", { status: 403 }),
    );
    const res = await run(cwd, publishArgs(), denied);
    expect(res.code).toBe(1);
    expect(denied.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(res.err).toContain("failed: 403");
    expect(denied.to("/publish/submit")).toEqual([]);
  });
});

// ── auth github-oidc ─────────────────────────────────────────────────────────────────────────

describe("pkey auth github-oidc", () => {
  it("masks the token and writes PKEY_CI_TOKEN to $GITHUB_ENV", async () => {
    const dir = await tempDir();
    const githubEnv = path.join(dir, "github_env");
    await writeFile(githubEnv, "EXISTING=1\n");
    const server = fakeServer();
    const { code, out } = await run(
      dir,
      ["auth", "github-oidc", "--product", SLUG, "--base-url", `${BASE}/`],
      server,
      actionsEnv({ GITHUB_ENV: githubEnv }),
    );
    expect(code).toBe(0);
    expect(await readFile(githubEnv, "utf8")).toBe(
      `EXISTING=1\nPKEY_CI_TOKEN=${CI_TOKEN}\n`,
    );
    expect(out.startsWith(`::add-mask::${CI_TOKEN}\n`)).toBe(true);
    expect(out.split("\n").filter((l) => l.includes(CI_TOKEN))).toHaveLength(1);
    expect(out).toContain("release:publish");
    // The OIDC request URL keeps its own query and adds the audience.
    const url = new URL(server.to("oidc.actions.example")[0]!.url);
    expect(url.searchParams.get("api-version")).toBe("2.0");
    expect(url.searchParams.get("audience")).toBe(
      `${BASE}/${SLUG}/release/publish`,
    );
    expect(OIDC_URL).toContain("?");
  });

  it("refuses outside an Actions job with an id-token grant", async () => {
    const dir = await tempDir();
    const { code, err } = await run(
      dir,
      ["auth", "github-oidc", "--product", SLUG],
      fakeServer(),
      {
        GITHUB_ACTIONS: "true",
        GITHUB_ENV: path.join(dir, "env"),
      },
    );
    expect(code).toBe(1);
    expect(err).toContain("permissions: id-token: write");
  });

  it("PKEY_CI_TOKEN wins over OIDC, and a malformed one is refused", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const ok = await run(
      cwd,
      publishArgs(),
      server,
      actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }),
    );
    expect(ok.code).toBe(0);
    expect(server.to("oidc.actions.example")).toEqual([]);
    expect(server.to("/publish/token")).toEqual([]);
    const bad = await run(cwd, publishArgs(), fakeServer(), {
      PKEY_CI_TOKEN: "ghp_nope",
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(
      "PKEY_CI_TOKEN is set but is not a pkeyci_ token",
    );
  });

  it("refuses a plain-http base URL", async () => {
    const cwd = await repo();
    const res = await run(cwd, [
      ...publishArgs(),
      "--base-url",
      "http://key.example.test",
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("--base-url must be https");
  });
});

// ── Channel commands ─────────────────────────────────────────────────────────────────────────

describe("pkey release promote|pin|unpin|yank", () => {
  it("calls P2-05's CI routes with the CI token", async () => {
    const dir = await tempDir();
    const server = fakeServer();
    const env = actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN });
    const base = ["--product", SLUG, "--base-url", BASE];
    expect(
      (
        await run(
          dir,
          ["release", "promote", "v0.3.0", "--channel", "stable", ...base],
          server,
          env,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          dir,
          [
            "release",
            "pin",
            "v0.3.0",
            "--channel",
            "beta",
            "--deliverable",
            "app",
            ...base,
          ],
          server,
          env,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          dir,
          ["release", "unpin", "--channel", "beta", ...base],
          server,
          env,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          dir,
          ["release", "yank", "v0.3.0", "--reason", "crash on launch", ...base],
          server,
          env,
        )
      ).code,
    ).toBe(0);
    expect(
      server.calls.map((c) => [
        c.url.slice(BASE.length),
        c.body,
        c.headers.authorization,
      ]),
    ).toEqual([
      [
        `/${SLUG}/release/channels/stable/promote`,
        { releaseId: "v0.3.0" },
        `Bearer ${CI_TOKEN}`,
      ],
      [
        `/${SLUG}/release/channels/beta/pin`,
        { releaseId: "v0.3.0", deliverable: "app" },
        `Bearer ${CI_TOKEN}`,
      ],
      [`/${SLUG}/release/channels/beta/unpin`, {}, `Bearer ${CI_TOKEN}`],
      [
        `/${SLUG}/release/releases/v0.3.0/yank`,
        { reason: "crash on launch" },
        `Bearer ${CI_TOKEN}`,
      ],
    ]);
  });

  it("prints a refusal's reason and exits non-zero", async () => {
    const dir = await tempDir();
    const server = fakeServer();
    server.script("/release/releases/v0.3.0/yank", () =>
      json(
        {
          error: "forbidden",
          reason: "missing_scope",
          message: "this token lacks release:yank",
        },
        403,
      ),
    );
    const { code, err } = await run(
      dir,
      [
        "release",
        "yank",
        "v0.3.0",
        "--reason",
        "bad",
        "--product",
        SLUG,
        "--base-url",
        BASE,
      ],
      server,
      actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }),
    );
    expect(code).toBe(1);
    expect(err).toContain("Yanking v0.3.0 failed (403 missing_scope)");
    expect(err).toContain("lacks this operation's scope");
  });

  it("promote needs a release id and a channel", async () => {
    const dir = await tempDir();
    const res = await run(
      dir,
      ["release", "promote", "--channel", "stable", "--product", SLUG],
      fakeServer(),
      actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }),
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain("needs a release id");
  });
});

// ── The API, directly ────────────────────────────────────────────────────────────────────────

describe("publishRelease", () => {
  it("calls the signRecord seam with the validated descriptor before submitting", async () => {
    const cwd = await repo();
    const server = fakeServer();
    const seen: unknown[] = [];
    const io = capture();
    const result = await publishRelease({
      cwd,
      product: SLUG,
      tag: "v0.3.0",
      dir: "dist",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      signRecord: async (d) => {
        seen.push(d);
        expect(server.to("/publish/submit")).toEqual([]);
      },
    });
    expect(seen).toEqual([result.descriptor]);
    expect(result.releaseId).toBe("v0.3.0");
    expect(result.uploaded).toHaveLength(8);
  });
});
