// The Cloud Sync machine's end-to-end policy (U-35.1; WIRE-CONTRACT-V5 §11.5, §13.10): the
// `locked` status, the encryption pin and its persistence, `encryptionSince`, and the client's
// `max`/`min` decision. The machine speaks plaintext (the host codec seals and opens), so these
// tests check what it sends, what it refuses to read, and what it never sends.

import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  SYNC_ENCRYPTION_PINNED,
  cloudSyncEncryption,
  relaunch,
  type CloudSyncOptions,
  type Json,
  type OpenedBody,
  type SyncRequest,
} from "../src/cloud-sync.js";

const T0 = 1_760_000_000_000;
const ALICE = "sub_alice";
const cid = (n: number): string => `c_${`client${n}`.padStart(22, "0")}`;
const VOL = "audio.volume";
const BEST = "stats.best";

function options(over: Partial<CloudSyncOptions> = {}): CloudSyncOptions {
  const ids = [cid(1), cid(2), cid(3)];
  return {
    product: "demo",
    catalog: {
      settings: [
        { key: VOL, route: "synced", scope: "user", policy: "lastWrite" },
        { key: BEST, route: "synced", scope: "user", policy: "max" },
      ],
      collections: [{ name: "slots", policy: "max", field: "playtime" }],
    },
    document: { values: { [VOL]: 0.8, [BEST]: 0 }, locked: [] },
    now: T0,
    offsetMs: 0,
    contacted: true,
    subject: ALICE,
    network: "online",
    newClientId: () => ids.shift()!,
    encryption: "e2e",
    hasRoot: true,
    ...over,
  };
}

function body(over: Record<string, Json> = {}): Json {
  return {
    subject: ALICE,
    serverNow: T0,
    cursor: 1,
    more: false,
    lastMutationId: 0,
    catalogVersion: 1,
    aliases: {},
    quota: { bytes: 268_435_456, files: true },
    usage: { bytes: 0, settings: 0, records: 0, files: 0 },
    changes: [],
    tombstones: [],
    encryption: "e2e",
    encryptionSince: 0,
    ...over,
  };
}

const mutations = (reqs: SyncRequest[]): Json[] =>
  reqs.flatMap((r) =>
    r.method === "POST"
      ? ((r.body as { mutations: Json[] }).mutations as Json[])
      : [],
  );

/** An E2E machine whose first pull (cursor 0) was answered `e2e`. */
function confirmed(
  over: Partial<CloudSyncOptions> = {},
  b: Json = body(),
  o?: OpenedBody,
) {
  const opts = options({ contacted: false, ...over });
  const m = new CloudSyncMachine(opts);
  const first = m.takeRequests();
  expect(first).toHaveLength(1);
  m.receive({ status: 200, body: b }, o);
  m.takeEvents();
  m.takeRequests();
  return { m, opts };
}

/** Every trigger the host has. None may produce a request while the gate is shut. */
/** The host asks for another pull (the network came back). */
function repull(m: CloudSyncMachine): void {
  m.setNetwork("offline");
  m.setNetwork("online");
  expect(m.takeRequests().length).toBeGreaterThan(0);
}

function poke(m: CloudSyncMachine): SyncRequest[] {
  m.flush();
  m.refresh();
  m.advance(10_000);
  m.setNetwork("offline");
  m.setNetwork("online");
  return m.takeRequests();
}

describe("the default mode (§13.10.6)", () => {
  it("an absent declaration is e2e, and so is the machine's own absent option", () => {
    expect(cloudSyncEncryption(undefined)).toBe("e2e");
    expect(cloudSyncEncryption("server")).toBe("server");
    const m = new CloudSyncMachine(options({ encryption: undefined }));
    expect(m.encryptionMode()).toBe("e2e");
    expect(
      new CloudSyncMachine(options({ encryption: "server" })).encryptionMode(),
    ).toBe("server");
  });

  it("server mode is unchanged: pushes at once, a body without `encryption` is read", () => {
    const m = new CloudSyncMachine(
      options({ encryption: "server", hasRoot: false }),
    );
    m.takeRequests();
    m.receive({
      status: 200,
      body: body({
        encryption: undefined as unknown as Json,
        changes: [{ setting: VOL, scope: "user", value: 0.3, version: 1 }],
      }),
    });
    expect(m.get(VOL)).toEqual({ value: 0.3, from: "cloud" });
    expect(m.status().state).toBe("idle");
    m.set(VOL, 0.4);
    m.advance(2000);
    expect(mutations(m.takeRequests())).toHaveLength(1);
  });
});

describe("locked (§11.5)", () => {
  it("is locked with no root: keyring, nothing pushed or pulled, whatever the trigger", () => {
    const m = new CloudSyncMachine(options({ hasRoot: false }));
    expect(m.takeRequests()).toEqual([]);
    expect(m.status()).toEqual({
      state: "locked",
      pending: 0,
      reason: "keyring",
    });
    m.set(VOL, 0.3);
    m.advance(2000);
    expect(m.status()).toEqual({
      state: "locked",
      pending: 1,
      reason: "keyring",
    });
    expect(poke(m)).toEqual([]);
    expect(m.persist().partitions[ALICE]!.pending).toHaveLength(1);
  });

  it("keeps the journal, reads the edit in the clear, and reads the snapshot as invalid", () => {
    const { m } = confirmed(
      {},
      body({
        changes: [{ setting: VOL, scope: "user", value: 0.5, version: 1 }],
      }),
      { changes: [{ sealed: true }] },
    );
    expect(m.get(VOL)).toEqual({ value: 0.5, from: "cloud" });
    m.setRoot(false);
    expect(m.get(VOL)).toEqual({ value: 0.8, from: "document" });
    expect(m.settingState(VOL).invalid).toBe(true);
    m.set(VOL, 0.2);
    expect(m.get(VOL)).toEqual({ value: 0.2, from: "pending" });
    expect(m.settingState(VOL).invalid).toBe(false);
    expect(poke(m)).toEqual([]);
  });

  it("unlock confirms the Worker, then pushes the held operations in mutationId order", () => {
    const m = new CloudSyncMachine(
      options({ hasRoot: false, contacted: true }),
    );
    m.takeRequests();
    m.set(VOL, 0.1);
    m.set(BEST, 4);
    m.advance(2000);
    m.setRoot(true);
    // A push waits for `e2e` to be confirmed this session: a pull first.
    const [pull] = m.takeRequests();
    expect(pull?.method).toBe("GET");
    m.receive({ status: 200, body: body() });
    const sent = mutations(m.takeRequests());
    expect(sent.map((x) => (x as { mutationId: number }).mutationId)).toEqual([
      1, 2,
    ]);
    expect(m.status().state).toBe("syncing");
  });

  it("sign-out while locked does not wait on a flush that cannot happen", () => {
    const m = new CloudSyncMachine(options({ hasRoot: false }));
    m.set(VOL, 0.1);
    m.signOut();
    expect(m.takeEvents()).toContainEqual({
      type: "signedOut",
      reason: "signOut",
      unsynced: 1,
    });
    expect(m.takeRequests()).toEqual([]);
  });

  it("locking mid sign-out ends it without sending", () => {
    const { m } = confirmed();
    m.set(VOL, 0.1);
    m.signOut();
    expect(m.takeRequests()).toHaveLength(1);
    m.setRoot(false);
    expect(m.takeEvents()).toContainEqual({
      type: "signedOut",
      reason: "signOut",
      unsynced: 1,
    });
  });

  it("a server-mode app is never locked", () => {
    const m = new CloudSyncMachine(
      options({ encryption: "server", hasRoot: false }),
    );
    expect(m.status().state).toBe("syncing");
  });
});

describe("the pin and the downgrade (§11.5, T26)", () => {
  it("a pull that says server is refused unread: unsupported, journal and snapshot kept", () => {
    const { m } = confirmed(
      {},
      body({
        changes: [{ setting: VOL, scope: "user", value: 0.5, version: 1 }],
      }),
      { changes: [{ sealed: true }] },
    );
    m.set(VOL, 0.6);
    m.advance(2000);
    m.takeRequests();
    m.receive({
      status: 200,
      body: body({
        encryption: "server",
        cursor: 9,
        changes: [{ setting: VOL, scope: "user", value: "x", version: 7 }],
      }),
    });
    expect(m.status()).toEqual({
      state: "unsupported",
      pending: 1,
      reason: "encryption",
      code: SYNC_ENCRYPTION_PINNED,
    });
    expect(m.get(VOL).value).toBe(0.6);
    const saved = m.persist().partitions[ALICE]!;
    expect(saved.settings[VOL]).toEqual({ value: 0.5, version: 1 });
    expect(saved.cursor).toBe(1);
    expect(saved.pending).toHaveLength(1);
    expect(poke(m)).toEqual([]);
  });

  it("a body that omits `encryption` is a downgrade too", () => {
    const { m } = confirmed();
    m.setNetwork("online");
    m.set(VOL, 0.6);
    m.flush();
    m.takeRequests();
    m.receive({
      status: 200,
      body: body({ encryption: undefined as unknown as Json }),
    });
    expect(m.status().state).toBe("unsupported");
    expect(m.persist().partitions[ALICE]!.pending).toHaveLength(1);
  });

  it("discovery that says server or omits the member sends nothing, not even a pull", () => {
    for (const d of [{ encryption: "server" as const }, {}]) {
      const m = new CloudSyncMachine(options({ discovery: d }));
      expect(m.takeRequests()).toEqual([]);
      m.set(VOL, 0.2);
      expect(m.status().state).toBe("unsupported");
      expect(poke(m)).toEqual([]);
    }
  });

  it("unsupported lifts when discovery later says e2e, and nothing was lost", () => {
    const { m } = confirmed();
    m.set(VOL, 0.2);
    m.advance(2000);
    m.takeRequests();
    m.receive({ status: 500 });
    m.setDiscovery({ encryption: "server" });
    expect(m.status().state).toBe("unsupported");
    m.setDiscovery({ encryption: "e2e" });
    expect(mutations(m.takeRequests())).toHaveLength(1);
  });

  it("a device that has seen e2e keeps requiring it after a relaunch with `server`", () => {
    const { m, opts } = confirmed();
    expect(m.persist().e2eSeen).toBe(true);
    const again = relaunch(m, { ...opts, encryption: "server" });
    expect(again.encryptionMode()).toBe("e2e");
    again.takeRequests();
    again.receive({
      status: 200,
      body: body({ encryption: "server" }),
    });
    expect(again.status().state).toBe("unsupported");
  });

  it("an app that says server refuses an e2e answer it cannot open", () => {
    const m = new CloudSyncMachine(options({ encryption: "server" }));
    m.takeRequests();
    m.receive({ status: 200, body: body() });
    expect(m.status().state).toBe("unsupported");
    expect(m.persist().e2eSeen).toBe(false);
  });

  it("no request carries a value before e2e is confirmed", () => {
    const m = new CloudSyncMachine(options({ contacted: true }));
    m.set(VOL, 0.2);
    m.advance(2000);
    const reqs = m.takeRequests();
    expect(reqs.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("encryptionSince (§13.10.7)", () => {
  // The host maps `seq = version` and reports it in its open result; the body's own fields
  // (`seq`, `sealed`, `invalid`) are never read.
  const changes = [
    { setting: VOL, scope: "user", value: 0.1, version: 3 },
    { setting: BEST, scope: "user", value: 7, version: 12 },
  ];
  const mapped: OpenedBody = { changes: [{ seq: 3 }, { seq: 12 }] };

  it("reads a plaintext row below the boundary and refuses one at or above it", () => {
    const { m } = confirmed({}, body({ encryptionSince: 10, changes }), mapped);
    expect(m.encryptionSince()).toBe(10);
    expect(m.get(VOL)).toEqual({ value: 0.1, from: "cloud" });
    expect(m.settingState(VOL).invalid).toBe(false);
    expect(m.get(BEST)).toEqual({ value: 0, from: "document" });
    expect(m.settingState(BEST).invalid).toBe(true);
  });

  it("a host that does not map seq = version fails closed: every plaintext row is invalid", () => {
    const { m } = confirmed({}, body({ encryptionSince: 10, changes }));
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.settingState(BEST).invalid).toBe(true);
    // The body's own `seq` is not a mapping.
    const withBodySeq = confirmed(
      {},
      body({
        encryptionSince: 10,
        changes: [{ ...changes[0]!, seq: 3 }],
      }),
    );
    expect(withBodySeq.m.settingState(VOL).invalid).toBe(true);
  });

  it("a sealed row is read; an unopenable one is invalid", () => {
    const { m } = confirmed(
      {},
      body({
        encryptionSince: 10,
        changes: [
          { setting: VOL, scope: "user", value: 0.1, version: 1 },
          { setting: BEST, scope: "user", value: 9, version: 11 },
        ],
      }),
      { changes: [{}, { sealed: true }] },
    );
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.get(BEST).value).toBe(9);

    const n = confirmed(
      {},
      body({
        changes: [{ setting: VOL, scope: "user", value: 0.1, version: 1 }],
      }),
      { changes: [{ invalid: true, seq: 0 }] },
    );
    expect(n.m.settingState(VOL).invalid).toBe(true);
  });

  it("takes sealed and invalid only from the host: a body that claims them is refused", () => {
    const { m } = confirmed(
      {},
      body({
        encryptionSince: 10,
        changes: [
          {
            setting: VOL,
            scope: "user",
            value: 666,
            version: 50,
            sealed: true,
            seq: 1,
          },
        ],
      }),
    );
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.get(VOL)).toEqual({ value: 0.8, from: "document" });
    // A host that reports the row unopenable wins over a body that says otherwise.
    const n = confirmed(
      {},
      body({
        changes: [
          { setting: VOL, scope: "user", value: 1, version: 1, sealed: true },
        ],
      }),
      { changes: [{ invalid: true }] },
    );
    expect(n.m.settingState(VOL).invalid).toBe(true);
  });

  it("a conflict copy is judged the same way: body claims do not count", () => {
    const { m } = confirmed({}, body({ encryptionSince: 10 }));
    m.set(VOL, 0.2);
    m.advance(2000);
    const sent = mutations(m.takeRequests())[0] as { mutationId: number };
    m.receive({
      status: 200,
      body: body({
        encryptionSince: 10,
        results: [
          {
            mutationId: sent.mutationId,
            status: "conflict",
            server: { value: 0.9, version: 40, sealed: true },
          },
        ],
      }),
    });
    m.takeRequests();
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.persist().partitions[ALICE]!.settings[VOL]).toMatchObject({
      bad: true,
    });
  });

  it("a later, higher encryptionSince does not let a forged plaintext row through", () => {
    const { m } = confirmed({}, body({ encryptionSince: 10 }));
    expect(m.encryptionSince()).toBe(10);
    // The Worker now serves a huge boundary and a forged plaintext row below it.
    repull(m);
    m.receive(
      {
        status: 200,
        body: body({
          encryptionSince: 2 ** 53,
          changes: [{ setting: VOL, scope: "user", value: 0.99, version: 40 }],
        }),
      },
      { changes: [{ seq: 40 }] },
    );
    expect(m.encryptionSince()).toBe(10);
    expect(m.settingState(VOL).invalid).toBe(true);
    expect(m.get(VOL)).toEqual({ value: 0.8, from: "document" });
  });

  it("only lowers the boundary, persists it, and is clamped by the lowest sealed version", () => {
    const { m, opts } = confirmed(
      {},
      body({
        encryptionSince: 100,
        changes: [{ setting: VOL, scope: "user", value: 0.5, version: 30 }],
      }),
      { changes: [{ sealed: true }] },
    );
    // Opened sealed at version 30: the boundary is held at or below it.
    expect(m.encryptionSince()).toBe(30);
    expect(m.persist().partitions[ALICE]!.encryptionSince).toBe(30);
    const again = relaunch(m, opts, "kept");
    expect(again.encryptionSince()).toBe(30);
    again.takeRequests();
    again.receive({ status: 200, body: body({ encryptionSince: 500 }) });
    expect(again.encryptionSince()).toBe(30);
    repull(again);
    again.receive({ status: 200, body: body({ encryptionSince: 7 }) });
    expect(again.encryptionSince()).toBe(7);
  });

  it("a version this machine pushed sealed clamps the boundary too", () => {
    const { m } = confirmed({}, body({ encryptionSince: 100 }));
    m.set(BEST, 4);
    m.advance(2000);
    const sent = mutations(m.takeRequests())[0] as { mutationId: number };
    m.receive({
      status: 200,
      body: body({
        encryptionSince: 100,
        results: [{ mutationId: sent.mutationId, status: "ok", version: 20 }],
      }),
    });
    expect(m.encryptionSince()).toBe(20);
  });

  it("server mode ignores `seq` and `encryptionSince`", () => {
    const m = new CloudSyncMachine(options({ encryption: "server" }));
    m.takeRequests();
    m.receive({
      status: 200,
      body: body({ encryption: undefined as unknown as Json, changes }),
    });
    expect(m.get(BEST)).toEqual({ value: 7, from: "cloud" });
    expect(m.encryptionSince()).toBeNull();
  });
});

describe("max and min are the client's call (§13.10.5)", () => {
  function pushed(value: number) {
    const { m } = confirmed(
      {},
      body({
        changes: [{ setting: BEST, scope: "user", value: 2, version: 4 }],
      }),
      { changes: [{ sealed: true }] },
    );
    m.set(BEST, value);
    m.advance(2000);
    m.takeEvents();
    const sent = mutations(m.takeRequests());
    return { m, sent: sent[0] as { mutationId: number; baseVersion: unknown } };
  }

  it("sends a set against the version it saw", () => {
    const { sent } = pushed(10);
    expect(sent.baseVersion).toBe(4);
  });

  it("re-pushes a better local value on the server's version, with origin merge", () => {
    const { m, sent } = pushed(10);
    m.receive(
      {
        status: 200,
        body: body({
          results: [
            {
              mutationId: sent.mutationId,
              status: "conflict",
              server: { value: 6, version: 5 },
            },
          ],
        }),
      },
      { conflicts: { [sent.mutationId]: { sealed: true } } },
    );
    const again = mutations(m.takeRequests())[0] as Record<string, Json>;
    expect(again).toMatchObject({ op: "set", value: 10, baseVersion: 5 });
    expect(again.mutationId).not.toBe(sent.mutationId);
  });

  it("keeps the server copy when it is better, and enqueues nothing", () => {
    const { m, sent } = pushed(3);
    m.receive(
      {
        status: 200,
        body: body({
          results: [
            {
              mutationId: sent.mutationId,
              status: "conflict",
              server: { value: 6, version: 5 },
            },
          ],
        }),
      },
      { conflicts: { [sent.mutationId]: { sealed: true } } },
    );
    expect(mutations(m.takeRequests())).toEqual([]);
    expect(m.get(BEST).value).toBe(6);
  });

  it("does not re-merge a server copy the host could not open", () => {
    const { m, sent } = pushed(10);
    m.receive(
      {
        status: 200,
        body: body({
          results: [
            {
              mutationId: sent.mutationId,
              status: "conflict",
              server: { value: 6, version: 5 },
            },
          ],
        }),
      },
      { conflicts: { [sent.mutationId]: { invalid: true } } },
    );
    expect(mutations(m.takeRequests())).toEqual([]);
  });

  it("a max record re-pushes on the server's version by its field", () => {
    const { m } = confirmed();
    m.put("slots", "a", { playtime: 50 });
    const sent = mutations(m.takeRequests())[0] as { mutationId: number };
    m.receive(
      {
        status: 200,
        body: body({
          results: [
            {
              mutationId: sent.mutationId,
              status: "conflict",
              server: { value: { playtime: 30 }, version: 8 },
            },
          ],
        }),
      },
      { conflicts: { [sent.mutationId]: { sealed: true } } },
    );
    expect(mutations(m.takeRequests())[0]).toMatchObject({
      op: "set",
      value: { playtime: 50 },
      baseVersion: 8,
    });
  });

  it("server mode leaves max to the server: no baseVersion, no re-push", () => {
    const m = new CloudSyncMachine(options({ encryption: "server" }));
    m.takeRequests();
    m.receive({
      status: 200,
      body: body({ encryption: undefined as unknown as Json }),
    });
    m.set(BEST, 10);
    m.advance(2000);
    const sent = mutations(m.takeRequests())[0] as Record<string, Json>;
    expect(sent.baseVersion).toBeUndefined();
  });
});
