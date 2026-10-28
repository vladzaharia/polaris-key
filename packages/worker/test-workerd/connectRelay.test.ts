/**
 * CC-07.4: the real `ConnectRelayDO` under workerd, bound from wrangler.toml's `CONNECT_RELAY`.
 * The Node lane proves the engine and the room over a fake state; this proves what a fake cannot:
 * a real WebSocket upgrade through the one namer, hibernation-API sockets and attachments, the
 * real storage across a rebuilt object, and a ring poke that closes a removed member's socket.
 *
 * Hibernation: miniflare does not evict an idle object on demand, so the wake is exercised by
 * constructing a second `ConnectRelayDO` over the live object's own `DurableObjectState`, which
 * is what the runtime does after an eviction (constructor, then `restore()` from storage and the
 * accepted sockets' attachments).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { decodeRelay, encodeRelay } from "@polaris-key/client-core/peer";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import {
  relayObjectName,
  type Admission,
} from "../src/services/connect/do/admission.js";
import {
  forwardToRelay,
  pokeRelayRoom,
} from "../src/services/connect/do/client.js";
import { ConnectRelayDO } from "../src/services/connect/do/relayDo.js";
import { seedProduct } from "./seed.js";

const PRODUCT = "wd";
const SUBJECT = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const dev = (n: number): Uint8Array => new Uint8Array(24).fill(n);
const A = dev(1);
const B = dev(2);
const idOf = (d: Uint8Array): string => Buffer.from(d).toString("base64url");

const admission = (device: Uint8Array): Admission => ({
  product: PRODUCT,
  subject: SUBJECT,
  monthCeiling: 500 * 1024 ** 3,
  seatsHeld: false,
  ticket: {
    device,
    members: [A, B],
    dayBytes: 256 * 1024 * 1024,
    paused: false,
    productOver: false,
    expiresAt: Date.now() + 60_000,
  },
});

interface Client {
  ws: WebSocket;
  frames: ReturnType<typeof decodeRelay>[];
  closed: Promise<number>;
}

async function connect(device: Uint8Array): Promise<Client> {
  const res = await forwardToRelay(
    env,
    admission(device),
    new Request("https://connect-relay.test/", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "pkey-relay.1, pkeyrt_x",
      },
    }),
  );
  expect(res?.status).toBe(101);
  const ws = res!.webSocket!;
  const frames: Client["frames"] = [];
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  ws.addEventListener("message", (e) => {
    if (e.data instanceof ArrayBuffer)
      frames.push(decodeRelay("toClient", new Uint8Array(e.data)));
  });
  ws.binaryType = "arraybuffer";
  ws.accept();
  return { ws, frames, closed };
}

/** Wait until a predicate over the client's frames holds. */
async function until(c: Client, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
}

const send = (to: Uint8Array, len: number): Uint8Array =>
  encodeRelay({ op: "send", to, session: 1, noise: new Uint8Array(len) });

beforeAll(async () => {
  const db = new D1Db(env.DB);
  await seedProduct(env, db, PRODUCT, { schemaVersion: 1, entries: [] });
  await db.run(
    "INSERT OR IGNORE INTO accounts (id, created_at, modified_at) VALUES ('acc1', 1, 1)",
  );
  await db.run(
    "INSERT OR IGNORE INTO account_product_subjects (account_id, product, subject, created_at) VALUES ('acc1', ?, ?, 1)",
    PRODUCT,
    SUBJECT,
  );
  for (const [i, d] of [A, B].entries()) {
    await db.run(
      `INSERT OR REPLACE INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES (?, ?, '', 'authorized', 1, 1, ?)`,
      PRODUCT,
      idOf(d),
      SUBJECT,
    );
    await db.run(
      `INSERT OR REPLACE INTO device_keys (product, device_id, sign_key, agree_key, key_seq, created_at)
       VALUES (?, ?, ?, ?, 1, 1)`,
      PRODUCT,
      idOf(d),
      `sign${i}${idOf(d)}`,
      `agree${i}${idOf(d)}`,
    );
  }
});

describe("ConnectRelayDO under workerd (CC-07.4)", () => {
  it("upgrades two devices, relays SEND as RECV with a stamped from, wakes with the day's usage, and a poke closes a removed member", async () => {
    expect(env.CONNECT_RELAY).toBeDefined();
    const a = await connect(A);
    const b = await connect(B);
    // Each hears the members list; A hears B arrive.
    await until(a, () => a.frames.some((f) => f?.op === "members"));
    await until(b, () => b.frames.some((f) => f?.op === "members"));

    // SEND from A to B arrives as RECV, stamped with A (the sender never names itself).
    a.ws.send(send(B, 40));
    await until(b, () => b.frames.some((f) => f?.op === "recv"));
    const recv = b.frames.find((f) => f?.op === "recv");
    expect(recv?.op === "recv" && Buffer.from(recv.from)).toEqual(
      Buffer.from(A),
    );

    const stub = env.CONNECT_RELAY!.get(
      env.CONNECT_RELAY!.idFromName(relayObjectName(PRODUCT, SUBJECT)),
    );

    // Hibernation wake: a rebuilt object over the same state keeps the day's usage and the
    // sockets, and still relays.
    const before = await runInDurableObject(
      stub,
      async (_o, state) =>
        (await state.storage.get<{ dayUsed: number }>("room"))!.dayUsed,
    );
    expect(before).toBeGreaterThan(0);
    const after = await runInDurableObject(stub, async (_o, state) => {
      const woken = new ConnectRelayDO(state, env);
      const [first] = state.getWebSockets(
        "d:" + Buffer.from(A).toString("hex"),
      );
      await woken.webSocketMessage(first!, send(B, 40).slice().buffer);
      return (await state.storage.get<{ dayUsed: number }>("room"))!.dayUsed;
    });
    expect(after).toBeGreaterThan(before);
    await until(b, () => b.frames.filter((f) => f?.op === "recv").length === 2);

    // The poke: B leaves the roster, and the room closes B at once, A hears GONE, then RING.
    await new D1Db(env.DB).run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = ?",
      PRODUCT,
      idOf(B),
    );
    await pokeRelayRoom(env, { product: PRODUCT, subject: SUBJECT, epoch: 9 });
    expect(await b.closed).toBe(4003);
    await until(a, () => a.frames.some((f) => f?.op === "gone"));
    await until(a, () => a.frames.some((f) => f?.op === "ring"));
    a.ws.close(1000);
  });

  it("is refused without the subprotocol and gets no pokes for a person without a room", async () => {
    const res = await forwardToRelay(
      env,
      admission(A),
      new Request("https://connect-relay.test/", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(res?.status).toBe(400);
    // Nothing to poke, nothing created, nothing thrown.
    await pokeRelayRoom(env, {
      product: PRODUCT,
      subject: "ps_BBBBBBBBBBBBBBBBBBBBBB",
      epoch: 1,
    });
  });
});
