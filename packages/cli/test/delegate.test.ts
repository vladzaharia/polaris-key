/**
 * P4-19 — content-key delegation in the CLI (plans/P4-19.md §6.4): `pkey release keys generate
 * --content`, `pkey release delegate`, a content-key `pkey release publish` of a data-only pack,
 * and `pkey release revoke --delegation`. Every key is generated at run time; none is committed.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  delegationHashOf,
  revocationOf,
  verifyReleaseRecord,
} from "@polaris-key/client-core/record";
import {
  delegateContentKey,
  generateContentKey,
  publishPack,
  revokeDelegation,
  runPkey,
  type PackPublishOptions,
} from "../src/index.js";
import { runAction } from "../src/action.js";
import { capture, cleanup, instant, tempDir } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  packRepo,
  packServer,
  sha,
  SLUG,
  testReleaseKey,
} from "./packFixtures.js";

afterEach(cleanup);

const key = testReleaseKey();
const NOW = 1_800_000_000;
const DAY = 86_400;
const PACK = "diceroll.events.halloween";

const EVENTS = `    ${PACK}:
      kind: pack
      type: files.tree
      binding: standalone
    diceroll.pinnedtree:
      kind: pack
      type: files.tree
`;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);
const dataFiles = (): Record<string, Uint8Array> => ({
  "default/data/events.json": new TextEncoder().encode('{"events": [1, 2]}\n'),
  "default/img/banner.png": PNG,
  "pinned/default/data/x.json": new TextEncoder().encode("{}\n"),
});

async function setup(files: Record<string, Uint8Array> = dataFiles()) {
  const cwd = await packRepo(key, files, { extraPacks: EVENTS });
  return { cwd, server: packServer() };
}

/** A content key in a temp dir, through the CLI's own generator. */
async function contentKey() {
  const dir = await tempDir();
  const out = path.join(dir, "content.pem");
  const g = await generateContentKey({ out });
  return { ...g, pem: await readFile(out, "utf8") };
}

function delegateOpts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  publicKey: string,
  over: Partial<Parameters<typeof delegateContentKey>[0]> = {},
) {
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      prefix: "diceroll.events",
      types: "files.tree,data.json",
      publicKey,
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

function publishOpts(
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
      deliverable: PACK,
      version: "1.0.0",
      dir: "dist",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      now: NOW + DAY,
      ...over,
    } satisfies PackPublishOptions,
  };
}

const payloadOf = (jws: string) =>
  JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;

describe("pkey release keys generate --content", () => {
  it("writes a 0600 PKCS#8 PEM, prints the public key and never overwrites", async () => {
    const dir = await tempDir();
    const io = capture();
    const code = await runPkey(
      ["release", "keys", "generate", "--content", "--out", "content.pem"],
      { cwd: dir, stdout: io.stdout, stderr: io.stderr },
    );
    expect(code).toBe(0);
    const file = path.join(dir, "content.pem");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(io.out()).toMatch(/Public key: [A-Za-z0-9_-]{43}\n/);
    expect(io.out()).not.toContain("kid:");
    const again = capture();
    expect(
      await runPkey(
        ["release", "keys", "generate", "--content", "--out", "content.pem"],
        { cwd: dir, stdout: again.stdout, stderr: again.stderr },
      ),
    ).toBe(1);
    expect(again.err()).toContain("never written over an existing file");
  });
});

describe("pkey release delegate", () => {
  it("takes seq from nextSeq, signs a usable delegation and submits {record}", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    server.delegationRows.push({
      sha256: "a".repeat(64),
      deliverable: "diceroll.events",
      seq: 2,
      keyFingerprint: "b".repeat(64),
      issuedAt: NOW - DAY,
      expiresAt: NOW + DAY,
      origin: "submit",
      revoked: true,
      version: "1",
      jws: "x",
    });
    const { io, o } = delegateOpts(cwd, server, ck.publicKey, {
      notes: "Events team",
    });
    const res = await delegateContentKey(o);
    expect(io.err()).toBe("");
    expect(server.to("/release/publish/delegations")[0]!.body).toEqual({
      deliverable: "diceroll.events",
    });
    expect(res.record).toMatchObject({
      kind: "delegation",
      deliverable: "diceroll.events",
      version: "3",
      seq: 3,
      issuedAt: NOW,
      expiresAt: NOW + 180 * DAY,
      delegate: { publicKey: ck.publicKey },
      types: ["files.tree", "data.json"],
      notes: "Events team",
    });
    expect(server.submits.at(-1)).toEqual({ record: res.jws });
    expect(res.sha256).toBe(sha(res.jws!));
    expect(res.kid).toBe(`pkd1-${res.sha256}`);
    expect(io.out()).toContain(`Content kid: pkd1-${res.sha256}`);
  });

  it("--dry-run prints the unsigned body and signs nothing", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const { io, o } = delegateOpts(cwd, server, ck.publicKey, {
      dryRun: true,
      releaseKeyPem: undefined,
      expiresInDays: 30,
    });
    const res = await delegateContentKey(o);
    expect(res.jws).toBeNull();
    expect(res.record.expiresAt).toBe(NOW + 30 * DAY);
    expect(server.submits).toHaveLength(0);
    expect(io.out()).toContain("Delegation record (unsigned");
    expect(io.out()).toContain("Dry run: nothing signed or submitted.");
  });

  it("refuses a key any delegation already names, revoked or not", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    server.delegationRows.push({
      sha256: "c".repeat(64),
      deliverable: "diceroll.other",
      seq: 1,
      keyFingerprint: ck.fingerprint,
      issuedAt: NOW - DAY,
      expiresAt: NOW + DAY,
      origin: "revocation",
      revoked: true,
      version: "1",
      jws: "x",
    });
    const { o } = delegateOpts(cwd, server, ck.publicKey);
    await expect(delegateContentKey(o)).rejects.toThrow(
      /one content key, one delegation/,
    );
    expect(server.submits).toHaveLength(0);
  });

  it("refuses a declared release key, a non-delegable type and a window over 366 days", async () => {
    const { cwd, server } = await setup();
    await expect(
      delegateContentKey(delegateOpts(cwd, server, key.publicKey).o),
    ).rejects.toThrow(/declared release key/);
    const ck = await contentKey();
    await expect(
      delegateContentKey(
        delegateOpts(cwd, server, ck.publicKey, { types: "godot.pck" }).o,
      ),
    ).rejects.toThrow(/can never be delegated/);
    await expect(
      delegateContentKey(
        delegateOpts(cwd, server, ck.publicKey, { expiresInDays: 367 }).o,
      ),
    ).rejects.toThrow(/1 to 366/);
    expect(server.calls).toHaveLength(0);
  });

  it("refuses a Worker whose discovery predates delegations", async () => {
    const { cwd, server } = await setup();
    server.delegations = false;
    const ck = await contentKey();
    await expect(
      delegateContentKey(delegateOpts(cwd, server, ck.publicKey).o),
    ).rejects.toThrow(/release.delegations/);
  });

  it("keeps the signed delegation when the submit fails after signing", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    server.failSubmit = 409;
    const { o } = delegateOpts(cwd, server, ck.publicKey);
    const err = await delegateContentKey(o).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const m = /kept at (\S+pkey-delegation-([0-9a-f]{64})\.jws)/.exec(
      (err as Error).message,
    );
    expect(m).not.toBeNull();
    const file = m![1]!;
    expect(path.dirname(file)).toBe(cwd);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const jws = (await readFile(file, "utf8")).trim();
    expect(sha(jws)).toBe(m![2]);
    expect(payloadOf(jws).kind).toBe("delegation");
  });
});

/** Delegate `ck` through the CLI against `server`, returning the delegation's hash. */
async function delegated(
  cwd: string,
  server: ReturnType<typeof packServer>,
  ck: { publicKey: string },
  over: Partial<Parameters<typeof delegateContentKey>[0]> = {},
): Promise<string> {
  const res = await delegateContentKey(
    delegateOpts(cwd, server, ck.publicKey, over).o,
  );
  return res.sha256!;
}

describe("pkey release publish with a content key", () => {
  it("signs under pkd1-<delegation>, verifies through the delegation and submits", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const d = await delegated(cwd, server, ck);
    const { io, o } = publishOpts(cwd, server, {
      contentKeyPem: ck.pem,
      delegation: d,
    });
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    expect(io.out()).toContain("Data-only: every file passes");
    expect(delegationHashOf(res.recordJws!)).toBe(d);
    expect(res.record!.issuedAt).toBe(NOW + DAY);
    const v = await verifyReleaseRecord(res.recordJws!, {
      releaseKeys: { [key.kid]: key.publicKey },
      productTrust: {},
      expectedAud: SLUG,
      expectedHash: sha(res.recordJws!),
      delegation: server.records.get(d)!,
    });
    expect(v.ok && v.delegation?.sha256).toBe(d);
    expect(server.submits.at(-1)).toEqual({ record: res.recordJws });
  });

  it("warns within 14 days of the window's end", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const d = await delegated(cwd, server, ck, { expiresInDays: 10 });
    const { io, o } = publishOpts(cwd, server, {
      contentKeyPem: ck.pem,
      delegation: d,
    });
    await publishPack(o);
    expect(io.err()).toMatch(/window closes .* within 14 days/);
  });

  it("refuses a pack outside the scope, a type the delegation does not cover and a closed window", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const narrow = await delegated(cwd, server, ck, {
      prefix: "diceroll.lore",
    });
    await expect(
      publishPack(
        publishOpts(cwd, server, { contentKeyPem: ck.pem, delegation: narrow })
          .o,
      ),
    ).rejects.toThrow(/outside the delegation's scope/);
    const ck2 = await contentKey();
    const dataOnly = await delegated(cwd, server, ck2, { types: "data.json" });
    await expect(
      publishPack(
        publishOpts(cwd, server, {
          contentKeyPem: ck2.pem,
          delegation: dataOnly,
        }).o,
      ),
    ).rejects.toThrow(/not files\.tree/);
    const ck3 = await contentKey();
    const d3 = await delegated(cwd, server, ck3, { expiresInDays: 1 });
    await expect(
      publishPack(
        publishOpts(cwd, server, {
          contentKeyPem: ck3.pem,
          delegation: d3,
          now: NOW + 2 * DAY,
        }).o,
      ),
    ).rejects.toThrow(/does not hold now/);
  });

  it("refuses another key than the delegated one", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const other = await contentKey();
    const d = await delegated(cwd, server, ck);
    await expect(
      publishPack(
        publishOpts(cwd, server, { contentKeyPem: other.pem, delegation: d }).o,
      ),
    ).rejects.toThrow(/is not the key delegation/);
  });

  it("refuses a file the data-only rule refuses, before any request", async () => {
    const { cwd, server } = await setup({
      ...dataFiles(),
      "default/scripts/boot.gd": new TextEncoder().encode("extends Node\n"),
      "default/data/scene.json": new TextEncoder().encode("[gd_scene]\n"),
      // plans/P4-19.md Amendment A1: an inline script object in a text file.
      "default/data/cfg.txt": new TextEncoder().encode(
        'x = Object(GDScript,"script/source":"extends Node")\n',
      ),
    });
    const ck = await contentKey();
    const err = await publishPack(
      publishOpts(cwd, server, {
        contentKeyPem: ck.pem,
        delegation: "d".repeat(64),
      }).o,
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/data-only rule refused 3 files/);
    expect((err as Error).message).toContain("default/data/cfg.txt");
    expect((err as Error).message).toMatch(/rename such keys or reword/);
    expect((err as Error).message).toContain("default/scripts/boot.gd");
    expect((err as Error).message).toContain("default/data/scene.json");
    expect(server.calls).toHaveLength(0);
  });

  it("names the content key, never PKEY_RELEASE_KEY, when its PEM is unreadable", async () => {
    const { publicKeyOfPem } = await import("../src/releaseKeys.js");
    expect(() =>
      publicKeyOfPem("not a pem", "The content key (PKEY_CONTENT_KEY)"),
    ).toThrow(/^The content key \(PKEY_CONTENT_KEY\) is not a PEM/);
  });

  it("refuses a pinned pack and a release key beside a content key", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    await expect(
      publishPack(
        publishOpts(cwd, server, {
          deliverable: "diceroll.pinnedtree",
          dir: "dist/pinned",
          contentKeyPem: ck.pem,
          delegation: "d".repeat(64),
        }).o,
      ),
    ).rejects.toThrow(/compatible or standalone/);
    await expect(
      publishPack(
        publishOpts(cwd, server, {
          contentKeyPem: ck.pem,
          releaseKeyPem: key.pem,
          delegation: "d".repeat(64),
        }).o,
      ),
    ).rejects.toThrow(/Both a release key .* and a content key/);
    expect(server.calls).toHaveLength(0);
  });

  it("the Action's content-key and delegation inputs, exclusive of release-key", async () => {
    const { cwd, server } = await setup();
    const io = capture();
    const code = await runAction({
      env: actionsEnv({
        INPUT_PRODUCT: SLUG,
        INPUT_DIR: "dist",
        INPUT_DELIVERABLE: PACK,
        INPUT_VERSION: "1.0.0",
        "INPUT_RELEASE-KEY": key.pem,
        "INPUT_CONTENT-KEY": "x",
      }),
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
    });
    expect(code).toBe(1);
    expect(io.err()).toContain("release-key and content-key are exclusive");
  });
});

describe("pkey release revoke --delegation", () => {
  it("revokes a stored delegation by hash: its deliverable, version and seq, no replacement", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    const d = await delegated(cwd, server, ck);
    const io = capture();
    const res = await revokeDelegation({
      cwd,
      product: SLUG,
      delegation: d,
      reason: "Content key retired.",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: () => NOW + 5,
    });
    expect(res.supplied).toBe(false);
    expect(res.record).toEqual({
      schemaVersion: 1,
      aud: SLUG,
      deliverable: "diceroll.events",
      kind: "revocation",
      version: "1",
      seq: 1,
      issuedAt: NOW + 5,
      revokes: d,
      reason: "Content key retired.",
    });
    expect(server.submits.at(-1)).toEqual({ record: res.jws });
    expect(revocationOf(payloadOf(res.jws))?.target).toBe(d);
    // The delegation came from the authenticated read route, never the record route.
    expect(server.to("/release/records/")).toHaveLength(0);
  });

  it("supplies a delegation from a file the Worker never stored as {record, delegation}", async () => {
    const { cwd, server } = await setup();
    const ck = await contentKey();
    server.failSubmit = 503;
    const err = await delegateContentKey(
      delegateOpts(cwd, server, ck.publicKey).o,
    ).catch((e: Error) => e);
    const file = /kept at (\S+\.jws)/.exec((err as Error).message)![1]!;
    const jws = (await readFile(file, "utf8")).trim();
    expect(server.records.has(sha(jws))).toBe(false);
    const io = capture();
    const res = await revokeDelegation({
      cwd,
      product: SLUG,
      delegation: path.basename(file),
      reason: "Leaked before it was stored.",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: () => NOW + 9,
    });
    expect(res.supplied).toBe(true);
    expect(server.submits.at(-1)).toEqual({ record: res.jws, delegation: jws });
  });

  it("the CLI wiring refuses --replacement and needs --reason", async () => {
    const { cwd } = await setup();
    const io = capture();
    const code = await runPkey(
      [
        "release",
        "revoke",
        "--delegation",
        "e".repeat(64),
        "--reason",
        "x",
        "--replacement",
        "1.0.0",
        "--product",
        SLUG,
      ],
      { cwd, stdout: io.stdout, stderr: io.stderr, env: {} },
    );
    expect(code).toBe(1);
    expect(io.err()).toContain("no release replaces a delegation");
  });
});
