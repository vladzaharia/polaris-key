// @pkey-feature sync.settings
// `account_required` on the Node host (U-52): the machine is saved as it stands and stays blocked
// across a relaunch (the refused subject is not signed in again), the offered `signInUrl` is
// vetted, a key-ring or file `account_required` reaches the machine, and a request in flight when
// that happens has its answer dropped.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolarisKeyClient } from "../src/client.js";
import { NodeFileTransport } from "../src/cloudSync/files.js";
import { writeStoredSubject } from "../src/identity/account.js";
import {
  CATALOG,
  SUBJECT,
  TOKEN,
  World,
  open,
  stateFile,
} from "./cloudSyncFixtures.js";

const OTHER = "ps_bbbbbbbbbbbbbbbbbbbbbb";
type Api = {
  flush(): Promise<unknown>;
  beforeSignOut(): Promise<void>;
};
const api = (c: PolarisKeyClient) =>
  (c as unknown as { cloudSyncApi: Api }).cloudSyncApi;

const refusal = (signInUrl?: string) =>
  new Response(
    JSON.stringify({
      error: {
        code: "account_required",
        ...(signInUrl !== undefined ? { signInUrl } : {}),
      },
    }),
    { status: 403 },
  );

async function signedIn(w: World, stateDir = tmpdir_()) {
  const client = await open(w, stateDir, { catalog: CATALOG(1) });
  await client.keyring.create();
  await client.cloudSyncHost.start();
  client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
  await api(client).flush();
  return { client, stateDir };
}
/** The session's stored subject, as a relaunch finds it. */
const session = (c: PolarisKeyClient, subject: string | null) =>
  writeStoredSubject(
    (c as unknown as { core: { dirs: { state: string } } }).core.dirs.state,
    subject,
  );
const tmpdir_ = () => mkdtempSync(join(tmpdir(), "pkey-carequired-"));

/** A refused client closed and opened again on its state, the session naming `subject`; no ring. */
async function relaunched(w: World, subject: string) {
  const { client, stateDir } = await signedIn(w);
  await refuse(client, w);
  await session(client, subject);
  client.close();
  const again = await open(w, stateDir, { catalog: CATALOG(1) }, false);
  await again.cloudSync.flush();
  return again;
}

/** The 403 a push earns once the account is gone; returns the client's offers. */
async function refuse(client: PolarisKeyClient, w: World, url?: string) {
  const offers: Array<string | null> = [];
  client.events.on("cloudSync", (e) => {
    if (e.type === "signInOffered") offers.push(e.signInUrl);
  });
  w.push = () => refusal(url);
  await client.config.set("theme", "dark");
  await api(client).flush();
  return offers;
}

describe("the blocked machine survives a relaunch", () => {
  it("is saved without the person's partition, root or open names, and relaunches blocked", async () => {
    const w = new World();
    const { client, stateDir } = await signedIn(w);
    await refuse(client, w);
    expect(client.cloudSync.status()).toMatchObject({
      state: "blocked",
      reason: "account_required",
    });
    expect(client.keyring.unlocked).toBe(false);
    const saved = JSON.parse(readFileSync(stateFile(stateDir), "utf8"));
    expect(saved.persisted.blocked).toBe("account_required");
    expect(saved.persisted.subject).toBeNull();
    expect(saved.openKeys).toEqual([]);
    expect(Object.keys(saved.persisted.partitions)).not.toContain(SUBJECT);
    expect(JSON.stringify(saved)).not.toContain('"dark"');
    expect(saved.refused).toBe(SUBJECT);
    await session(client, SUBJECT);
    client.close();

    // A relaunch (no ring): the session still names the refused subject; nothing is sent.
    const again = await open(w, stateDir, { catalog: CATALOG(1) }, false);
    w.seen = [];
    await again.cloudSync.flush();
    expect(again.cloudSync.status().state).toBe("blocked");
    expect(w.syncReqs).toEqual([]);
    // An edit made while blocked is the device's own and is kept for the next sign-in.
    await again.config.set("theme", "light");
    await api(again).flush();
    expect(w.syncReqs).toEqual([]);
    expect(again.config.get("theme", "none")).toBe("light");
    again.close();
  });

  it("a different subject lifts it", async () => {
    const again = await relaunched(new World(), OTHER);
    // Signed in as the new subject; with no ring on this launch the machine is locked, not blocked.
    expect(again.cloudSync.status().state).toBe("locked");
    again.close();
  });

  it("a sign-out forgets the refusal: the same subject back is the person's to make", async () => {
    const again = await relaunched(new World(), SUBJECT);
    expect(again.cloudSync.status().state).toBe("blocked");
    again.events.safeEmit("identity", { kind: "signedOut", released: false });
    await api(again).flush();
    again.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
    await api(again).flush();
    expect(again.cloudSync.status().state).toBe("locked");
    again.close();
  });
});

describe("the offered signInUrl is vetted", () => {
  const cases: Array<[string | undefined, string | null]> = [
    ["https://k.test/signin", "https://k.test/signin"],
    ["/signin?x=1", "https://k.test/signin?x=1"],
    [undefined, null],
    ["https://evil.test/signin", null],
    ["http://k.test/signin", null],
    ["https://k.test.evil.test/signin", null],
    ["https://k.test:8443/signin", null],
    ["https://k.test@evil.test/signin", null],
    ["//evil.test/signin", null],
    ["javascript:alert(1)", null],
    ["https://k.test/sign in", null],
    ["https://k.test/sign\nin", null],
  ];
  for (const [given, offered] of cases)
    it(`${JSON.stringify(given)} is offered as ${JSON.stringify(offered)}`, async () => {
      const w = new World();
      const { client } = await signedIn(w);
      expect(await refuse(client, w, given)).toEqual([offered]);
      client.close();
    });
});

describe("a key-ring or file account_required reaches the machine", () => {
  it("a key-ring route does, and the call still throws its own error", async () => {
    const w = new World();
    const base = w.fetch;
    let ringRefused = false;
    w.fetch = (async (input: string | URL, init?: RequestInit) =>
      ringRefused &&
      new URL(String(input)).pathname.endsWith("/devices/keyring")
        ? refusal("https://k.test/signin")
        : base(input, init)) as typeof fetch;
    const { client } = await signedIn(w);
    const offers: Array<string | null> = [];
    client.events.on("cloudSync", (e) => {
      if (e.type === "signInOffered") offers.push(e.signInUrl);
    });
    await client.config.set("theme", "dark");
    ringRefused = true;
    await expect(client.keyring.read()).rejects.toMatchObject({
      code: "account_required",
    });
    await api(client).flush();
    expect(client.cloudSync.status().state).toBe("blocked");
    expect(client.keyring.unlocked).toBe(false);
    expect(offers).toEqual(["https://k.test/signin"]);
    client.close();
  });

  it("a file route does: the transport tells its owner with the answer's URL", async () => {
    const told: Array<string | null> = [];
    const body = JSON.stringify({
      error: { code: "account_required", signInUrl: "https://k.test/in" },
    });
    const transport = new NodeFileTransport({
      ctx: {
        product: "djdl",
        baseUrl: "https://k.test",
        requestTimeoutMs: 15_000,
        headers: (extra = {}) => extra,
        plainFetcher: () =>
          (async () => new Response(body, { status: 403 })) as typeof fetch,
      },
      token: () => TOKEN,
      onAccountRequired: (u) => told.push(u),
    });
    const r = await transport.revisions(
      { collection: "saves", record: "slot-1" },
      {},
    );
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "account_required",
    });
    expect(told).toEqual(["https://k.test/in"]);
  });

  it("other refusals are not account_required", async () => {
    const told: Array<string | null> = [];
    const transport = new NodeFileTransport({
      ctx: {
        product: "djdl",
        baseUrl: "https://k.test",
        requestTimeoutMs: 15_000,
        headers: (extra = {}) => extra,
        plainFetcher: () =>
          (async () =>
            new Response(JSON.stringify({ error: { code: "forbidden" } }), {
              status: 403,
            })) as typeof fetch,
      },
      token: () => TOKEN,
      onAccountRequired: (u) => told.push(u),
    });
    await transport.revisions({ collection: "saves", record: "slot-1" }, {});
    expect(told).toEqual([]);
  });
});

describe("a request in flight when account_required arrives", () => {
  it("has its answer dropped: nothing throws and the machine stays blocked", async () => {
    const w = new World();
    const base = w.fetch;
    let release: (() => void) | null = null;
    let holdPush = false;
    let held: Promise<void> | null = null;
    w.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (holdPush && url.pathname.endsWith("/sync/ops")) {
        held = new Promise<void>((r) => (release = r));
        await held;
      }
      if (url.pathname.endsWith("/devices/keyring") && holdPush)
        return refusal();
      return base(input, init);
    }) as typeof fetch;
    const { client } = await signedIn(w);
    holdPush = true;
    await client.config.set("theme", "dark");
    const flushing = client.cloudSync.flush();
    // The push is on the wire; the key ring learns the account is gone.
    for (let i = 0; i < 200 && release === null; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(release).not.toBeNull();
    await expect(client.keyring.read()).rejects.toMatchObject({
      code: "account_required",
    });
    expect(client.cloudSync.status().state).toBe("blocked");
    release!();
    await expect(flushing).resolves.toMatchObject({ state: "blocked" });
    expect(client.cloudSync.status().state).toBe("blocked");
    client.close();
  });
});
