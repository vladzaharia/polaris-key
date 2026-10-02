/**
 * P4-03 — `pkey release publish --deliverable <packId>` end to end against a fake Polaris Key:
 * the preflight first (seq, gate, the cached bases' record hashes), stage rounds of objects not
 * `present`, then the record submit; the strip written back; the marker beside the payload; the
 * `--out`/`--bases` cache and its deltas; the gate; the discovery check; `--dry-run`.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { releaseRecordClaims } from "@polaris-key/client-core/record";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { publishPack, runPkey, type PackPublishOptions } from "../src/index.js";
import { runAction } from "../src/action.js";
import { capture, cleanup, instant } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  kaykitUnstripped,
  kaykitV2,
  l10nTrees,
  manyEntries,
  packRepo,
  packServer,
  sha,
  SLUG,
  testReleaseKey,
  writeFiles,
  writeTestPck,
  type PackRepoOptions,
} from "./packFixtures.js";

afterEach(cleanup);

const key = testReleaseKey();
const pck = (files: [string, Uint8Array][]) => writeTestPck(files);

async function setup(
  o: PackRepoOptions = {},
  files?: Record<string, Uint8Array>,
) {
  const cwd = await packRepo(
    key,
    files ?? {
      "default/diceroll.core3d.pck": pck(kaykitUnstripped()),
      ...l10nTrees(),
    },
    o,
  );
  return { cwd, server: packServer() };
}

function opts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  over: Partial<PackPublishOptions> = {},
) {
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      deliverable: "diceroll.core3d",
      version: "1.0.0",
      dir: "dist",
      out: "cache",
      bases: "cache",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: 1_759_300_000,
      ...over,
    } satisfies PackPublishOptions,
  };
}

const payloadOf = (jws: string) =>
  JSON.parse(
    Buffer.from(jws.split(".")[1]!, "base64url").toString(),
  ) as PackRecordDoc;

describe("publishing a godot.pck pack", () => {
  it("strips, writes back, signs, stages every object, submits, and writes the marker and the cache", async () => {
    const { cwd, server } = await setup();
    const { io, o } = opts(cwd, server);
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    const file = path.join(cwd, "dist/default/diceroll.core3d.pck");
    const onDisk = new Uint8Array(await readFile(file));
    // The record hashes the stripped bytes, which are now the file on disk.
    const v = res.record!.variants[0]!;
    expect(v.payload).toEqual({ size: onDisk.byteLength, sha256: sha(onDisk) });
    expect(res.variants[0]!.stripped).toEqual([
      "project.binary",
      ".godot/global_script_class_cache.cfg",
    ]);
    expect(onDisk.byteLength).toBeLessThan(pck(kaykitUnstripped()).byteLength);
    // The first call is the preflight (no objects), then tickets, PUTs, stage rounds, submit.
    const uploads = server.to("/release/publish/uploads");
    expect(uploads[0]!.body).toEqual({
      releases: [{ deliverable: "diceroll.core3d", version: "1.0.0" }],
    });
    expect(server.puts()).toHaveLength(res.objects.length);
    expect(res.uploaded).toHaveLength(res.objects.length);
    expect(server.to("/release/publish/stage")).toHaveLength(1);
    const submit = server.to("/release/publish/submit")[0]!.body as {
      record: string;
    };
    expect(Object.keys(submit)).toEqual(["record"]);
    expect(submit.record).toBe(res.recordJws);
    // The signed record verifies with the test release key and passes the record claims.
    const verified = await verifyJws(
      res.recordJws!,
      { [key.kid]: key.publicKey },
      {
        typ: "pkey-release+jws",
      },
    );
    expect(verified).not.toBeNull();
    expect(
      releaseRecordClaims(verified!.payload, {
        expectedAud: SLUG,
        nonWire: verified!.nonWireIntegers,
      }),
    ).toBe(true);
    expect(payloadOf(res.recordJws!)).toMatchObject({
      kind: "pack",
      deliverable: "diceroll.core3d",
      version: "1.0.0",
      seq: 1,
      type: "godot.pck",
      formatVersion: 4,
      handler: {
        mountOrder: 2,
        prefixes: ["res://assets/kaykit/"],
        activation: "restart",
      },
      provenance: {
        commit: expect.any(String),
        workflowRun: expect.any(String),
      },
    });
    expect(v.requires).toEqual({ engine: "godot-4.7" });
    expect(v.deltas).toBeUndefined();
    expect(v.files).toMatchObject({
      format: "pkey-files/1",
      layout: "container",
    });
    expect(v.files.gaps).toBeDefined();
    // The marker sits beside the payload and pins the record.
    const marker = JSON.parse(
      await readFile(`${file}.pkey.json`, "utf8"),
    ) as Record<string, string>;
    expect(marker).toEqual({
      format: "pkey-marker/1",
      packId: "diceroll.core3d",
      version: "1.0.0",
      release: res.recordJws,
    });
    // The cache for --bases.
    expect(
      (
        await readFile(
          path.join(cwd, "cache/diceroll.core3d/1.0.0/record.jws"),
          "utf8",
        )
      ).trim(),
    ).toBe(res.recordJws);
    const cached = await readFile(
      path.join(cwd, "cache/diceroll.core3d/1.0.0/default/diceroll.core3d.pck"),
    );
    expect(sha(cached)).toBe(v.payload.sha256);
    expect(io.out()).toContain("Published diceroll.core3d@1.0.0 (created)");
  });

  it("publishing v2 after v1 uploads only new objects and adds deltas proven by seqs[].recordSha256", async () => {
    const { cwd, server } = await setup();
    const first = await publishPack(opts(cwd, server).o);
    const v1Objects = new Set(first.objects);
    await writeFiles(path.join(cwd, "dist"), {
      "default/diceroll.core3d.pck": pck(kaykitV2()),
    });
    const putsBefore = server.puts().length;
    const { io, o } = opts(cwd, server, { version: "1.1.0" });
    const second = await publishPack(o);
    expect(io.err()).toContain("re-import noise");
    const fresh = second.objects.filter((s) => !v1Objects.has(s));
    expect(server.puts().length - putsBefore).toBe(fresh.length);
    expect(second.uploaded).toHaveLength(fresh.length);
    expect(second.skipped).toHaveLength(second.objects.length - fresh.length);
    expect(fresh.length).toBeLessThan(second.objects.length);
    // The preflight named the cached version, and the answer proved it.
    const preflight = server
      .to("/release/publish/uploads")
      .find(
        (c) =>
          (c.body as { objects?: unknown }).objects === undefined &&
          JSON.stringify(c.body).includes("1.1.0"),
      )!;
    expect(preflight.body).toEqual({
      releases: [
        { deliverable: "diceroll.core3d", version: "1.1.0" },
        { deliverable: "diceroll.core3d", version: "1.0.0" },
      ],
    });
    const v = second.record!.variants[0]!;
    expect(second.record!.seq).toBe(2);
    expect(v.deltas!.map((d) => [d.scope, d.from])).toEqual([
      ["payload", first.record!.variants[0]!.payload.sha256],
      ["files", first.record!.variants[0]!.payload.sha256],
    ]);
    for (const d of v.deltas!) expect(d.memBytes).toBeGreaterThan(0);
    expect(io.out()).toMatch(
      /payload delta from 1\.0\.0 \d+; files delta from 1\.0\.0 \d+/,
    );
  });

  it("a cached base whose record Polaris Key does not store gets no delta and a warning", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    server.stored.set("diceroll.core3d@1.0.0", {
      seq: 1,
      recordSha256: "0".repeat(64),
    });
    await writeFiles(path.join(cwd, "dist"), {
      "default/diceroll.core3d.pck": pck(kaykitV2()),
    });
    const { io, o } = opts(cwd, server, { version: "1.1.0" });
    const res = await publishPack(o);
    expect(res.record!.variants[0]!.deltas).toBeUndefined();
    expect(io.err()).toContain(
      "base diceroll.core3d 1.0.0: the cached record is not the one Polaris Key stores",
    );
  });

  it("a proven base whose cached payload was tampered with gets no delta and a warning", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    await writeFile(
      path.join(cwd, "cache/diceroll.core3d/1.0.0/default/diceroll.core3d.pck"),
      pck(kaykitV2()),
    );
    await writeFiles(path.join(cwd, "dist"), {
      "default/diceroll.core3d.pck": pck(kaykitV2()),
    });
    const { io, o } = opts(cwd, server, { version: "1.1.0" });
    const res = await publishPack(o);
    expect(res.record!.variants[0]!.deltas).toBeUndefined();
    expect(io.err()).toMatch(
      /base diceroll\.core3d 1\.0\.0 \(default\): the cached payload is not the record's .*no delta from it/,
    );
  });

  it("an asserted gate that differs from the pack's (set) gate stops before any upload", async () => {
    const extra = `    diceroll.hd:
      kind: pack
      type: files.tree
      entitlement: hd
`;
    const { cwd, server } = await setup(
      { extraPacks: extra },
      {
        "default/hi.txt": new TextEncoder().encode("hd\n"),
      },
    );
    server.gate = "premium";
    await expect(
      publishPack(opts(cwd, server, { deliverable: "diceroll.hd" }).o),
    ).rejects.toThrow(
      /asserts diceroll\.hd is gated by hd, but its delivery gate is premium: set it under Distribution → Access first/,
    );
    expect(server.puts()).toEqual([]);
    expect(server.to("/release/publish/uploads")).toHaveLength(1);
  });

  it("refuses a ticket that leaves out a requested object, before staging", async () => {
    const { cwd, server } = await setup();
    server.dropFromTicket = true;
    await expect(publishPack(opts(cwd, server).o)).rejects.toThrow(
      /answered a ticket without 1 of the \d+ requested objects/,
    );
    expect(server.to("/release/publish/stage")).toEqual([]);
    expect(server.to("/release/publish/submit")).toEqual([]);
  });

  it("signs the delivery gate as entitlement and stages every object gated; an assertion the gate lacks stops before any upload", async () => {
    const extra = `    diceroll.hd:
      kind: pack
      type: files.tree
      entitlement: hd
`;
    const files = { "default/hi.txt": new TextEncoder().encode("hd\n") };
    const { cwd, server } = await setup({ extraPacks: extra }, files);
    // Gate unset: the assertion cannot be honoured.
    const refused = opts(cwd, server, { deliverable: "diceroll.hd" });
    await expect(publishPack(refused.o)).rejects.toThrow(
      /asserts diceroll\.hd is gated by hd, but its delivery gate is none: set it under Distribution → Access first/,
    );
    expect(server.puts()).toEqual([]);
    expect(server.to("/release/publish/uploads")).toHaveLength(1); // the preflight only
    // Gate set: signed, and every ticket object is gated.
    server.gate = "hd";
    const { o } = opts(cwd, server, { deliverable: "diceroll.hd" });
    const res = await publishPack(o);
    expect(payloadOf(res.recordJws!).entitlement).toBe("hd");
    const tickets = server
      .to("/release/publish/uploads")
      .filter((c) => (c.body as { objects?: unknown }).objects);
    for (const t of tickets)
      for (const obj of (t.body as { objects: { gated: boolean }[] }).objects)
        expect(obj.gated).toBe(true);
  });

  it("refuses without release.packs in discovery, before any upload", async () => {
    const { cwd, server } = await setup();
    server.packs = false;
    await expect(publishPack(opts(cwd, server).o)).rejects.toThrow(
      /does not advertise release\.packs/,
    );
    expect(server.to("/release/publish/uploads")).toEqual([]);
  });

  it("refuses a lint failure with every path, before any request", async () => {
    const files = {
      "default/diceroll.core3d.pck": pck([
        ...kaykitV2(),
        ["assets/kaykit/roll.gd", new TextEncoder().encode("extends Node\n")],
      ]),
      ...l10nTrees(),
    };
    const { cwd, server } = await setup({}, files);
    await expect(publishPack(opts(cwd, server).o)).rejects.toThrow(
      /Lint failed; nothing was published:\n {2}diceroll\.core3d\.pck: assets\/kaykit\/roll\.gd: a script/,
    );
    expect(server.calls).toEqual([]);
  });

  it("retries a failed stage round once with a new ticket", async () => {
    const { cwd, server } = await setup();
    server.failStage = 1;
    const { io, o } = opts(cwd, server);
    await publishPack(o);
    expect(io.err()).toContain("retrying with a new ticket");
    expect(server.to("/release/publish/stage")).toHaveLength(2);
  });

  it("an existing version is refused, and a pack without a release key cannot publish", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    await expect(publishPack(opts(cwd, server).o)).rejects.toThrow(
      /already published/,
    );
    const { o } = opts(cwd, server, {
      version: "1.2.0",
      releaseKeyPem: undefined,
    });
    await expect(publishPack(o)).rejects.toThrow(
      /A pack release is a signed release record/,
    );
  });
});

describe("--dry-run", () => {
  it("prints the lint, the gate, objects new and deduplicated, bytes per strategy and the unsigned record; writes nothing", async () => {
    const { cwd, server } = await setup();
    const before = await readFile(
      path.join(cwd, "dist/default/diceroll.core3d.pck"),
    );
    const { io, o } = opts(cwd, server, { dryRun: true });
    const res = await publishPack(o);
    const text = io.out();
    expect(text).toContain(
      "strip would remove project.binary, .godot/global_script_class_cache.cfg",
    );
    expect(text).toContain("Lint: ok");
    expect(text).toContain("delivery gate: none (ungated)");
    expect(text).toMatch(/Objects: \d+ new, 0 already stored \(deduplicated\)/);
    expect(text).toMatch(/bytes per strategy: full \d+; file \d+/);
    expect(text).toContain("Pack record (unsigned; a dry run signs nothing)");
    expect(text).toContain("Dry run: nothing uploaded, signed or written.");
    expect(res.recordJws).toBeUndefined();
    expect(server.puts()).toEqual([]);
    expect(server.to("/release/publish/stage")).toEqual([]);
    expect(server.to("/release/publish/submit")).toEqual([]);
    expect(
      await readFile(path.join(cwd, "dist/default/diceroll.core3d.pck")),
    ).toEqual(before);
    await expect(
      stat(path.join(cwd, "dist/default/diceroll.core3d.pck.pkey.json")),
    ).rejects.toThrow();
    await expect(stat(path.join(cwd, "cache"))).rejects.toThrow();
  });

  it("without a credential stops before the network", async () => {
    const { cwd, server } = await setup();
    const { io, o } = opts(cwd, server, { dryRun: true, env: {} });
    await publishPack(o);
    expect(io.out()).toContain("Server checks: skipped");
    expect(server.calls).toEqual([]);
  });

  it("warns that a tree base starting 37 A4 30 EC gets no zstd-patch-from frame", async () => {
    const magic = (edit: number) => {
      const b = new Uint8Array(4096);
      b.set([0x37, 0xa4, 0x30, 0xec]);
      for (let i = 4; i < b.length; i++) b[i] = (i * 7) & 0xff;
      b[2000] = edit;
      return b;
    };
    const tree = (edit: number) => ({
      "locale=en/dict.bin": magic(edit),
      "locale=fr/dict.bin": magic(edit + 1),
    });
    const { cwd, server } = await setup(
      {},
      { ...tree(1), "default/x.pck": pck(kaykitV2()) },
    );
    await publishPack(opts(cwd, server, { deliverable: "diceroll.l10n" }).o);
    await writeFiles(path.join(cwd, "dist"), tree(50));
    const { io, o } = opts(cwd, server, {
      deliverable: "diceroll.l10n",
      version: "1.1.0",
      dryRun: true,
    });
    const res = await publishPack(o);
    expect(io.err()).toContain(
      "warning: locale=en: files delta from 1.0.0: dict.bin's base starts with the zstd dictionary magic 37 A4 30 EC, so it ships as a blob entry (§2.7 rule 5)",
    );
    for (const v of res.record!.variants)
      for (const d of v.deltas ?? []) expect(d.scope).toBe("files");
  });
});

describe("a Diceroll-sized pack", () => {
  it("625 entries in three variants with deltas: the signed record stays under the cap and every zstd ref carries size", async () => {
    const variants = "      variants:\n        texture: [s3tc, etc2, astc]\n";
    const make = (edit: number) => {
      const files: Record<string, Uint8Array> = { ...l10nTrees() };
      for (const t of ["s3tc", "etc2", "astc"]) {
        const entries = manyEntries(625).map(
          ([p, b], i): [string, Uint8Array] =>
            i % 40 === 0 && edit
              ? [p, new TextEncoder().encode(`${t} ${i} edited ${edit}\n`)]
              : [p, b],
        );
        files[`texture=${t}/core3d.pck`] = pck(entries);
      }
      return files;
    };
    const { cwd, server } = await setup({ core3dVariants: variants }, make(0));
    await publishPack(opts(cwd, server).o);
    await writeFiles(path.join(cwd, "dist"), make(1));
    const res = await publishPack(opts(cwd, server, { version: "1.1.0" }).o);
    const record = payloadOf(res.recordJws!);
    expect(record.variants.map((v) => v.variant.texture)).toEqual([
      "astc",
      "etc2",
      "s3tc",
    ]);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(65536);
    expect(res.recordJws!.length).toBeLessThan(MAX_RECORD_JWS_BYTES);
    for (const v of record.variants) {
      expect(v.deltas).toHaveLength(2);
      const refs = [
        v.full,
        v.files,
        v.files.gaps!,
        ...v.deltas!.flatMap((d) => ("patch" in d ? [d.patch] : [])),
      ];
      for (const r of refs) {
        expect(Number.isSafeInteger(r.size)).toBe(true);
        if (r.codec === "none") expect(r.bytes).toBe(r.size);
      }
    }
    expect(
      await verifyJws(
        res.recordJws!,
        { [key.kid]: key.publicKey },
        { typ: "pkey-release+jws" },
      ),
    ).not.toBeNull();
  }, 120_000);
});

describe("the CLI", () => {
  it("pkey release publish --deliverable <packId> dispatches to the pack publish", async () => {
    const { cwd, server } = await setup();
    const io = capture();
    const code = await runPkey(
      [
        "release",
        "publish",
        "--product",
        SLUG,
        "--deliverable",
        "diceroll.core3d",
        "--version",
        "1.0.0",
        "--dir",
        "dist",
        "--base-url",
        BASE,
        "--out",
        "cache",
        "--dry-run",
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
    expect(io.out()).toContain(
      "Pack diceroll.core3d@1.0.0 (godot.pck), 1 variant",
    );
  });

  it("refuses flags that do not apply instead of ignoring them", async () => {
    const { cwd, server } = await setup();
    const run = async (args: string[]) => {
      const io = capture();
      const code = await runPkey(
        [
          "release",
          "publish",
          "--product",
          SLUG,
          "--dir",
          "dist",
          "--version",
          "1.0.0",
          ...args,
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
      return { code, err: io.err() };
    };
    expect(
      await run([
        "--deliverable",
        "diceroll.core3d",
        "--content-stamp",
        "x.json",
      ]),
    ).toEqual({
      code: 1,
      err: "--content-stamp does not apply here: --deliverable diceroll.core3d is a pack; these stamp an app release's packs.\n",
    });
    expect(
      (
        await run([
          "--deliverable",
          "diceroll.core3d",
          "--pin",
          "a.b@1",
          "--embedded",
          "d",
        ])
      ).err,
    ).toContain("--embedded, --pin do not apply here");
    expect((await run(["--out", "cache"])).err).toContain(
      "--out does not apply here: they keep and read a pack's earlier releases; the app takes neither.",
    );
    expect((await run(["--pin"])).err).toBe(
      "--pin needs a value: --pin <packId>@<version>.\n",
    );
    expect(server.calls).toEqual([]);
  });

  it("the Action refuses inputs that do not apply", async () => {
    const { cwd, server } = await setup();
    const input = (o: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
      );
    for (const [over, msg] of [
      [
        { deliverable: "diceroll.core3d", pins: "diceroll.l10n@1.0.0" },
        "pins does not apply to a pack deliverable",
      ],
      [
        { deliverable: "app", out: "cache", bases: "cache" },
        "out, bases do not apply to the app",
      ],
    ] as const) {
      const io = capture();
      const code = await runAction({
        env: {
          ...actionsEnv(),
          ...input({
            product: SLUG,
            dir: "dist",
            version: "1.0.0",
            "base-url": BASE,
            ...over,
          }),
        },
        cwd,
        stdout: io.stdout,
        stderr: io.stderr,
        fetchImpl: server.fetchImpl,
        sleep: instant,
        exec: () => "v1.5.7",
      });
      expect(code).toBe(1);
      expect(io.err()).toContain(msg);
    }
    expect(server.calls).toEqual([]);
  });

  it("the Action publishes a pack from its inputs and writes release-id and outcome", async () => {
    const { cwd, server } = await setup();
    const output = path.join(cwd, "gh_output");
    await writeFile(output, "");
    const io = capture();
    const input = (o: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]),
      );
    const code = await runAction({
      env: {
        ...actionsEnv({ GITHUB_OUTPUT: output }),
        ...input({
          product: SLUG,
          deliverable: "diceroll.core3d",
          version: "1.0.0",
          dir: "dist",
          out: "cache",
          bases: "cache",
          "base-url": BASE,
          "release-key": key.pem,
          "dry-run": "false",
        }),
      },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      exec: () => "v1.5.7",
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "release-id=diceroll.core3d@1.0.0\noutcome=created\n",
    );
    expect(io.out()).not.toContain(key.pem.split("\n")[1]!);
  });
});
