// @vitest-environment node
//
// @pkey-feature connect.transfer
//
// Direct Transfer between the browser SDK and the Node SDK over the relay (CC-20.F): the browser's
// relay service and transfer module on one device, the Node ones on the other, both on sdk-react's
// in-process room (its `relayFixtures.ts`). One file, both ways, and a re-offer of delivered
// content answered as done by each receiver.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { CloudTransfer as BrowserTransfer } from "@polaris-key/ui-core/browser/sdk/browser/connect/transfer.js";
import { XferStore } from "@polaris-key/ui-core/browser/sdk/browser/connect/xferStore.js";
import type { TransferEvent as BrowserEvent } from "@polaris-key/ui-core/browser/sdk/browser/connect/xferTypes.js";
import {
  OPEN_MS,
  PING_MS,
  ManualTimer,
  until,
  world,
  live,
  A,
  B,
} from "./relayFixtures.js";
import { RelayService as NodeRelay } from "../../sdk-node/src/connect/relay.js";
import { PartialStore } from "../../sdk-node/src/connect/transferStore.js";
import {
  CloudTransfer as NodeTransfer,
  type TransferEvent as NodeEvent,
} from "../../sdk-node/src/connect/transfer.js";
import type { ConnectSession } from "../../sdk-node/src/connect/session.js";

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

const dirs: string[] = [];
const nodeRelays: NodeRelay[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
  await Promise.all(nodeRelays.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const body = (n: number): Uint8Array<ArrayBuffer> => {
  const u = new Uint8Array(n);
  u.set(randomBytes(n));
  return u;
};

/** Node is device A, the browser is device B; each holds a session to the other. */
async function rig() {
  const w = await world();
  const node = new NodeRelay(
    (await w.source(w.a)) as unknown as ConstructorParameters<
      typeof NodeRelay
    >[0],
    {
      webSocket: w.room.webSocket,
      timer: new ManualTimer().timer,
      random: () => 0.5,
      pingMs: PING_MS,
      openMs: OPEN_MS,
    },
  );
  nodeRelays.push(node);
  let nodeSide: ConnectSession | null = null;
  node.onSession((s) => (nodeSide = s));
  node.start();
  const browser = await w.svc(w.b, new ManualTimer());
  await node.ready();
  await browser.ready();
  await until(() => browser.members().includes(A));
  let browserSide = await browser.dial(A);
  await until(() => nodeSide !== null);

  const root = mkdtempSync(join(tmpdir(), "pkey-xfer-interop-"));
  dirs.push(root);
  const nodeGot: NodeEvent[] = [];
  const nodeT = new NodeTransfer({
    store: new PartialStore(join(root, "parts")),
    openDevice: async () => nodeSide!,
    openLink: async () => {
      throw new Error("no links");
    },
    hasLink: async () => false,
  });
  nodeT.onResult((e) => nodeGot.push(e));
  const browserGot: BrowserEvent[] = [];
  const blobs: Blob[] = [];
  let browserHandles = true;
  const browserT = new BrowserTransfer({
    store: new XferStore("pkey-xfer-interop", { idb: new IDBFactory() }),
    openDevice: async () => browserSide,
    handler: () =>
      browserHandles
        ? () => ({
            blob: (b: Blob) => {
              blobs.push(b);
            },
          })
        : null,
    maxSize: () => null,
    emit: (e) => browserGot.push(e),
  });
  nodeT.adopt(nodeSide!);
  browserT.adopt(browserSide as never);
  return {
    root,
    nodeT,
    browserT,
    get nodeSide(): ConnectSession {
      return nodeSide!;
    },
    get browserSide() {
      return browserSide;
    },
    /** Close both sessions and dial a new one: an id is used once per session (§15.11). */
    async reopen(): Promise<void> {
      const old = nodeSide;
      await browserSide.close();
      await until(() => old!.closed !== null);
      nodeSide = null;
      browserSide = await browser.dial(A);
      await until(() => nodeSide !== null);
      nodeT.adopt(nodeSide!);
      browserT.adopt(browserSide as never);
    },
    nodeGot,
    browserGot,
    blobs,
    deny: () => (browserHandles = false),
  };
}

describe("Direct Transfer between the browser and Node over the relay", () => {
  it("Node to the browser: a file arrives whole and hash-checked", async () => {
    const r = await rig();
    const data = body(300_000);
    const file = join(r.root, "out.bin");
    writeFileSync(file, data);
    const sent = await r.nodeT.send(r.nodeSide, file);
    expect(sent.sha256).toBe(sha(data));
    await until(() => r.browserGot.some((e) => e.outcome === "delivered"));
    expect(new Uint8Array(await r.blobs[0]!.arrayBuffer())).toEqual(data);
  });

  it("the browser to Node: a Blob arrives where the Node host said", async () => {
    const r = await rig();
    const data = body(250_001);
    const dest = join(r.root, "in.bin");
    r.nodeT.onOffer(() => ({ saveTo: dest }));
    const sent = await r.browserT.send(
      r.browserSide as never,
      new Blob([data]),
    );
    expect(sent.sha256).toBe(sha(data));
    await until(() => r.nodeGot.some((e) => e.outcome === "delivered"));
    expect(new Uint8Array(readFileSync(dest))).toEqual(data);
  });

  it("a re-offer of delivered content is answered as done by each receiver, and the host is told once", async () => {
    const r = await rig();
    // Browser to Node.
    const data = body(70_000);
    const dest = join(r.root, "again.bin");
    r.nodeT.onOffer(() => ({ saveTo: dest }));
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    await r.browserT.send(r.browserSide as never, new Blob([data]), { id });
    await until(() => r.nodeGot.some((e) => e.outcome === "delivered"));
    const first = r.nodeGot.length;
    await r.reopen();
    // The same id and content again: no new consent, no second file, the sender is told delivered.
    let asked = 0;
    r.nodeT.onOffer(() => (asked++, { saveTo: dest }));
    await r.browserT.send(r.browserSide as never, new Blob([data]), { id });
    expect(asked).toBe(0);
    expect(r.nodeGot.length).toBe(first);
    expect(new Uint8Array(readFileSync(dest))).toEqual(data);

    // Node to the browser.
    const data2 = body(70_000);
    const file = join(r.root, "o2.bin");
    writeFileSync(file, data2);
    const id2 = "AQEBAQEBAQEBAQEBAQEBAQ";
    await r.nodeT.send(r.nodeSide, file, { id: id2 });
    await until(() => r.blobs.length === 1);
    r.deny();
    await r.reopen();
    await r.nodeT.send(r.nodeSide, file, { id: id2 });
    expect(r.blobs.length).toBe(1);
    expect(
      r.browserGot.filter(
        (e) => e.direction === "in" && e.outcome === "delivered",
      ).length,
    ).toBe(1);
  });
});
