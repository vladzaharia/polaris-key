// The Cloud Sync machine's U-01b behaviour (plans/U-01b.md §2.5 and Revision 2): the setting
// routes and open settings, the one-time `config.local` import, the 403 reasons, the paused state
// and the parked rejections. `conformance/corpus/v2/sync-scenarios.json` pins the same rules
// scenario by scenario; these are the unit-level checks, each with a negative control.

import { describe, expect, it } from "vitest";
import {
  CloudSyncMachine,
  SYNC_IMPORT_HLC,
  SYNC_MAX_VALUE_BYTES,
  jsonBytes,
  relaunch,
  type CloudSyncOptions,
  type Json,
  type SyncRequest,
} from "../src/cloud-sync.js";

const T0 = 1_760_000_000_000;
const ALICE = "sub_alice";
const cid = (n: number): string => `c_${`client${n}`.padStart(22, "0")}`;
const hlc = (ms: number, counter = 0): string =>
  `${ms.toString(16).padStart(12, "0")}:${counter.toString(16).padStart(4, "0")}`;

const VOL = "audio.volume";
const BEST = "stats.best";
const BIND = "input.bindings";
const WINDOW = "ui.window";
const REGION = "ops.region";
const TOKEN = "api.token";
const OPEN = "mods.profile";

function options(over: Partial<CloudSyncOptions> = {}): CloudSyncOptions {
  const ids = [cid(1), cid(2), cid(3)];
  return {
    product: "demo",
    catalog: {
      settings: [
        {
          key: VOL,
          route: "synced",
          scope: "user",
          policy: "lastWrite",
          schema: { type: "number", minimum: 0, maximum: 1 },
        },
        {
          key: BEST,
          route: "synced",
          scope: "platform",
          policy: "max",
          schema: { type: "integer", minimum: 0 },
        },
        {
          key: BIND,
          route: "synced",
          scope: "user",
          policy: "merge",
          schema: { type: "object" },
        },
        { key: WINDOW, route: "local" },
        { key: REGION, route: "locked" },
        { key: TOKEN, route: "refused" },
      ],
      collections: [
        { name: "slots", policy: "max", field: "playtime" },
        { name: "prefs", policy: "merge" },
      ],
    },
    document: {
      values: { [VOL]: 0.8, [BEST]: 0, [WINDOW]: "1280x720", [REGION]: "eu" },
      locked: [],
    },
    now: T0,
    offsetMs: 0,
    contacted: true,
    subject: ALICE,
    network: "online",
    newClientId: () => ids.shift()!,
    ...over,
  };
}

const QUOTA = { bytes: 268_435_456, files: true };
const USAGE = { bytes: 0, settings: 0, records: 0, files: 0 };

function body(over: Record<string, Json> = {}): Json {
  return {
    subject: ALICE,
    serverNow: T0,
    cursor: 1,
    more: false,
    lastMutationId: 0,
    catalogVersion: 1,
    aliases: {},
    quota: QUOTA,
    usage: USAGE,
    changes: [],
    tombstones: [],
    ...over,
  };
}

/** A started machine: the start-up pull answered. */
function started(over: Partial<CloudSyncOptions> = {}): {
  m: CloudSyncMachine;
  opts: CloudSyncOptions;
} {
  const opts = options(over);
  const m = new CloudSyncMachine(opts);
  if (opts.subject) {
    expect(m.takeRequests()).toEqual([
      { method: "GET", path: `/demo/sync?cursor=0&clientId=${cid(1)}` },
    ]);
    m.receive({ status: 200, body: body() });
  }
  m.takeEvents();
  return { m, opts };
}

/** Commit the debounce and return what the machine sent (the edit's own events drained). */
function commit(m: CloudSyncMachine): SyncRequest[] {
  m.advance(2000);
  m.takeEvents();
  return m.takeRequests();
}

const mutations = (reqs: SyncRequest[]): Json[] =>
  reqs.flatMap((r) =>
    r.method === "POST"
      ? ((r.body as { mutations: Json[] }).mutations as Json[])
      : [],
  );

describe("setting routes (§2.5)", () => {
  it("answers in the plan's order and journals nothing on a refusal", () => {
    const { m } = started({
      document: { values: { [VOL]: 0.8 }, locked: [VOL] },
    });
    expect(m.set(TOKEN, "x")).toEqual({ ok: false, error: "bad_request" });
    expect(m.clear(TOKEN)).toEqual({ ok: false, error: "bad_request" });
    expect(m.set(REGION, "us")).toEqual({
      ok: false,
      error: "managed_by_admin",
    });
    expect(m.set(VOL, 0.5)).toEqual({ ok: false, error: "managed_by_admin" });
    expect(m.set(BEST, -1)).toEqual({ ok: false, error: "bad_request" });
    expect(commit(m)).toEqual([]);
    expect(m.status()).toEqual({ state: "idle", pending: 0 });
    expect(m.takeEvents()).toEqual([]);
  });

  it("bounds every value at 8 KiB of canonical JSON, open or declared", () => {
    const { m } = started();
    const atLimit = "x".repeat(SYNC_MAX_VALUE_BYTES - 2);
    expect(jsonBytes(atLimit)).toBe(SYNC_MAX_VALUE_BYTES);
    expect(m.set(OPEN, `${atLimit}x`)).toEqual({
      ok: false,
      error: "bad_request",
    });
    // Negative control: one byte less is an open setting, pushed with scope user.
    expect(m.set(OPEN, atLimit)).toEqual({ ok: true });
    expect(mutations(commit(m))).toEqual([
      {
        mutationId: 1,
        target: { setting: OPEN, scope: "user" },
        op: "set",
        value: atLimit,
        editedHlc: hlc(T0),
      },
    ]);
  });

  it("measures canonical JSON: member order and whitespace never count", () => {
    expect(jsonBytes({ b: 1, a: [1, 2] })).toBe(jsonBytes({ a: [1, 2], b: 1 }));
    expect(jsonBytes({ a: "é" })).toBe(`{"a":"é"}`.length + 1);
  });

  it("pushes a platform-scoped key with scope platform", () => {
    const { m } = started();
    m.set(BEST, 7);
    expect(mutations(commit(m))).toEqual([
      {
        mutationId: 1,
        target: { setting: BEST, scope: "platform" },
        op: "set",
        value: 7,
        editedHlc: hlc(T0),
      },
    ]);
  });

  it("keeps a local key on the device: never pushed, never moved, kept through journal loss", () => {
    const { m, opts } = started({ subject: null });
    expect(m.set(WINDOW, "800x600")).toEqual({ ok: true });
    expect(m.get(WINDOW)).toEqual({ value: "800x600", from: "device" });
    expect(m.settingState(WINDOW)).toEqual({
      sync: "local",
      invalid: false,
      locked: false,
    });
    m.signIn(ALICE);
    expect(mutations(m.takeRequests())).toEqual([]);
    expect(m.settingState(WINDOW).sync).toBe("local");
    const lost = relaunch(m, opts, "lost");
    expect(lost.get(WINDOW)).toEqual({ value: "800x600", from: "device" });
    // A lock in the document still beats the device's own choice.
    const locked = new CloudSyncMachine(
      options({ document: { values: { [WINDOW]: "x" }, locked: [WINDOW] } }),
      m.persist(),
    );
    expect(locked.get(WINDOW)).toEqual({ value: "x", from: "document" });
  });

  it("reports sync local signed out, pending with a draft, synced otherwise", () => {
    const { m } = started();
    expect(m.settingState(VOL).sync).toBe("synced");
    m.set(VOL, 0.4);
    expect(m.settingState(VOL).sync).toBe("pending");
    m.signOut({ discardUnsynced: true });
    expect(m.settingState(VOL).sync).toBe("local");
  });
});

describe("importLocal (§2.5 Import)", () => {
  it("imports synced and open keys at the floor, local keys to the device, and skips the rest", () => {
    const { m } = started({ subject: null, contacted: false });
    expect(
      m.importLocal({
        [VOL]: 0.3,
        [OPEN]: "legacy",
        [WINDOW]: "640x480",
        [REGION]: "us",
        [TOKEN]: "old",
        [BEST]: -5,
        big: "x".repeat(SYNC_MAX_VALUE_BYTES),
      }),
    ).toEqual({ ok: true });
    expect(m.journal()).toEqual({
      local: {
        settings: {
          [VOL]: { value: 0.3, editedHlc: SYNC_IMPORT_HLC },
          [OPEN]: { value: "legacy", editedHlc: SYNC_IMPORT_HLC },
        },
      },
    });
    expect(m.get(WINDOW)).toEqual({ value: "640x480", from: "device" });
    expect(m.get(REGION)).toEqual({ value: "eu", from: "document" });
    expect(m.get(BEST)).toEqual({ value: 0, from: "document" });
    // Once per install: a second call changes nothing.
    expect(m.importLocal({ [VOL]: 0.9 })).toEqual({ ok: true });
    expect(m.get(VOL)).toEqual({ value: 0.3, from: "device" });
  });

  it("is never re-stamped at first contact, so the cloud beats it", () => {
    const { m } = started({
      subject: null,
      contacted: false,
      now: T0 - 3 * 86_400_000,
    });
    m.importLocal({ [VOL]: 0.3 });
    m.signIn(ALICE);
    m.takeRequests();
    m.receive({ status: 200, body: body({ serverNow: T0 }) });
    expect(mutations(m.takeRequests())).toEqual([
      {
        mutationId: 1,
        target: { setting: VOL, scope: "user" },
        op: "set",
        value: 0.3,
        editedHlc: SYNC_IMPORT_HLC,
      },
    ]);
  });

  it("goes straight into a signed-in subject's journal as moved operations", () => {
    const { m } = started();
    m.importLocal({ [VOL]: 0.3, [BIND]: { jump: "j" } });
    const sent = mutations(m.takeRequests());
    expect(sent).toEqual([
      {
        mutationId: 1,
        target: { setting: VOL, scope: "user" },
        op: "set",
        value: 0.3,
        editedHlc: SYNC_IMPORT_HLC,
      },
      {
        mutationId: 2,
        target: { setting: BIND, scope: "user" },
        op: "setMember",
        member: "jump",
        value: "j",
        editedHlc: SYNC_IMPORT_HLC,
      },
    ]);
  });
});

describe("403 reasons (§2.5)", () => {
  it("blocks on attestation_required and on any other 403, keeps the journal, and lifts on refresh", () => {
    for (const [code, reason] of [
      ["attestation_required", "attestation"],
      ["forbidden", "forbidden"],
    ] as const) {
      const { m } = started();
      m.set(VOL, 0.5);
      commit(m);
      m.receive({ status: 403, body: { error: { code, message: "no" } } });
      expect(m.status()).toEqual({ state: "blocked", pending: 1, reason });
      expect(m.takeEvents()).toEqual([]);
      m.flush();
      expect(m.takeRequests()).toEqual([]);
      m.refresh();
      expect(mutations(m.takeRequests())).toHaveLength(1);
    }
  });

  it("still signs out on account_required (negative control)", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    m.receive({
      status: 403,
      body: { error: { code: "account_required", message: "Sign in." } },
    });
    expect(m.status()).toEqual({
      state: "blocked",
      pending: 0,
      reason: "account_required",
    });
    m.refresh();
    expect(m.status().state).toBe("blocked");
  });
});

describe("writes_paused (R4)", () => {
  const PAUSED = {
    status: 503,
    body: { error: { code: "writes_paused", message: "Paused." } },
  };

  it("keeps the journal, shows paused, retries on the next trigger and clears on a 200 push", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    m.receive(PAUSED);
    expect(m.status()).toEqual({ state: "paused", pending: 1 });
    expect(m.get(VOL)).toEqual({ value: 0.5, from: "pending" });
    m.flush();
    expect(mutations(m.takeRequests())).toHaveLength(1);
    m.receive({
      status: 200,
      body: body({
        cursor: 2,
        lastMutationId: 1,
        results: [{ mutationId: 1, status: "ok", version: 2 }],
      }),
    });
    expect(m.status()).toEqual({ state: "idle", pending: 0 });
  });

  it("is a plain failure on any other 503, or on a pull (negative controls)", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    m.receive({ status: 503, body: { error: { code: "unavailable" } } });
    expect(m.status()).toEqual({ state: "pending", pending: 1 });
    const fresh = new CloudSyncMachine(options());
    fresh.takeRequests();
    fresh.receive(PAUSED);
    expect(fresh.status()).toEqual({ state: "idle", pending: 0 });
  });
});

describe("parked rejections (R5)", () => {
  const rejectedWith = (
    m: CloudSyncMachine,
    code: string,
    quota = { bytes: 1_048_576, files: false },
    usage = { bytes: 2_097_152, settings: 3, records: 0, files: 0 },
  ): void => {
    m.receive({
      status: 200,
      body: body({
        cursor: 1,
        lastMutationId: 1,
        results: [{ mutationId: 1, status: "rejected", code }],
        quota,
        usage,
      }),
    });
  };

  it("parks a quota refusal: kept, still read, not resent, and it survives a relaunch", () => {
    const { m, opts } = started();
    m.set(VOL, 0.5);
    commit(m);
    rejectedWith(m, "quota_exceeded");
    expect(m.takeEvents()).toEqual([]);
    expect(m.get(VOL)).toEqual({ value: 0.5, from: "pending" });
    expect(m.settingState(VOL).sync).toBe("pending");
    expect(m.status()).toEqual({
      state: "pending",
      pending: 1,
      reason: "quota",
    });
    m.flush();
    expect(m.takeRequests()).toEqual([]);
    const again = relaunch(m, opts);
    expect(again.journal()[ALICE]).toMatchObject({
      pending: [{ mutationId: 1, parked: "quota", value: 0.5 }],
    });
    expect(again.get(VOL)).toEqual({ value: 0.5, from: "pending" });
  });

  it("re-sends a quota-parked edit as a new mutation with its clock once a response shows more room", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    rejectedWith(m, "quota_exceeded");
    // Negative control: the same room re-sends nothing.
    m.setNetwork("offline");
    m.setNetwork("online");
    m.receive({
      status: 200,
      body: body({
        quota: { bytes: 1_048_576, files: false },
        usage: { bytes: 2_097_152, settings: 3, records: 0, files: 0 },
      }),
    });
    expect(m.takeRequests().filter((r) => r.method === "POST")).toEqual([]);
    m.setNetwork("offline");
    m.setNetwork("online");
    m.receive({
      status: 200,
      body: body({
        usage: { bytes: 2_097_152, settings: 3, records: 0, files: 0 },
      }),
    });
    expect(mutations(m.takeRequests())).toEqual([
      {
        mutationId: 2,
        target: { setting: VOL, scope: "user" },
        op: "set",
        value: 0.5,
        editedHlc: hlc(T0),
      },
    ]);
  });

  it("re-sends an entitlement-parked edit at the next sign-in, and not on more room", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    rejectedWith(m, "entitlement_required");
    expect(m.status().reason).toBe("entitlement");
    m.setNetwork("offline");
    m.setNetwork("online");
    m.receive({ status: 200, body: body() });
    expect(m.takeRequests().filter((r) => r.method === "POST")).toEqual([]);
    m.signOut();
    expect(m.takeEvents()).toContainEqual({
      type: "signedOut",
      reason: "signOut",
      unsynced: 1,
    });
    m.signIn(ALICE);
    expect(mutations(m.takeRequests())).toEqual([
      expect.objectContaining({
        mutationId: 2,
        value: 0.5,
        editedHlc: hlc(T0),
      }),
    ]);
  });

  it("drops a parked lastWrite edit when a newer local edit or a newer remote value replaces it", () => {
    const local = started().m;
    local.set(VOL, 0.5);
    commit(local);
    rejectedWith(local, "quota_exceeded");
    local.set(VOL, 0.6);
    commit(local);
    expect(local.journal()[ALICE]).toMatchObject({
      pending: [{ mutationId: 2, value: 0.6 }],
    });

    const remote = started().m;
    remote.set(VOL, 0.5);
    commit(remote);
    rejectedWith(remote, "quota_exceeded");
    remote.setNetwork("offline");
    remote.setNetwork("online");
    // Negative control: an OLDER remote value leaves the parked edit alone.
    remote.receive({
      status: 200,
      body: body({
        cursor: 2,
        quota: { bytes: 1_048_576, files: false },
        usage: { bytes: 2_097_152, settings: 3, records: 0, files: 0 },
        changes: [
          {
            setting: VOL,
            scope: "user",
            value: 0.2,
            version: 2,
            editedHlc: hlc(T0 - 5000),
          },
        ],
      }),
    });
    expect(remote.get(VOL)).toEqual({ value: 0.5, from: "pending" });
    remote.setNetwork("offline");
    remote.setNetwork("online");
    remote.receive({
      status: 200,
      body: body({
        cursor: 3,
        quota: { bytes: 1_048_576, files: false },
        usage: { bytes: 2_097_152, settings: 3, records: 0, files: 0 },
        changes: [
          {
            setting: VOL,
            scope: "user",
            value: 0.9,
            version: 3,
            editedHlc: hlc(T0 + 5000),
          },
        ],
      }),
    });
    expect(remote.get(VOL)).toEqual({ value: 0.9, from: "cloud" });
    expect(remote.status()).toEqual({ state: "idle", pending: 0 });
  });

  it("keeps a parked max edit through a newer local edit: the server decides by value", () => {
    const { m } = started();
    m.set(BEST, 150);
    commit(m);
    rejectedWith(m, "quota_exceeded");
    m.set(BEST, 100);
    commit(m);
    expect(m.journal()[ALICE]).toMatchObject({
      pending: [
        { mutationId: 1, value: 150, parked: "quota" },
        { mutationId: 2, value: 100 },
      ],
    });
    expect(m.get(BEST)).toEqual({ value: 150, from: "pending" });
  });

  it("reverts a terminal refusal with an event (negative control)", () => {
    const { m } = started({
      document: { values: { [VOL]: 0.8 }, locked: [] },
    });
    m.set(VOL, 0.5);
    commit(m);
    rejectedWith(m, "value_invalid");
    expect(m.takeEvents()).toEqual([
      { type: "rejected", mutationId: 1, code: "value_invalid" },
      { type: "change", keys: [VOL], origin: "remote" },
    ]);
    expect(m.get(VOL)).toEqual({ value: 0.8, from: "document" });
    expect(m.status()).toEqual({ state: "idle", pending: 0 });
  });

  it("does not hold up a sign-out flush", () => {
    const { m } = started();
    m.set(VOL, 0.5);
    commit(m);
    rejectedWith(m, "quota_exceeded");
    m.signOut();
    expect(m.status().state).toBe("local");
    expect(m.takeEvents()).toContainEqual({ type: "unsyncedData", count: 1 });
  });
});

describe("record field policies (D4)", () => {
  it("sends a stamped set for a max record and coalesces a queued one", () => {
    const { m } = started();
    m.setNetwork("offline");
    m.put("slots", "1", { playtime: 10 });
    m.advance(5);
    m.put("slots", "1", { playtime: 20 });
    expect(m.journal()[ALICE]).toMatchObject({
      pending: [
        {
          mutationId: 1,
          op: "set",
          value: { playtime: 20 },
          editedHlc: hlc(T0 + 5),
        },
      ],
    });
  });

  it("sends member operations for a merge record", () => {
    const { m } = started();
    m.put("prefs", "main", { a: 1, b: 2 });
    expect(mutations(m.takeRequests())).toEqual([
      expect.objectContaining({ op: "setMember", member: "a", value: 1 }),
      expect.objectContaining({ op: "setMember", member: "b", value: 2 }),
    ]);
    expect(m.record("prefs", "main")).toEqual({
      value: { a: 1, b: 2 },
      from: "pending",
    });
  });

  it("refuses a put on a union collection or an unknown one", () => {
    const { m } = started();
    expect(m.put("nope", "1", 1)).toEqual({
      ok: false,
      error: "collection-unknown",
    });
  });
});
