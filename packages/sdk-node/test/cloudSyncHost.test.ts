// @pkey-feature sync.e2e
// The Node Cloud Sync host (U-06.2): client-core's `CloudSyncMachine` driven over bearer HTTP, with
// the host codec on both sides, against a small fake of the Worker's `/sync` routes. It pins the
// security points of plans/U-sync-clients-slices.md section 9 that a host owns: a locked ring sends
// nothing (S3), a forged `sealed` flag is ignored (S1), a plaintext row below `encryptionSince` is
// legacy data and one above it is not, a conflict's server copy opens against the mutation's own
// setting, an answer that cannot be opened never advances the cursor (S10), the state file is 0600,
// and no module of the licence path reaches the host.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import type { Store } from "@polaris-key/client-core";
import type { PolarisKeyClient } from "../src/client.js";
import { CATALOG_REFETCH_MS, CloudSyncHost } from "../src/cloudSync/host.js";
import { CloudSyncStateFile } from "../src/cloudSync/state.js";
import { readCappedText } from "../src/core/boundedBody.js";
import {
  CATALOG,
  PRODUCT,
  ROOM,
  SUBJECT,
  TOKEN,
  World,
  entry,
  open,
  stateFile,
  type Body,
} from "./cloudSyncFixtures.js";

async function rig(w: World, opts: { catalog?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-csync-"));
  const client = await open(
    w,
    stateDir,
    opts.catalog === false ? {} : { catalog: CATALOG(1), encryption: "e2e" },
  );
  return { client, host: client.cloudSyncHost, stateDir };
}

/** A host over the client's own parts, with a clock the test moves. */
const timed = (
  client: PolarisKeyClient,
  mirror?: object,
  subject?: () => Promise<string | null>,
) => {
  const clock = { t: 1_700_000_000_000 };
  const inner = client as unknown as { core: never; tokens: never };
  const host = new CloudSyncHost(
    {
      ctx: inner.core,
      tokens: inner.tokens,
      keyring: client.keyring,
      discovery: () => null,
      fetchSchema: () => client.config.fetchSchema(),
      document: () => ({ values: {} }),
      clock: { now: () => clock.t },
      ...(subject ? { subject } : {}),
    },
    mirror ? { catalog: mirror as never } : {},
  );
  return { host, clock };
};

/** A rig with a created ring (the root held), the host started and `SUBJECT` signed in. */
async function live(w: World) {
  const r = await rig(w);
  await r.client.keyring.create();
  await r.host.start();
  r.host.machine.signIn(SUBJECT);
  await r.host.touch();
  return r;
}

const ct = async (
  c: PolarisKeyClient,
  name: string,
  value: string,
): Promise<string> =>
  base64UrlEncodeBytes(await c.keyring.codec.seal("$settings", name, value));

const change = (over: Body): Body => ({
  setting: "theme",
  scope: "user",
  version: 5,
  editedHlc: "0199c82cc000:0000",
  updatedBy: "c_AAAAAAAAAAAAAAAAAAAAAA",
  ...over,
});

describe("cloud sync host: the ring gates every request (S3)", () => {
  it("a locked ring sends nothing, edits stay on the device, and an unlock sends them sealed", async () => {
    const w = new World();
    const { client, host } = await rig(w);
    await host.start();
    host.machine.signIn(SUBJECT);
    host.machine.set("theme", "dark");
    await host.flush(1000);
    expect(w.syncReqs).toEqual([]);
    expect(host.machine.status()).toMatchObject({
      state: "locked",
      reason: "keyring",
    });
    expect(host.machine.get("theme").value).toBe("dark");

    await client.keyring.create();
    await host.touch();
    // The first request is a pull (the Worker is not yet confirmed e2e); then the push is sealed.
    const push = w.syncReqs.find((r) => r.method === "POST");
    expect(push).toBeDefined();
    const m = (push!.body!.mutations as Array<Body>)[0]!;
    expect(m).toHaveProperty("ct");
    expect(m).not.toHaveProperty("value");
    expect(JSON.stringify(push!.body)).not.toContain("dark");
    expect(push!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(push!.headers.get("x-pkey-device")).toBeTruthy();
    await client.close?.();
  });

  it("an open key leaves blinded and never in the clear", async () => {
    const w = new World();
    const { client, host } = await live(w);
    host.machine.set("notes-private", "x");
    await host.flush(1000);
    const push = w.syncReqs.find((r) => r.method === "POST")!;
    const m = (
      push.body!.mutations as Array<{ target: { setting: string } }>
    )[0]!;
    expect(m.target.setting).not.toContain("notes");
    expect(JSON.stringify(push.body)).not.toContain("notes-private");
    client.close();
  });

  it("a ring locked while a pull is in flight drops the answer and the cursor stays (S10)", async () => {
    const w = new World();
    const { client, host } = await rig(w);
    await client.keyring.create();
    await host.start();
    w.pull = () => {
      client.keyring.lock();
      return w.body({ cursor: 7 });
    };
    host.machine.signIn(SUBJECT);
    await host.touch();
    const p = host.machine.persist().partitions[SUBJECT]!;
    expect(p.cursor).toBe(0);
    client.close();
  });
});

describe("cloud sync host: a wake-up is never lost", () => {
  it("start, then signIn, then touch sends the pull (the touch lands while start's own pump settles)", async () => {
    const w = new World();
    const { client, host } = await rig(w);
    await client.keyring.create();
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.touch();
    expect(w.syncReqs.some((r) => r.method === "GET")).toBe(true);
    client.close();
  });

  it("a touch that lands while the pump saves is run, not dropped", async () => {
    const w = new World();
    const { client, host } = await rig(w);
    await client.keyring.create();
    await host.start();
    host.machine.signIn(SUBJECT);
    const save = CloudSyncStateFile.prototype.save;
    let injected = false;
    const spy = vi
      .spyOn(CloudSyncStateFile.prototype, "save")
      .mockImplementation(async function (this: CloudSyncStateFile, file) {
        if (!injected) {
          injected = true;
          // The pump's loop has looked and found nothing; new work arrives while it saves.
          host.machine.set("theme", "late");
          host.machine.flush();
          void host.touch();
        }
        await new Promise((r) => setTimeout(r, 20));
        return save.call(this, file);
      });
    await host.touch();
    spy.mockRestore();
    expect(w.syncReqs.some((r) => r.method === "POST")).toBe(true);
    client.close();
  });
});

describe("cloud sync host: what a Worker serves is not trusted (S1, S10)", () => {
  it("ignores a forged sealed flag on a plaintext row", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        cursor: 5,
        encryptionSince: 3,
        changes: [
          change({ value: "evil", sealed: true, invalid: false, seq: 1 }),
        ],
      });
    const { client, host } = await live(w);
    expect(host.machine.settingState("theme").invalid).toBe(true);
    expect(host.machine.get("theme").value).not.toBe("evil");
    client.close();
  });

  it("reads a plaintext row below encryptionSince as legacy data, and one at or above it as invalid", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        cursor: 2,
        encryptionSince: 4,
        changes: [change({ value: "legacy", version: 2 })],
      });
    const a = await live(w);
    expect(a.host.machine.settingState("theme").invalid).toBe(false);
    expect(a.host.machine.get("theme").value).toBe("legacy");
    a.client.close();

    const w2 = new World();
    w2.pull = () =>
      w2.body({
        cursor: 6,
        encryptionSince: 4,
        changes: [change({ value: "late", version: 6 })],
      });
    const b = await live(w2);
    expect(b.host.machine.settingState("theme").invalid).toBe(true);
    b.client.close();
  });

  it("opens a sealed row, and marks an unopenable ct invalid", async () => {
    const w = new World();
    const r = await rig(w);
    await r.client.keyring.create();
    const good = await ct(r.client, "theme", "dark");
    w.pull = () =>
      w.body({ cursor: 5, changes: [change({ ct: good, version: 5 })] });
    await r.host.start();
    r.host.machine.signIn(SUBJECT);
    await r.host.touch();
    expect(r.host.machine.get("theme").value).toBe("dark");
    r.client.close();

    const w2 = new World();
    w2.pull = () =>
      w2.body({ cursor: 5, changes: [change({ ct: "AAAA", version: 5 })] });
    const bad = await live(w2);
    expect(bad.host.machine.settingState("theme").invalid).toBe(true);
    bad.client.close();
  });

  it("opens a conflict's server copy against the mutation's own setting", async () => {
    const w = new World();
    const r = await rig(w);
    await r.client.keyring.create();
    const theirs = await ct(r.client, "theme", "theirs");
    const other = await ct(r.client, "other", "swapped");
    let copy = theirs;
    w.pull = () => w.body({ cursor: 5 });
    w.push = (body) => {
      const [m] = body.mutations as Array<{ mutationId: number }>;
      return w.body({
        cursor: 5,
        results: [
          {
            mutationId: m!.mutationId,
            status: "conflict",
            server: change({ ct: copy, version: 9 }),
          },
        ],
      });
    };
    await r.host.start();
    r.host.machine.signIn(SUBJECT);
    await r.host.touch();
    r.host.machine.set("theme", "mine");
    await r.host.flush(1000);
    expect(r.host.machine.settingState("theme").invalid).toBe(false);
    expect(r.host.machine.get("theme").value).toBe("theirs");
    r.client.close();

    // A copy sealed for another setting is not the mutation's: it reads as invalid.
    const w2 = new World();
    const r2 = await rig(w2);
    await r2.client.keyring.create();
    copy = other;
    w2.pull = w.pull;
    w2.push = w.push;
    await r2.host.start();
    r2.host.machine.signIn(SUBJECT);
    await r2.host.touch();
    r2.host.machine.set("theme", "mine");
    await r2.host.flush(1000);
    expect(r2.host.machine.settingState("theme").invalid).toBe(true);
    r2.client.close();
  });
});

describe("cloud sync host: mode, catalog and state", () => {
  it("a Worker that answers in server mode is not read when the app requires e2e", async () => {
    const w = new World();
    w.pull = () =>
      w.body({
        encryption: "server",
        cursor: 3,
        changes: [change({ value: "plain", version: 3 })],
      });
    const { client, host } = await live(w);
    expect(host.machine.status()).toMatchObject({
      state: "unsupported",
      code: "sync-encryption-pinned",
    });
    expect(host.machine.get("theme").value).not.toBe("plain");
    client.close();
  });

  it("fetches the catalog once when none is cached or compiled, and again only after the refetch window", async () => {
    const w = new World();
    const { client, stateDir } = await rig(w, { catalog: false });
    await client.keyring.create();
    const { host, clock } = timed(client);
    await host.start();
    expect(w.schemaFetches).toBe(1);
    w.schema = CATALOG(2);
    w.pull = () => w.body({ catalogVersion: 2 });
    host.machine.signIn(SUBJECT);
    await host.touch();
    // A Worker alternating versions cannot make the client fetch on every pull.
    expect(w.schemaFetches).toBe(1);
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(2);
    // A version it does not serve is not asked for again, window or not.
    w.pull = () => w.body({ catalogVersion: 3 });
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    const after = w.schemaFetches;
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(after);
    // With no mirror the served catalog is cached beside the journal.
    expect(
      JSON.parse(readFileSync(stateFile(stateDir), "utf8")).catalog,
    ).toMatchObject({ schemaVersion: 2 });
    client.close();
  });

  it("the compiled mirror is authoritative: a served catalog only adds keys, and bad keys are dropped", async () => {
    const w = new World();
    w.schema = {
      schemaVersion: 2,
      entries: [
        entry("theme", { sync: "local" }),
        entry("extra", { sync: "local" }),
        entry("bad key!", { sync: "local" }),
      ],
    };
    const r = await rig(w);
    await r.client.keyring.create();
    await r.host.start();
    w.pull = () => w.body({ catalogVersion: 2 });
    r.host.machine.signIn(SUBJECT);
    await r.host.touch();
    await r.host.touch();
    const m = r.host.machine;
    m.set("theme", "dark");
    m.set("extra", "x");
    expect(m.settingState("theme").sync).not.toBe("local");
    expect(m.settingState("extra").sync).toBe("local");
    // The mirror is never replaced by the served copy in the file.
    const saved = JSON.parse(readFileSync(stateFile(r.stateDir), "utf8"));
    expect(
      saved.catalog.entries.map((e: { key: string }) => e.key),
    ).not.toContain("bad key!");
    r.client.close();
  });

  it("with no mirror a served catalog cannot reclassify an open setting the person already uses", async () => {
    const w = new World();
    const { client } = await rig(w, { catalog: false });
    await client.keyring.create();
    const { host, clock } = timed(client);
    await host.start();
    host.machine.signIn(SUBJECT);
    await host.touch();
    host.machine.set("notes", "mine");
    await host.flush(1000);
    w.schema = {
      schemaVersion: 2,
      entries: [
        entry("notes", { sync: "local" }),
        entry("fresh", { sync: "local" }),
      ],
    };
    w.pull = () => w.body({ catalogVersion: 2 });
    clock.t += CATALOG_REFETCH_MS + 1;
    host.machine.setNetwork("online");
    await host.touch();
    expect(w.schemaFetches).toBe(2);
    expect(host.machine.settingState("notes").sync).not.toBe("local");
    expect(host.machine.settingState("fresh").sync).toBe("local");
    client.close();
  });

  it("junk names a Worker serves cannot push the person's open keys out of the tombstone map", async () => {
    const w = new World();
    const { client, host, stateDir } = await live(w);
    host.machine.set("notes-private", "x");
    await host.flush(1000);
    w.pull = () =>
      w.body({
        cursor: 9,
        encryptionSince: 100,
        changes: Array.from({ length: 5000 }, (_, i) =>
          change({ setting: `junk${i}`, value: i, version: i + 1 }),
        ),
      });
    host.machine.setNetwork("online");
    await host.touch();
    const keys = JSON.parse(readFileSync(stateFile(stateDir), "utf8")).openKeys;
    expect(keys).toContain("notes-private");
    expect(keys.filter((k: string) => k.startsWith("junk"))).toEqual([]);
    client.close();
  });

  it("writes cloud-sync.json with mode 0600 and the journal in it", async () => {
    const w = new World();
    const { client, host, stateDir } = await live(w);
    host.machine.set("theme", "dark");
    await host.flush(1000);
    const file = stateFile(stateDir);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.product).toBe(PRODUCT);
    expect(Object.keys(saved.persisted.partitions)).toContain(SUBJECT);
    expect(
      readdirSync(dirname(file)).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
    client.close();
  });

  it("the journal survives a relaunch", async () => {
    const w = new World();
    const a = await live(w);
    a.host.machine.set("theme", "dark");
    a.host.machine.flush();
    // No push goes out: keep the answer from landing by locking first.
    a.client.keyring.lock();
    await a.host.flush(1000);
    a.client.close();
    const client = await open(w, a.stateDir, { catalog: CATALOG(1) }, false);
    await client.cloudSyncHost.start();
    expect(client.cloudSyncHost.machine.get("theme").value).toBe("dark");
    client.close();
  });
});

describe("cloud sync host: isolation", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
    );

  it("only the client facade imports the Cloud Sync host", () => {
    const importers = sources(SRC)
      .filter((f) => !f.includes(`${SRC}/cloudSync/`))
      .filter((f) =>
        /from\s+["'][^"']*cloudSync\//.test(readFileSync(f, "utf8")),
      )
      .map((f) => f.slice(SRC.length + 1));
    expect(importers.sort()).toEqual(["client.ts"]);
  });
});

describe("cloud sync host: bounded bodies", () => {
  const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(x);
          c.close();
        },
      }),
      { headers },
    );

  it("counts bytes, not string length", async () => {
    // 4 characters, 12 bytes.
    const euro = new TextEncoder().encode("\u20ac\u20ac\u20ac\u20ac");
    expect(await readCappedText(stream([euro]), 12)).toBe("\u20ac".repeat(4));
    expect(await readCappedText(stream([euro]), 11)).toBeNull();
  });

  it("refuses on content-length without reading, and aborts a stream that outgrows its cap", async () => {
    const big = new Response("x", {
      headers: { "content-length": "999999999" },
    });
    expect(await readCappedText(big)).toBeNull();
    let pulled = 0;
    const endless = new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
        },
      }),
    );
    expect(await readCappedText(endless, 4096)).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("fetchSchema answers null for an oversized catalog", async () => {
    const w = new World();
    const { client } = await rig(w);
    w.schemaLength = String(2 ** 30);
    expect(await client.config.fetchSchema()).toBeNull();
    client.close();
  });
});

describe("cloud sync host: requests are bound to the person they were queued for", () => {
  it("a request queued for one person is never sent once the session is another's", async () => {
    const w = new World();
    const { client } = await rig(w);
    await client.keyring.create();
    const now = { v: SUBJECT as string | null };
    const { host } = timed(client, undefined, async () => now.v);
    await host.start();
    host.machine.signIn(SUBJECT);
    host.bindSubject(SUBJECT);
    await host.touch();
    const before = w.syncReqs.length;
    host.machine.set("theme", "P1-VALUE");
    now.v = "P2";
    await host.flush(1000);
    expect(w.syncReqs.slice(before)).toEqual([]);
    client.close();
  });

  it("an unknown subject still sends", async () => {
    const w = new World();
    const { client } = await rig(w);
    await client.keyring.create();
    const { host } = timed(client, undefined, async () => null);
    await host.start();
    host.machine.signIn(SUBJECT);
    host.bindSubject(SUBJECT);
    await host.touch();
    const before = w.syncReqs.length;
    host.machine.set("theme", "offline-boot");
    await host.flush(1000);
    expect(w.syncReqs.slice(before).some((r) => r.method === "POST")).toBe(
      true,
    );
    client.close();
  });
});
