/**
 * P4-03 — an app release's `content` and `embeds` (plans/P4-01.md §2.4, §2.8, decision 37):
 * `pkey release content-stamp` from verified markers and `--pin`, the app publish's
 * `--content-stamp` (and `--embedded`/`--pin`), the publish rules, and the record the CLI signs
 * being exactly `descriptorToRecord` of the descriptor that carries both members.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { descriptorToRecord } from "@polaris-key/manifest";
import { parseContentStamp } from "@polaris-key/client-core/packs";
import {
  publishPack,
  publishRelease,
  runPkey,
  writeContentStampFile,
} from "../src/index.js";
import { capture, cleanup, instant } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  kaykitV1,
  kaykitV2,
  l10nTrees,
  noiseBytes,
  packRepo,
  packServer,
  SLUG,
  testReleaseKey,
  writeTestPck,
} from "./packFixtures.js";

afterEach(cleanup);

const key = testReleaseKey();

/** A repo whose diceroll.core3d 1.0.0 and diceroll.l10n 1.0.0 are published (markers written). */
async function published(o: { webEmbeds?: string } = { webEmbeds: "[]" }) {
  const cwd = await packRepo(
    key,
    {
      "default/diceroll.core3d.pck": writeTestPck(kaykitV1()),
      ...l10nTrees(),
      "app/Diceroll-1.5.0-macos.zip": noiseBytes(5000, 31),
      "app/Diceroll-1.5.0-web.zip": noiseBytes(4000, 32),
    },
    o,
  );
  const server = packServer();
  for (const deliverable of ["diceroll.core3d", "diceroll.l10n"]) {
    const io = capture();
    await publishPack({
      cwd,
      product: SLUG,
      deliverable,
      version: "1.0.0",
      dir: "dist",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
    });
  }
  return { cwd, server };
}

function appOpts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  over = {},
) {
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      version: "1.5.0",
      dir: "dist/app",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: 1_759_300_000,
      ...over,
    },
  };
}

describe("pkey release content-stamp", () => {
  it("writes the pkey-content/1 stamp from the verified markers and --pin", async () => {
    const { cwd, server } = await published();
    const io = capture();
    const { content } = await writeContentStampFile({
      cwd,
      product: SLUG,
      out: "pkey-content.json",
      embedded: "dist/default",
      pins: ["diceroll.l10n@1.0.0"],
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    const text = await readFile(path.join(cwd, "pkey-content.json"), "utf8");
    const parsed = parseContentStamp(text);
    expect(parsed).toEqual({ ok: true, content });
    expect(content).toEqual({
      contentApi: 4,
      pins: [
        {
          pack: "diceroll.core3d",
          release: {
            sha256: server.stored.get("diceroll.core3d@1.0.0")!.recordSha256,
            seq: 1,
            version: "1.0.0",
          },
        },
        {
          pack: "diceroll.l10n",
          release: {
            sha256: server.stored.get("diceroll.l10n@1.0.0")!.recordSha256,
            seq: 1,
            version: "1.0.0",
          },
        },
      ],
      expects: [
        { pack: "diceroll.core3d", required: true, delivery: "essential" },
        { pack: "diceroll.l10n", required: false, delivery: "on-demand" },
      ],
    });
    expect(io.out()).toContain("from --pin");
    expect(io.out()).toContain("diceroll.core3d.pck.pkey.json");
  });

  it("refuses a stale marker (the payload beside it changed) and a stamp that leaves a required pack unpinned", async () => {
    const { cwd, server } = await published();
    const io = capture();
    const base = {
      cwd,
      product: SLUG,
      out: "pkey-content.json",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    };
    await expect(
      writeContentStampFile({ ...base, pins: ["diceroll.l10n@1.0.0"] }),
    ).rejects.toThrow(
      /diceroll\.core3d is required, so every app release pins it/,
    );
    await writeFile(
      path.join(cwd, "dist/default/diceroll.core3d.pck"),
      writeTestPck(kaykitV2()),
    );
    await expect(
      writeContentStampFile({ ...base, embedded: "dist/default" }),
    ).rejects.toThrow(/marker rejected at payload: .*a stale marker/);
  });

  it("is reachable as a CLI command with repeatable --pin", async () => {
    const { cwd, server } = await published();
    const io = capture();
    const code = await runPkey(
      [
        "release",
        "content-stamp",
        "--product",
        SLUG,
        "--out",
        "stamp.json",
        "--embedded",
        "dist/default",
        "--pin",
        "diceroll.l10n@1.0.0",
        "--base-url",
        BASE,
      ],
      {
        cwd,
        stdout: io.stdout,
        stderr: io.stderr,
        env: actionsEnv(),
        fetchImpl: server.fetchImpl,
        sleep: instant,
      },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    const stamp = JSON.parse(
      await readFile(path.join(cwd, "stamp.json"), "utf8"),
    ) as {
      pins: { pack: string }[];
    };
    expect(stamp.pins.map((p) => p.pack)).toEqual([
      "diceroll.core3d",
      "diceroll.l10n",
    ]);
  });
});

describe("pkey release publish --deliverable app with packs", () => {
  it("--dry-run prints contentApi, pins from embedded markers and --pin, and embeds per build", async () => {
    const { cwd, server } = await published();
    const { io, o } = appOpts(cwd, server, {
      dryRun: true,
      embedded: "dist/default",
      pins: ["diceroll.l10n@1.0.0"],
    });
    const res = await publishRelease(o);
    const text = io.out();
    expect(text).toContain("Content: contentApi 4");
    expect(text).toMatch(
      /pin diceroll\.core3d@1\.0\.0 \(seq 1, record [0-9a-f]{12}…\) required, essential — from .*diceroll\.core3d\.pck\.pkey\.json/,
    );
    expect(text).toMatch(
      /pin diceroll\.l10n@1\.0\.0 \(seq 1, record [0-9a-f]{12}…\) optional, on-demand — from --pin/,
    );
    expect(text).toContain("embeds macos: diceroll.core3d");
    expect(text).toContain("embeds web: none");
    expect(res.content?.pins.map((p) => p.pack)).toEqual([
      "diceroll.core3d",
      "diceroll.l10n",
    ]);
    expect(server.puts().length).toBeGreaterThan(0); // the two packs' publishes only
    expect(server.to("/release/publish/submit").at(-1)!.body).toMatchObject({
      dryRun: true,
    });
  });

  it("--content-stamp reaches the signed record through the descriptor: the record is descriptorToRecord of it", async () => {
    const { cwd, server } = await published();
    const io = capture();
    await writeContentStampFile({
      cwd,
      product: SLUG,
      out: "pkey-content.json",
      embedded: "dist/default",
      pins: ["diceroll.l10n@1.0.0"],
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    const stamp = JSON.parse(
      await readFile(path.join(cwd, "pkey-content.json"), "utf8"),
    ) as Record<string, unknown>;
    const { o } = appOpts(cwd, server, { contentStamp: "pkey-content.json" });
    const res = await publishRelease(o);
    const { format: _format, ...content } = stamp;
    expect(res.descriptor.content).toEqual(content);
    expect(res.descriptor.builds.map((b) => [b.id, b.embeds])).toEqual([
      ["macos", ["diceroll.core3d"]],
      ["web", []],
    ]);
    const submit = server.to("/release/publish/submit").at(-1)!.body as {
      descriptor: typeof res.descriptor;
      record: string;
    };
    expect(submit.descriptor.content).toEqual(content);
    const record = JSON.parse(
      Buffer.from(submit.record.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(record).toEqual(
      descriptorToRecord(submit.descriptor, {
        seq: submit.descriptor.seq!,
        issuedAt: 1_759_300_000,
      }),
    );
    expect(record.content).toEqual(content);
  });

  it("a product that declares packs must state its pins, and a stamp cannot mix with --embedded", async () => {
    const { cwd, server } = await published();
    await expect(publishRelease(appOpts(cwd, server).o)).rejects.toThrow(
      /declares packs, so an app release states its pins: pass --content-stamp/,
    );
    await expect(
      publishRelease(
        appOpts(cwd, server, {
          contentStamp: "x.json",
          embedded: "dist/default",
        }).o,
      ),
    ).rejects.toThrow(/cannot be combined with --embedded or --pin/);
  });

  it("an embedded pack the release does not pin breaks the publish rules", async () => {
    const { cwd, server } = await published({ webEmbeds: "[diceroll.l10n]" });
    await expect(
      publishRelease(
        appOpts(cwd, server, { dryRun: true, embedded: "dist/default" }).o,
      ),
    ).rejects.toThrow(
      /build web embeds diceroll\.l10n, which the release does not pin/,
    );
  });
});
