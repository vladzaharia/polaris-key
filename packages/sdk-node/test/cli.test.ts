// The CLI command surface — `src/cli/commands.ts` plus the commander adapter.
//
// The commands are framework-agnostic and side-effect-free by construction: each takes plain
// arguments and a `PolarisClient` and returns a `CommandResult` (`{ok, message, data}`). That
// is what makes them testable with no console and no `process.exitCode`, and it is why the
// adapters are shells with no logic of their own — the behavior lives in exactly one place.
//
// ── WHAT THESE PINS ARE FOR ─────────────────────────────────────────────────────────────────
//
// A CLI result is read by a human under stress and by a shell script that only sees the exit
// code, so two things must hold for every verb: `ok` has to mean "the gate permits running",
// and the message has to name the REMEDY rather than the HTTP status. Both are easy to
// regress silently, so both are asserted per outcome rather than spot-checked.
//
// ── WHAT v3 CHANGED ─────────────────────────────────────────────────────────────────────────
//
// Verbs are grouped by the service that owns them:
//
//   license  activate · enroll · deactivate · status
//   devices  register
//   config   config <key>
//   core     import-bundle
//
//   * `register` is new and the reason the grouping matters. It is a DEVICES verb: a
//     config-only product (D-08) has no `activate` to run and its entire provisioning story is
//     `register`, which under a licence-shaped CLI would have had nowhere to live. Its refusal
//     modes are reported AS THEMSELVES — a `requires-license` product answering
//     `registration_closed` is told to activate instead, never silently retried against
//     `activate`, because those are two different operator intents.
//   * `status` on a product with the licence service DISABLED is `ok: true` with
//     `not-applicable` (the D-08 CLI pin). A config-only product must exit 0, not sit on
//     `needs-activation` forever.
//   * config values are resolved through `client.config.*`, and overrides ride
//     `PolarisClientOptions.config`.

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { signJws } from "@plrs/jws";
import { ISSUER } from "@plrs/protocol/core";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { ConfigDoc } from "@plrs/protocol/config";
import { PolarisClient, type PolarisClientOptions } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import {
  activate,
  deactivate,
  enroll,
  getConfig,
  register,
  registerPolarisCommands,
  status,
  type ClientFactory,
} from "../src/cli/index.js";

// The project's deterministic test key (see client.test.ts).
const TEST_KID = "pkey-test-prod-2026";
const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const base = {
  productSlug: "djdl",
  baseUrl: "https://k.test",
  version: "1.2.3",
  trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
  // Hardware probes shell out to `ioreg`/`system_profiler`; the fingerprint body is pinned in
  // endpoints.test.ts, so keep the CLI suite fast and deterministic by opting out here.
  devices: { fingerprint: false },
  license: { fingerprint: false },
} as const satisfies Partial<PolarisClientOptions>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The signed licence document (`plrs-license+jws`) the stub server hands back. */
function licenseJws(deviceId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const doc: LicenseDoc = {
    iss: ISSUER,
    aud: "djdl",
    deviceId,
    issuedAt: now,
    expiresAt: now + 3600,
    graceUntil: now + 30 * 86400,
    licenseId: "lic_1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: now,
    },
    entitlements: {
      "license.tier": { state: "enforced", value: "pro", updatedAt: now },
    },
  };
  return signJws(doc, TEST_PEM, TEST_KID, "plrs-license+jws");
}

/** The signed config document (`plrs-config+jws`), with one `default` key so override
 *  layering is observable through the `config` verb. */
function configJws(deviceId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const doc: ConfigDoc = {
    iss: ISSUER,
    aud: "djdl",
    deviceId,
    issuedAt: now,
    expiresAt: now + 3600,
    graceUntil: now + 30 * 86400,
    schemaVersion: 1,
    config: { "run.mode": { state: "default", value: "fast", updatedAt: now } },
    secrets: {},
  };
  return signJws(doc, TEST_PEM, TEST_KID, "plrs-config+jws");
}

interface StubOptions {
  /** Status for `POST /djdl/license/activate` (200 mints, 403 is a device-limit body). */
  activate?: number;
  /** Status for `POST /djdl/license/enroll`. */
  enroll?: number;
  /** Status for `POST /djdl/devices/register`. */
  register?: number;
}

/** A v3 route-aware stub server + a log of every request, so "did it sync?" is observable. */
function stubFetch(opts: StubOptions = {}): {
  impl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const mint = (statusCode: number, token: string): Response => {
    if (statusCode === 200) return jsonResponse({ token, schemaVersion: 3 });
    if (statusCode === 403)
      return jsonResponse({ limit: 3, deviceCount: 3 }, 403);
    return new Response("", { status: statusCode });
  };

  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const device = new Headers(init?.headers).get("x-polaris-device") ?? "d";
    calls.push(`${init?.method ?? "GET"} ${path}`);

    switch (path) {
      // Core refreshes the signed trust manifest on its own cadence inside `sync()`; a 404 is
      // swallowed (a manifest we could not fetch is a manifest we keep).
      case "/djdl/.well-known/polaris-trust.jws":
        return new Response("", { status: 404 });
      case "/djdl/license/activate":
        return mint(opts.activate ?? 200, "plrst_activated");
      case "/djdl/license/enroll":
        return mint(opts.enroll ?? 200, "plrst_enrolled");
      case "/djdl/license/deauthorize":
        return jsonResponse({});
      case "/djdl/devices/register":
        return (opts.register ?? 200) === 200
          ? jsonResponse({ token: "plrst_registered", deviceId: device })
          : new Response("", { status: opts.register ?? 200 });
      case "/djdl/devices/report":
        return jsonResponse({});
      case "/djdl/license/document":
        return new Response(await licenseJws(device), {
          status: 200,
          headers: { "content-type": "application/jose", etag: '"lic-1"' },
        });
      case "/djdl/config/document":
        return new Response(await configJws(device), {
          status: 200,
          headers: { "content-type": "application/jose", etag: '"cfg-1"' },
        });
      default:
        return new Response("", { status: 404 });
    }
  }) as typeof fetch;

  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  over: Partial<PolarisClientOptions> = {},
): Promise<PolarisClient> {
  return PolarisClient.create({
    ...base,
    store: new InMemoryStore("djdl"),
    fetchImpl,
    ...over,
  });
}

const KEY = "plrs_djdl_AAAAAAAAAAAAAAAAAAAAAA";

describe("cli/commands — license verbs", () => {
  it("activate success reflects the gate status", async () => {
    const client = await makeClient(stubFetch().impl);
    const r = await activate(client, KEY);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Activated");
    expect(r.message).toContain("ok");
    expect(client.isLicensed()).toBe(true);
  });

  it("activate failure surfaces device-limit and unauthorized reasons", async () => {
    // The message has to name the remedy — "free a seat" vs "your key is bad" — because the
    // operator never sees the HTTP status.
    const limited = await activate(
      await makeClient(stubFetch({ activate: 403 }).impl),
      "k",
    );
    expect(limited.ok).toBe(false);
    expect(limited.message).toContain("device limit reached");
    expect(limited.message).toContain("3/3");

    const revoked = await activate(
      await makeClient(stubFetch({ activate: 401 }).impl),
      "k",
    );
    expect(revoked.ok).toBe(false);
    expect(revoked.message).toContain("invalid or revoked");
  });

  it("enroll mints keylessly and reports the gate", async () => {
    const client = await makeClient(stubFetch().impl);
    const r = await enroll(client);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Enrolled");
    expect(client.isLicensed()).toBe(true);
  });

  it("enroll on a product that never opted in says so (404 → enroll-disabled)", async () => {
    const r = await enroll(await makeClient(stubFetch({ enroll: 404 }).impl));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("does not offer keyless enrollment");
  });

  it("status reflects the gate (needs-activation before, ok after activation)", async () => {
    const client = await makeClient(stubFetch().impl);
    const before = status(client);
    expect(before.ok).toBe(false);
    expect(before.message).toContain("needs-activation");

    await activate(client, KEY);
    const after = status(client);
    expect(after.ok).toBe(true);
    expect(after.message).toContain("Status: ok");
    // The greeting block is SIGNED, so the CLI can print it offline without it being spoofable.
    expect(after.message).toContain("Ada Lovelace");
  });

  it("deactivate wipes credentials and flips the gate back", async () => {
    const client = await makeClient(stubFetch().impl);
    await activate(client, KEY);
    const r = await deactivate(client);
    expect(r.ok).toBe(true);
    expect(client.isLicensed()).toBe(false);
    expect(status(client).message).toContain("needs-activation");
  });
});

describe("cli/commands — status under D-08 (licence service disabled)", () => {
  it("is ok:true with not-applicable, so a config-only product exits 0", async () => {
    // The whole D-08 promise at the CLI: a product that does not license must not be held
    // hostage by a licence gate. `ok` maps to the exit code, so `false` here would break every
    // `plrs status || exit 1` in a config-only product's installer.
    const client = await makeClient(stubFetch().impl, {
      expectedServices: ["config"],
    });
    const r = status(client);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Status: not-applicable");
    expect(r.message).toContain("Usable: true");
    expect(r.data).toMatchObject({ status: "not-applicable" });
  });
});

describe("cli/commands — register (devices, §6)", () => {
  it("mints keylessly, syncs, and reports the resulting status", async () => {
    const { impl, calls } = stubFetch();
    const client = await makeClient(impl);
    const r = await register(client);

    expect(r.ok).toBe(true);
    expect(r.message).toContain("Registered device");
    expect(r.message).toContain(client.core.deviceId);
    expect(r.message).toContain("Status: ok");
    expect(r.data).toMatchObject({ deviceId: client.core.deviceId });

    // The mint went to the DEVICES route, not a licensing one...
    expect(calls).toContain("POST /djdl/devices/register");
    // ...and it was followed by a real sync: both documents pulled, telemetry sent.
    expect(calls).toContain("GET /djdl/license/document");
    expect(calls).toContain("GET /djdl/config/document");
    expect(calls).toContain("POST /djdl/devices/report");
    expect(client.isLicensed()).toBe(true);
  });

  it("registration-closed (403) tells the operator to activate instead", async () => {
    // A `requires-license` product refuses the keyless mint. Quietly falling back to
    // `activate` would hide a misconfigured registration policy behind a working command, so
    // the refusal is reported as itself — with the remedy named.
    const { impl, calls } = stubFetch({ register: 403 });
    const r = await register(await makeClient(impl));

    expect(r.ok).toBe(false);
    expect(r.message).toContain("does not accept keyless registration");
    expect(r.message).toContain("Activate with a licence key instead");
    expect(r.data).toMatchObject({ kind: "registration-closed" });
    // No sync, and emphatically no silent retry against `/license/activate`.
    expect(calls).not.toContain("POST /djdl/license/activate");
    expect(calls).not.toContain("GET /djdl/license/document");
  });

  it("rate-limited (429) and not-configured (404) map distinctly", async () => {
    // Three refusals, three different remedies: wait, fix the policy, fix the product slug.
    // Collapsing them into one "registration failed" is what makes a CLI unusable.
    const limited = await register(
      await makeClient(stubFetch({ register: 429 }).impl),
    );
    expect(limited.ok).toBe(false);
    expect(limited.message).toContain("too many attempts");
    expect(limited.data).toMatchObject({ kind: "rate-limited" });

    const unknown = await register(
      await makeClient(stubFetch({ register: 404 }).impl),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain("unknown product");
    expect(unknown.data).toMatchObject({ kind: "not-configured" });

    expect(limited.message).not.toBe(unknown.message);
  });
});

describe("cli/commands — config", () => {
  it("returns the layered value + provenance (local override beats remote default)", async () => {
    // remote-default
    const remote = await makeClient(stubFetch().impl);
    await activate(remote, KEY);
    const r1 = getConfig(remote, "run.mode");
    expect(r1.ok).toBe(true);
    expect(r1.data).toMatchObject({
      key: "run.mode",
      value: "fast",
      source: "remote-default",
    });

    // local override wins over a `default` remote value — and rides `config.localOverrides`,
    // not the old top-level option bag.
    const overridden = await makeClient(stubFetch().impl, {
      config: { localOverrides: { "run.mode": "slow" } },
    });
    await activate(overridden, KEY);
    const r2 = getConfig(overridden, "run.mode");
    expect(r2.data).toMatchObject({ value: "slow", source: "local" });

    // unset key with an explicit fallback
    const r3 = getConfig(remote, "missing.key", "def");
    expect(r3.ok).toBe(true);
    expect(r3.data).toMatchObject({ value: "def", source: "fallback" });

    // unset key, no fallback → not-ok (nothing to print, and the exit code should say so)
    const r4 = getConfig(remote, "missing.key");
    expect(r4.ok).toBe(false);
  });
});

describe("cli/commander adapter smoke", () => {
  it("registerPolarisCommands wires a Command and dispatches status to the core", async () => {
    const seen: { client?: PolarisClient; factoryOpts?: unknown } = {};
    const lines: string[] = [];

    const factory: ClientFactory = async (opts) => {
      seen.factoryOpts = opts;
      const client = await makeClient(stubFetch().impl);
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
    // ...and the status command printed the core's output (gate = needs-activation).
    expect(lines.join("\n")).toContain("needs-activation");
    expect(seen.client).toBeInstanceOf(PolarisClient);

    // Every v3 verb is attached, in its service group. `register` in particular: a config-only
    // product's whole provisioning story is this command, and an adapter that forgot it would
    // leave those products with no way to obtain a credential at all.
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "activate",
        "deactivate",
        "status",
        "enroll",
        "register",
        "config",
        "import-bundle",
      ]),
    );
  });

  it("dispatches register through the same adapter", async () => {
    const lines: string[] = [];
    const { impl, calls } = stubFetch();
    const factory: ClientFactory = () => makeClient(impl);

    const program = new Command();
    program.exitOverride();
    program
      .option("--product <slug>", "product slug", "djdl")
      .option("--version <v>", "client version", "1.2.3");

    registerPolarisCommands(program, factory, {
      pinnedKeys: base.trust.pinnedKeys,
      print: (line) => lines.push(line),
      setExitCode: () => {
        /* no process side effects in tests */
      },
    });

    await program.parseAsync(["register"], { from: "user" });

    expect(calls).toContain("POST /djdl/devices/register");
    expect(lines.join("\n")).toContain("Registered device");
  });
});
