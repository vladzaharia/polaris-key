/// <reference types="@cloudflare/workers-types" />
import { CLOUD_CONNECT_CEILINGS } from "@polaris-key/catalog";
import { D1Db } from "../../../db/d1.js";
import { hexDecode, hexEncode } from "../../../platform/bytes.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { accountDeviceKeys } from "../../../core/devices/keys.js";
import { platformSetting } from "../../../core/settings/platformRead.js";
import {
  RELAY_CLOSE,
  RelayEngine,
  type RelayOutput,
  type RelayRestore,
} from "../relay/engine.js";
import {
  ADMISSION_HEADER,
  RELAY_PROTOCOL,
  decodeAdmission,
  deviceIdBytes,
} from "./admission.js";

// One person's relay room for one product (CC-07.2; plans/CC-01-cloud-connect.md §2.7, §2.9).
//
// A thin shell around the pure `RelayEngine`: it owns the sockets, the clock and the storage, and
// carries out the engine's outputs. The engine decides everything else.
//
// Reach. The object is named only by `do/client.ts` and is called only by the upgrade route
// (CC-07.3), which consumes the single-use ticket and sends the admission in a header. The object
// still checks the `launch.relay` gate on every upgrade and on every alarm (fail closed), and
// refuses an upgrade without an admission or without the `pkey-relay.1` subprotocol.
//
// Pin. The first admission pins (product, subject); any other pair is refused 403, so a misrouted
// call cannot join another person's room.
//
// Hibernation. Sockets are accepted with `ctx.acceptWebSocket`, so the object may be evicted
// while they stay open. Each socket's attachment holds its engine id, device and sequence number;
// the room's roster, quota, flags and the day's usage are in storage under `room`. On wake the
// engine is rebuilt with `restore()` from those, and the day's usage survives, so a restart never
// resets the person's daily ceiling.
//
// Meter. Bytes sent are kept in `pending`, by day. The alarm (every 60 s while there are sockets
// or unflushed bytes) writes them to `connect_relay_daily`, adds up the product's month, ticks
// the engine with the product-over flag and the gate, and sets the next alarm. A failed D1 write
// throws, so the runtime retries; `pending` is cleared only after D1 took it.
//
// Month ceiling. The 500 GiB product ceiling is enforced from `connect_relay_daily` (every
// instance of every person adds to it), checked at ticket time by the route and here on each alarm.

const ALARM_MS = 60_000;
const DAY_MS = 86_400_000;
const FLUSH_TIMEOUT_MS = 10_000;
/** After a purge, no admission for this long: a reconnect racing the erasure cannot re-create the room. */
const ERASED_MS = 600_000;
/** Consecutive unreadable gate, pause or roster reads the alarm tolerates before it enforces a close. */
const READ_FAILS_MAX = 3;

interface Attachment {
  id: string;
  device: string; // 48 hex
  seq: number;
}

interface Room {
  product: string;
  subject: string;
  members: string[];
  dayBytesQuota: number;
  paused: boolean;
  productOver: boolean;
  monthCeiling: number;
  seatsHeld?: boolean;
  day: number;
  dayUsed: number;
  seq: number;
}

type Pending = Record<string, { bytes: number; sessions: number }>;

const unhex = (h: string): Uint8Array => hexDecode(h) ?? new Uint8Array(0);

const dayString = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);
const monthStart = (day: number): { from: string; to: string } => {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    from: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10),
  };
};

/** Seams for tests; production passes none. */
export interface ConnectRelayDoOptions {
  db?: () => Db;
  now?: () => number;
  /** Mints a socket's engine id (default `crypto.randomUUID`). */
  newId?: () => string;
  /** Makes the upgrade pair (default `new WebSocketPair()`). */
  pair?: () => { client: WebSocket; server: WebSocket };
  /** Builds the 101 answer (Node's `Response` refuses status 101; the runtime's accepts it). */
  upgraded?: (client: WebSocket, headers: Record<string, string>) => Response;
}

export class ConnectRelayDO implements DurableObject {
  private readonly engine = new RelayEngine();
  private ready = false;
  private readonly loaded: Promise<void>;
  private readonly now: () => number;
  private readonly db: () => Db;
  private readonly newId: () => string;
  private readonly pair: () => { client: WebSocket; server: WebSocket };
  private readonly upgraded: (
    client: WebSocket,
    headers: Record<string, string>,
  ) => Response;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    opts: ConnectRelayDoOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.db = opts.db ?? (() => new D1Db(env.DB));
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.pair =
      opts.pair ??
      (() => {
        const p = new WebSocketPair();
        return { client: p[0], server: p[1] };
      });
    this.upgraded =
      opts.upgraded ??
      ((client, headers) =>
        new Response(null, { status: 101, webSocket: client, headers }));
    // Load the room before any event is delivered, then rebuild the engine from it.
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.cached = await ctx.storage.get<Room>("room");
      this.wake(this.now());
    });
  }

  // ── upgrade ────────────────────────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (request.method === "POST") return this.purge(request);
    // Fail closed: an unreadable gate is off. The route gated already; this is the second lock.
    if (!(await this.gateOn())) return new Response(null, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((s) => s.trim());
    if (!offered.includes(RELAY_PROTOCOL))
      return new Response(null, { status: 400 });
    const adm = decodeAdmission(request.headers.get(ADMISSION_HEADER));
    if (!adm) return new Response(null, { status: 400 });

    const pinned = this.cached;
    if (
      pinned &&
      (pinned.product !== adm.product || pinned.subject !== adm.subject)
    )
      return new Response(null, { status: 403 });
    const erasedAt = await this.ctx.storage.get<number>("erasedAt");
    if (erasedAt !== undefined && this.now() - erasedAt < ERASED_MS)
      return new Response(null, { status: 403 });

    const now = this.now();
    this.wake(now);
    const id = this.newId();
    const { client, server } = this.pair();
    const outs = this.engine.step({
      kind: "connect",
      socket: id,
      ticket: adm.ticket,
      now,
    });
    const refused = outs.some((o) => o.kind === "close" && o.socket === id);
    const dev = hexEncode(adm.ticket.device);
    const mine = this.engine.snapshot().sockets.find((x) => x.socket === id);
    this.ctx.acceptWebSocket(server, [`d:${dev}`]);
    server.serializeAttachment({
      id,
      device: dev,
      seq: mine?.seq ?? 0,
    } satisfies Attachment);

    if (!refused) {
      await this.persist(
        adm.product,
        adm.subject,
        adm.monthCeiling,
        adm.seatsHeld,
      );
      await this.addSession(now);
    }
    await this.carryOut(outs);
    await this.ensureAlarm();
    return this.upgraded(client, {
      "sec-websocket-protocol": RELAY_PROTOCOL,
    });
  }

  /**
   * Erase the room (account deletion or merge): close every socket, drop the roster, the usage
   * and the alarm. Not behind the launch gate: erasure must work whatever the gate says. Reached
   * only by `do/client.ts`, which is called by the subject store; the pin must match.
   */
  private async purge(request: Request): Promise<Response> {
    let body: { product?: unknown; subject?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(null, { status: 400 });
    }
    const pinned = this.cached;
    if (
      pinned &&
      (pinned.product !== body.product || pinned.subject !== body.subject)
    )
      return new Response(null, { status: 403 });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(RELAY_CLOSE.notMember, "erased");
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("erasedAt", this.now());
    this.cached = undefined;
    this.engine.restore(
      {
        sockets: [],
        members: [],
        dayBytesQuota: 0,
        paused: false,
        productOver: false,
        day: -1,
        dayUsed: 0,
      },
      this.now(),
    );
    return new Response(null, { status: 204 });
  }

  // ── hibernation handlers ───────────────────────────────────────────────────────────────────

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.loaded;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) {
      ws.close(RELAY_CLOSE.refused, "refused");
      return;
    }
    const now = this.now();
    this.wake(now);
    const outs = this.engine.step({
      kind: "frame",
      socket: att.id,
      data: typeof message === "string" ? message : new Uint8Array(message),
      now,
    });
    if (outs.some((o) => o.kind === "meter")) await this.persistUsage();
    await this.carryOut(outs);
    await this.ensureAlarm();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.gone(ws);
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 ? code : 1000);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws);
  }

  private async gone(ws: WebSocket): Promise<void> {
    await this.loaded;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const now = this.now();
    this.wake(now);
    await this.carryOut(
      this.engine.step({ kind: "close", socket: att.id, now }),
    );
  }

  // ── alarm ──────────────────────────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    await this.loaded;
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = await this.ctx.storage.get<Room>("room");
      if (!room) return;
      const now = this.now();
      this.wake(now);

      // What the room must still be true to: the launch gate, the deployment pause and the
      // person's roster, each read fresh. An unreadable read keeps the room open and is retried
      // on the next alarm; the third in a row enforces the close (fail closed).
      let closeAll = false;
      let paused = false;
      let roster: Uint8Array[] | null = null;
      let readFailed = false;
      try {
        const gate = await platformSetting(this.env, this.db(), "launch.relay");
        paused =
          (await platformSetting(
            this.env,
            this.db(),
            "cloudConnect.relayPaused",
          )) === "on";
        closeAll = gate !== "on";
      } catch {
        readFailed = true;
      }
      try {
        const keys = await accountDeviceKeys(
          this.db(),
          room.product,
          room.subject,
          { seatsHeld: room.seatsHeld ?? true, now: Math.floor(now / 1000) },
        );
        roster = keys
          .map((k) => deviceIdBytes(k.deviceId))
          .filter((b): b is Uint8Array => b !== null);
      } catch {
        readFailed = true;
      }
      const fails = readFailed
        ? ((await this.ctx.storage.get<number>("readFails")) ?? 0) + 1
        : 0;
      if (readFailed) await this.ctx.storage.put("readFails", fails);
      else await this.ctx.storage.delete("readFails");
      if (fails >= READ_FAILS_MAX) closeAll = true;

      if (closeAll || paused) {
        // Off, paused or unverifiable: LIMIT 4, then every socket closes with 4008.
        await this.carryOut(
          this.engine.step({ kind: "tick", now, paused: true }),
        );
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(RELAY_CLOSE.limit, "paused");
          } catch {
            // Already closed.
          }
        }
      } else if (!readFailed) {
        // Recovery: the pause is over, new admissions are allowed again.
        await this.carryOut(
          this.engine.step({ kind: "tick", now, paused: false }),
        );
      }
      if (roster !== null && !closeAll) {
        if (roster.length === 0) {
          // The person has no device left: nothing can reconnect, so the room goes.
          await this.eraseRoom(RELAY_CLOSE.notMember);
          return;
        }
        // Devices that left the roster lose their sockets (4003) and are announced gone.
        await this.carryOut(
          this.engine.step({ kind: "members", members: roster }),
        );
      }
      // Flush the meter. A failure throws: the runtime retries, and `pending` stays owed.
      const pending = (await this.ctx.storage.get<Pending>("pending")) ?? {};
      const days = Object.keys(pending);
      const db = this.db();
      if (days.length > 0) {
        await withTimeout(
          db.batch(
            days.map((d) => ({
              sql: `INSERT INTO connect_relay_daily (product, day, bytes, sessions)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT (product, day) DO UPDATE SET
                      bytes = bytes + excluded.bytes,
                      sessions = sessions + excluded.sessions`,
              params: [
                room.product,
                dayString(Number(d)),
                pending[d]!.bytes,
                pending[d]!.sessions,
              ],
            })),
          ),
        );
        await this.ctx.storage.delete("pending");
      }
      // The product's month, from the counters every room feeds.
      const { from, to } = monthStart(Math.floor(now / DAY_MS));
      const row = await withTimeout(
        db.first<{ b: number }>(
          "SELECT COALESCE(SUM(bytes), 0) AS b FROM connect_relay_daily WHERE product = ? AND day >= ? AND day < ?",
          room.product,
          from,
          to,
        ),
      );
      const over = (row?.b ?? 0) >= room.monthCeiling;
      await this.carryOut(
        this.engine.step({ kind: "tick", now, productOver: over }),
      );
      await this.persist(room.product, room.subject, room.monthCeiling);
      await this.ensureAlarm();
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  private async gateOn(): Promise<boolean> {
    try {
      return (
        (await platformSetting(this.env, this.db(), "launch.relay")) === "on"
      );
    } catch {
      return false;
    }
  }

  /** Close every socket and drop the room, the usage and the alarm (no tombstone). */
  private async eraseRoom(code: number): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, "closed");
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.cached = undefined;
  }

  /** Rebuild the engine after hibernation or eviction (once per wake). */
  private wake(now: number): void {
    if (this.ready) return;
    this.ready = true;
    const room = this.cached;
    if (!room) return;
    const sockets = this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Attachment | null)
      .filter((a): a is Attachment => !!a)
      .map((a) => ({
        socket: a.id,
        device: unhex(a.device),
        seq: a.seq,
      }));
    const r: RelayRestore = {
      sockets,
      members: room.members.map(unhex),
      dayBytesQuota: room.dayBytesQuota,
      paused: room.paused,
      productOver: room.productOver,
      day: room.day,
      dayUsed: room.dayUsed,
    };
    this.engine.restore(r, now);
  }

  /** The persisted room, loaded in the constructor and kept in step with storage. */
  private cached: Room | undefined;

  private async persist(
    product: string,
    subject: string,
    monthCeiling: number,
    seatsHeld: boolean = this.cached?.seatsHeld ?? true,
  ): Promise<void> {
    const s = this.engine.snapshot();
    const room: Room = {
      seatsHeld,
      product,
      subject,
      members: s.members.map((m) => hexEncode(m)),
      dayBytesQuota: s.dayBytesQuota,
      paused: s.paused,
      productOver: s.productOver,
      monthCeiling: Math.min(
        monthCeiling,
        CLOUD_CONNECT_CEILINGS.perProduct.relayBytesPerMonth,
      ),
      day: s.day,
      dayUsed: s.dayUsed,
      seq: Math.max(0, ...s.sockets.map((x) => x.seq + 1)),
    };
    this.cached = room;
    await this.ctx.storage.put("room", room);
  }

  /** Persist just the day's usage after metered bytes (the rest of the room is unchanged). */
  private async persistUsage(): Promise<void> {
    const room = this.cached;
    if (!room) return;
    const s = this.engine.snapshot();
    room.day = s.day;
    room.dayUsed = s.dayUsed;
    await this.ctx.storage.put("room", room);
  }

  private async addSession(now: number): Promise<void> {
    const day = String(Math.floor(now / DAY_MS));
    const p = (await this.ctx.storage.get<Pending>("pending")) ?? {};
    const cur = p[day] ?? { bytes: 0, sessions: 0 };
    cur.sessions += 1;
    p[day] = cur;
    await this.ctx.storage.put("pending", p);
  }

  private async carryOut(outs: RelayOutput[]): Promise<void> {
    const live = new Map<string, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) live.set(a.id, ws);
    }
    const bytes: Record<string, number> = {};
    for (const o of outs) {
      if (o.kind === "send") {
        try {
          live.get(o.socket)?.send(o.data);
        } catch {
          // A socket that just closed: the close handler drops it.
        }
      } else if (o.kind === "close") {
        try {
          live.get(o.socket)?.close(o.code, "closed");
        } catch {
          // Already closed.
        }
      } else {
        bytes[String(o.day)] = (bytes[String(o.day)] ?? 0) + o.bytes;
      }
    }
    if (Object.keys(bytes).length > 0) await this.addBytes(bytes);
  }

  private async addBytes(bytes: Record<string, number>): Promise<void> {
    const p = (await this.ctx.storage.get<Pending>("pending")) ?? {};
    for (const [d, n] of Object.entries(bytes)) {
      const cur = p[d] ?? { bytes: 0, sessions: 0 };
      cur.bytes += n;
      p[d] = cur;
    }
    await this.ctx.storage.put("pending", p);
  }

  private async ensureAlarm(): Promise<void> {
    const owed = await this.ctx.storage.get<Pending>("pending");
    const busy =
      this.ctx.getWebSockets().length > 0 ||
      (owed !== undefined && Object.keys(owed).length > 0);
    if (busy && (await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(this.now() + ALARM_MS);
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(
      () => rej(new Error("relay meter timeout")),
      FLUSH_TIMEOUT_MS,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
