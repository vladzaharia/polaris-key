/// <reference types="@cloudflare/workers-types" />
// The Cloud Sync settings conversations (U-05.16; WIRE-CONTRACT-V4 §13.3, §13.4), recorded through
// the real router and the real `CloudSyncDO` over its SQLite mock. Named `cloudsync-*` because
// `sync-etag-304` and `sync-errors` already pin document sync.
//
//   cloudsync-push-pull       an empty pull, a push, a snapshot pull, then the same pull as `304`
//   cloudsync-duplicate       a replayed batch: every mutation `duplicate`, state unchanged
//   cloudsync-conflict        a stale `baseVersion`: `conflict` with the server's copy
//   cloudsync-cursor-expired  `410 cursor_expired` on a pull and on a push
//   cloudsync-hlc-clamp       an `editedHlc` from the future is stored as `serverNow`
//   cloudsync-atomic          one bad mutation aborts the batch; nothing is stored
//   cloudsync-client-mismatch a `clientId` bound to another device: `409 client_mismatch`
//   cloudsync-members         `merge` members by concurrent clocks; a whole `set` is rejected
//
// Every conversation is a signed-in, key-activated device (the account and its device binding are
// seeded, as a completed sign-in leaves them). The two SDK calls are `cloudSyncPull` and
// `cloudSyncPush` (format.ts); the client's own state (its `clientId`, mutation ids and clocks) is
// not asserted, so each push body is held to its shape. The pull's `cursor` is always sent.

import { expect } from "vitest";
import type {
  MutationResult,
  PullResponse,
  PushResponse,
  SyncJson,
  SyncMutation,
} from "@polaris-key/protocol/sync";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  pinned,
  PRODUCT,
  emptyWorld,
  seedLicense,
  servicesOn,
  type Scenario,
} from "../world.js";
import { seedProduct } from "../../seed.js";
import type { Pinned } from "../determinism.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { formatHlc } from "../../../src/services/sync/engine/hlc.js";
import { callCloudSync } from "../../../src/services/sync/do/client.js";
import { seedAccount } from "./account.js";

const SYNC_ON = servicesOn("license", "config", "identity", "sync");
const FEATURES = ["sync.settings"];
const REQUIRES = ["core.store"];

/** The install's partition id: client state, so never asserted. */
const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_CLIENT = "c_BBBBBBBBBBBBBBBBBBBBBB";

const entry = (key: string, schema: unknown, extra: object = {}) => ({
  key,
  kind: "config",
  category: "Cloud Sync",
  label: key,
  description: key,
  schema,
  ...extra,
});

/** Declared settings, none with a catalog default (see TRANSCRIPT_CATALOG on why). */
const SYNC_CATALOG = {
  schemaVersion: 1,
  entries: [
    entry("audio.volume", { type: "number", minimum: 0, maximum: 1 }),
    entry("ui.theme", { type: "string", enum: ["dark", "light"] }),
    entry("game.best", { type: "number" }, { user: { conflict: "max" } }),
    entry(
      "ui.flags",
      {
        type: "object",
        properties: { a: { type: "boolean" }, b: { type: "boolean" } },
        additionalProperties: false,
      },
      { user: { conflict: "merge" } },
    ),
  ],
};

/** A key-activated device whose person is signed in, with Cloud Sync on. */
async function syncWorld(): Promise<{
  world: World;
  token: string;
  subject: string;
}> {
  const world = emptyWorld();
  await seedProduct(world.db, PRODUCT, { catalog: SYNC_CATALOG });
  await setServices(
    world.db,
    PRODUCT,
    serializeServices({ services: SYNC_ON }),
    "manifest",
    T0,
  );
  const { key } = await seedLicense(world);
  const token = await activated(world, key);
  const { subject } = await seedAccount(world, "ada@example.com");
  expect(
    await setDeviceSubject(world.env, world.db, PRODUCT, DEVICE, subject),
  ).toBe(true);
  return { world, token, subject };
}

function recorder(
  id: string,
  description: string,
  pin: Pinned,
  world: World,
  token: string,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features: FEATURES,
    requires: REQUIRES,
    product: PRODUCT,
    now: T0,
    world,
    pinned: pin,
    initial: { deviceId: DEVICE, token, version: VERSION },
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────────────────────────

let mid = 0;
/** An HLC `back` milliseconds before the recording instant. */
const hlcAt = (offsetMs: number, counter = 0): string =>
  formatHlc(T0 * 1000 + offsetMs, counter);

const mutation = (
  setting: string,
  op: SyncMutation["op"],
  extra: Partial<SyncMutation> = {},
): SyncMutation => ({
  mutationId: ++mid,
  target: { setting, scope: "user" },
  op,
  editedHlc: hlcAt(-1000),
  ...extra,
});
const set = (setting: string, value: SyncJson, extra = {}): SyncMutation =>
  mutation(setting, "set", { value, ...extra });

// ── The two SDK calls ──────────────────────────────────────────────────────────────────────────

const PUSH_ALLOWED = ["clientId", "cursor", "atomic", "mutations"];

function push(
  s: StepRecorder,
  mutations: SyncMutation[],
  opts: { cursor?: number; atomic?: boolean; clientId?: string } = {},
): Promise<Response> {
  const body = {
    clientId: opts.clientId ?? CLIENT,
    cursor: opts.cursor ?? 0,
    ...(opts.atomic ? { atomic: true } : {}),
    mutations,
  };
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/sync/ops`,
    bearer: "token",
    body,
    expectBody: {
      json: { ...body, mutations: [] } as never,
      match: "shape",
      allowedKeys: PUSH_ALLOWED,
    },
  });
}

function pull(
  s: StepRecorder,
  cursor: number,
  ifNoneMatch?: string,
): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/sync?cursor=${cursor}`,
    bearer: "token",
    ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
  });
}

const label = (r: MutationResult): string =>
  r.status === "rejected"
    ? `rejected:${r.code}`
    : r.status === "ok" && r.renamedTo
      ? `ok:renamedTo:${r.renamedTo}`
      : r.status;

/** The pull members a client acts on, as the step's `expect`. */
function pulled(body: PullResponse): Record<string, SyncJson> {
  return {
    result: "ok",
    cursor: body.cursor,
    more: body.more,
    empty: body.empty === true,
    settings: body.changes
      .flatMap((c) => ("setting" in c ? [c.setting] : []))
      .sort(),
  };
}

const refused = (status: number, code: string): Record<string, SyncJson> => ({
  result: "refused",
  status,
  code,
});

async function errorCode(res: Response): Promise<string> {
  return ((await res.clone().json()) as { error: { code: string } }).error.code;
}

/** `expect` for a push the Worker answered `200`. */
async function pushed(res: Response): Promise<Record<string, SyncJson>> {
  expect(res.status).toBe(200);
  const body = (await res.clone().json()) as PushResponse;
  return {
    ...pulled(body),
    lastMutationId: body.lastMutationId,
    results: body.results.map(label),
  };
}

type Expect = Record<string, SyncJson>;

/** One pull step. `etag` is sent as `If-None-Match`; the answer's ETag is returned. */
async function pullStep(
  r: TranscriptRecorder,
  cursor: number,
  note: string,
  opts: { now?: number; etag?: string } = {},
): Promise<{ body: PullResponse | null; etag: string }> {
  const out: { body: PullResponse | null; etag: string } = {
    body: null,
    etag: "",
  };
  const exp: Expect = {};
  await r.step(
    {
      action: "cloudSyncPull",
      args: { cursor },
      note,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
    async (s) => {
      const res = await pull(s, cursor, opts.etag);
      if (res.status === 304) {
        Object.assign(exp, { result: "not-modified" });
        return;
      }
      if (res.status !== 200) {
        Object.assign(exp, refused(res.status, await errorCode(res)));
        return;
      }
      out.etag = res.headers.get("etag") ?? "";
      out.body = (await res.clone().json()) as PullResponse;
      Object.assign(exp, pulled(out.body));
    },
    exp,
  );
  return out;
}

/** One push step; the parsed `200` body, or null when the Worker refused. */
async function pushStep(
  r: TranscriptRecorder,
  mutations: SyncMutation[],
  note: string,
  opts: {
    cursor?: number;
    atomic?: boolean;
    clientId?: string;
    now?: number;
  } = {},
): Promise<{ body: PushResponse | null; status: number; code?: string }> {
  const out: { body: PushResponse | null; status: number; code?: string } = {
    body: null,
    status: 0,
  };
  const exp: Expect = {};
  await r.step(
    {
      action: "cloudSyncPush",
      args: {
        cursor: opts.cursor ?? 0,
        atomic: opts.atomic === true,
        mutations: mutations.length,
      },
      note,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
    async (s) => {
      const res = await push(s, mutations, opts);
      out.status = res.status;
      if (res.status !== 200) {
        out.code = await errorCode(res);
        Object.assign(exp, refused(res.status, out.code));
        return;
      }
      out.body = (await res.clone().json()) as PushResponse;
      Object.assign(exp, await pushed(res));
    },
    exp,
  );
  return out;
}

const statuses = (b: PushResponse | null): string[] =>
  (b?.results ?? []).map(label);

export const cloudSyncPushPull: Scenario = {
  id: "cloudsync-push-pull",
  record: () =>
    pinned("cloudsync-push-pull", async (pin) => {
      mid = 0;
      const { world, token, subject } = await syncWorld();
      const r = recorder(
        "cloudsync-push-pull",
        "Settings over /sync (WIRE-CONTRACT-V4 §13.3, §13.4) for a signed-in, key-activated device. A pull of a person with nothing stored answers an empty snapshot (empty: true, cursor 0); a push of two declared settings answers each ok with its version, the new cursor and the person's changes; a snapshot pull returns both with an ETag; the same pull sent with that ETag answers 304 and no body.",
        pin,
        world,
        token,
      );
      const first = await pullStep(r, 0, "Nothing stored: an empty snapshot.");
      expect(first.body?.empty).toBe(true);
      expect(first.body?.subject).toBe(subject);

      const pushed1 = await pushStep(
        r,
        [set("ui.theme", "dark"), set("audio.volume", 0.5)],
        "Two declared settings, both accepted.",
      );
      expect(statuses(pushed1.body)).toEqual(["ok", "ok"]);

      const snap = await pullStep(r, 0, "A snapshot pull: both settings.");
      expect(snap.body?.changes.length).toBe(2);
      expect(snap.etag).not.toBe("");

      const again = await pullStep(
        r,
        snap.body!.cursor,
        "Nothing new since the cursor: the ETag matches and the answer is 304.",
        { etag: snap.etag },
      );
      expect(again.body).toBeNull();
      return r.transcript();
    }),
};

export const cloudSyncDuplicate: Scenario = {
  id: "cloudsync-duplicate",
  record: () =>
    pinned("cloudsync-duplicate", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-duplicate",
        "A batch sent twice (a lost response, a retry). Mutation ids at or below the last processed one are duplicate: not applied again, and the answer still carries the person's current state.",
        pin,
        world,
        token,
      );
      const batch = [set("ui.theme", "dark"), set("audio.volume", 0.25)];
      const first = await pushStep(r, batch, "The batch lands.");
      expect(statuses(first.body)).toEqual(["ok", "ok"]);
      const second = await pushStep(
        r,
        batch,
        "The same mutation ids again: duplicate, nothing applied.",
      );
      expect(statuses(second.body)).toEqual(["duplicate", "duplicate"]);
      expect(second.body?.lastMutationId).toBe(first.body?.lastMutationId);
      return r.transcript();
    }),
};

export const cloudSyncConflict: Scenario = {
  id: "cloudsync-conflict",
  record: () =>
    pinned("cloudsync-conflict", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-conflict",
        "An offline edit that lost. A set whose editedHlc is older than the stored value's is answered conflict with the server's copy (value, version, editedHlc) and is not applied; the same value re-stamped later is ok. (baseVersion compare-and-swap is for records, not settings.)",
        pin,
        world,
        token,
      );
      const seeded = await pushStep(r, [set("ui.theme", "dark")], "Create.");
      expect(statuses(seeded.body)).toEqual(["ok"]);
      const lost = await pushStep(
        r,
        [set("ui.theme", "light", { editedHlc: hlcAt(-60_000) })],
        "Edited a minute before the stored value: it loses.",
        { cursor: seeded.body!.cursor },
      );
      expect(statuses(lost.body)).toEqual(["conflict"]);
      const retry = await pushStep(
        r,
        [set("ui.theme", "light", { editedHlc: hlcAt(0) })],
        "Re-stamped after the server's copy.",
        { cursor: lost.body!.cursor },
      );
      expect(statuses(retry.body)).toEqual(["ok"]);
      return r.transcript();
    }),
};

export const cloudSyncCursorExpired: Scenario = {
  id: "cloudsync-cursor-expired",
  record: () =>
    pinned("cloudsync-cursor-expired", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-cursor-expired",
        "A cursor the object cannot serve (older than the tombstone window, or from another history) is 410 cursor_expired, on a pull and on a push. A push whose mutations landed before the cursor was found stale answers 410 as well; the client repeats it from cursor 0 and every mutation is duplicate.",
        pin,
        world,
        token,
      );
      const stalePull = await pullStep(
        r,
        9999,
        "A pull from a cursor ahead of the history.",
      );
      expect(stalePull.body).toBeNull();
      const m = [set("ui.theme", "dark")];
      const stalePush = await pushStep(r, m, "A push with the same cursor.", {
        cursor: 9999,
      });
      expect(stalePush.status).toBe(410);
      expect(stalePush.code).toBe("cursor_expired");
      const again = await pushStep(
        r,
        m,
        "Repeated from cursor 0: the mutation had landed.",
      );
      expect(statuses(again.body)).toEqual(["duplicate"]);
      return r.transcript();
    }),
};

export const cloudSyncHlcClamp: Scenario = {
  id: "cloudsync-hlc-clamp",
  record: () =>
    pinned("cloudsync-hlc-clamp", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-hlc-clamp",
        "A client clock an hour fast. An editedHlc later than serverNow plus 300 seconds is stored as serverNow with a zero counter (§13.3), so the value is accepted but can never pin the key in the future; the pull shows the clamped stamp.",
        pin,
        world,
        token,
      );
      const res = await pushStep(
        r,
        [set("ui.theme", "dark", { editedHlc: hlcAt(3_600_000) })],
        "An editedHlc one hour ahead.",
      );
      expect(statuses(res.body)).toEqual(["ok"]);
      const snap = await pullStep(r, 0, "The stored stamp is serverNow.");
      const change = snap.body!.changes[0]!;
      expect("setting" in change && change.editedHlc).toBe(hlcAt(0));
      return r.transcript();
    }),
};

export const cloudSyncAtomic: Scenario = {
  id: "cloudsync-atomic",
  record: () =>
    pinned("cloudsync-atomic", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-atomic",
        "An atomic batch is all or nothing. One mutation fails its setting's schema, so the valid one is aborted and nothing is stored (the snapshot pull is still empty); the batch without the bad mutation applies.",
        pin,
        world,
        token,
      );
      const bad = await pushStep(
        r,
        [set("ui.theme", "dark"), set("audio.volume", 99)],
        "atomic: the second mutation is invalid.",
        { atomic: true },
      );
      expect(statuses(bad.body)).toEqual(["aborted", "rejected:value_invalid"]);
      const snap = await pullStep(r, 0, "Nothing was stored.");
      expect(snap.body?.empty).toBe(true);
      const good = await pushStep(
        r,
        [set("ui.theme", "dark"), set("audio.volume", 0.5)],
        "atomic: both valid.",
        { atomic: true },
      );
      expect(statuses(good.body)).toEqual(["ok", "ok"]);
      return r.transcript();
    }),
};

export const cloudSyncClientMismatch: Scenario = {
  id: "cloudsync-client-mismatch",
  record: () =>
    pinned("cloudsync-client-mismatch", async (pin) => {
      mid = 0;
      const { world, token, subject } = await syncWorld();
      // Setup: another of the person's devices has already used OTHER_CLIENT.
      const other = await callCloudSync<"push">(
        world.env,
        { product: PRODUCT, subject },
        {
          op: "push",
          deviceId: "TRANSCRIPTOTHERDEVICE00000000002",
          family: "desktop",
          limits: { quotaBytes: 1_000_000 },
          request: {
            clientId: OTHER_CLIENT,
            cursor: 0,
            mutations: [set("audio.volume", 0.1)],
          },
          classified: [
            { verdict: "accept", scope: "user", policy: "lastWrite" },
          ],
          serverNow: T0 * 1000,
        },
      );
      expect(other.outcome.ok).toBe(true);
      const r = recorder(
        "cloudsync-client-mismatch",
        "A clientId belongs to one device. A push that names a clientId another device of the person already used is 409 client_mismatch and writes nothing; the client mints a new clientId and pushes again.",
        pin,
        world,
        token,
      );
      const refusedPush = await pushStep(
        r,
        [set("ui.theme", "dark")],
        "Another device's clientId.",
        { clientId: OTHER_CLIENT },
      );
      expect(refusedPush.status).toBe(409);
      expect(refusedPush.code).toBe("client_mismatch");
      const fresh = await pushStep(
        r,
        [set("ui.theme", "dark")],
        "A fresh clientId.",
      );
      expect(statuses(fresh.body)).toEqual(["ok"]);
      return r.transcript();
    }),
};

export const cloudSyncMembers: Scenario = {
  id: "cloudsync-members",
  record: () =>
    pinned("cloudsync-members", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-members",
        "A merge setting is merged member by member. Two edits of different members both stand; two concurrent edits of one member are decided by their clocks (the later editedHlc wins whatever the arrival order; the loser is answered conflict); a whole set of a merge setting is rejected op_invalid_for_policy.",
        pin,
        world,
        token,
      );
      const res = await pushStep(
        r,
        [
          mutation("ui.flags", "setMember", {
            member: "a",
            value: true,
            editedHlc: hlcAt(-1000),
          }),
          mutation("ui.flags", "setMember", {
            member: "b",
            value: true,
            editedHlc: hlcAt(-2000),
          }),
          // Concurrent with the first, but older: it arrives later and loses.
          mutation("ui.flags", "setMember", {
            member: "a",
            value: false,
            editedHlc: hlcAt(-5000),
          }),
          mutation("ui.flags", "set", { value: { a: false } }),
        ],
        "Members by clock, then a whole set.",
      );
      expect(statuses(res.body)).toEqual([
        "ok",
        "ok",
        "conflict",
        "rejected:op_invalid_for_policy",
      ]);
      const snap = await pullStep(r, 0, "The merged members.");
      const change = snap.body!.changes[0]!;
      expect("setting" in change && change.value).toEqual({ a: true, b: true });
      return r.transcript();
    }),
};

export const CLOUD_SYNC_SCENARIOS: Scenario[] = [
  cloudSyncPushPull,
  cloudSyncDuplicate,
  cloudSyncConflict,
  cloudSyncCursorExpired,
  cloudSyncHlcClamp,
  cloudSyncAtomic,
  cloudSyncClientMismatch,
  cloudSyncMembers,
];
