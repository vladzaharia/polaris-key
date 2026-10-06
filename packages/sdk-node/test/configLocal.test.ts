// @pkey-feature config.resolve core.sync config.local
// SDK parity pass §3.11: persisted local overrides (config.set/clear/setting), per-key change
// events, client.events, and the default refresh for long-running hosts.

import { describe, expect, it, vi } from "vitest";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import {
  DEVICE,
  json,
  PRODUCT,
  seededClient,
  signedLicense,
  TEST_KID,
  TEST_PEM,
} from "./parityFixtures.js";

async function configJws(
  config: Record<string, [string, unknown]>,
  at = Math.floor(Date.now() / 1000),
) {
  return signJws(
    {
      iss: ISSUER,
      aud: PRODUCT,
      deviceId: DEVICE,
      issuedAt: at,
      expiresAt: at + 3600,
      graceUntil: at + 86400,
      schemaVersion: 1,
      config: Object.fromEntries(
        Object.entries(config).map(([k, [state, value]]) => [
          k,
          { state, value, updatedAt: at },
        ]),
      ),
      secrets: {},
    },
    TEST_PEM,
    TEST_KID,
    "pkey-config+jws",
  );
}

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "ui",
      schema: { type: "string", enum: ["light", "dark"] },
      managementDefault: "default",
    },
  ],
};

describe("config.local (§3.11)", () => {
  it("set persists across clients, emits per-key and wildcard changes, and clear removes it", async () => {
    const routes = { "GET /djdl/config/schema": () => json(CATALOG) };
    const { client, dir } = await seededClient({ routes });
    const keyed: unknown[] = [];
    const all: unknown[] = [];
    const events: unknown[] = [];
    const theme = client.config.setting<string>("ui.theme");
    theme.on((c) => keyed.push(c.value));
    client.config.onConfigChange("*", (c) => all.push(c.key));
    client.events.on("config", (c) => events.push(c.key));
    await theme.set("dark");
    expect(theme.get("light")).toBe("dark");
    expect(theme.source()).toBe("local");
    expect(keyed).toEqual(["dark"]);
    expect(all).toEqual(["ui.theme"]);
    expect(events).toEqual(["ui.theme"]);

    // A second client over the same state directory sees the persisted value.
    const again = await seededClient({ routes, extra: { stateDir: dir } });
    expect(again.client.config.getConfig("ui.theme", "light")).toBe("dark");

    await theme.clear();
    expect(theme.get("light")).toBe("light");
    expect(keyed).toEqual(["dark", undefined]);
  });

  it("validates against the catalog and refuses a locked key", async () => {
    const at = Math.floor(Date.now() / 1000);
    const { client } = await seededClient({
      license: await signedLicense({}),
      routes: {
        "GET /djdl/config/schema": () => json(CATALOG),
        "GET /djdl/license/document": async () =>
          new Response(await signedLicense({}, at + 1)),
        "GET /djdl/config/document": async () =>
          new Response(
            await configJws({ "ui.locked": ["enforced", 1] }, at + 1),
          ),
        "POST /djdl/devices/report": () => json({}),
      },
    });
    await expect(client.config.set("ui.theme", "purple")).rejects.toMatchObject(
      { code: "bad_request" },
    );
    await client.sync({ force: true });
    expect(client.config.isLocked("ui.locked")).toBe(true);
    await expect(client.config.set("ui.locked", 2)).rejects.toMatchObject({
      code: "managed_by_admin",
    });
  });
});

describe("client.events (§3.11)", () => {
  it("reports a sync that changed a value, and the license moving", async () => {
    const at = Math.floor(Date.now() / 1000);
    const { client } = await seededClient({
      license: await signedLicense({}),
      routes: {
        "GET /djdl/license/document": async () =>
          new Response(await signedLicense({}, at + 1)),
        "GET /djdl/config/document": async () =>
          new Response(
            await configJws({ "net.limit": ["default", 5] }, at + 1),
          ),
        "POST /djdl/devices/report": () => json({}),
        "POST /djdl/license/deauthorize": () => json({}),
      },
    });
    const config: unknown[] = [];
    const license: unknown[] = [];
    client.events.on("config", (c) =>
      config.push([c.key, c.value, c.previous]),
    );
    client.events.on("license", (e) =>
      license.push([e.previous, e.state.status]),
    );
    await client.sync({ force: true });
    expect(config).toEqual([["net.limit", 5, undefined]]);
    await client.license.deactivate();
    expect(license).toEqual([["ok", "needs-activation"]]);
  });
});

describe("startRefresh (§3.11)", () => {
  it("syncs on the interval, backs off after a failure, and close() stops it", async () => {
    let calls = 0;
    let fail = true;
    const { client } = await seededClient({
      license: await signedLicense({}),
      routes: {
        "GET /djdl/license/document": () => {
          calls += 1;
          if (fail) throw new Error("offline");
          return signedLicense({}, Math.floor(Date.now() / 1000) + calls).then(
            (l) => new Response(l),
          );
        },
        "GET /djdl/config/document": () => new Response("", { status: 304 }),
        "POST /djdl/devices/report": () => json({}),
      },
    });
    const armed: { fn: () => void; ms: number }[] = [];
    let clock = 0;
    client.startRefresh({
      intervalSeconds: 600,
      timers: {
        setTimeout: (fn, ms) => armed.push({ fn, ms }),
        now: () => clock,
      },
    });
    const fire = async () => {
      const t = armed.shift()!;
      clock += t.ms;
      t.fn();
      await vi.waitFor(() => expect(armed.length).toBe(1));
      return t.ms;
    };
    expect(await fire()).toBe(600_000);
    expect(calls).toBe(1);
    expect(armed[0]!.ms).toBe(30_000); // the first backoff step
    fail = false;
    await fire();
    expect(calls).toBe(2);
    expect(armed[0]!.ms).toBe(600_000); // back to the interval
    client.close();
    armed.shift()!.fn();
    expect(calls).toBe(2);
  });
});
