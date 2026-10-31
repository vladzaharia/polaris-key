// The relay fixtures the Connect browser tests share: devices with real keys, a roster and
// certificates signed by the corpus key, an in-process room with the CC-07 engine's framing, and a
// world of two devices (`pair()`).
import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import { signJws } from "@polaris-key/jws";
import {
  decodeRelay,
  deviceIdBytes,
  encodeRelay,
  type RelayMessage,
} from "@polaris-key/client-core/peer";
import type { ConnectSession } from "../src/browser/connect/index.js";
import {
  RelayService,
  type RelaySocket,
  type RelaySource,
} from "@polaris-key/ui-core/browser/sdk/browser/connect/relay.js";

export const PRODUCT = "acme";
export const BASE = "https://key.plrs.im";
export const T0 = 1_761_300_000;
export const WEEK = 604_800;
export const SUB = "ps_AAAAAAAAAAAAAAAAAAAAAA";
export const TOKEN = `pkeyt_${"T".repeat(43)}`;
export const devId = (n: string): string => "RELAYDEVICE".padEnd(31, "0") + n;
export const A = devId("1");
export const B = devId("2");

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS = JSON.parse(
  readFileSync(join(HERE, "../../../conformance/corpus/v2/cases.json"), "utf8"),
) as {
  keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
};
export const PIN = CORPUS.keys.find((k) => k.kid === "pkey-test-prod-2026")!;
export const TRUST = { [PIN.kid]: PIN.publicKeyRaw };

export const b64 = (b: Uint8Array): string =>
  Buffer.from(b).toString("base64url");
export const raw32 = (der: Buffer | Uint8Array): Uint8Array =>
  new Uint8Array(der.subarray(der.length - 32));
export const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
}
export const utf8 = (s: string) => new TextEncoder().encode(s);

// ── Devices with real keys ─────────────────────────────────────────────────────────────────────

export interface Dev {
  id: string;
  signKey: string;
  agreeKey: string;
  port: DeviceKeyPort;
}
export function device(id: string): Dev {
  const ed = generateKeyPairSync("ed25519");
  const x = generateKeyPairSync("x25519");
  const keys = {
    signKey: b64(raw32(ed.publicKey.export({ format: "der", type: "spki" }))),
    agreeKey: b64(raw32(x.publicKey.export({ format: "der", type: "spki" }))),
    generation: 1,
  };
  const port: DeviceKeyPort = {
    ensure: async () => keys,
    publicKeys: async () => keys,
    sign: async (m) =>
      new Uint8Array(sign(null, Buffer.from(m), ed.privateKey)),
    dh: async (p) =>
      new Uint8Array(
        diffieHellman({
          privateKey: x.privateKey,
          publicKey: createPublicKey({
            key: Buffer.concat([X25519_SPKI, Buffer.from(p)]),
            format: "der",
            type: "spki",
          }),
        }),
      ),
    rotate: async () => keys,
    persistence: () => "durable",
    wipe: async () => undefined,
  };
  return { id, ...keys, port };
}

export const signRing = (devs: Dev[], epoch: number, sub = SUB, span = WEEK) =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: PRODUCT,
      sub,
      epoch,
      issuedAt: T0,
      expiresAt: T0 + span,
      devices: devs
        .map((d) => ({
          deviceId: d.id,
          signKey: d.signKey,
          agreeKey: d.agreeKey,
        }))
        .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
    },
    PIN.privateKeyPkcs8Pem,
    PIN.kid,
    "pkey-ring+jws",
  );
export const signCert = (d: Dev, epoch: number) =>
  signJws(
    {
      iss: "key.plrs.im",
      aud: PRODUCT,
      sub: SUB,
      deviceId: d.id,
      signKey: d.signKey,
      agreeKey: d.agreeKey,
      ringEpoch: epoch,
      issuedAt: T0,
      expiresAt: T0 + WEEK,
    },
    PIN.privateKeyPkcs8Pem,
    PIN.kid,
    "pkey-peer+jws",
  );

// ── The room ───────────────────────────────────────────────────────────────────────────────────

export class FakeSock implements RelaySocket {
  binaryType = "blob";
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  device: string | null = null;
  open = false;
  closed = false;
  closeCode: number | null = null;
  constructor(
    readonly room: FakeRoom,
    readonly url: string,
    readonly protocols: string[],
  ) {
    setTimeout(() => room.admit(this), 0);
  }
  send(data: Uint8Array): void {
    if (!this.open) throw new Error("not open");
    this.room.fromClient(this, data);
  }
  close(code = 1000): void {
    if (!this.closed) this.shut(code);
  }
  shut(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.closeCode = code;
    this.room.sockets = this.room.sockets.filter((s) => s !== this);
    setTimeout(() => this.onclose?.({ code }), 0);
  }
  deliver(m: RelayMessage | Uint8Array): void {
    if (!this.open) return;
    const bytes = m instanceof Uint8Array ? m : encodeRelay(m);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    setTimeout(() => this.onmessage?.({ data: buf }), 0);
  }
}

export class FakeRoom {
  sockets: FakeSock[] = [];
  made: FakeSock[] = [];
  received: { device: string; msg: RelayMessage }[] = [];
  offered: string[][] = [];
  tickets = new Map<string, string>();
  members = new Set<string>();
  rejectWith: number | null = null;
  webSocket = (url: string, protocols: string[]): RelaySocket => {
    const s = new FakeSock(this, url, protocols);
    this.made.push(s);
    return s;
  };
  admit(s: FakeSock): void {
    this.offered.push(s.protocols);
    const [proto, ticket] = s.protocols;
    if (this.rejectWith !== null) {
      const c = this.rejectWith;
      this.rejectWith = null;
      return s.shut(c);
    }
    const dev = ticket === undefined ? undefined : this.tickets.get(ticket);
    if (proto !== "pkey-relay.1" || dev === undefined) return s.shut(4001);
    this.tickets.delete(ticket!);
    if (!this.members.has(dev)) return s.shut(4003);
    s.device = dev;
    s.open = true;
    this.sockets.push(s);
    s.onopen?.({});
  }
  fromClient(s: FakeSock, data: Uint8Array): void {
    const m = decodeRelay("toRoom", data);
    if (m === null) return s.shut(1008);
    this.received.push({ device: s.device!, msg: m });
    if (m.op === "send") {
      const to = b64(m.to);
      for (const t of this.sockets.filter((x) => x.device === to))
        t.deliver({
          op: "recv",
          from: deviceIdBytes(s.device!),
          session: m.session,
          noise: m.noise,
        });
    } else if (m.op === "list")
      s.deliver({
        op: "members",
        devices: [...new Set(this.sockets.map((x) => x.device!))].map((d) =>
          deviceIdBytes(d),
        ),
      });
    else if (m.op === "ping") s.deliver({ op: "pong", data: m.data });
  }
  inject(from: string, to: string, session: number, noise: Uint8Array): void {
    for (const t of this.sockets.filter((x) => x.device === to))
      t.deliver({ op: "recv", from: deviceIdBytes(from), session, noise });
  }
  sends(device: string) {
    return this.received.flatMap((r) =>
      r.device === device && r.msg.op === "send" ? [r.msg] : [],
    );
  }
}

export class ManualTimer {
  pending: { ms: number; fn: () => void; id: number }[] = [];
  delays: number[] = [];
  #n = 0;
  timer = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.#n;
    this.delays.push(ms);
    this.pending.push({ ms, fn, id });
    return () => {
      this.pending = this.pending.filter((p) => p.id !== id);
    };
  };
  fire(match: (ms: number) => boolean): boolean {
    const p = this.pending.find((x) => match(x.ms));
    if (p === undefined) return false;
    this.pending = this.pending.filter((x) => x !== p);
    p.fn();
    return true;
  }
}

// ── A world of two devices and a room ───────────────────────────────────────────────────────────

export const OPEN_MS = 222_222;
export const PING_MS = 111_111;
export const isBackoff = (ms: number) => ms !== OPEN_MS && ms !== PING_MS;

export const live: RelayService[] = [];

export async function world() {
  const a = device(A);
  const b = device(B);
  const disc = new Uint8Array(randomBytes(32));
  const room = new FakeRoom();
  room.members.add(A).add(B);
  const ringJws = await signRing([a, b], 1);
  const identity = async (d: Dev, ring = ringJws, epoch = 1) => ({
    slug: PRODUCT,
    trust: TRUST,
    sub: SUB,
    deviceId: d.id,
    certJws: await signCert(d, epoch),
    certExpiresAt: T0 + WEEK,
    ringJws: ring,
    ringEpoch: epoch,
    roster: [A, B],
    keys: { current: disc, previous: null },
    agreePublic: Uint8Array.from(Buffer.from(d.agreeKey, "base64url")),
    dh: (p: Uint8Array) => d.port.dh(p),
  });
  const calls = {
    adopt: [] as string[],
    trust: [] as string[],
    refresh: 0,
    tickets: 0,
  };
  const source = async (
    d: Dev,
    over: Partial<RelaySource> = {},
  ): Promise<RelaySource> => {
    const id = await identity(d);
    return {
      now: () => T0,
      load: async () => id,
      refresh: async () => {
        calls.refresh += 1;
      },
      adoptRing: async (jws) => {
        calls.adopt.push(jws);
        return { stored: true, epoch: 2 };
      },
      applyTrust: async (jws) => {
        calls.trust.push(jws);
        return { applied: true };
      },
      ticket: async () => {
        calls.tickets += 1;
        const ticket = `pkeyrt_${b64(randomBytes(24))}`;
        room.tickets.set(ticket, d.id);
        return {
          ticket,
          url: `wss://key.plrs.im/${PRODUCT}/connect/relay`,
          protocol: "pkey-relay.1",
          expiresAt: T0 + 60,
        };
      },
      ...over,
    };
  };
  const svc = async (
    d: Dev,
    t: ManualTimer,
    extra: object = {},
    over: Partial<RelaySource> = {},
  ) => {
    const r = new RelayService(await source(d, over), {
      webSocket: room.webSocket,
      timer: t.timer,
      random: () => 0.5,
      pingMs: PING_MS,
      openMs: OPEN_MS,
      ...extra,
    });
    live.push(r);
    r.start();
    return r;
  };
  return { a, b, disc, room, calls, svc, source, identity, ringJws };
}

export async function pair() {
  const w = await world();
  const ta = new ManualTimer();
  const tb = new ManualTimer();
  const ra = await w.svc(w.a, ta);
  const rb = await w.svc(w.b, tb);
  let inn: ConnectSession | null = null;
  ra.onSession((s) => (inn = s));
  await ra.ready();
  await rb.ready();
  await until(() => rb.members().includes(A));
  const out = await rb.dial(A);
  await until(() => inn !== null);
  return { ...w, ra, rb, out, inn: inn! as ConnectSession, ta, tb };
}
