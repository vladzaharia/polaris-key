/// <reference types="@cloudflare/workers-types" />
// The relay room tests' harness (CC-07.2, shared since CC-19.4): a fake state (storage, alarm,
// hibernation-API sockets) and a fake WebSocket pair around the real `ConnectRelayDO`.

import { decodeRelay, encodeRelay } from "@polaris-key/client-core/peer";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import {
  ADMISSION_HEADER,
  encodeAdmission,
  type Admission,
} from "../../../src/services/connect/do/admission.js";
import {
  ConnectRelayDO,
  type ConnectRelayDoOptions,
} from "../../../src/services/connect/do/relayDo.js";

export const DAY = 86_400_000;
export const T0 = Math.floor(1_800_000_000_000 / DAY) * DAY + 3_600_000;
export const GiB = 1024 ** 3;
export const dev = (n: number): Uint8Array => new Uint8Array(24).fill(n);
export const A = dev(1);
export const B = dev(2);

export class FakeSocket {
  sent: Uint8Array[] = [];
  closed: number | null = null;
  attachment: unknown = null;
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(code: number): void {
    this.closed = code;
  }
  serializeAttachment(v: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(v));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/** Storage and sockets that outlive the object instance, as they do across hibernation. */
export class FakeState {
  store = new Map<string, unknown>();
  alarmAt: number | null = null;
  sockets: FakeSocket[] = [];
  storage = {
    get: async (k: string) => structuredClone(this.store.get(k)),
    put: async (k: string, v: unknown) =>
      void this.store.set(k, structuredClone(v)),
    delete: async (k: string) => void this.store.delete(k),
    getAlarm: async () => this.alarmAt,
    setAlarm: async (t: number) => void (this.alarmAt = t),
    deleteAlarm: async () => void (this.alarmAt = null),
    deleteAll: async () => void this.store.clear(),
  };
  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }
  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.closed === null);
  }
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> {
    return f();
  }
}

export function world(env: Env = makeEnv(new KvMock())) {
  const db = makeTestDb();
  const state = new FakeState();
  let now = T0;
  let n = 0;
  const pairs: { client: FakeSocket; server: FakeSocket }[] = [];
  const make = (extra: Partial<ConnectRelayDoOptions> = {}) =>
    new ConnectRelayDO(state as unknown as DurableObjectState, env, {
      db: () => db,
      now: () => now,
      newId: () => `s${++n}`,
      pair: () => {
        const p = { client: new FakeSocket(), server: new FakeSocket() };
        pairs.push(p);
        return p as never;
      },
      upgraded: (_c, headers) =>
        new Response("upgraded", { status: 200, headers }),
      ...extra,
    });
  return {
    db,
    state,
    env,
    make,
    pairs,
    tick: (ms: number) => (now += ms),
    now: () => now,
  };
}

export const idOf = (d: Uint8Array): string =>
  Buffer.from(d).toString("base64url");

/** Seed the person's roster (subject ps_AAAAAAAAAAAAAAAAAAAAAA on djdl) the alarm re-reads: the given devices. */
export async function seedRoster(
  w: ReturnType<typeof world>,
  devices: Uint8Array[] = [A, B],
): Promise<void> {
  await seedProduct(w.db, "djdl");
  await w.db.run(
    "INSERT OR IGNORE INTO accounts (id, created_at, modified_at) VALUES ('acc1', 1, 1)",
  );
  await w.db.run(
    "INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at) VALUES ('acc1', 'djdl', 'ps_AAAAAAAAAAAAAAAAAAAAAA', 1)",
  );
  for (const [i, d] of devices.entries()) {
    await w.db.run(
      `INSERT OR REPLACE INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES ('djdl', ?, '', 'authorized', 1, 1, 'ps_AAAAAAAAAAAAAAAAAAAAAA')`,
      idOf(d),
    );
    await w.db.run(
      `INSERT OR REPLACE INTO device_keys (product, device_id, sign_key, agree_key, key_seq, created_at)
       VALUES ('djdl', ?, ?, ?, 1, 1)`,
      idOf(d),
      `sign${i}${idOf(d)}`,
      `agree${i}${idOf(d)}`,
    );
  }
}

const seeded = new WeakSet<object>();
/** Run the room's alarm with the default roster (A and B) seeded once. */
export async function alarmOf(
  w: ReturnType<typeof world>,
  room: ConnectRelayDO,
): Promise<void> {
  if (!seeded.has(w.db)) {
    seeded.add(w.db);
    await seedRoster(w);
  }
  await room.alarm();
}

export const adm = (
  device: Uint8Array,
  over: Partial<Admission["ticket"]> = {},
  top: Partial<Admission> = {},
): Admission => ({
  product: "djdl",
  subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
  monthCeiling: 500 * GiB,
  seatsHeld: false,
  ticket: {
    device,
    members: [A, B],
    dayBytes: 256 * 1024 * 1024,
    paused: false,
    productOver: false,
    expiresAt: T0 + 60_000,
    ...over,
  },
  ...top,
});

export function upgrade(
  a: Admission | null,
  protocols = "pkey-relay.1, pkeyrt_x",
) {
  const h: Record<string, string> = {
    upgrade: "websocket",
    "sec-websocket-protocol": protocols,
  };
  if (a) h[ADMISSION_HEADER] = encodeAdmission(a);
  return new Request("https://connect-relay.do/", { headers: h });
}

export const frames = (s: FakeSocket) =>
  s.sent.map((d) => decodeRelay("toClient", d)?.op);
export const send = (to: Uint8Array, len = 10): ArrayBuffer =>
  encodeRelay({
    op: "send",
    to,
    session: 1,
    noise: new Uint8Array(len),
  }).slice().buffer;

/** A room with devices A and B online (sockets pairs 0 and 1). */
export async function joined(
  w: ReturnType<typeof world>,
): Promise<ConnectRelayDO> {
  const room = w.make();
  await room.fetch(upgrade(adm(A)));
  await room.fetch(upgrade(adm(B)));
  return room;
}
