// @pkey-feature core.errors
// SP-46, acceptance 3: no public result prints (`console.log`, `util.inspect`) or serialises
// (`JSON.stringify`) a `pkeyt_` device token, and neither does the client itself. The token
// stays a readable property of the results that carry it; only printing hides it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const PINS = {
  "pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
};
const HELD = `pkeyt_${"H".repeat(43)}`;
const MINTED = `pkeyt_${"M".repeat(43)}`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Everything a host can print: `console.log`'s formatting, a deep inspect and JSON. */
function printed(value: unknown): string {
  const out = [
    format(value),
    format("%o", value),
    inspect(value, { depth: Infinity }),
  ];
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    // A structure JSON cannot serialise (a cycle) prints nothing to leak.
  }
  return out.join("\n");
}

/** A Worker stand-in that mints `MINTED` on every route that hands out a device token. */
function worker(path: string, method: string): Response {
  if (path.endsWith("/license/activate") || path.endsWith("/license/enroll"))
    return json({ token: MINTED, schemaVersion: 1 });
  if (path.endsWith("/devices/register"))
    return json({ token: MINTED, deviceId: "dev_1" });
  if (path.endsWith("/identity/auth/device/start"))
    return json({
      deviceCode: "device-code-secret",
      userCode: "ABCD-EFGH",
      verificationUri: `${BASE}/${PRODUCT}/identity/auth/device`,
      verificationUriComplete: `${BASE}/${PRODUCT}/identity/auth/device?user_code=ABCD-EFGH`,
      expiresIn: 600,
      interval: 5,
    });
  if (path.endsWith("/identity/auth/device/poll"))
    return json({
      status: "ready",
      token: MINTED,
      identity: { name: "Ada", email: "ada@example.com" },
    });
  if (path.endsWith("/config/mint/recipe/token"))
    return json({ token: "third-party-token", expiresAt: 4_102_444_800 });
  if (path.endsWith("/.well-known/polaris.json"))
    return json({
      product: PRODUCT,
      services: {
        license: { enabled: true },
        config: { enabled: true },
        identity: { enabled: true },
      },
    });
  if (path.endsWith("/devices") && method === "GET")
    return json({
      devices: [{ id: "dev_1", status: "authorized", current: true }],
    });
  return new Response("", { status: 404 });
}

describe("SP-46: no public result prints a device token", () => {
  it("activation, enrolment, registration, sign-in, edge-mint, sync and the client itself", async () => {
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) =>
      worker(
        new URL(String(input)).pathname,
        init?.method ?? "GET",
      )) as typeof fetch;
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.0.0",
      trust: { pinnedKeys: PINS },
      store: new InMemoryStore(PRODUCT),
      fetchImpl,
      requestTimeoutMs: 0,
      deviceName: "",
      stateDir: mkdtempSync(join(tmpdir(), "pkey-sp46-redact-")),
      expectedServices: ["license", "config", "identity"],
      license: { fingerprint: false },
      devices: { fingerprint: false },
    });

    const activated = await client.license.activateWithKey("pkey_djdl_x");
    const enrolled = await client.license.enroll();
    const registered = await client.devices.register();
    const prompt = await client.identity.beginSignIn();
    const ready = await client.identity.pollSignIn(prompt);
    const minted = await client.config.mintToken("recipe");

    // The tokens are still there to read: only printing hides them.
    expect(activated.kind === "ok" && activated.token).toBe(MINTED);
    expect(enrolled.kind === "ok" && enrolled.token).toBe(MINTED);
    expect(registered.kind === "ok" && registered.token).toBe(MINTED);
    expect(minted.token).toBe("third-party-token");

    const results: Record<string, unknown> = {
      activated,
      enrolled,
      registered,
      prompt,
      ready,
      minted,
      sync: await client.sync(),
      status: client.status(),
      syncState: client.getSyncState(),
      licenseInfo: client.license.licenseInfo(),
      current: await client.identity.current(),
      discovery: await client.discover(),
      devices: await client.listDevices(),
      store: await client.storeStatus(),
      client,
    };
    for (const [name, value] of Object.entries(results)) {
      const text = printed(value);
      expect(text, name).not.toContain("pkeyt_");
      expect(text, name).not.toContain("device-code-secret");
      expect(text, name).not.toContain("third-party-token");
    }
    for (const r of [activated, enrolled, registered])
      expect(printed(r)).toContain("[redacted]");
    client.close();
  });

  it("the token custody prints whether a token is held, and nothing else of it", async () => {
    const store = new InMemoryStore(PRODUCT);
    expect(printed(store)).toContain("token: null");
    await store.setToken(HELD);
    expect(printed(store)).not.toContain("pkeyt_");
    expect(printed(store)).toContain("[redacted]");
    expect(await store.getToken()).toBe(HELD);
  });
});
