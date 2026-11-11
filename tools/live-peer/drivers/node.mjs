// The Node live-peer driver (CC-29X): the built @polaris-key/node behind the JSON-lines contract in
// tools/live-peer/README.md. One client, no account, local pairing on; discovery is answered by a
// local fetch, mDNS by the harness's broker; every dial is real TCP on 127.0.0.1.
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// stdout is the protocol: nothing else may write to it.
console.log = console.error;

const repo = new URL("../../../", import.meta.url);
const { PolarisKeyClient } = await import(
  pathToFileURL(new URL("packages/sdk-node/dist/index.js", repo).pathname).href
);
const { resetLocalBudgets } = await import(
  pathToFileURL(
    new URL("packages/sdk-node/dist/connect/localLinks.js", repo).pathname,
  ).href
);

const PRODUCT = "djdl";
const CATEGORIES = ["notes"];
const LOOP = { host: "127.0.0.1", allowLoopback: true };

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mDNS through the harness ──────────────────────────────────────────────────────────────────
class BrokerNet {
  adverts = new Map(); // instance -> { advert, remote }
  browsers = new Set();

  #found(a) {
    return {
      instance: a.instance,
      hosts: ["127.0.0.1"],
      port: a.port,
      txt: [...a.txt],
    };
  }

  adapter() {
    return {
      advertise: async (a) => {
        this.adverts.set(a.instance, { advert: a, remote: false });
        send({
          mdns: "advertise",
          advert: { instance: a.instance, port: a.port, txt: [...a.txt] },
        });
        for (const b of this.browsers) b.up(this.#found(a));
        return {
          stop: async () => {
            if (this.adverts.delete(a.instance)) {
              send({ mdns: "withdraw", instance: a.instance });
              for (const b of this.browsers) b.down?.(a.instance);
            }
          },
        };
      },
      browse: async (up, down) => {
        const b = { up, down };
        this.browsers.add(b);
        for (const e of this.adverts.values()) up(this.#found(e.advert));
        return { stop: async () => void this.browsers.delete(b) };
      },
    };
  }

  remoteUp(advert) {
    this.adverts.set(advert.instance, { advert, remote: true });
    for (const b of this.browsers) b.up(this.#found(advert));
  }

  remoteDown(instance) {
    if (this.adverts.delete(instance))
      for (const b of this.browsers) b.down?.(instance);
  }
}

// ── The client ────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "pkey-live-node-"));
const stateDir = join(root, "state");
const recvDir = join(root, "recv");
mkdirSync(recvDir, { recursive: true });
const net = new BrokerNet();

const discovery = {
  product: PRODUCT,
  protocolVersion: 5,
  services: { connect: { enabled: true, localPairing: true } },
};
const fetchImpl = async (input) =>
  String(input).endsWith("/.well-known/polaris.json")
    ? new Response(JSON.stringify(discovery), { status: 200 })
    : new Response("{}", { status: 404 });

resetLocalBudgets();
const client = new PolarisKeyClient({
  productSlug: PRODUCT,
  baseUrl: "https://k.test",
  version: "1.0.0",
  trust: {
    pinnedKeys: { "live-peer-1": randomBytes(32).toString("base64url") },
  },
  trustRefresh: false,
  license: { fingerprint: false },
  devices: { fingerprint: false },
  fetchImpl,
  stateDir,
});
await client.init();
await client.discover();
const links = client.cloudConnect.localLinks;

// ── State the commands share ──────────────────────────────────────────────────────────────────
const events = [];
const sessions = new Map(); // link id -> the last session this side holds for it
let handle = null;
let codeNow = null;
const received = [];
const waiting = [];

const track = (s, dir) => {
  const id = s.local?.id ?? null;
  if (id !== null) sessions.set(id, s);
  s.onClose((c) =>
    events.push({
      kind: "session-end",
      dir,
      id,
      code: c.code,
      byPeer: c.byPeer,
    }),
  );
};

links.onChange(() => events.push({ kind: "change" }));
links.onLink((s) => {
  track(s, "in");
  events.push({ kind: "link", id: s.local?.id ?? null });
});

client.cloudConnect.transfer.onOffer((o) => ({
  saveTo: join(recvDir, `${received.length + waiting.length}-${o.id}.bin`),
}));
client.cloudConnect.transfer.onResult((e) => {
  if (e.direction !== "in" || e.outcome !== "delivered") return;
  const file = readdirSync(recvDir).find((f) => f.endsWith(`-${e.id}.bin`));
  const data = readFileSync(join(recvDir, file));
  const r = {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
  const w = waiting.shift();
  if (w) w(r);
  else received.push(r);
});

await client.cloudConnect.start({
  lan: { mdns: net.adapter(), ...LOOP },
  relay: false,
});

const errorOf = (e) => ({
  code: e?.code ?? null,
  reason: e?.reason ?? null,
  cap: e?.cap ?? null,
  message: String(e?.message ?? e),
});

const infoOf = (l) => ({
  id: l.id,
  label: l.label,
  platform: l.platform,
  categories: [...l.categories],
  reachable: l.reachable,
});

// The pattern the harness hashes: the sender builds it, so a wrong pattern shows as a hash mismatch.
const pattern = (n) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + 13) & 0xff);

const opts = (extra) => ({
  categories: CATEGORIES,
  mdns: net.adapter(),
  ...LOOP,
  onConfirm: (offer) => void offer.confirm(),
  ...extra,
});

const commands = {
  async show(a) {
    // After a pairing the window closes on its own; a fresh one waits for that.
    if (a.fresh === true)
      for (let i = 0; i < 100 && handle?.open === true; i++) await sleep(50);
    if (handle === null || !handle.open) {
      codeNow = null;
      handle = await links.pair(
        opts({ label: "node", onCode: (c) => (codeNow = c) }),
      );
    }
    const c = handle.code() ?? codeNow;
    return { code: c.code, qr: c.qr };
  },

  async join(a) {
    const dialsLeft = () =>
      typeof a.code === "string" ? links.dialsLeft(a.code) : null;
    try {
      const p = await links.join(
        opts({
          label: "node",
          // The joiner waits out its browse after a failed dial in case a second device answers.
          browseSeconds: 4,
          ...(a.code !== undefined ? { code: a.code } : { qr: a.qr }),
        }),
      );
      return { link: p.id, dialsLeft: dialsLeft() };
    } catch (e) {
      const err = new Error(e.message);
      err.fail = { error: errorOf(e), dialsLeft: dialsLeft() };
      throw err;
    }
  },

  async list() {
    return { links: (await links.list()).map(infoOf) };
  },

  async open(a) {
    const until = Date.now() + (a.wait === false ? 0 : 20_000);
    for (;;) {
      try {
        const s = await links.open(a.id);
        track(s, "out");
        return { link: a.id };
      } catch (e) {
        // Not seen on the network yet is not an attempt: keep looking until the hang guard.
        if (e?.reason !== "unknown_peer" || Date.now() >= until) throw e;
        await sleep(50);
      }
    }
  },

  async send(a) {
    const data = pattern(a.bytes);
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== a.sha256)
      throw new Error("the sender's pattern hashes differently");
    const until = Date.now() + 20_000;
    for (;;) {
      try {
        const r = await client.cloudConnect.transfer.send(
          { link: a.id },
          data,
          {
            name: "live.bin",
            category: CATEGORIES[0],
          },
        );
        return { sha256: r.sha256, bytes: r.size };
      } catch (e) {
        if (e?.reason !== "unknown_peer" || Date.now() >= until) throw e;
        await sleep(50);
      }
    }
  },

  async recv() {
    const r = received.shift();
    return r ?? (await new Promise((res) => waiting.push(res)));
  },

  async forget(a) {
    return { removed: await links.remove(a.id) };
  },

  async events() {
    return { events: events.splice(0) };
  },

  async quit() {
    setImmediate(() => void shutdown(0));
    return {};
  },
};

async function shutdown(code) {
  await handle?.stop().catch(() => {});
  await client.cloudConnect.stop().catch(() => {});
  client.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(code);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.mdns === "up") return net.remoteUp(m.advert);
  if (m.mdns === "down") return net.remoteDown(m.instance);
  const run = commands[m.cmd];
  if (run === undefined)
    return send({
      seq: m.seq,
      ok: false,
      error: { message: `unknown command ${m.cmd}` },
    });
  run(m).then(
    (r) => send({ seq: m.seq, ok: true, ...r }),
    (e) =>
      send({ seq: m.seq, ok: false, error: errorOf(e), ...(e.fail ?? {}) }),
  );
});
lines.on("close", () => void shutdown(0));
send({ ready: true, driver: "node" });
