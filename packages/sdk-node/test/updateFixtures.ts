// Shared fixtures for the wire v4 update suites: the corpus signing keys, feed and record
// builders, an in-memory store with a chosen device id, and a fake v4 Worker.
//
// The keys are the corpus's own (`conformance/corpus/v2/cases.json#/keys`), so a feed signed here
// verifies against the same pins the `feedCases` do, and a floor feed can be minted for any of
// them. Never production keys.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signJws, type JwsTyp } from "@polaris-key/jws";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import type { ChannelFeedDoc, FeedTarget } from "@polaris-key/protocol/update";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(
  here,
  "..",
  "..",
  "..",
  "conformance",
  "corpus",
  "v2",
);

export function readCorpus<T>(file: string): T {
  return JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")) as T;
}

interface CorpusKey {
  kid: string;
  publicKeyRaw: string;
  privateKeyPkcs8Pem: string;
}

const KEYS = new Map(
  readCorpus<{ keys: CorpusKey[] }>("cases.json").keys.map((k) => [k.kid, k]),
);

export function corpusKey(kid: string): CorpusKey {
  const k = KEYS.get(kid);
  if (!k) throw new Error(`no corpus key ${kid}`);
  return k;
}

export const PRODUCT = "djdl";
export const BASE = "https://k.test";
export const PRODUCT_KID = "pkey-test-prod-2026";
export const RELEASE_KID = "djdl-release-test-2026";
export const PINS = { [PRODUCT_KID]: corpusKey(PRODUCT_KID).publicKeyRaw };
export const RELEASE_KEYS = {
  [RELEASE_KID]: corpusKey(RELEASE_KID).publicKeyRaw,
};

export function sign(payload: unknown, kid: string, typ: JwsTyp) {
  return signJws(payload, corpusKey(kid).privateKeyPkcs8Pem, kid, typ);
}

export const signFeed = (payload: unknown, kid = PRODUCT_KID) =>
  sign(payload, kid, "pkey-feed+jws");
export const signRecord = (payload: unknown, kid = RELEASE_KID) =>
  sign(payload, kid, "pkey-release+jws");

/** A release record with one payload build for `platform`/`arch`. */
export function recordPayload(
  o: {
    version?: string;
    seq?: number;
    platform?: string;
    arch?: string;
    format?: string;
    buildId?: string;
  } = {},
): ReleaseRecordDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    deliverable: "app",
    kind: "app",
    version: o.version ?? "1.5.0",
    seq: o.seq ?? 15,
    issuedAt: 1_699_990_000,
    builds: [
      {
        id: o.buildId ?? "macos-zip",
        platform: o.platform ?? "macos",
        arch: o.arch ?? "universal",
        format: o.format ?? "zip",
        artifacts: [
          {
            name: "app.zip",
            role: "payload",
            sha256: "a".repeat(64),
            size: 10,
          },
        ],
      },
    ],
  } as ReleaseRecordDoc;
}

/** A channel feed pinning `sha256` for `platform`, with one `direct` outlet live on it. */
export function feedPayload(o: {
  channel?: string;
  seq: number;
  issuedAt: number;
  expiresAt?: number;
  platform?: string;
  sha256: string;
  version?: string;
  recordSeq?: number;
  target?: Partial<FeedTarget>;
}): ChannelFeedDoc {
  const version = o.version ?? "1.5.0";
  const recordSeq = o.recordSeq ?? 15;
  return {
    schemaVersion: 1,
    iss: "key.plrs.im",
    aud: PRODUCT,
    channel: o.channel ?? "stable",
    selector: {},
    seq: o.seq,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt ?? o.issuedAt + 900,
    app: {
      deliverable: "app",
      versionScheme: "semver",
      targets: [
        {
          platform: o.platform ?? "macos",
          release: { sha256: o.sha256, seq: recordSeq, version },
          floor: null,
          critical: false,
          outlets: {
            direct: {
              kind: "direct",
              live: { version, seq: recordSeq },
              halted: false,
            },
          },
          ...o.target,
        },
      ],
    },
  } as ChannelFeedDoc;
}

/** An in-memory store with a chosen device id (`""` for none) and an optional seeded cache. */
export class MemStore implements Store {
  token: string | null = null;
  cache: CacheRecordV3 | null;
  constructor(
    private readonly deviceId: string,
    cache: CacheRecordV3 | null = null,
  ) {
    this.cache = cache ? structuredClone(cache) : null;
  }
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return this.deviceId;
  }
  async readCache() {
    return this.cache ? structuredClone(this.cache) : null;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = structuredClone(rec);
  }
  async clearCache() {
    this.cache = null;
  }
}

/** A v4 Worker's discovery document: the feed and record endpoints, and the builds route. */
export function discoveryDoc(
  o: { feed?: boolean; record?: boolean; update?: boolean } = {},
): unknown {
  const update = o.update !== false;
  return {
    version: 2,
    protocolVersion: 4,
    product: PRODUCT,
    baseUrl: BASE,
    services: {
      license: { enabled: false },
      config: { enabled: false },
      release: {
        enabled: true,
        endpoints: {
          changelog: `${BASE}/${PRODUCT}/release/changelog`,
          ...(o.record === false
            ? {}
            : { record: `${BASE}/${PRODUCT}/release/records/{sha256}` }),
        },
      },
      distribution: {
        enabled: true,
        endpoints: {
          builds: `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
        },
      },
      update: update
        ? {
            enabled: true,
            endpoints: {
              version: `${BASE}/${PRODUCT}/update/version`,
              appcast: `${BASE}/${PRODUCT}/update/appcast.xml`,
              ...(o.feed === false
                ? {}
                : { feed: `${BASE}/${PRODUCT}/update/{channel}/feed.jws` }),
            },
          }
        : { enabled: false },
      identity: { enabled: false },
    },
  };
}

export interface Call {
  url: string;
  headers: Headers;
}

/**
 * A fake v4 Worker. `feeds` answers `GET …/update/{channel}/feed.jws` by channel (a function, so a
 * test can change the answer between calls; a number is a status with no body), `records`
 * answers `GET …/release/records/{sha256}` by hash. Discovery answers `discovery`. Everything
 * else is a 404, so an unexpected request is visible in `calls`.
 */
export function fakeWorker(o: {
  feeds?: (channel: string) => string | number | Response;
  records?: Record<string, string | Response>;
  discovery?: unknown;
}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: new Headers(init?.headers) });
    const path = url.pathname;
    if (path === `/${PRODUCT}/.well-known/polaris.json`)
      return new Response(JSON.stringify(o.discovery ?? discoveryDoc()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const feed = /^\/djdl\/update\/([^/]+)\/feed\.jws$/.exec(path);
    if (feed && o.feeds) {
      const answer = o.feeds(decodeURIComponent(feed[1]!));
      if (answer instanceof Response) return answer;
      if (typeof answer === "number")
        return new Response("unavailable", { status: answer });
      return new Response(answer, { status: 200 });
    }
    const record = /^\/djdl\/release\/records\/([^/]+)$/.exec(path);
    if (record && o.records) {
      const hash = decodeURIComponent(record[1]!);
      const answer = Object.prototype.hasOwnProperty.call(o.records, hash)
        ? o.records[hash]
        : undefined;
      if (answer instanceof Response) return answer;
      if (typeof answer === "string")
        return new Response(answer, { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), {
      status: 404,
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const V4_SERVICES = ["release", "distribution", "update"] as const;
