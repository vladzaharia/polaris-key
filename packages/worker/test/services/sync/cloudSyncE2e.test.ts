/**
 * U-09.1: Cloud Sync end-to-end settings on the Worker (WIRE-CONTRACT-V5 §13.3, §13.4, §13.5,
 * §13.10): `ct` push and pull, `encryption_mismatch`, the client `max`/`min` compare-and-swap
 * register, `encryptionSince`, and discovery's `encryption`.
 *
 * Driven through the real `dispatch` pipeline and the real `CloudSyncDO` over the SQLite mock. The
 * server never decodes a `ct`: the envelopes here are shaped bytes, not real ciphertext.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  MutationResult,
  PullResponse,
  PushResponse,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import { dispatch } from "../../../src/dispatch.js";
import {
  authed,
  BASE,
  hlc,
  mut,
  push,
  SLUG,
  world,
  type World,
} from "./cloudSyncAbuseWorld.js";

const entry = (key: string, extra: object = {}) => ({
  key,
  kind: "config",
  category: "test",
  label: key,
  description: key,
  schema: { type: "string" },
  ...extra,
});

const catalog = (encryption?: "server" | "e2e") => ({
  schemaVersion: 1,
  entries: [
    entry("ui.theme"),
    entry("game.best", {
      schema: { type: "number" },
      user: { conflict: "max" },
    }),
    entry("game.fastest", {
      schema: { type: "number" },
      user: { conflict: "min" },
    }),
    entry("ui.flags", {
      schema: { type: "object", additionalProperties: { type: "boolean" } },
      user: { conflict: "merge" },
    }),
  ],
  ...(encryption ? { cloudSync: { encryption } } : {}),
});

const worldOf = (
  opts: { encryption?: "server" | "e2e"; gate?: "on" | "off" } = {},
): Promise<World> =>
  world({ catalog: catalog(opts.encryption), gate: opts.gate ?? "on" });

const headers = (w: World) => authed(w);

const call = (w: World, path: string, init: RequestInit = {}) =>
  dispatch(
    new Request(`${BASE}/${SLUG}${path}`, {
      ...init,
      headers: { ...headers(w), ...(init.headers as object) },
    }) as unknown as Request,
    w.env,
    w.db,
  );

/** A shaped envelope: byte 0 = 1, `blocks` padded blocks of payload, every other byte `fill`. */
function envelope(blocks = 1, fill = 7, byte0 = 1, extra = 0): string {
  const bytes = new Uint8Array(49 + 64 * blocks + extra).fill(fill);
  bytes[0] = byte0;
  return Buffer.from(bytes).toString("base64url");
}

const BLIND = (n: number) => `x:${String(n).padStart(43, "A")}`;

const pushed = async (w: World, mutations: SyncMutation[]) => {
  const res = await push(w, mutations);
  expect(res.status).toBe(200);
  return (await res.json()) as PushResponse;
};
/** The first result is the refused `ct`, the second the accepted write. */
const expectMismatchThenOk = (b: PushResponse) => {
  expect(b.results[0]).toMatchObject({ code: "encryption_mismatch" });
  expect(b.results[1]).toMatchObject({ status: "ok" });
};
/** A `ct` then a `value` on `ui.theme`: the pair a server-mode (or gate-off) Worker splits. */
const ctThenValue = async (w: World) => {
  const b = await pushed(w, [
    mut("ui.theme", "set", { ct: envelope() }),
    mut("ui.theme", "set", { value: "dark" }),
  ]);
  expectMismatchThenOk(b);
  return b;
};
const only = (b: PushResponse): MutationResult => b.results[0]!;

describe("E2E push: refusals", () => {
  let w: World;
  beforeEach(async () => {
    w = await worldOf();
  });

  it("a value on an E2E product is encryption_mismatch", async () => {
    const b = await pushed(w, [mut("ui.theme", "set", { value: "dark" })]);
    expect(only(b)).toMatchObject({
      status: "rejected",
      code: "encryption_mismatch",
    });
  });

  it("an undeclared key that is not blinded is encryption_mismatch; a blinded one is open", async () => {
    const b = await pushed(w, [
      mut("my.private.name", "set", { ct: envelope() }),
      mut(BLIND(1), "set", { ct: envelope() }),
    ]);
    expectMismatchThenOk(b);
  });

  it("an unblinded merge member is encryption_mismatch", async () => {
    const b = await pushed(w, [
      mut("ui.flags", "setMember", { member: "plain", ct: envelope() }),
      mut("ui.flags", "setMember", { member: BLIND(2), ct: envelope() }),
    ]);
    expectMismatchThenOk(b);
  });

  it("a malformed envelope is value_invalid", async () => {
    const bad = [
      envelope(1, 7, 2), // version byte
      envelope(1, 7, 1, 1), // (length - 49) mod 64 != 0
      "AQ", // too short
      `${envelope()}=`, // not canonical base64url
      "!!!!",
    ];
    const b = await pushed(
      w,
      bad.map((ct) => mut("ui.theme", "set", { ct })),
    );
    for (const r of b.results)
      expect(r).toMatchObject({ status: "rejected", code: "value_invalid" });
  });

  it("an open setting is bounded at 8 KiB, charged on envelopeBytes - 113", async () => {
    // 8192 + 113 = 8305 bytes of envelope is the largest allowed; 49 + 64k steps by 64.
    const fits = Math.floor((8192 + 113 - 49) / 64);
    const b = await pushed(w, [
      mut(BLIND(3), "set", { ct: envelope(fits) }),
      mut(BLIND(4), "set", { ct: envelope(fits + 1) }),
    ]);
    expect(b.results[0]).toMatchObject({ status: "ok" });
    expect(b.results[1]).toMatchObject({ code: "value_invalid" });
  });
});

describe("a ct on a server-mode product", () => {
  it("is encryption_mismatch, and a value still works", async () => {
    const w = await worldOf({ encryption: "server" });
    const b = await ctThenValue(w);
    expect(b.encryption).toBe("server");
    expect(b.encryptionSince).toBeUndefined();
  });
});

describe("E2E pull", () => {
  it("carries ct, encryption and encryptionSince; an empty store names the next sequence", async () => {
    const w = await worldOf();
    const empty = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(empty).toMatchObject({ encryption: "e2e", encryptionSince: 1 });
    const ct = envelope(2);
    const b = await pushed(w, [mut("ui.theme", "set", { ct })]);
    expect(b.encryption).toBe("e2e");
    expect(b.encryptionSince).toBe(1);
    const pull = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(pull.changes).toEqual([
      expect.objectContaining({ setting: "ui.theme", ct, version: 1 }),
    ]);
    expect(pull.changes[0]).not.toHaveProperty("value");
    expect(pull).toMatchObject({ encryption: "e2e", encryptionSince: 1 });
  });

  it("a merge setting's members are sealed, with blinded names", async () => {
    const w = await worldOf();
    const a = envelope(1, 1);
    const c = envelope(1, 2);
    await pushed(w, [
      mut("ui.flags", "setMember", { member: BLIND(5), ct: a }),
      mut("ui.flags", "setMember", { member: BLIND(6), ct: c }),
      mut("ui.flags", "removeMember", { member: BLIND(6) }),
    ]);
    const pull = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(pull.changes).toEqual([
      expect.objectContaining({
        setting: "ui.flags",
        members: [{ member: BLIND(5), ct: a, editedHlc: hlc }],
      }),
    ]);
    expect(pull.changes[0]).not.toHaveProperty("value");
    expect(pull.changes[0]).not.toHaveProperty("ct");
  });

  it("budgets are charged on envelopeBytes - 113, the quota on the stored bytes", async () => {
    const w = await worldOf();
    const ct = envelope(3);
    const b = await pushed(w, [mut("ui.theme", "set", { ct })]);
    expect(b.usage).toMatchObject({ settings: 1 });
    // The stored string, quoted, plus the key.
    expect(b.usage.bytes).toBe("ui.theme".length + ct.length + 2);
  });
});

describe("E2E max/min: a compare-and-swap register", () => {
  it("create-only, then a stale baseVersion is a conflict carrying the server ct", async () => {
    const w = await worldOf();
    const first = envelope(1, 1);
    const v1 = await pushed(w, [
      mut("game.best", "set", { ct: first, baseVersion: "*" }),
    ]);
    expect(only(v1)).toMatchObject({ status: "ok", version: 1 });

    // Create-only again: the key exists.
    const again = await pushed(w, [
      mut("game.best", "set", { ct: envelope(1, 2), baseVersion: "*" }),
    ]);
    expect(only(again)).toMatchObject({
      status: "conflict",
      server: { ct: first, version: 1 },
    });
    expect(only(again)).not.toHaveProperty("server.value");

    // A stale version: conflict. The client opens the copy, keeps the better value and re-pushes
    // on the server's version.
    const stale = await pushed(w, [
      mut("game.best", "set", { ct: envelope(1, 3), baseVersion: 99 }),
    ]);
    expect(only(stale)).toMatchObject({
      status: "conflict",
      server: { ct: first, version: 1 },
    });
    const better = envelope(1, 4);
    const merged = await pushed(w, [
      mut("game.best", "set", { ct: better, baseVersion: 1 }),
    ]);
    expect(only(merged)).toMatchObject({ status: "ok", version: 2 });
    const pull = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(pull.changes[0]).toMatchObject({ ct: better, version: 2 });
  });

  it("min is the same register; a baseVersion of another type is value_invalid", async () => {
    const w = await worldOf();
    const b = await pushed(w, [
      mut("game.fastest", "set", { ct: envelope(), baseVersion: "*" }),
      mut("game.fastest", "set", { ct: envelope(), baseVersion: -1 }),
      mut("game.fastest", "set", {
        ct: envelope(),
        baseVersion: "7" as unknown as number,
      }),
    ]);
    expect(b.results[0]).toMatchObject({ status: "ok" });
    expect(b.results[1]).toMatchObject({ code: "value_invalid" });
    expect(b.results[2]).toMatchObject({ code: "value_invalid" });
  });
});

describe("encryptionSince", () => {
  it("is fixed by the first sealed write, and a plaintext row below it is still served as value", async () => {
    // Plaintext history first: a server-mode product (`value`), then the catalog turns E2E.
    const w = await worldOf({ encryption: "server" });
    await pushed(w, [mut("ui.theme", "set", { value: "dark" })]);
    await w.db.run(
      "UPDATE product_schema SET catalog_json = ? WHERE product = ?",
      JSON.stringify(catalog("e2e")),
      SLUG,
    );
    const legacy = (await (await call(w, "/sync")).json()) as PullResponse;
    // Nothing sealed yet: the next write takes sequence 2.
    expect(legacy).toMatchObject({ encryption: "e2e", encryptionSince: 2 });
    expect(legacy.changes[0]).toMatchObject({ value: "dark", version: 1 });

    const ct = envelope();
    await pushed(w, [mut("game.best", "set", { ct, baseVersion: "*" })]);
    const pull = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(pull.encryptionSince).toBe(2);
    expect(pull.changes).toEqual([
      expect.objectContaining({
        setting: "ui.theme",
        value: "dark",
        version: 1,
      }),
      expect.objectContaining({ setting: "game.best", ct, version: 2 }),
    ]);

    // The client re-seals the legacy row on its next write: it moves above the line.
    const sealed = envelope(1, 9);
    await pushed(w, [mut("ui.theme", "set", { ct: sealed })]);
    const after = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(after.encryptionSince).toBe(2);
    expect(
      after.changes.find((c) => "setting" in c && c.setting === "ui.theme"),
    ).toMatchObject({ ct: sealed, version: 3 });
  });
});

describe("the launch gate and discovery", () => {
  const sync = async (w: World) => {
    const res = await dispatch(
      new Request(
        `${BASE}/${SLUG}/.well-known/polaris.json`,
      ) as unknown as Request,
      w.env,
      w.db,
    );
    return (
      (await res.json()) as { services: { sync: Record<string, unknown> } }
    ).services.sync;
  };

  it("gate on: discovery names the mode and the key ring endpoint", async () => {
    expect(await sync(await worldOf())).toMatchObject({
      encryption: "e2e",
      endpoints: { keyring: `${BASE}/${SLUG}/devices/keyring` },
    });
    const server = await sync(await worldOf({ encryption: "server" }));
    expect(server).toMatchObject({ encryption: "server" });
    expect(server.endpoints).not.toHaveProperty("keyring");
  });

  it("gate off: no encryption member, ct is refused, a pull says nothing of E2E", async () => {
    const w = await worldOf({ gate: "off" });
    const d = await sync(w);
    expect(d).not.toHaveProperty("encryption");
    expect(d.endpoints).not.toHaveProperty("keyring");
    const b = await ctThenValue(w);
    expect(b).not.toHaveProperty("encryption");
    expect(b).not.toHaveProperty("encryptionSince");
    const pull = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(pull).not.toHaveProperty("encryption");
    expect(pull.changes[0]).toMatchObject({ value: "dark" });
  });

  it("is not fixed by a rejected sealed write, only by an accepted one", async () => {
    const w = await worldOf({ encryption: "e2e" });
    // A sealed write the engine refuses (a negative base version) leaves it unset.
    const rejected = await pushed(w, [
      mut("game.best", "set", { ct: envelope(), baseVersion: -1 }),
    ]);
    expect(rejected.results[0]).toMatchObject({ status: "rejected" });
    const before = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(before.encryptionSince).toBe(1);
    const ct = envelope();
    await pushed(w, [mut("game.best", "set", { ct, baseVersion: "*" })]);
    const after = (await (await call(w, "/sync")).json()) as PullResponse;
    expect(after.encryptionSince).toBe(1);
    expect(after.changes).toEqual([
      expect.objectContaining({ setting: "game.best", ct, version: 1 }),
    ]);
  });
});
