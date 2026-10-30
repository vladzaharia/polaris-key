/**
 * CC-19.4: a contact room under workerd, bound from wrangler.toml's `CONNECT_RELAY`. The Node lane
 * proves the room and the lease over fake states; this proves what a fake cannot: the real
 * Durable Object namespace routing a contact upgrade to `<p>:c:<rid>`, hibernation-API sockets
 * with their attachments, and the lease crossing from the contact object to each sender's own
 * account object. Two people on two accounts meet in one room, SEND and RECV with aliases only,
 * and a sender whose day is spent is told LIMIT 2 and closed 4008.
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  contactAlias,
  decodeRelay,
  encodeRelay,
} from "@polaris-key/client-core/peer";
import { describe, expect, it } from "vitest";
import {
  contactObjectName,
  relayObjectName,
  type Admission,
} from "../src/services/connect/do/admission.js";
import { forwardToRelay } from "../src/services/connect/do/client.js";

const PRODUCT = "wd";
const RID = "lXg0MgIHVN5qAmGFUen7vA";
const S1 = "ps_AAAAAAAAAAAAAAAAAAAAAA";
const S2 = "ps_BBBBBBBBBBBBBBBBBBBBBB";
const dev = (n: number): Uint8Array => new Uint8Array(24).fill(n);
const D1 = dev(1);
const D2 = dev(2);
const MiB = 1024 * 1024;
const b64 = (d: Uint8Array): string => Buffer.from(d).toString("base64url");

const admission = (
  subject: string,
  device: Uint8Array,
  dayBytes: number,
): Admission => ({
  product: PRODUCT,
  subject,
  monthCeiling: 500 * 1024 ** 3,
  seatsHeld: false,
  contact: { rid: RID },
  ticket: {
    device,
    members: [device],
    dayBytes,
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

async function connect(
  subject: string,
  device: Uint8Array,
  dayBytes = 256 * MiB,
): Promise<Client> {
  const res = await forwardToRelay(
    env,
    admission(subject, device, dayBytes),
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

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
}

const send = (to: Uint8Array, len: number): Uint8Array =>
  encodeRelay({ op: "send", to, session: 1, noise: new Uint8Array(len) });

describe("a contact room under workerd (CC-19.4)", () => {
  it("relays between two accounts by alias, charges each sender's own account room, and closes a spent sender 4008", async () => {
    expect(env.CONNECT_RELAY).toBeDefined();
    const aliasA = await contactAlias(RID, b64(D1));
    const aliasB = await contactAlias(RID, b64(D2));
    // A's day is one lease; B's is the default.
    const a = await connect(S1, D1, MiB);
    const b = await connect(S2, D2);
    await until(() => a.frames.some((f) => f?.op === "members"));
    await until(() => b.frames.some((f) => f?.op === "members"));
    await until(() =>
      a.frames.some((f) => f?.op === "members" && f.devices.length === 2),
    );

    // SEND from A reaches B as RECV from A's alias (never the device id); B answers the same way.
    a.ws.send(send(aliasB, 100));
    await until(() => b.frames.some((f) => f?.op === "recv"));
    const recv = b.frames.find((f) => f?.op === "recv");
    expect(recv?.op === "recv" && Buffer.from(recv.from)).toEqual(
      Buffer.from(aliasA),
    );
    b.ws.send(send(aliasA, 100));
    await until(() => a.frames.some((f) => f?.op === "recv"));

    // The lease landed in each sender's own account object, and in no one else's.
    const dayUsed = (subject: string): Promise<number | undefined> =>
      runInDurableObject(
        env.CONNECT_RELAY!.get(
          env.CONNECT_RELAY!.idFromName(relayObjectName(PRODUCT, subject)),
        ),
        async (_o, state) =>
          (await state.storage.get<{ dayUsed: number }>("room"))?.dayUsed,
      );
    expect(await dayUsed(S1)).toBe(MiB);
    expect(await dayUsed(S2)).toBe(MiB);

    // The contact room holds aliases only: no subject, no device id.
    const stored = await runInDurableObject(
      env.CONNECT_RELAY!.get(
        env.CONNECT_RELAY!.idFromName(contactObjectName(PRODUCT, RID)),
      ),
      async (_o, state) => JSON.stringify([...(await state.storage.list())]),
    );
    for (const secret of [S1, S2, b64(D1), b64(D2), RID])
      expect(stored).not.toContain(secret);

    // A spends the rest of its one lease, then asks for another: the day has none to give.
    for (let i = 0; i < 25; i++) a.ws.send(send(aliasB, 60_000));
    await until(() =>
      a.frames.some((f) => f?.op === "limit" && f.reason === 2),
    );
    expect(await a.closed).toBe(4008);
    // B is untouched.
    b.ws.close(1000);
  });
});
