// Shared fixtures for the SDK parity pass tests: a client seeded with a signed licence document
// and a token, and a scriptable fake control plane.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signJws } from "@polaris-key/jws";
import { ISSUER, type ManagedEntry } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import {
  PolarisKeyClient,
  type PolarisKeyClientOptions,
} from "../src/client.js";
import { CACHE_VERSION, InMemoryStore } from "../src/core/store.js";

export const TEST_KID = "pkey-test-prod-2026";
export const TEST_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
export const TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";
export const PRODUCT = "djdl";
export const BASE = "https://k.test";
export const DEVICE = "dev_parity_0001";

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pkey-parity-"));
}

export function entitlement(value: unknown, at = nowSec()): ManagedEntry {
  return { state: "enforced", value: value as never, updatedAt: at };
}

export async function signedLicense(
  entitlements: Record<string, unknown>,
  at = nowSec(),
): Promise<string> {
  const doc: LicenseDoc = {
    iss: ISSUER,
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: at,
    expiresAt: at + 3600,
    graceUntil: at + 30 * 86400,
    licenseId: "lic_parity",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: at,
    },
    entitlements: Object.fromEntries(
      Object.entries(entitlements).map(([k, v]) => [k, entitlement(v, at)]),
    ),
  };
  return signJws(doc, TEST_PEM, TEST_KID, "pkey-license+jws");
}

/** An in-memory store whose device id is the fixtures' `DEVICE`. */
export class FixedStore extends InMemoryStore {
  override async getDeviceId(): Promise<string> {
    return DEVICE;
  }
}

/** One recorded request. */
export interface Seen {
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: string | null;
}

export type Handler = (req: Seen) => Response | Promise<Response>;

/** A fake fetch: `routes` maps `"METHOD /path"` to a handler; anything else is a 404. */
export function fakeServer(routes: Record<string, Handler> = {}): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      url: url.toString(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    seen.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h) return h(req);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, seen };
}

export function json(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A client with a token and (optionally) a cached signed licence, no network unless routed. */
export async function seededClient(
  opts: {
    license?: string;
    token?: string | null;
    routes?: Record<string, Handler>;
    lastSyncUnauthorized?: boolean;
    extra?: Partial<PolarisKeyClientOptions>;
  } = {},
): Promise<{
  client: PolarisKeyClient;
  store: FixedStore;
  seen: Seen[];
  dir: string;
}> {
  const store = new FixedStore();
  if (opts.token !== null) await store.setToken(opts.token ?? "pkeyt_seed");
  if (opts.license)
    await store.writeCache({
      v: CACHE_VERSION,
      docs: { license: opts.license },
      ...(opts.lastSyncUnauthorized ? { lastSyncUnauthorized: true } : {}),
    });
  const server = fakeServer(opts.routes);
  const dir = tempDir();
  const client = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.2.3",
    trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
    trustRefresh: false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    config: { env: {} },
    store,
    fetchImpl: server.fetch,
    stateDir: dir,
    dataDir: dir,
    cacheDir: dir,
    configDir: dir,
    ...opts.extra,
  });
  await client.init();
  return { client, store, seen: server.seen, dir };
}
