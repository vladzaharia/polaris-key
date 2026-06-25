import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { signJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/store.js";
import {
  activate,
  deactivate,
  getConfig,
  status,
  registerPolarisCommands,
  type ClientFactory,
} from "../src/cli/index.js";

// Reuse the project's deterministic test key (see client.test.ts).
const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
} as const;

/** A stub fetch whose /enroll status is configurable; /config returns one signed doc with a
 *  single `default` config key (so override layering is observable). */
function stubFetch(enrollStatus = 200): typeof fetch {
  return (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const device = new Headers(init?.headers).get("x-pkey-device") ?? "d";
    if (u.pathname.endsWith("/enroll")) {
      if (enrollStatus === 200) {
        return new Response(
          JSON.stringify({ token: "pkeyt_ok", schemaVersion: 1 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (enrollStatus === 403) {
        return new Response(JSON.stringify({ limit: 3, machineCount: 3 }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: enrollStatus });
    }
    if (u.pathname.endsWith("/config/report"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/deauthorize"))
      return new Response("{}", { status: 200 });
    if (u.pathname.endsWith("/config")) {
      const now = Math.floor(Date.now() / 1000);
      const doc: ManagedConfigDoc = {
        schemaVersion: 1,
        aud: "djdl",
        iss: "key.plrs.im",
        licenseId: "lic_1",
        deviceId: device,
        issuedAt: now,
        expiresAt: now + 3600,
        graceUntil: now + 30 * 86400,
        profile: {
          name: "Ada Lovelace",
          firstName: "Ada",
          email: "ada@example.com",
          enrolledAt: now,
        },
        payload: {
          config: {
            "run.mode": { state: "default", value: "fast", updatedAt: now },
          },
          secrets: {},
          entitlements: {},
        },
      };
      const jws = await signJws(doc, TEST_PEM, TEST_KID);
      return new Response(jws, {
        status: 200,
        headers: { "content-type": "application/jwt" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

function makeClient(
  fetchImpl: typeof fetch,
  localOverrides?: Record<string, string>,
) {
  return PolarisKeyClient.create({
    ...base,
    store: new InMemoryStore("djdl"),
    fetchImpl,
    localOverrides,
  });
}

describe("cli/commands core", () => {
  it("activate success reflects the gate status", async () => {
    const client = await makeClient(stubFetch(200));
    const r = await activate(client, "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Activated");
    expect(r.message).toContain("ok");
    expect(client.isLicensed()).toBe(true);
  });

  it("activate failure surfaces device-limit and unauthorized reasons", async () => {
    const limited = await activate(await makeClient(stubFetch(403)), "k");
    expect(limited.ok).toBe(false);
    expect(limited.message).toContain("device limit reached");
    expect(limited.message).toContain("3/3");

    const revoked = await activate(await makeClient(stubFetch(401)), "k");
    expect(revoked.ok).toBe(false);
    expect(revoked.message).toContain("invalid or revoked");
  });

  it("status reflects the gate (needs-enroll before, ok after activation)", async () => {
    const client = await makeClient(stubFetch(200));
    const before = status(client);
    expect(before.ok).toBe(false);
    expect(before.message).toContain("needs-enroll");

    await activate(client, "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    const after = status(client);
    expect(after.ok).toBe(true);
    expect(after.message).toContain("Status: ok");
    expect(after.message).toContain("Ada Lovelace");
  });

  it("deactivate wipes credentials and flips the gate back", async () => {
    const client = await makeClient(stubFetch(200));
    await activate(client, "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    const r = await deactivate(client);
    expect(r.ok).toBe(true);
    expect(client.isLicensed()).toBe(false);
    expect(status(client).message).toContain("needs-enroll");
  });

  it("config returns the layered value + provenance (local override beats remote default)", async () => {
    // remote-default
    const remote = await makeClient(stubFetch(200));
    await activate(remote, "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    const r1 = getConfig(remote, "run.mode");
    expect(r1.ok).toBe(true);
    expect(r1.data).toMatchObject({
      key: "run.mode",
      value: "fast",
      source: "remote-default",
    });

    // local override wins over a `default` remote value
    const overridden = await makeClient(stubFetch(200), { "run.mode": "slow" });
    await activate(overridden, "pkey_djdl_AAAAAAAAAAAAAAAAAAAAAA");
    const r2 = getConfig(overridden, "run.mode");
    expect(r2.data).toMatchObject({ value: "slow", source: "local" });

    // unset key with an explicit fallback
    const r3 = getConfig(remote, "missing.key", "def");
    expect(r3.ok).toBe(true);
    expect(r3.data).toMatchObject({ value: "def", source: "fallback" });

    // unset key, no fallback → not-ok
    const r4 = getConfig(remote, "missing.key");
    expect(r4.ok).toBe(false);
  });
});

describe("cli/commander adapter smoke", () => {
  it("registerPolarisCommands wires a Command and dispatches status to the core", async () => {
    const seen: { client?: PolarisKeyClient; factoryOpts?: unknown } = {};
    const lines: string[] = [];

    const factory: ClientFactory = async (opts) => {
      seen.factoryOpts = opts;
      const client = await makeClient(stubFetch(200));
      seen.client = client;
      return client;
    };

    const program = new Command();
    program.exitOverride();
    program
      .option("--product <slug>", "product slug", "djdl")
      .option("--version <v>", "client version", "1.2.3")
      .option("--base-url <url>", "API base url");

    registerPolarisCommands(program, factory, {
      pinnedKeys: base.trust.pinnedKeys,
      print: (line) => lines.push(line),
      setExitCode: () => {
        /* don't touch process.exitCode in tests */
      },
    });

    await program.parseAsync(["status"], { from: "user" });

    // The factory received the program's resolved flags...
    expect(seen.factoryOpts).toMatchObject({
      productSlug: "djdl",
      version: "1.2.3",
    });
    // ...and the status command printed the core's output (gate = needs-enroll, unactivated).
    expect(lines.join("\n")).toContain("needs-enroll");
    expect(seen.client).toBeInstanceOf(PolarisKeyClient);

    // Sanity: a config subcommand was registered too.
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining(["activate", "deactivate", "status", "config"]),
    );
  });
});
