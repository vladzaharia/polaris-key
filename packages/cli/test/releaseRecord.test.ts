/**
 * P3-03 — `pkey release publish` signs the release record (`pkey-release+jws`) through P2-06's
 * `signRecord` seam with the CI-held release key, and `pkey release keys generate` makes one.
 * Driven against the fake Polaris Key of `publishFixture.ts`, with the corpus release test key.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { publishRelease, runPkey } from "../src/index.js";
import {
  actionsEnv,
  BASE,
  capture,
  CI_TOKEN,
  cleanup,
  fakeServer,
  instant,
  json,
  RELEASE_KID,
  RELEASE_PEM,
  RELEASE_PEM_BODY,
  RELEASE_PUB,
  RELEASE_YAML,
  RELEASE_YAML_KEYED,
  repo,
  sha,
  SLUG,
  tempDir,
} from "./publishFixture.js";
import { runAction } from "../src/action.js";

afterEach(cleanup);

const NOW = 1_800_000_000;

async function publish(
  over: Partial<Parameters<typeof publishRelease>[0]> = {},
  opts: { yaml?: string; server?: ReturnType<typeof fakeServer> } = {},
) {
  const cwd = await repo(undefined, opts.yaml ?? RELEASE_YAML_KEYED);
  const server = opts.server ?? fakeServer();
  const io = capture();
  const result = await publishRelease({
    cwd,
    product: SLUG,
    tag: "v0.3.0",
    dir: "dist",
    baseUrl: BASE,
    env: actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN, PKEY_RELEASE_KEY: RELEASE_PEM }),
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: server.fetchImpl,
    sleep: instant,
    now: NOW,
    ...over,
  });
  return { result, server, io };
}

function everythingSent(server: ReturnType<typeof fakeServer>): string {
  return server.calls
    .map((c) =>
      [
        c.url,
        JSON.stringify(c.headers),
        c.body === undefined ? "" : JSON.stringify(c.body),
        c.bytes ? Buffer.from(c.bytes).toString("latin1") : "",
      ].join("\n"),
    )
    .join("\n");
}

describe("pkey release publish — the release record", () => {
  it("signs a record that verifies against the release key, whose builds equal the descriptor's, and submits it with the descriptor", async () => {
    const { result, server, io } = await publish();
    const [submit] = server.to("/publish/submit");
    const body = submit!.body as {
      descriptor: Record<string, any>;
      record: string;
    };
    expect(body.record).toBe(result.recordJws);
    // The descriptor carries the seq the upload route answered for this release.
    const [uploads] = server.to("/publish/uploads");
    expect((uploads!.body as any).releases).toEqual([
      { deliverable: "app", version: "0.3.0" },
    ]);
    expect(body.descriptor.seq).toBe(7);

    const v = await verifyJws(
      body.record,
      { [RELEASE_KID]: RELEASE_PUB },
      { typ: "pkey-release+jws" },
    );
    expect(v).not.toBeNull();
    expect(
      releaseRecordClaims(v!.payload, {
        expectedAud: SLUG,
        nonWire: v!.nonWireIntegers,
      }),
    ).toBe(true);
    const record = v!.payload as Record<string, any>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      aud: SLUG,
      deliverable: "app",
      kind: "app",
      version: "0.3.0",
      seq: 7,
      issuedAt: NOW,
      tag: "v0.3.0",
    });
    // The record's builds are the descriptor's, with every location dropped.
    expect(record.builds).toEqual(
      body.descriptor.builds.map((b: any) => ({
        ...b,
        artifacts: b.artifacts.map(({ locations: _l, ...a }: any) => a),
      })),
    );
    expect(io.out()).toContain("Signed the release record (seq 7");
    // The private key is in no request and no log line.
    expect(everythingSent(server)).not.toContain(RELEASE_PEM_BODY);
    expect(io.out() + io.err()).not.toContain(RELEASE_PEM_BODY);
  });

  it("calls the signRecord seam after the upload route answered the seq, with the mapped record", async () => {
    const server = fakeServer();
    const seen: unknown[] = [];
    const { result } = await publish(
      {
        signRecord: async (record) => {
          seen.push(record);
          expect(server.to("/publish/uploads")).toHaveLength(1);
          expect(server.to("/publish/submit")).toEqual([]);
          const { signJws } = await import("@polaris-key/jws");
          return signJws(record, RELEASE_PEM, RELEASE_KID, "pkey-release+jws");
        },
      },
      { server },
    );
    expect(seen).toEqual([result.record]);
    expect((seen[0] as any).seq).toBe(7);
  });

  it("refuses to publish a record the seam signed wrongly (another key, or another payload)", async () => {
    const { signJws } = await import("@polaris-key/jws");
    for (const signRecord of [
      // Signed under the declared kid with an undeclared key.
      async () => {
        const { generateKeyPairSync } = await import("node:crypto");
        const pem = generateKeyPairSync("ed25519")
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString();
        return signJws({ any: 1 }, pem, RELEASE_KID, "pkey-release+jws");
      },
      // The right key, another record.
      async (record: any) =>
        signJws(
          { ...record, seq: record.seq + 1 },
          RELEASE_PEM,
          RELEASE_KID,
          "pkey-release+jws",
        ),
    ]) {
      const server = fakeServer();
      await expect(
        publish({ signRecord: signRecord as never }, { server }),
      ).rejects.toThrow(/nothing was published/);
      expect(server.to("/publish/submit")).toEqual([]);
    }
  });

  it("--min-supported-seq becomes the record's minSupportedSeq", async () => {
    const { result } = await publish({ minSupportedSeq: 5 });
    expect(result.record?.minSupportedSeq).toBe(5);
    await expect(publish({ minSupportedSeq: 0 })).rejects.toThrow(
      /--min-supported-seq/,
    );
  });

  it("--dry-run prints the record unsigned and signs nothing", async () => {
    const server = fakeServer();
    let signed = false;
    const { result, io } = await publish(
      {
        dryRun: true,
        signRecord: async () => {
          signed = true;
          return "x";
        },
      },
      { server },
    );
    expect(signed).toBe(false);
    expect(result.recordJws).toBeUndefined();
    expect(io.out()).toContain(
      "Release record (unsigned; a dry run signs nothing)",
    );
    expect(io.out()).toContain('"seq": 7');
    const [submit] = server.to("/publish/submit");
    expect((submit!.body as any).record).toBeUndefined();
    expect((submit!.body as any).dryRun).toBe(true);
  });

  it("a product that declares releaseKeys must sign: no key is an error before any request", async () => {
    const server = fakeServer();
    await expect(
      publish({ env: actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }) }, { server }),
    ).rejects.toThrow(/PKEY_RELEASE_KEY/);
    expect(server.calls).toEqual([]);
    // --no-record publishes without one.
    const { server: s2, result } = await publish({
      env: actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN }),
      noRecord: true,
    });
    expect((s2.to("/publish/submit")[0]!.body as any).record).toBeUndefined();
    expect(result.record).toBeUndefined();
  });

  it("a key .pkey/release does not declare is refused before any request", async () => {
    const server = fakeServer();
    await expect(publish({}, { yaml: RELEASE_YAML, server })).rejects.toThrow(
      /declares no releaseKeys/,
    );
    expect(server.calls).toEqual([]);
  });

  it("an older Polaris Key that answers no seq: refuse rather than sign a guessed seq", async () => {
    const server = fakeServer();
    server.script("/uploads", () =>
      json({
        ticket: `pkeyup_${"C".repeat(43)}`,
        expiresAt: 1_900_000_000,
        credentials: {
          endpoint:
            "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
          bucket: "polaris-key-blobs",
          accessKeyId: "a",
          secretAccessKey: "b",
          sessionToken: "c",
        },
        prefix: "staging/x/",
        objects: [],
        nextSeq: { app: 7 },
      }),
    );
    await expect(publish({}, { server })).rejects.toThrow(/answered no seq/);
    expect(server.to("/publish/submit")).toEqual([]);
  });

  it("the Action's release-key input signs the record", async () => {
    const cwd = await repo(undefined, RELEASE_YAML_KEYED);
    const server = fakeServer();
    const io = capture();
    const code = await runAction({
      cwd,
      env: actionsEnv({
        PKEY_CI_TOKEN: CI_TOKEN,
        INPUT_PRODUCT: SLUG,
        INPUT_DIR: "dist",
        INPUT_TAG: "v0.3.0",
        "INPUT_BASE-URL": BASE,
        "INPUT_RELEASE-KEY": RELEASE_PEM,
      }),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code, io.err()).toBe(0);
    const record = (server.to("/publish/submit")[0]!.body as any).record;
    expect(typeof record).toBe("string");
    expect(
      await verifyJws(
        record,
        { [RELEASE_KID]: RELEASE_PUB },
        {
          typ: "pkey-release+jws",
        },
      ),
    ).not.toBeNull();
    expect(io.out() + io.err()).not.toContain(RELEASE_PEM_BODY);
  });
});

describe("pkey release keys generate", () => {
  it("writes a 0600 private key, prints the releaseKeys entry, and never overwrites", async () => {
    const dir = await tempDir();
    const io = capture();
    const argv = [
      "release",
      "keys",
      "generate",
      "--kid",
      "ci-2026",
      "--out",
      "release-key.pem",
    ];
    const code = await runPkey(argv, {
      cwd: dir,
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
    });
    expect(code, io.err()).toBe(0);
    const file = path.join(dir, "release-key.pem");
    const pem = await readFile(file, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const out = io.out();
    const m = /publicKey: ([A-Za-z0-9_-]{43})/.exec(out);
    expect(m).not.toBeNull();
    expect(out).toContain("kid: ci-2026");
    expect(out).toContain(sha(Buffer.from(m![1]!, "base64url")));
    // The private key is in the file only.
    for (const line of pem
      .split("\n")
      .filter((l) => l && !l.startsWith("-----")))
      expect(out).not.toContain(line);
    // A second run refuses to overwrite.
    const again = capture();
    expect(
      await runPkey(argv, {
        cwd: dir,
        stdout: again.stdout,
        stderr: again.stderr,
        env: {},
      }),
    ).toBe(1);
    expect(again.err()).toContain("exists");
    // The key it wrote signs a record pkey release publish accepts once declared.
    const yaml = RELEASE_YAML.replace(
      "  binaryName: diceroll\n",
      `  binaryName: diceroll\n  releaseKeys:\n    - kid: ci-2026\n      publicKey: ${m![1]}\n`,
    );
    const { result } = await publish(
      { env: actionsEnv({ PKEY_CI_TOKEN: CI_TOKEN, PKEY_RELEASE_KEY: pem }) },
      { yaml },
    );
    expect(result.recordJws).toBeDefined();
  });

  it("needs --kid and --out, and a kid in the release-key pattern", async () => {
    const dir = await tempDir();
    for (const argv of [
      ["release", "keys", "generate", "--out", "k.pem"],
      ["release", "keys", "generate", "--kid", "-bad", "--out", "k.pem"],
    ]) {
      const io = capture();
      expect(
        await runPkey(argv, {
          cwd: dir,
          stdout: io.stdout,
          stderr: io.stderr,
          env: {},
        }),
      ).toBe(1);
      expect(io.err()).toContain("pkey release keys generate");
    }
  });
});
