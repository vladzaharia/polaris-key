// WIRE-CONTRACT-V5 §15.7: relay envelopes, one binary WebSocket message each. A device is its
// 24 decoded device-id bytes. A message that does not match its layout exactly is refused.

export const RELAY_MAX_MESSAGE = 65564;

export type RelayMessage =
  | { op: "send"; to: Uint8Array; session: number; noise: Uint8Array }
  | { op: "list" }
  | { op: "ping"; data: Uint8Array }
  | { op: "recv"; from: Uint8Array; session: number; noise: Uint8Array }
  | { op: "members"; devices: Uint8Array[] }
  | { op: "ring"; epoch: number }
  | { op: "pong"; data: Uint8Array }
  | { op: "gone"; device: Uint8Array }
  | { op: "limit"; reason: 1 | 2 | 3 | 4 };

const OPS: Record<RelayMessage["op"], number> = {
  send: 0x01,
  list: 0x02,
  ping: 0x03,
  recv: 0x81,
  members: 0x82,
  ring: 0x83,
  pong: 0x84,
  gone: 0x85,
  limit: 0x86,
};

const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const need = (ok: boolean): void => {
  if (!ok) throw new RangeError("relay envelope");
};

/** Encode one message; throws on a value its layout cannot hold. */
export function encodeRelay(m: RelayMessage): Uint8Array {
  const op = Uint8Array.of(OPS[m.op]);
  let out: Uint8Array;
  switch (m.op) {
    case "send":
    case "recv": {
      const dev = m.op === "send" ? m.to : m.from;
      need(dev.length === 24 && Number.isInteger(m.session));
      need(m.session >= 0 && m.session <= 0xffffffff);
      need(m.noise.length >= 1 && m.noise.length <= 65535);
      out = cat(op, dev, u32(m.session), m.noise);
      break;
    }
    case "list":
      out = op;
      break;
    case "ping":
    case "pong":
      need(m.data.length === 8);
      out = cat(op, m.data);
      break;
    case "members":
      need(m.devices.length <= 255 && m.devices.every((d) => d.length === 24));
      out = cat(op, Uint8Array.of(m.devices.length), ...m.devices);
      break;
    case "ring": {
      need(Number.isSafeInteger(m.epoch) && m.epoch >= 0);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, BigInt(m.epoch));
      out = cat(op, b);
      break;
    }
    case "gone":
      need(m.device.length === 24);
      out = cat(op, m.device);
      break;
    case "limit":
      need(m.reason >= 1 && m.reason <= 4);
      out = cat(op, Uint8Array.of(m.reason));
      break;
  }
  need(out.length <= RELAY_MAX_MESSAGE);
  return out;
}

/** Decode one message. `dir` is who sent it. Null means refused (the caller closes the socket). */
export function decodeRelay(
  dir: "toRoom" | "toClient",
  b: Uint8Array,
): RelayMessage | null {
  if (b.length < 1 || b.length > RELAY_MAX_MESSAGE) return null;
  const op = b[0]!;
  const rest = b.slice(1);
  const view = new DataView(rest.buffer, rest.byteOffset, rest.length);
  if (dir === "toRoom") {
    if (op === 0x01 && rest.length >= 29)
      return {
        op: "send",
        to: rest.slice(0, 24),
        session: view.getUint32(24),
        noise: rest.slice(28),
      };
    if (op === 0x02 && rest.length === 0) return { op: "list" };
    if (op === 0x03 && rest.length === 8) return { op: "ping", data: rest };
    return null;
  }
  if (op === 0x81 && rest.length >= 29)
    return {
      op: "recv",
      from: rest.slice(0, 24),
      session: view.getUint32(24),
      noise: rest.slice(28),
    };
  if (op === 0x82 && rest.length >= 1 && rest.length === 1 + rest[0]! * 24)
    return {
      op: "members",
      devices: Array.from({ length: rest[0]! }, (_, i) =>
        rest.slice(1 + i * 24, 25 + i * 24),
      ),
    };
  if (op === 0x83 && rest.length === 8)
    return { op: "ring", epoch: Number(view.getBigUint64(0)) };
  if (op === 0x84 && rest.length === 8) return { op: "pong", data: rest };
  if (op === 0x85 && rest.length === 24) return { op: "gone", device: rest };
  if (op === 0x86 && rest.length === 1 && rest[0]! >= 1 && rest[0]! <= 4)
    return { op: "limit", reason: rest[0]! as 1 | 2 | 3 | 4 };
  return null;
}
