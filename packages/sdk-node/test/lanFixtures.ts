// Shared fixtures for the Cloud Connect LAN tests (CC-08.2): an in-process mDNS network, a small
// multi-device fake of the Worker's connect routes, and helpers to build clients.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { base64UrlEncodeBytes, signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import { PolarisKeyClient } from "../src/client.js";
import { createNodeDeviceKeyStore } from "../src/devices/deviceKeys.js";
import { CACHE_VERSION, InMemoryStore } from "../src/core/store.js";
import type {
  MdnsAdapter,
  MdnsAdvert,
  MdnsFound,
  MdnsHandle,
} from "../src/connect/mdns.js";
import {
  signedLicense,
  TEST_KID,
  TEST_PEM,
  TEST_PUB,
} from "./parityFixtures.js";

export const PRODUCT = "djdl";
export const BASE = "https://k.test";
export const T0 = 1_761_300_000;
export const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
export const devId = (n: string): string => "LANDEVICE".padEnd(31, "0") + n;
export const tokenOf = (n: string): string =>
  `pkeyt_${n.repeat(43).slice(0, 43)}`;

/** Every advert and browser on one fake LAN, all at 127.0.0.1 unless `hosts` says otherwise. */
export class MemoryMdnsNetwork {
  adverts = new Map<string, MdnsAdvert>();
  /** The addresses every advert is found at. */
  hosts: string[] = ["127.0.0.1"];
  #browsers = new Set<{
    up: (f: MdnsFound) => void;
    down?: (i: string) => void;
  }>();
  log: string[] = [];

  adapter(): MdnsAdapter {
    return {
      advertise: async (a): Promise<MdnsHandle> => {
        this.adverts.set(a.instance, a);
        this.log.push(`up ${a.instance}`);
        for (const b of this.#browsers) b.up(this.#found(a));
        return {
          stop: async () => {
            this.adverts.delete(a.instance);
            this.log.push(`down ${a.instance}`);
            for (const b of this.#browsers) b.down?.(a.instance);
          },
        };
      },
      browse: async (up, down): Promise<MdnsHandle> => {
        const b = { up, down };
        this.#browsers.add(b);
        for (const a of this.adverts.values()) up(this.#found(a));
        return { stop: async () => void this.#browsers.delete(b) };
      },
    };
  }

  /** Announce a made-up advert, as a hostile neighbour would. */
  inject(f: MdnsFound): void {
    for (const b of this.#browsers) b.up(f);
  }

  #found(a: MdnsAdvert): MdnsFound {
    return {
      instance: a.instance,
      hosts: [...this.hosts],
      port: a.port,
      txt: [...a.txt],
    };
  }
}

const sign = (
  typ: "pkey-ring+jws" | "pkey-peer+jws",
  claims: Record<string, unknown>,
): Promise<string> =>
  signJws({ iss: ISSUER, aud: PRODUCT, ...claims }, TEST_PEM, TEST_KID, typ);

const discovery = (interAccount: boolean, localPairing: boolean) => ({
  product: PRODUCT,
  services: {
    connect: {
      enabled: true,
      interAccount,
      localPairing,
      endpoints: { identity: `${BASE}/${PRODUCT}/connect/identity` },
    },
  },
});

interface Member {
  signKey: string;
  agreeKey: string;
}

/** The Worker's connect routes for several devices of one subject (or several subjects). */
export class MultiWorker {
  members = new Map<string, Member>();
  epoch = 1;
  sub = SUB;
  disc = base64UrlEncodeBytes(randomBytes(32));
  tokens = new Map<string, string>();
  /** Per-device subject override, for a device of another person. */
  subs = new Map<string, string>();
  /** Rings and certificates are issued at this time. */
  issuedAt = T0;
  certSpan = 604_800;
  /** The relay ticket route: what it answers, and the tickets it issued (ticket to device). */
  relay: "ok" | "disabled" | "paused" | "quota-person" | "quota-product" = "ok";
  /** The `Retry-After` of a paused answer, seconds. */
  retryAfter = 300;
  tickets = new Map<string, string>();
  ticketsAsked = 0;
  /** The `url` the ticket answer carries. */
  relayUrl = `wss://k.test/${PRODUCT}/connect/relay`;
  /** Discovery's `services.connect.interAccount` and whether contact tickets are served (§15.7). */
  interAccount = false;
  /** Discovery's `services.connect.localPairing` (§15.9, §15.12). */
  localPairing = false;
  /** The status of the discovery route (200 answers the document). */
  discoveryStatus = 200;
  /** An older Worker ignores the contact body and answers an account ticket. */
  echoRoom = true;
  /** Contact tickets: ticket to device and rid, and every ticket request body seen. */
  contactTickets = new Map<string, { device: string; rid: string }>();
  ticketBodies: string[] = [];
  /** Count and switch for the identity route. */
  identityCalls = 0;
  failIdentity = false;

  add(deviceId: string, token: string): void {
    this.tokens.set(token, deviceId);
  }

  async ring(sub: string): Promise<string> {
    const devices = [...this.members]
      .filter(([id]) => (this.subs.get(id) ?? SUB) === sub)
      .map(([deviceId, k]) => ({ deviceId, ...k }))
      .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    return sign("pkey-ring+jws", {
      sub,
      epoch: this.epoch,
      issuedAt: this.issuedAt,
      expiresAt: this.issuedAt + 604_800,
      devices,
    });
  }

  cert(deviceId: string, sub: string): Promise<string> {
    const k = this.members.get(deviceId)!;
    return sign("pkey-peer+jws", {
      sub,
      deviceId,
      ...k,
      ringEpoch: this.epoch,
      issuedAt: this.issuedAt,
      expiresAt: this.issuedAt + this.certSpan,
    });
  }

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.slice(PRODUCT.length + 2);
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    if (path === ".well-known/polaris.json")
      return this.discoveryStatus === 200
        ? j(discovery(this.interAccount, this.localPairing))
        : j({}, this.discoveryStatus);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const deviceId = this.tokens.get(auth.replace("Bearer ", ""));
    if (deviceId === undefined) return j({}, 401);
    const sub = this.subs.get(deviceId) ?? SUB;
    if (method === "PUT" && path === "devices/keys") {
      const body = JSON.parse(String(init!.body)) as Member;
      this.members.set(deviceId, {
        signKey: body.signKey,
        agreeKey: body.agreeKey,
      });
      this.epoch++;
      return j({ keySeq: 1 });
    }
    if (!this.members.has(deviceId))
      return j({ error: { code: "device_keys_required" } }, 409);
    if (method === "POST" && path === "connect/relay/ticket") {
      this.ticketsAsked++;
      const hdr = (extra: Record<string, string> = {}) => ({
        headers: extra,
      });
      if (this.relay === "disabled")
        return j({ error: { code: "relay_disabled" } }, 403);
      if (this.relay === "paused")
        return new Response(
          JSON.stringify({ error: { code: "relay_paused" } }),
          {
            status: 503,
            ...hdr({ "retry-after": String(this.retryAfter) }),
          },
        );
      if (this.relay === "quota-person" || this.relay === "quota-product")
        return j(
          {
            error: { code: "relay_quota_exceeded" },
            scope: this.relay === "quota-person" ? "person" : "product",
          },
          429,
        );
      const ticket = `pkeyrt_${base64UrlEncodeBytes(randomBytes(24))}`;
      const raw = typeof init?.body === "string" ? init.body : "";
      this.ticketBodies.push(raw);
      if (raw !== "") {
        // A contact ticket (§15.7): the gate first, then the body, which must be exactly the two members.
        if (!this.interAccount)
          return j({ error: { code: "connect_links_disabled" } }, 403);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return j({ error: { code: "bad_request" } }, 400);
        }
        const b = body as Record<string, unknown>;
        if (
          typeof b !== "object" ||
          b === null ||
          Object.keys(b).length !== 2 ||
          b.room !== "c" ||
          typeof b.rid !== "string" ||
          !/^[A-Za-z0-9_-]{22}$/.test(b.rid)
        )
          return j({ error: { code: "bad_request" } }, 400);
        this.contactTickets.set(ticket, { device: deviceId, rid: b.rid });
        return j({
          ticket,
          url: this.relayUrl,
          protocol: "pkey-relay.1",
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          ...(this.echoRoom ? { room: "c" } : {}),
        });
      }
      this.tickets.set(ticket, deviceId);
      return j({
        ticket,
        url: this.relayUrl,
        protocol: "pkey-relay.1",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
    }
    if (path === "connect/identity" && this.failIdentity)
      return j({ error: { code: "server_error" } }, 500);
    if (path === "connect/identity") {
      this.identityCalls++;
      return j({
        ring: await this.ring(sub),
        certificate: await this.cert(deviceId, sub),
        discKeys: [this.disc],
      });
    }
    return j({}, 404);
  }) as typeof fetch;
}

export function tmpDir(dirs: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "pkey-lan-"));
  dirs.push(d);
  return d;
}

export async function makeClient(
  worker: MultiWorker,
  n: string,
  dirs: string[],
  extra: {
    trustRefresh?: boolean;
    /** A device with no credential (and so not known to the Worker's token table). */
    noToken?: boolean;
    /** A licence document cached for this device: the "licence" half of autoSignIn()'s rung 1
     *  (the acquisition sync that would fetch it after a sign-in is not part of these tests). */
    licensed?: boolean;
  } = {},
): Promise<PolarisKeyClient> {
  const deviceId = devId(n);
  const store = Object.assign(new InMemoryStore(), {
    getDeviceId: async () => deviceId,
  });
  if (extra.licensed === true)
    await store.writeCache({
      v: CACHE_VERSION,
      docs: { license: await signedLicense({}, undefined, deviceId) },
    });
  if (extra.noToken !== true) {
    worker.add(deviceId, tokenOf(n));
    await store.setToken(tokenOf(n));
  }
  const stateDir = tmpDir(dirs);
  const keys = createNodeDeviceKeyStore({ product: PRODUCT, stateDir });
  const client = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: { [TEST_KID]: TEST_PUB } },
    trustRefresh: extra.trustRefresh ?? false,
    license: { fingerprint: false },
    devices: { fingerprint: false },
    store,
    fetchImpl: worker.fetch,
    stateDir,
    // One key store for Connect and the key ring: both are this device's identity.
    connect: { deviceKeys: keys },
    keyring: { deviceKeys: keys },
  });
  await client.init();
  return client;
}

/** Mark a client signed in, as a finished sign-in leaves it (identity.json beside the token). */
export function markSignedIn(c: PolarisKeyClient): void {
  const state = (c as unknown as { core: { dirs: { state: string } } }).core
    .dirs.state;
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "identity.json"),
    JSON.stringify({ email: "ana@example.test", signedInAt: T0 }),
  );
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll until `f` holds. Date is frozen in these tests, so it counts turns, not milliseconds. */
export async function until(
  f: () => boolean | Promise<boolean>,
  ms = 3000,
): Promise<void> {
  for (let i = 0; i < ms / 5; i++) {
    if (await f()) return;
    await sleep(5);
  }
  throw new Error("timed out");
}

/** LAN options for tests: this network, loopback allowed. */
export const loopLan = (net: MemoryMdnsNetwork) => ({
  mdns: net.adapter(),
  host: "127.0.0.1",
  allowLoopback: true,
});

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Freeze only `Date` at `T0`: the sockets and the timers of a LAN test run for real. */
export function freezeAtT0(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
}

/** The end of a LAN test: stop what it started, close its clients, remove its directories. */
export async function endTest(o: {
  clients: PolarisKeyClient[];
  dirs: string[];
  stoppables?: { stop(): Promise<unknown> }[];
}): Promise<void> {
  for (const h of o.stoppables?.splice(0) ?? []) await h.stop().catch(() => {});
  for (const c of o.clients.splice(0)) {
    await c.cloudConnect.stop().catch(() => {});
    c.close();
  }
  vi.useRealTimers();
  for (const d of o.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
