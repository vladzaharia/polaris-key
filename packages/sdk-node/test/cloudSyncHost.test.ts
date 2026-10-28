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
import { describe, expect, it } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import type { Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { createNodeDeviceKeyStore } from "../src/devices/deviceKeys.js";

const PRODUCT = "djdl";
const TOKEN = `pkeyt_${"T".repeat(43)}`;
const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";

/** A store that holds the device token and nothing else. */
const memStore = (): Store => {
  let token: string | null = TOKEN;
  return {
    getToken: async () => token,
    setToken: async (t: string) => void (token = t),
    clearToken: async () => void (token = null),
    getDeviceId: async () => "DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB",
    readCache: async () => null,
    writeCache: async () => {},
    clearCache: async () => {},
  } as never;
};

const entry = (key: string, user: object = {}) => ({
  key,
  kind: "config",
  category: "ui",
  label: key,
  description: key,
  schema: { type: "string" },
  user: { sync: "user", conflict: "lastWrite", ...user },
});
const CATALOG = (version: number) => ({
  schemaVersion: version,
  entries: [entry("theme")],
});

type Body = Record<string, unknown>;

/** The quota and usage members every answer carries. */
const ROOM = {
  usage: { files: 0, records: 0, settings: 0, bytes: 0 },
  quota: { files: true, bytes: 2 ** 28 },
};

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Body | undefined;
}

class World {
  seen: Seen[] = [];
  schemaFetches = 0;
  schema: unknown = CATALOG(1);
  /** What the next pull / push answers (a function so a test can act mid-request). */
  pull: (url: URL) => Response | Body = () => this.body();
  version = 100;
  /** Accepts every mutation. */
  push: (body: Body) => Response | Body = (body) =>
    this.body({
      results: (body.mutations as Array<{ mutationId: number }>).map((m) => ({
        mutationId: m.mutationId,
        status: "ok",
        version: ++this.version,
      })),
    });

  body(over: Body = {}): Body {
    return {
      subject: SUBJECT,
      serverNow: 1_700_000_000_000,
      cursor: 0,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      ...ROOM,
      encryption: "e2e",
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }

  get syncReqs(): Seen[] {
    return this.seen.filter((r) => r.path.startsWith(`/${PRODUCT}/sync`));
  }

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Body)
      : undefined;
    this.seen.push({
      method,
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body,
    });
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    const wrap = (r: Response | Body) => (r instanceof Response ? r : j(r));
    if (url.pathname === `/${PRODUCT}/devices/keyring` && method === "POST")
      return j({ ringId: body!.ringId, epoch: 1 }, 201);
    if (url.pathname === `/${PRODUCT}/config/schema`) {
      this.schemaFetches++;
      return j(this.schema);
    }
    if (url.pathname === `/${PRODUCT}/sync` && method === "GET")
      return wrap(this.pull(url));
    if (url.pathname === `/${PRODUCT}/sync/ops` && method === "POST")
      return wrap(this.push(body!));
    return j({}, 404);
  }) as typeof fetch;
}

/** A client over `stateDir`; `keys` gives it a key ring (a relaunch passes none). */
async function open(
  w: World,
  stateDir: string,
  cloudSync: object,
  keys = true,
) {
  const client = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    store: memStore(),
    fetchImpl: w.fetch,
    stateDir,
    expectedServices: ["license", "config", "sync"],
    ...(keys
      ? { keyring: { deviceKeys: createNodeDeviceKeyStore({ memory: true }) } }
      : {}),
    cloudSync,
  });
  await client.init();
  return client;
}

async function rig(w: World, opts: { catalog?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-csync-"));
  const client = await open(
    w,
    stateDir,
    opts.catalog === false ? {} : { catalog: CATALOG(1), encryption: "e2e" },
  );
  return { client, host: client.cloudSyncHost, stateDir };
}

/** A rig with a created ring (the root held), the host started and `SUBJECT` signed in. */
async function live(w: World) {
  const r = await rig(w);
  await r.client.keyring.create();
  await r.host.start();
  r.host.machine.signIn(SUBJECT);
  await r.host.touch();
  return r;
}

/** The state file: the SDK namespaces its state directory, so find it below `dir`. */
function stateFile(dir: string): string {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const f = stateFile(p);
      if (f !== "") return f;
    } else if (e.name === "cloud-sync.json") return p;
  }
  return "";
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

  it("fetches the catalog once when none is cached or compiled, and again when catalogVersion changes", async () => {
    const w = new World();
    const r = await rig(w, { catalog: false });
    await r.client.keyring.create();
    await r.host.start();
    expect(w.schemaFetches).toBe(1);
    w.schema = CATALOG(2);
    w.pull = () => w.body({ catalogVersion: 2 });
    r.host.machine.signIn(SUBJECT);
    await r.host.touch();
    expect(w.schemaFetches).toBe(2);
    // A Worker that keeps naming a version it does not serve is not asked again.
    w.pull = () => w.body({ catalogVersion: 3 });
    await r.host.touch();
    r.host.machine.flush();
    await r.host.touch();
    await r.host.touch();
    expect(w.schemaFetches).toBeLessThanOrEqual(3);
    // The catalog is cached beside the journal.
    const saved = JSON.parse(readFileSync(stateFile(r.stateDir), "utf8"));
    expect(saved.catalog.schemaVersion).toBe(2);
    r.client.close();
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
