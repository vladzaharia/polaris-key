/**
 * P4-13 — `pkey release revoke` (plans/P4-13.md §2.3, §6.5) and `pkey release content-stamp
 * --hold` (§2.4, decision 17).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { holdsOf, parseContentStamp } from "@polaris-key/client-core/packs";
import {
  releaseRecordClaims,
  revocationOf,
} from "@polaris-key/client-core/record";
import {
  readContentStamp,
  revokePackRelease,
  runPkey,
  writeContentStampFile,
} from "../src/index.js";
import { capture, cleanup, instant } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  packRepo,
  packServer,
  SLUG,
  testReleaseKey,
} from "./packFixtures.js";

afterEach(cleanup);

const key = testReleaseKey();
const H = (c: string) => c.repeat(64);
const NOW = 1_800_000_000;

const FOES = `    diceroll.foes:
      kind: pack
      type: files.tree
      binding: compatible
      requires:
        contentApi: { app: ">=4 <5" }
`;

async function setup() {
  const cwd = await packRepo(key, {}, { extraPacks: FOES });
  const server = packServer();
  server.stored.set("diceroll.l10n@1.0.0", { seq: 1, recordSha256: H("a") });
  server.stored.set("diceroll.l10n@1.0.1", { seq: 2, recordSha256: H("b") });
  server.stored.set("diceroll.core3d@1.0.0", { seq: 1, recordSha256: H("c") });
  server.stored.set("diceroll.foes@1.3.4", { seq: 7, recordSha256: H("d") });
  return { cwd, server };
}

function revokeOpts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  over: Partial<Parameters<typeof revokePackRelease>[0]> = {},
) {
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      target: "diceroll.l10n@1.0.0",
      reason: "Exploit in the menu strings",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: () => NOW,
      ...over,
    },
  };
}

function payloadOf(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString());
}

describe("pkey release revoke", () => {
  it("signs a kind: revocation record naming the target with its replacement and submits it as {record}", async () => {
    const { cwd, server } = await setup();
    const { io, o } = revokeOpts(cwd, server, { replacement: "1.0.1" });
    const res = await revokePackRelease(o);
    expect(io.err()).toBe("");
    expect(res.record).toEqual({
      schemaVersion: 1,
      aud: SLUG,
      deliverable: "diceroll.l10n",
      kind: "revocation",
      version: "1.0.0",
      seq: 1,
      issuedAt: NOW,
      revokes: H("a"),
      replacement: { sha256: H("b"), seq: 2, version: "1.0.1" },
      reason: "Exploit in the menu strings",
    });
    const submits = server.to("/release/publish/submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.body).toEqual({ record: res.jws });
    expect(server.revoked).toEqual([res.jws]);
    // The record verifies under the declared release key, passes the claims and revocationOf.
    const v = await verifyJws(
      res.jws,
      { [key.kid]: key.publicKey },
      { typ: "pkey-release+jws" },
    );
    expect(v).not.toBeNull();
    expect(
      releaseRecordClaims(v!.payload, {
        expectedAud: SLUG,
        nonWire: v!.nonWireIntegers,
      }),
    ).toBe(true);
    expect(revocationOf(v!.payload, v!.nonWireIntegers)).toEqual({
      pack: "diceroll.l10n",
      target: H("a"),
      replacement: { sha256: H("b"), seq: 2, version: "1.0.1" },
      reason: "Exploit in the menu strings",
      issuedAt: NOW,
    });
    expect(io.out()).toContain(`sha256 ${res.sha256}`);
    expect(io.out()).toContain("Revoked diceroll.l10n@1.0.0 (revoked)");
  });

  it("revokes without a replacement", async () => {
    const { cwd, server } = await setup();
    const { o } = revokeOpts(cwd, server);
    const res = await revokePackRelease(o);
    expect(payloadOf(res.jws)).not.toHaveProperty("replacement");
    expect(revocationOf(payloadOf(res.jws))?.replacement).toBeNull();
  });

  it("--dry-run prints the signed record and its hash and submits nothing", async () => {
    const { cwd, server } = await setup();
    const { io, o } = revokeOpts(cwd, server, { dryRun: true });
    const res = await revokePackRelease(o);
    expect(server.to("/release/publish/submit")).toHaveLength(0);
    expect(res.server).toBeNull();
    expect(io.out()).toContain(res.jws);
    expect(io.out()).toContain(res.sha256);
    expect(io.out()).toContain("Dry run: nothing submitted.");
  });

  it("refuses against a Worker whose discovery does not advertise release.revocations", async () => {
    const { cwd, server } = await setup();
    server.revocations = false;
    const { o } = revokeOpts(cwd, server);
    await expect(revokePackRelease(o)).rejects.toThrow(
      /does not advertise release\.revocations/,
    );
    expect(server.to("/release/publish/submit")).toHaveLength(0);
  });

  it("refuses a bad reason, an undeclared pack, an unstored target, a replacement equal to the target and a missing key", async () => {
    const { cwd, server } = await setup();
    const run = (over: Partial<Parameters<typeof revokePackRelease>[0]>) =>
      revokePackRelease(revokeOpts(cwd, server, over).o);
    await expect(run({ reason: "" })).rejects.toThrow(/--reason must be 1–512/);
    await expect(run({ reason: "x".repeat(513) })).rejects.toThrow(
      /--reason must be 1–512 bytes \(got 513\)/,
    );
    await expect(run({ reason: "é".repeat(256) })).resolves.toBeDefined();
    await expect(run({ target: "diceroll.other@1.0.0" })).rejects.toThrow(
      /not a pack \.pkey\/release declares/,
    );
    await expect(run({ target: "diceroll.l10n@9.9.9" })).rejects.toThrow(
      /revoke diceroll\.l10n@9\.9\.9: Polaris Key stores no record/,
    );
    await expect(run({ replacement: "1.0.0" })).rejects.toThrow(
      /names the revoked release itself/,
    );
    await expect(
      run({ releaseKeyPem: undefined, env: actionsEnv() }),
    ).rejects.toThrow(/set PKEY_RELEASE_KEY/);
    expect(server.revoked).toHaveLength(1); // only the 256 × "é" (512-byte) reason
  });

  it("is reachable as a CLI command (PKEY_RELEASE_KEY from the environment)", async () => {
    const { cwd, server } = await setup();
    const io = capture();
    const code = await runPkey(
      [
        "release",
        "revoke",
        "diceroll.l10n@1.0.0",
        "--replacement",
        "1.0.1",
        "--reason",
        "Broken strings",
        "--product",
        SLUG,
        "--base-url",
        BASE,
      ],
      {
        cwd,
        stdout: io.stdout,
        stderr: io.stderr,
        env: { ...actionsEnv(), PKEY_RELEASE_KEY: key.pem },
        fetchImpl: server.fetchImpl,
        sleep: instant,
      },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(server.revoked).toHaveLength(1);
    expect(payloadOf(server.revoked[0]!)).toMatchObject({
      kind: "revocation",
      deliverable: "diceroll.l10n",
      revokes: H("a"),
      reason: "Broken strings",
    });
    const usage = capture();
    expect(
      await runPkey(["release", "revoke", "diceroll.l10n@1.0.0"], {
        cwd,
        stdout: usage.stdout,
        stderr: usage.stderr,
      }),
    ).toBe(1);
    expect(usage.err()).toMatch(/Usage: pkey release revoke/);
  });
});

describe("pkey release content-stamp --hold", () => {
  function stampOpts(
    cwd: string,
    server: ReturnType<typeof packServer>,
    holds: string[],
  ) {
    const io = capture();
    return {
      io,
      o: {
        cwd,
        product: SLUG,
        out: "pkey-content.json",
        pins: ["diceroll.core3d@1.0.0"],
        holds,
        baseUrl: BASE,
        env: actionsEnv(),
        stdout: io.stdout,
        stderr: io.stderr,
        fetchImpl: server.fetchImpl,
        sleep: instant,
      },
    };
  }

  it("resolves a hold through the preflight and writes it into the stamp's holds", async () => {
    const { cwd, server } = await setup();
    const { io, o } = stampOpts(cwd, server, [
      "diceroll.foes@1.3.4=Balance pass pending",
    ]);
    const { content } = await writeContentStampFile(o);
    const hold = {
      pack: "diceroll.foes",
      release: { sha256: H("d"), seq: 7, version: "1.3.4" },
      reason: "Balance pass pending",
    };
    expect(content.holds).toEqual([hold]);
    const text = await readFile(path.join(cwd, "pkey-content.json"), "utf8");
    // parseContentStamp ignores holds; holdsOf reads them.
    const parsed = parseContentStamp(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.content).not.toHaveProperty("holds");
    expect(holdsOf(JSON.parse(text), undefined, "")).toEqual([hold]);
    // And the app publish's --content-stamp carries them into the descriptor's content.
    expect(
      (await readContentStamp(path.join(cwd, "pkey-content.json"))).holds,
    ).toEqual([hold]);
    expect(io.out()).toMatch(
      /hold diceroll\.foes@1\.3\.4 \(seq 7, record d{12}…\) — Balance pass pending/,
    );
  });

  it("a stamp without holds has no holds member", async () => {
    const { cwd, server } = await setup();
    const { o } = stampOpts(cwd, server, []);
    await writeContentStampFile(o);
    const text = await readFile(path.join(cwd, "pkey-content.json"), "utf8");
    expect(JSON.parse(text)).not.toHaveProperty("holds");
  });

  it("refuses a pinned pack, a pack that is not compatible, a duplicate, an unstored release and a bad reason", async () => {
    const { cwd, server } = await setup();
    const run = (holds: string[]) =>
      writeContentStampFile(stampOpts(cwd, server, holds).o);
    await expect(run(["diceroll.core3d@1.0.0"])).rejects.toThrow(
      /a pinned pack is never held/,
    );
    await expect(run(["diceroll.l10n@1.0.0"])).rejects.toThrow(
      /its binding is pinned; a hold keeps a compatible pack/,
    );
    await expect(
      run(["diceroll.foes@1.3.4", "diceroll.foes@1.3.4"]),
    ).rejects.toThrow(/given twice/);
    await expect(run(["diceroll.foes@9.0.0"])).rejects.toThrow(
      /--hold diceroll\.foes@9\.0\.0: Polaris Key stores no record/,
    );
    await expect(
      run(["diceroll.foes@1.3.4=" + "r".repeat(201)]),
    ).rejects.toThrow(/reason after "=" must be 1–200 characters/);
    await expect(run(["foes"])).rejects.toThrow(/--hold foes must be/);
  });

  it("is reachable as a CLI command with repeatable --hold", async () => {
    const { cwd, server } = await setup();
    const io = capture();
    const code = await runPkey(
      [
        "release",
        "content-stamp",
        "--product",
        SLUG,
        "--out",
        "stamp.json",
        "--pin",
        "diceroll.core3d@1.0.0",
        "--hold",
        "diceroll.foes@1.3.4",
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
    ) as { holds: unknown[] };
    expect(stamp.holds).toEqual([
      {
        pack: "diceroll.foes",
        release: { sha256: H("d"), seq: 7, version: "1.3.4" },
      },
    ]);
  });
});
