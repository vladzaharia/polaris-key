// Shared fixtures for the Cloud Sync Node tests: a fake of the Worker's `/sync` routes and a client
// opened over it (cloudSyncHost.test.ts, cloudSyncSettings.test.ts).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { Store } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { createNodeDeviceKeyStore } from "../src/devices/deviceKeys.js";

export const PRODUCT = "djdl";
export const TOKEN = `pkeyt_${"T".repeat(43)}`;
export const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";

/** A store that holds the device token and nothing else. */
export const memStore = (): Store => {
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

export const entry = (key: string, user: object = {}) => ({
  key,
  kind: "config",
  category: "ui",
  label: key,
  description: key,
  schema: { type: "string" },
  user: { sync: "user", conflict: "lastWrite", ...user },
});
export const CATALOG = (version: number) => ({
  schemaVersion: version,
  entries: [entry("theme")],
});

export type Body = Record<string, unknown>;

/** The quota and usage members every answer carries. */
export const ROOM = {
  usage: { files: 0, records: 0, settings: 0, bytes: 0 },
  quota: { files: true, bytes: 2 ** 28 },
};

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Body | undefined;
}

export class World {
  seen: Seen[] = [];
  schemaFetches = 0;
  schemaLength: string | undefined;
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
      return this.schemaLength === undefined
        ? j(this.schema)
        : new Response("{}", {
            headers: { "content-length": this.schemaLength },
          });
    }
    if (url.pathname === `/${PRODUCT}/sync` && method === "GET")
      return wrap(this.pull(url));
    if (url.pathname === `/${PRODUCT}/sync/ops` && method === "POST")
      return wrap(this.push(body!));
    return j({}, 404);
  }) as typeof fetch;
}

/** A client over `stateDir`; `keys` gives it a key ring (a relaunch passes none). */
export async function open(
  w: World,
  stateDir: string,
  cloudSync: object,
  keys = true,
  over: { entries?: object; store?: Store } = {},
) {
  const client = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: "https://k.test",
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    store: over.store ?? memStore(),
    fetchImpl: w.fetch,
    stateDir,
    expectedServices: ["license", "config", "sync"],
    ...(keys
      ? { keyring: { deviceKeys: createNodeDeviceKeyStore({ memory: true }) } }
      : {}),
    cloudSync,
  });
  if (over.entries)
    vi.spyOn(client.config, "entries").mockReturnValue(over.entries as never);
  await client.init();
  return client;
}

/** The host's state file: the SDK namespaces its state directory, so find it below `dir`
 *  ("" when absent). */
export function stateFile(dir: string): string {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const f = stateFile(p);
      if (f !== "") return f;
    } else if (e.name === "cloud-sync.json") return p;
  }
  return "";
}
