// @pkey-feature sync.settings config.sync
// The Cloud Sync settings API on the Node client (U-06.3): `config.set` and `clear` through the
// machine while a principal is held, `setting(k).sync()`, `onConfigChange` with `origin`,
// `client.cloudSync.status()` / `flush()` and the `cloudSync` event, the one-time import of
// `local-config.json`, and the identity subject driving the machine. Security (S6): every way the
// machine leaves a principal forgets the key ring, and the licence state is never touched.

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import {
  CATALOG,
  PRODUCT,
  SUBJECT,
  TOKEN,
  World,
  memStore,
  open,
  stateFile,
} from "./cloudSyncFixtures.js";

/** A signed-in rig: a ring (root held), the host started and `SUBJECT` signed in through the
 *  identity session's event, the way a real sign-in reaches the client. */
async function signedIn(
  w: World,
  over: { entries?: object; store?: Store } = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "pkey-csettings-"));
  const client = await open(w, stateDir, { catalog: CATALOG(1) }, true, over);
  await client.keyring.create();
  await client.cloudSyncHost.start();
  client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
  await settle(client);
  return { client, stateDir };
}

const settle = async (c: PolarisKeyClient) => {
  await (
    c as unknown as { cloudSyncApi: { flush(): Promise<unknown> } }
  ).cloudSyncApi.flush();
};

const signOutHook = (c: PolarisKeyClient) =>
  (
    c as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
  ).cloudSyncApi.beforeSignOut();

describe("config.set and clear through the machine", () => {
  it("applies, reports origin, and sync() goes pending then synced", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    const changes: Array<{ value: unknown; origin: string }> = [];
    client.config.onConfigChange("theme", (c) => changes.push(c));
    const setting = client.config.setting<string>("theme");
    await setting.set("dark");
    expect(client.config.get("theme", "x")).toBe("dark");
    expect(client.config.getConfigSource("theme")).toBe("local");
    expect(setting.sync()).toBe("pending");
    expect(changes).toEqual([
      expect.objectContaining({ value: "dark", origin: "local" }),
    ]);
    await client.cloudSync.flush();
    expect(setting.sync()).toBe("synced");
    expect(
      w.syncReqs.some((r) => r.method === "POST" && r.body?.mutations),
    ).toBe(true);
    await setting.clear();
    expect(setting.value).toBeNull();
    client.close();
  });

  it("refuses in machine order: bad_request for an invalid value", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    await expect(client.config.set("theme", 5 as never)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(client.config.get("theme", "none")).toBe("none");
    client.close();
  });

  it("refuses managed_by_admin for a key the operator locked", async () => {
    const w = new World();
    const { client } = await signedIn(w, {
      entries: { theme: { state: "enforced", value: "light" } },
    });
    await expect(client.config.set("theme", "dark")).rejects.toMatchObject({
      code: "managed_by_admin",
    });
    client.close();
  });

  it("without a principal config.set keeps the legacy local file and sync() is local", async () => {
    const w = new World();
    const stateDir = mkdtempSync(join(tmpdir(), "pkey-csettings-"));
    const client = await open(w, stateDir, { catalog: CATALOG(1) });
    await client.config.set("theme", "dark");
    expect(client.config.get("theme", "x")).toBe("dark");
    expect(client.config.setting("theme").sync()).toBe("local");
    expect(client.config.localValues()).toEqual({ theme: "dark" });
    client.close();
  });
});

describe("client.cloudSync", () => {
  it("status() and flush() answer, and the typed N/A names a product without Sync", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    expect(client.cloudSync.status()).toMatchObject({ pending: 0 });
    const seen: string[] = [];
    client.events.on("cloudSync", (e) => seen.push(e.type));
    await client.config.set("theme", "dark");
    const s = await client.cloudSync.flush();
    expect(s.pending).toBe(0);
    expect(seen).toContain("change");
    client.close();

    const off = new PolarisKeyClient({
      productSlug: PRODUCT,
      baseUrl: "https://k.test",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: memStore(),
      fetchImpl: w.fetch,
      stateDir: mkdtempSync(join(tmpdir(), "pkey-csettings-")),
      expectedServices: ["license"],
    });
    await off.init();
    expect(() => off.cloudSync.status()).toThrow(/sync/);
    off.close();
  });
});

describe("importLocal of local-config.json", () => {
  it("runs once: the legacy value is pushed, and a second sign-in does not import again", async () => {
    const w = new World();
    const stateDir = mkdtempSync(join(tmpdir(), "pkey-csettings-"));
    const first = await open(w, stateDir, { catalog: CATALOG(1) });
    await first.config.set("theme", "legacy");
    first.close();
    const client = await open(w, stateDir, { catalog: CATALOG(1) });
    await client.keyring.create();
    client.events.safeEmit("identity", { kind: "signedIn", subject: SUBJECT });
    await settle(client);
    const m = client.cloudSyncHost.machine;
    expect(m.persist().imported).toBe(true);
    const spy = vi.spyOn(m, "importLocal");
    const wasImported = m.persist().imported;
    client.cloudSyncHost.machine.signIn(SUBJECT);
    expect(wasImported).toBe(true);
    expect(client.config.get("theme", "x")).toBe("legacy");
    expect(spy).not.toHaveBeenCalled();
    client.close();
  });
});

describe("the identity subject drives the machine; leaving forgets the ring (S6)", () => {
  it("a sign-out flushes, forgets the ring, then offers sign-in", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    const order: string[] = [];
    client.events.on("cloudSync", (e) => order.push(e.type));
    await client.config.set("theme", "dark");
    expect(client.keyring.unlocked).toBe(true);
    await (
      client as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
    ).cloudSyncApi.beforeSignOut();
    expect(client.keyring.unlocked).toBe(false);
    expect(order.indexOf("signedOut")).toBeGreaterThan(-1);
    expect(order[order.length - 1]).toBe("signInOffered");
    expect(
      w.syncReqs.some((r) => r.method === "POST" && r.body?.mutations),
    ).toBe(true);
    client.close();
  });

  it("account_required forgets the ring and offers sign-in with the URL", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    const offers: unknown[] = [];
    client.events.on("cloudSync", (e) => {
      if (e.type === "signInOffered") offers.push(e.signInUrl);
    });
    w.push = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "account_required",
            signInUrl: "https://k.test/signin",
          },
        }),
        { status: 403 },
      );
    await client.config.set("theme", "dark");
    await client.cloudSync.flush();
    expect(client.keyring.unlocked).toBe(false);
    expect(offers).toEqual(["https://k.test/signin"]);
    client.close();
  });

  it("a forget that fails is logged away and does not replace the sign-out", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    vi.spyOn(client.keyring, "forget").mockRejectedValue(new Error("disk"));
    await expect(
      (
        client as unknown as {
          cloudSyncApi: { beforeSignOut(): Promise<void> };
        }
      ).cloudSyncApi.beforeSignOut(),
    ).resolves.toBeUndefined();
    client.close();
  });

  it("an identity sign-out event with no state held does nothing and fails nothing", async () => {
    const w = new World();
    const stateDir = mkdtempSync(join(tmpdir(), "pkey-csettings-"));
    const client = await open(w, stateDir, { catalog: CATALOG(1) });
    client.events.safeEmit("identity", { kind: "signedOut", released: false });
    await settle(client);
    expect(client.cloudSync.status().state).toBe("local");
    client.close();
  });

  it("never touches licence state", async () => {
    const w = new World();
    const store = memStore();
    const { client } = await signedIn(w, { store });
    const clear = vi.spyOn(store, "clearToken");
    const wipe = vi.spyOn(client.license, "wipeLocal");
    const before = JSON.stringify(client.license.status());
    await client.config.set("theme", "dark");
    await (
      client as unknown as { cloudSyncApi: { beforeSignOut(): Promise<void> } }
    ).cloudSyncApi.beforeSignOut();
    expect(clear).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
    expect(JSON.stringify(client.license.status())).toBe(before);
    expect(await store.getToken()).toBe(TOKEN);
    client.close();
  });

  it("deletes the synced data on sign-out and does not write it back", async () => {
    const w = new World();
    const { client, stateDir } = await signedIn(w);
    await client.config.set("theme", "dark");
    await client.cloudSync.flush();
    expect(stateFile(stateDir)).not.toBe("");
    await signOutHook(client);
    expect(stateFile(stateDir)).toBe("");
    expect(client.cloudSync.status().state).toBe("local");
    await client.cloudSyncHost.close();
    expect(stateFile(stateDir)).toBe("");
    // The person's value is gone with the file.
    expect(client.config.get("theme", "none")).toBe("none");
  });

  it("deletes the synced data when the account is required again", async () => {
    const w = new World();
    const { client, stateDir } = await signedIn(w);
    w.push = () =>
      new Response(JSON.stringify({ error: { code: "account_required" } }), {
        status: 403,
      });
    await client.config.set("theme", "dark");
    await client.cloudSync.flush();
    expect(stateFile(stateDir)).toBe("");
    expect(client.keyring.unlocked).toBe(false);
    client.close();
  });

  it("deletes the synced data on deactivation, signed in or not", async () => {
    const w = new World();
    const { client, stateDir } = await signedIn(w);
    await client.config.set("theme", "dark");
    await client.cloudSync.flush();
    const api = (
      client as unknown as { cloudSyncApi: { onDeactivated(): Promise<void> } }
    ).cloudSyncApi;
    await api.onDeactivated();
    expect(stateFile(stateDir)).toBe("");
    expect(client.keyring.unlocked).toBe(false);
    await api.onDeactivated();
    expect(existsSync(stateDir)).toBe(true);
    client.close();
  });

  it("another person signing in drops the first person's data before theirs starts", async () => {
    const w = new World();
    const { client } = await signedIn(w);
    await client.config.set("theme", "dark");
    await client.cloudSync.flush();
    client.events.safeEmit("identity", {
      kind: "subjectChanged",
      subject: "ps_bbbbbbbbbbbbbbbbbbbbbb",
    });
    await settle(client);
    expect(client.keyring.unlocked).toBe(false);
    expect(client.config.get("theme", "none")).not.toBe("dark");
    client.close();
  });
});
