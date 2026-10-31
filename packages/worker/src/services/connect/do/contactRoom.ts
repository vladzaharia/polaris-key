/// <reference types="@cloudflare/workers-types" />
/**
 * A contact room (CC-19.4; plans/CC-16-CC-19-CC-20-slices.md D-5, D-6; WIRE-CONTRACT-V5 §15.7,
 * §15.10): the Durable Object `<p>:c:<rid>`, which joins the two devices of one link. It is the
 * same class as the account room (`relayDo.ts` delegates here when the object is a contact room),
 * so there is no new binding.
 *
 * What it keeps. At rest, per alias: the alias itself, an unspent lease count and the last-seen
 * time, plus the product and the product's month ceiling (neither names a person) and the day the
 * leases belong to. The subject and the device id of a connected device live only in the memory of
 * its live socket (the hibernation attachment, from the ticket) and are never written to storage;
 * the device id stays in the socket attachment only, for the alarm's roster check, and is never
 * stored. `from`, `to`, MEMBERS and
 * GONE carry the alias, `SHA-256(rid ‖ deviceId)[0..24]`, never the device id.
 *
 * Pin. The first two aliases that connect with a valid ticket are the members; a third is closed
 * 4003. There is no RING and the pinned aliases are never re-derived from a roster. At its alarm
 * the room checks each open socket's device against its person's devices, read fresh by the
 * admission rule: a socket whose device left closes 4003 and the peer hears GONE.
 *
 * Meter. Each sender pays for its own bytes from a lease: before a SEND is forwarded the room holds
 * lease for its bytes, and tops up from the sender's account room (`do/client.ts` `leaseBytes`) in
 * steps of `CONTACT_LEASE_BYTES`. That room adds the grant to the person's day, so the day quota,
 * the unlicensed rate, the 4 GiB ceiling and the product's month all hold however many rooms are
 * open. A grant of 0 sends LIMIT and closes 4008; a lease left over stays with the alias across
 * sockets until the day rolls over or the room erases. Receiving costs nothing.
 *
 * Gates. The upgrade and every alarm ask `launch.relay` and `launch.connectLinks`; an off gate
 * closes the open sockets with 4003 at the next minute, the pause sends LIMIT 4 and closes 4008.
 *
 * Erasure. With no socket for `CONTACT_ROOM_IDLE_SECONDS` the room erases itself on an alarm.
 *
 * Calls are serialized: the lease call awaits another object, and the room must not interleave two
 * messages of one sender across it.
 */

import {
  CONTACT_LEASE_BYTES,
  CONTACT_ROOM_IDLE_SECONDS,
  contactAlias,
} from "@polaris-key/client-core/peer";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { b64urlEncode, hexDecode, hexEncode } from "../../../platform/bytes.js";
import { platformSetting } from "../../../core/settings/platformRead.js";
import {
  RELAY_CLOSE,
  RelayEngine,
  type LeaseDenied,
  type RelayOutput,
} from "../relay/engine.js";
import { accountDeviceKeys } from "../../../core/devices/keys.js";
import { RELAY_PROTOCOL, deviceIdBytes, type Admission } from "./admission.js";
import { leaseBytes } from "./client.js";

const ALARM_MS = 60_000;
const IDLE_MS = CONTACT_ROOM_IDLE_SECONDS * 1000;
const DAY_MS = 86_400_000;
/** Consecutive unreadable gate reads the alarm tolerates before it enforces a close. */
const READ_FAILS_MAX = 3;

/** What a contact room stores. No subject, no device id (see the header). */
export interface ContactRecord {
  product: string;
  monthCeiling: number;
  /** The pinned aliases (hex), at most two. */
  aliases: Record<string, { lease: number; seen: number }>;
  /** The UTC day the leases were granted on. */
  day: number;
}

/** A live socket's attachment: in the socket's memory only. */
interface ContactAttachment {
  id: string;
  /** The alias, 48 hex. */
  device: string;
  seq: number;
  /** The sender's pairwise subject, for its lease calls. */
  subject: string;
  /** The sender's resolved relay bytes per day, from its ticket. */
  dayBytes: number;
  /** The licence service is on for the sender's product (decides the roster rule of its room). */
  seatsHeld: boolean;
  /** The ticket's device, 48 hex: for the alarm's roster check; in the socket's memory only. */
  dev?: string;
}

/** What the object hands the room. */
export interface ContactHost {
  ctx: DurableObjectState;
  env: Env;
  db: () => Db;
  now: () => number;
  newId: () => string;
  pair: () => { client: WebSocket; server: WebSocket };
  upgraded: (client: WebSocket, headers: Record<string, string>) => Response;
  /** The room erased itself: the object is an empty shell again. */
  erased: () => void;
}

const unhex = (h: string): Uint8Array => hexDecode(h) ?? new Uint8Array(0);

export class ContactRoom {
  private readonly engine = new RelayEngine({ contact: true });
  private woke = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: ContactHost,
    private record: ContactRecord | undefined,
  ) {
    if (record) this.wake(host.now());
  }

  /** Is anything stored? (The object keeps a contact room only while this is true.) */
  get present(): boolean {
    return this.record !== undefined;
  }

  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.tail.then(f, f);
    this.tail = run.catch(() => undefined);
    return run;
  }

  // ── admission ──────────────────────────────────────────────────────────────────────────────

  async upgrade(adm: Admission): Promise<Response> {
    return this.exclusive(() => this.admit(adm));
  }

  private async admit(adm: Admission): Promise<Response> {
    if (!adm.contact) return new Response(null, { status: 400 });
    if (!(await this.gatesOn())) return new Response(null, { status: 404 });
    const rec = this.record;
    if (rec && rec.product !== adm.product)
      return new Response(null, { status: 403 });

    const now = this.host.now();
    this.wake(now);
    const alias = await contactAlias(
      adm.contact.rid,
      b64urlEncode(adm.ticket.device),
    );
    const aliasHex = hexEncode(alias);
    const pinned = Object.keys(rec?.aliases ?? {});
    // A third alias is not a member: the pinned two are the members, the engine closes it 4003.
    const members =
      pinned.length >= 2 || pinned.includes(aliasHex)
        ? pinned.map(unhex)
        : [...pinned.map(unhex), alias];

    const id = this.host.newId();
    const { client, server } = this.host.pair();
    const outs = this.engine.step({
      kind: "connect",
      socket: id,
      ticket: {
        device: alias,
        members,
        dayBytes: adm.ticket.dayBytes,
        paused: false,
        productOver: false,
        expiresAt: adm.ticket.expiresAt,
      },
      now,
    });
    const refused = outs.some((o) => o.kind === "close" && o.socket === id);
    const mine = this.engine.snapshot().sockets.find((x) => x.socket === id);
    this.host.ctx.acceptWebSocket(server, [`d:${aliasHex}`]);
    server.serializeAttachment({
      id,
      device: aliasHex,
      seq: mine?.seq ?? 0,
      subject: adm.subject,
      dayBytes: adm.ticket.dayBytes,
      seatsHeld: adm.seatsHeld,
      dev: hexEncode(adm.ticket.device),
    } satisfies ContactAttachment);

    if (!refused) {
      const held = this.record?.aliases[aliasHex];
      await this.save(
        adm.product,
        adm.monthCeiling,
        { [aliasHex]: { lease: held?.lease ?? 0, seen: now } },
        now,
      );
    }
    await this.carryOut(outs);
    await this.ensureAlarm(now);
    return this.host.upgraded(client, {
      "sec-websocket-protocol": RELAY_PROTOCOL,
    });
  }

  // ── sockets ────────────────────────────────────────────────────────────────────────────────

  async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.exclusive(async () => {
      const att = ws.deserializeAttachment() as ContactAttachment | null;
      if (!att || !this.record) {
        ws.close(RELAY_CLOSE.refused, "refused");
        return;
      }
      const now = this.host.now();
      this.wake(now);
      const data =
        typeof message === "string" ? message : new Uint8Array(message);
      let denied: LeaseDenied | undefined;
      if (this.engine.needLease(att.id, data, now) > 0) {
        const grant = await leaseBytes(this.host.env, {
          product: this.record.product,
          subject: att.subject,
          bytes: CONTACT_LEASE_BYTES,
          dayBytes: att.dayBytes,
          monthCeiling: this.record.monthCeiling,
          seatsHeld: att.seatsHeld,
        });
        this.engine.credit(att.device, grant.granted, now);
        if (this.engine.needLease(att.id, data, now) > 0)
          denied = {
            reason: grant.reason === 0 ? 2 : grant.reason,
            zero: grant.granted === 0,
          };
      }
      const outs = this.engine.step({
        kind: "frame",
        socket: att.id,
        data,
        now,
        ...(denied ? { denied } : {}),
      });
      await this.saveLeases();
      await this.carryOut(outs);
    });
  }

  async close(ws: WebSocket): Promise<void> {
    return this.exclusive(async () => {
      const att = ws.deserializeAttachment() as ContactAttachment | null;
      if (!att || !this.record) return;
      const now = this.host.now();
      this.wake(now);
      const outs = this.engine.step({ kind: "close", socket: att.id, now });
      const alias = this.record.aliases[att.device];
      if (alias) alias.seen = now;
      await this.saveLeases();
      await this.carryOut(outs);
      // The sockets are gone when the last one leaves: the idle period starts here.
      if (this.host.ctx.getWebSockets().every((s) => s === ws))
        await this.host.ctx.storage.setAlarm(now + IDLE_MS);
    });
  }

  // ── alarm ──────────────────────────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    return this.exclusive(async () => {
      const rec = this.record;
      if (!rec) return;
      const now = this.host.now();
      this.wake(now);
      const { ctx } = this.host;
      const open = ctx.getWebSockets();

      if (open.length === 0) {
        const last = Math.max(
          0,
          ...Object.values(rec.aliases).map((a) => a.seen),
        );
        if (now >= last + IDLE_MS) {
          await this.erase();
          return;
        }
        await ctx.storage.setAlarm(last + IDLE_MS);
        return;
      }

      // The gates and the pause, read fresh. An unreadable read keeps the room open and is
      // retried; the third in a row enforces the close (fail closed).
      let gatesOn = true;
      let paused = false;
      let readFailed = false;
      try {
        gatesOn = await this.gatesOn(true);
        paused =
          (await platformSetting(
            this.host.env,
            this.host.db(),
            "cloudConnect.relayPaused",
          )) === "on";
      } catch {
        readFailed = true;
      }
      // Each open socket's device against its person's devices, read fresh (not the settings
      // copy). Skipped when the room closes or pauses anyway; a failed read counts like the gates'.
      let departed: WebSocket[] = [];
      if (!readFailed && gatesOn && !paused) {
        try {
          departed = await this.departedSockets(rec.product, open, now);
        } catch {
          readFailed = true;
        }
      }
      const fails = readFailed
        ? ((await ctx.storage.get<number>("readFails")) ?? 0) + 1
        : 0;
      if (readFailed) await ctx.storage.put("readFails", fails);
      else await ctx.storage.delete("readFails");

      if ((!readFailed && !gatesOn) || fails >= READ_FAILS_MAX) {
        // The gate went off: contact sockets close 4003, as a removed member's do.
        for (const ws of open) {
          try {
            ws.close(RELAY_CLOSE.notMember, "closed");
          } catch {
            // Already closed.
          }
        }
        for (const a of Object.values(rec.aliases)) a.seen = now;
        await this.saveLeases();
        await ctx.storage.setAlarm(now + IDLE_MS);
        return;
      }
      if (paused) {
        await this.carryOut(
          this.engine.step({ kind: "tick", now, paused: true }),
        );
        for (const ws of ctx.getWebSockets()) {
          try {
            ws.close(RELAY_CLOSE.limit, "paused");
          } catch {
            // Already closed.
          }
        }
      } else if (!readFailed) {
        await this.carryOut(
          this.engine.step({ kind: "tick", now, paused: false }),
        );
        // A device that left its person loses its socket (4003) and the peer hears GONE.
        for (const ws of departed) {
          const att = ws.deserializeAttachment() as ContactAttachment | null;
          if (att)
            await this.carryOut(
              this.engine.step({ kind: "close", socket: att.id, now }),
            );
          try {
            ws.close(RELAY_CLOSE.notMember, "closed");
          } catch {
            // Already closed.
          }
        }
      }
      for (const a of Object.values(rec.aliases)) a.seen = now;
      await this.saveLeases();
      await ctx.storage.setAlarm(now + ALARM_MS);
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────

  /**
   * The open sockets whose device is no longer one of their person's devices (the admission
   * rule), or that carry no device. One roster read per distinct (subject, seatsHeld). Throws
   * when a roster is unreadable.
   */
  private async departedSockets(
    product: string,
    open: WebSocket[],
    now: number,
  ): Promise<WebSocket[]> {
    const rosters = new Map<string, Set<string>>();
    const departed: WebSocket[] = [];
    for (const ws of open) {
      const att = ws.deserializeAttachment() as ContactAttachment | null;
      if (!att) continue;
      const key = `${att.seatsHeld ? 1 : 0}:${att.subject}`;
      let roster = rosters.get(key);
      if (!roster) {
        const keys = await accountDeviceKeys(
          this.host.db(),
          product,
          att.subject,
          { seatsHeld: att.seatsHeld, now: Math.floor(now / 1000) },
        );
        roster = new Set(
          keys.flatMap((k) => {
            const b = deviceIdBytes(k.deviceId);
            return b ? [hexEncode(b)] : [];
          }),
        );
        rosters.set(key, roster);
      }
      if (!att.dev || !roster.has(att.dev)) departed.push(ws);
    }
    return departed;
  }

  /** `launch.relay` and `launch.connectLinks` both on. Unreadable reads off, unless `throws`. */
  private async gatesOn(throws = false): Promise<boolean> {
    try {
      const { env } = this.host;
      const db = this.host.db();
      return (
        (await platformSetting(env, db, "launch.relay")) === "on" &&
        (await platformSetting(env, db, "launch.connectLinks")) === "on"
      );
    } catch (e) {
      if (throws) throw e;
      return false;
    }
  }

  /** Rebuild the engine from storage and the accepted sockets (once per wake). */
  private wake(now: number): void {
    if (this.woke) return;
    this.woke = true;
    const rec = this.record;
    if (!rec) return;
    this.engine.restore(
      {
        sockets: this.host.ctx
          .getWebSockets()
          .map((ws) => ws.deserializeAttachment() as ContactAttachment | null)
          .filter((a): a is ContactAttachment => !!a)
          .map((a) => ({ socket: a.id, device: unhex(a.device), seq: a.seq })),
        members: Object.keys(rec.aliases).map(unhex),
        dayBytesQuota: 0,
        paused: false,
        productOver: false,
        day: rec.day,
        dayUsed: 0,
        leases: Object.fromEntries(
          Object.entries(rec.aliases).map(([k, v]) => [k, v.lease]),
        ),
      },
      now,
    );
  }

  private async save(
    product: string,
    monthCeiling: number,
    aliases: ContactRecord["aliases"],
    now: number,
  ): Promise<void> {
    const s = this.engine.snapshot();
    const merged = { ...(this.record?.aliases ?? {}), ...aliases };
    for (const [k, v] of Object.entries(merged))
      v.lease = s.leases?.[k] ?? v.lease;
    this.record = {
      product,
      monthCeiling,
      aliases: merged,
      day: s.day >= 0 ? s.day : Math.floor(now / DAY_MS),
    };
    await this.host.ctx.storage.put("croom", this.record);
  }

  /** Write the leases and the day the engine holds (after a frame or a close). */
  private async saveLeases(): Promise<void> {
    const rec = this.record;
    if (!rec) return;
    const s = this.engine.snapshot();
    for (const [k, v] of Object.entries(rec.aliases))
      v.lease = s.leases?.[k] ?? 0;
    if (s.day >= 0) rec.day = s.day;
    await this.host.ctx.storage.put("croom", rec);
  }

  private async carryOut(outs: RelayOutput[]): Promise<void> {
    const live = new Map<string, WebSocket>();
    for (const ws of this.host.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as ContactAttachment | null;
      if (a) live.set(a.id, ws);
    }
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
      }
      // A contact room emits no `meter`: the account room counted the bytes when it leased them.
    }
  }

  /** With a socket open the alarm runs within a minute (it may have been the long idle one). */
  private async ensureAlarm(now: number): Promise<void> {
    const at = await this.host.ctx.storage.getAlarm();
    if (at === null || at > now + ALARM_MS)
      await this.host.ctx.storage.setAlarm(now + ALARM_MS);
  }

  /** Erase everything: the pin, the aliases, their last-seen times and their leases. */
  private async erase(): Promise<void> {
    for (const ws of this.host.ctx.getWebSockets()) {
      try {
        ws.close(RELAY_CLOSE.notMember, "erased");
      } catch {
        // Already closed.
      }
    }
    await this.host.ctx.storage.deleteAlarm();
    await this.host.ctx.storage.deleteAll();
    this.record = undefined;
    this.woke = false;
    this.host.erased();
  }
}
