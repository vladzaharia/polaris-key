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
//   cloudsync-e2e-settings    (U-09.1) ct push and pull, encryption_mismatch, a max CAS re-merge
//
// U-05.17 adds account-required, quota, migrations, first-signin, cors, open-settings, trust and
// paused.
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
import { DEVICE, document, syncReport, T0, trust, VERSION } from "../client.js";
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
import { serializeWebOrigins } from "../../../src/core/cors.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";

const SYNC_ON = servicesOn("license", "config", "identity", "sync");
const FEATURES = ["sync.settings"];
const REQUIRES = ["core.store"];

/** The install's partition id: client state, so never asserted. */
export const CLIENT = "c_AAAAAAAAAAAAAAAAAAAAAA";
export const OTHER_CLIENT = "c_BBBBBBBBBBBBBBBBBBBBBB";

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
export async function syncWorld(
  opts: { catalog?: unknown; signedIn?: boolean; e2eGate?: boolean } = {},
): Promise<{
  world: World;
  token: string;
  subject: string;
}> {
  const world = emptyWorld();
  // The launch gate `launch.syncE2e` (U-09.1): off for the server-mode conversations, which are
  // the wire as it was before end-to-end mode, so those transcripts stay byte for byte. The
  // `cloudsync-e2e-settings` conversation turns it on.
  (world.env as unknown as Record<string, string>).LAUNCH_SYNC_E2E =
    opts.e2eGate === true ? "on" : "off";
  invalidatePlatformSettings(world.env, world.db);
  await seedProduct(world.db, PRODUCT, {
    catalog: opts.catalog ?? SYNC_CATALOG,
  });
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
  if (opts.signedIn !== false)
    expect(
      await setDeviceSubject(world.env, world.db, PRODUCT, DEVICE, subject),
    ).toBe(true);
  return { world, token, subject };
}

export function recorder(
  id: string,
  description: string,
  pin: Pinned,
  world: World,
  token: string,
  features: string[] = FEATURES,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features,
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
/** The next push-wide `mutationId`; a scenario resets it so its transcript is deterministic. */
export const nextMutationId = (): number => ++mid;
export const resetMutationIds = (): void => {
  mid = 0;
};
/** An HLC `back` milliseconds before the recording instant. */
export const hlcAt = (offsetMs: number, counter = 0): string =>
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

export function push(
  s: StepRecorder,
  mutations: SyncMutation[],
  opts: {
    cursor?: number;
    atomic?: boolean;
    clientId?: string;
    assertHeaders?: Record<string, string>;
    recordHeaders?: string[];
  } = {},
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
    ...(opts.assertHeaders ? { assertHeaders: opts.assertHeaders } : {}),
    ...(opts.recordHeaders ? { recordHeaders: opts.recordHeaders } : {}),
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
    ? r.code === "quota_exceeded"
      ? `rejected:quota_exceeded:${r.scope}`
      : `rejected:${r.code}`
    : r.status === "ok" && r.renamedTo
      ? `ok:renamedTo:${r.renamedTo}`
      : r.status === "ok" && r.dropped
        ? "ok:dropped"
        : r.status;

/** The record changes and record tombstones of an answer, as `collection/id` lists. */
function recordsOf(body: PullResponse): Record<string, SyncJson> {
  const live = body.changes
    .flatMap((c) => ("record" in c ? [c.record.join("/")] : []))
    .sort();
  const gone = (body.tombstones ?? [])
    .flatMap((t) => ("record" in t ? [t.record.join("/")] : []))
    .sort();
  return {
    ...(live.length > 0 ? { records: live } : {}),
    ...(gone.length > 0 ? { deletedRecords: gone } : {}),
  };
}

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
    // Records (U-09): present only when the answer carries one, so a settings conversation is
    // unchanged. `collection/id`, sorted.
    ...recordsOf(body),
    // End-to-end mode only (U-09.1): the server-mode conversations carry neither member.
    ...(body.encryption !== undefined ? { encryption: body.encryption } : {}),
    ...(body.encryptionSince !== undefined
      ? { encryptionSince: body.encryptionSince }
      : {}),
  };
}

const refused = (status: number, code: string): Record<string, SyncJson> => ({
  result: "refused",
  status,
  code,
});

/** The client-visible refusal: status, code and, when the Worker sent one, `Retry-After`. */
async function refusal(res: Response): Promise<Record<string, SyncJson>> {
  const retry = res.headers.get("retry-after");
  return {
    ...refused(res.status, await errorCode(res)),
    ...(retry !== null ? { retryAfter: Number(retry) } : {}),
  };
}

const quotaOf = (b: PullResponse): Record<string, SyncJson> => ({
  quotaBytes: b.quota.bytes,
  files: b.quota.files,
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

export type Expect = Record<string, SyncJson>;

/** One pull step. `etag` is sent as `If-None-Match`; the answer's ETag is returned. */
export async function pullStep(
  r: TranscriptRecorder,
  cursor: number,
  note: string,
  opts: { now?: number; etag?: string; quota?: boolean } = {},
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
        Object.assign(exp, await refusal(res));
        return;
      }
      out.etag = res.headers.get("etag") ?? "";
      out.body = (await res.clone().json()) as PullResponse;
      Object.assign(exp, pulled(out.body));
      if (opts.quota) Object.assign(exp, quotaOf(out.body));
    },
    exp,
  );
  return out;
}

/** One push step; the parsed `200` body, or null when the Worker refused. */
export async function pushStep(
  r: TranscriptRecorder,
  mutations: SyncMutation[],
  note: string,
  opts: {
    cursor?: number;
    atomic?: boolean;
    clientId?: string;
    now?: number;
    quota?: boolean;
    aliases?: boolean;
    assertHeaders?: Record<string, string>;
    recordHeaders?: string[];
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
        Object.assign(exp, await refusal(res));
        return;
      }
      out.body = (await res.clone().json()) as PushResponse;
      Object.assign(exp, await pushed(res));
      if (opts.quota) Object.assign(exp, quotaOf(out.body));
      if (opts.aliases) exp.aliases = out.body.aliases;
    },
    exp,
  );
  return out;
}

export const statuses = (b: PushResponse | null): string[] =>
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
      expect("setting" in change && "value" in change && change.value).toEqual({
        a: true,
        b: true,
      });
      return r.transcript();
    }),
};

const LISTED = "https://play.djdl.example";
const UNLISTED = "https://evil.example";
const OTHER_DEVICE = "TRANSCRIPTOTHERDEVICE00000000002";

/** Setup: the person's other device pushes, so the cloud is not empty. */
async function otherDevicePushes(
  world: World,
  subject: string,
  mutations: SyncMutation[],
): Promise<void> {
  const reply = await callCloudSync<"push">(
    world.env,
    { product: PRODUCT, subject },
    {
      op: "push",
      deviceId: OTHER_DEVICE,
      family: "desktop",
      limits: { quotaBytes: 1_000_000 },
      request: { clientId: OTHER_CLIENT, cursor: 0, mutations },
      classified: mutations.map(() => ({
        verdict: "accept" as const,
        scope: "user" as const,
        policy: "lastWrite" as const,
      })),
      serverNow: T0 * 1000,
    },
  );
  expect(reply.outcome.ok).toBe(true);
}

export const cloudSyncAccountRequired: Scenario = {
  id: "cloudsync-account-required",
  record: () =>
    pinned("cloudsync-account-required", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld({ signedIn: false });
      const r = recorder(
        "cloudsync-account-required",
        "A key-activated device whose person has not signed in has no Cloud Sync principal: the pull and the push are 403 account_required (the body carries a signInUrl), and the object is never reached. The refusal is not a licence event: the next document sync is unchanged, the licence still applies, and the token is still held.",
        pin,
        world,
        token,
      );
      const stalePull = await pullStep(r, 0, "Not signed in.");
      expect(stalePull.body).toBeNull();
      const refusedPush = await pushStep(
        r,
        [set("ui.theme", "dark")],
        "Not signed in: values stay local.",
      );
      expect(refusedPush.code).toBe("account_required");
      await r.step(
        {
          action: "sync",
          args: { force: false },
          note: "The licence document fetch is unaffected.",
        },
        async (s) => {
          await trust(s, PRODUCT);
          expect((await document(s, PRODUCT, "license")).status).toBe(200);
          expect((await document(s, PRODUCT, "config")).status).toBe(200);
          expect(
            (
              await syncReport(s, PRODUCT, {
                config: { "ui.theme": "dark" },
                entitlements: { polarisVpn: true },
              })
            ).status,
          ).toBe(200);
        },
        {
          applied: true,
          unauthorized: false,
          blocked: false,
          documents: { license: "applied", config: "applied" },
          licenseStatus: "ok",
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const cloudSyncQuota: Scenario = {
  id: "cloudsync-quota",
  record: () =>
    pinned("cloudsync-quota", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-quota",
        "The three quotas (§13.1, §13.9). A write over the person's quota is rejected quota_exceeded with scope user; past the product's ceiling a growing write is rejected with scope product (a clear still passes); a device with no usable licence is at 1 MiB with files refused, which the pull's quota member reports. A rejected write is not a failed request: the answer is 200 with the result.",
        pin,
        world,
        token,
      );
      await world.db.run(
        "UPDATE licenses SET overrides_json = ? WHERE product = ?",
        JSON.stringify({
          config: {},
          secrets: {},
          entitlements: {
            "pkey.cloudSync.bytes": {
              state: "enforced",
              value: 1,
              updatedAt: T0,
            },
          },
        }),
        PRODUCT,
      );
      const user = await pushStep(
        r,
        [set("audio.volume", 0.5)],
        "A person quota of one byte.",
        { quota: true },
      );
      expect(statuses(user.body)).toEqual(["rejected:quota_exceeded:user"]);

      await world.db.run(
        "UPDATE licenses SET overrides_json = '{}' WHERE product = ?",
        PRODUCT,
      );
      const first = await pushStep(
        r,
        [set("audio.volume", 0.5)],
        "Under every limit: stored.",
        { quota: true, cursor: user.body!.cursor },
      );
      expect(statuses(first.body)).toEqual(["ok"]);
      await world.db.run(
        `INSERT INTO sync_product_usage (product, bytes, users, settings_bytes, record_bytes, file_bytes, revision_bytes, breakdown_json, computed_at)
         VALUES (?, 1000, 1, 1000, 0, 0, 0, '{}', 1)`,
        PRODUCT,
      );
      await world.db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'cloudSync.ceiling.bytes', '500', 'console', ?, 'transcript')`,
        PRODUCT,
        T0,
      );
      const product = await pushStep(
        r,
        [set("ui.theme", "dark"), mutation("audio.volume", "clear")],
        "The product is past its ceiling: growth is refused, a clear passes.",
        { quota: true, cursor: first.body!.cursor },
      );
      expect(statuses(product.body)).toEqual([
        "rejected:quota_exceeded:product",
        "ok",
      ]);

      await world.db.run(
        "UPDATE licenses SET status = 'disabled' WHERE product = ?",
        PRODUCT,
      );
      const bare = await pullStep(r, 0, "No usable licence: 1 MiB, no files.", {
        quota: true,
      });
      expect(bare.body?.quota).toEqual({ bytes: 1_048_576, files: false });
      return r.transcript();
    }),
};

const MIGRATION_CATALOG = {
  schemaVersion: 2,
  entries: [entry("audio.volume", { type: "number", minimum: 0, maximum: 1 })],
  cloudSync: {
    migrations: [
      {
        toSchemaVersion: 2,
        rename: { "old.vol": "audio.volume" },
        drop: ["gone.key"],
      },
    ],
  },
};

export const cloudSyncMigrations: Scenario = {
  id: "cloudsync-migrations",
  record: () =>
    pinned("cloudsync-migrations", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld({ catalog: MIGRATION_CATALOG });
      const r = recorder(
        "cloudsync-migrations",
        "An older client pushes keys the catalog has since renamed or dropped (cloudSync.migrations, §13.3). A renamed key is stored under its new name and the result says renamedTo; a dropped key is accepted and discarded with dropped: true; the answer's aliases member maps old names to new so the client can migrate its journal.",
        pin,
        world,
        token,
      );
      const res = await pushStep(
        r,
        [set("old.vol", 0.2), set("gone.key", 1)],
        "A renamed key and a dropped key.",
        { aliases: true },
      );
      expect(statuses(res.body)).toEqual([
        "ok:renamedTo:audio.volume",
        "ok:dropped",
      ]);
      const snap = await pullStep(r, 0, "Stored under the new name only.");
      expect(snap.body?.changes.length).toBe(1);
      return r.transcript();
    }),
};

export const cloudSyncFirstSignin: Scenario = {
  id: "cloudsync-first-signin",
  record: () =>
    pinned("cloudsync-first-signin", async (pin) => {
      mid = 0;
      const { world, token, subject } = await syncWorld();
      const r = recorder(
        "cloudsync-first-signin",
        "The first pull after sign-in (§13.4). A person with nothing stored gets an empty snapshot marked empty: true, so the client may upload its local values; once another device has stored settings the same pull has no empty member and carries the person's changes, which the client merges with its own.",
        pin,
        world,
        token,
      );
      const empty = await pullStep(r, 0, "Nothing in the cloud yet.");
      expect(empty.body?.empty).toBe(true);
      await otherDevicePushes(world, subject, [set("ui.theme", "light")]);
      const full = await pullStep(r, 0, "Another device has stored a value.");
      expect(full.body?.empty).toBeUndefined();
      expect(full.body?.changes.length).toBe(1);
      return r.transcript();
    }),
};

const OPEN_CATALOG = {
  schemaVersion: 1,
  entries: [
    entry("audio.volume", { type: "number", minimum: 0, maximum: 1 }),
    entry("local.cache", { type: "string" }, { user: { sync: "local" } }),
    entry("api.token", { type: "string" }, { kind: "secret" }),
  ],
};

export const cloudSyncOpenSettings: Scenario = {
  id: "cloudsync-open-settings",
  record: () =>
    pinned("cloudsync-open-settings", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld({ catalog: OPEN_CATALOG });
      const r = recorder(
        "cloudsync-open-settings",
        "A key the catalog does not declare is an open setting (§13.1): user scope, last write wins, a JSON value of at most 8192 canonical bytes. The same push shows its limits: a larger value is value_invalid, platform scope and member operations are refused, and a key the catalog declares local-only or secret is setting_not_synced.",
        pin,
        world,
        token,
      );
      const res = await pushStep(
        r,
        [
          set("open.setting", { n: 1 }),
          set("open.edge", "x".repeat(8190)),
          set("open.big", "x".repeat(8191)),
          mutation("open.platform", "set", {
            value: 1,
            target: { setting: "open.platform", scope: "platform" },
          }),
          mutation("open.members", "setMember", { member: "a", value: 1 }),
          set("local.cache", "x"),
          set("api.token", "x"),
          set("audio.volume", 0.5),
        ],
        "Open keys beside declared ones.",
      );
      expect(statuses(res.body)).toEqual([
        "ok",
        "ok",
        "rejected:value_invalid",
        "rejected:setting_not_synced",
        "rejected:op_invalid_for_policy",
        "rejected:setting_not_synced",
        "rejected:setting_not_synced",
        "ok",
      ]);
      return r.transcript();
    }),
};

export const cloudSyncTrust: Scenario = {
  id: "cloudsync-trust",
  record: () =>
    pinned("cloudsync-trust", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-trust",
        "The product's cloudSyncWrite trust policy (attested). Log-only, a push from an unattested device goes through and the Worker audits the would-be refusal; enforced, the same push is 403 attestation_required for the whole request and nothing is stored. A pull is never a trust operation.",
        pin,
        world,
        token,
      );
      const audits = () =>
        world.db.all<{ action: string }>(
          "SELECT action FROM audit WHERE action LIKE 'device.trust.%' ORDER BY action",
        );
      const policy = (enforce: boolean) =>
        world.db.run(
          "UPDATE products SET trust_policy_json = ? WHERE slug = ?",
          JSON.stringify({ cloudSyncWrite: "attested", enforce }),
          PRODUCT,
        );
      await policy(false);
      const logOnly = await pushStep(
        r,
        [set("ui.theme", "dark")],
        "Log-only: the push is applied.",
      );
      expect(statuses(logOnly.body)).toEqual(["ok"]);
      expect((await audits()).map((a) => a.action)).toEqual([
        "device.trust.would_refuse",
      ]);
      await policy(true);
      const enforced = await pushStep(
        r,
        [set("audio.volume", 0.5)],
        "Enforced: the unattested device is refused.",
        { cursor: logOnly.body!.cursor },
      );
      expect(enforced.status).toBe(403);
      expect(enforced.code).toBe("attestation_required");
      const read = await pullStep(r, 0, "Reads stay allowed.");
      expect(read.body?.changes.length).toBe(1);
      return r.transcript();
    }),
};

export const cloudSyncPaused: Scenario = {
  id: "cloudsync-paused",
  record: () =>
    pinned("cloudsync-paused", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      const r = recorder(
        "cloudsync-paused",
        "The operator's kill switch (§13.9). While writes are paused a push is 503 writes_paused with Retry-After (300 seconds), before the object is reached; the client keeps its journal and retries later. A pull is still served.",
        pin,
        world,
        token,
      );
      await world.db.run(
        `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
         VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'transcript')`,
        T0,
      );
      invalidatePlatformSettings(world.env, world.db);
      const paused = await pushStep(
        r,
        [set("ui.theme", "dark")],
        "Writes are paused.",
      );
      expect(paused.status).toBe(503);
      expect(paused.code).toBe("writes_paused");
      const read = await pullStep(r, 0, "The pull is served.");
      expect(read.body?.empty).toBe(true);
      return r.transcript();
    }),
};

export const cloudSyncCors: Scenario = {
  id: "cloudsync-cors",
  record: () =>
    pinned("cloudsync-cors", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld();
      await world.db.run(
        "UPDATE products SET web_origins_json = ? WHERE slug = ?",
        serializeWebOrigins([LISTED]),
        PRODUCT,
      );
      const r = recorder(
        "cloudsync-cors",
        "A browser app on a listed web origin may call the push (the browser's own preflight and request, so `browser` steps no SDK asserts). The preflight and the request from a listed origin are answered with access-control-allow-origin naming it and never allow-credentials; an unlisted origin gets no CORS headers at all. The bearer is the credential, so no cookie is involved.",
        pin,
        world,
        token,
      );
      const ACAO = [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-allow-credentials",
      ];
      const preflight = (origin: string) => async (s: StepRecorder) => {
        const res = await s.send({
          method: "OPTIONS",
          path: `/${PRODUCT}/sync/ops`,
          metadata: false,
          assertHeaders: {
            origin,
            "access-control-request-method": "POST",
          },
          recordHeaders: ACAO,
        });
        expect(res.status).toBe(204);
      };
      await r.step(
        { action: "browser", note: "Preflight from the listed origin." },
        preflight(LISTED),
        {},
      );
      await r.step(
        { action: "browser", note: "The push from the listed origin." },
        async (s) => {
          const res = await push(s, [set("ui.theme", "dark")], {
            assertHeaders: { origin: LISTED },
            recordHeaders: ACAO,
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("access-control-allow-origin")).toBe(LISTED);
        },
        {},
      );
      await r.step(
        { action: "browser", note: "Preflight from an unlisted origin." },
        async (s) => {
          const res = await s.send({
            method: "OPTIONS",
            path: `/${PRODUCT}/sync/ops`,
            metadata: false,
            assertHeaders: { origin: UNLISTED },
            recordHeaders: ACAO,
          });
          expect(res.headers.get("access-control-allow-origin")).toBeNull();
        },
        {},
      );
      await r.step(
        { action: "browser", note: "The push from an unlisted origin." },
        async (s) => {
          const res = await push(s, [set("audio.volume", 0.5)], {
            assertHeaders: { origin: UNLISTED },
            recordHeaders: ACAO,
          });
          expect(res.headers.get("access-control-allow-origin")).toBeNull();
        },
        {},
      );
      return r.transcript();
    }),
};

// ── End-to-end settings (U-09.1; WIRE-CONTRACT-V5 §13.3, §13.4, §13.10) ───────────────────────

/**
 * A shaped `pkey-sync-value/1` envelope: byte 0 = 1 and `(length - 49) mod 64 = 0`. The server
 * checks the shape and never decodes the rest, so a fixture needs no key.
 */
export const sealed = (fill: number, blocks = 1): string => {
  const bytes = new Uint8Array(49 + 64 * blocks).fill(fill);
  bytes[0] = 1;
  return Buffer.from(bytes).toString("base64url");
};
export const blinded = (c: string): string => `x:${c.repeat(43)}`;
const sealedSet = (setting: string, ct: string, extra = {}): SyncMutation =>
  mutation(setting, "set", { ct, ...extra });

export const cloudSyncE2eSettings: Scenario = {
  id: "cloudsync-e2e-settings",
  record: () =>
    pinned("cloudsync-e2e-settings", async (pin) => {
      mid = 0;
      const { world, token } = await syncWorld({ e2eGate: true });
      const r = recorder(
        "cloudsync-e2e-settings",
        "End-to-end settings (§13.10). The product is in E2E mode (the default): a push carries ct, a sealed envelope, in place of value, and the pull answers ct with encryption and encryptionSince. A value, or an open setting whose key is not blinded, is rejected encryption_mismatch. A max setting is a compare-and-swap register: a stale baseVersion is a conflict carrying the server's ct, and the client re-pushes the better value on the server's version.",
        pin,
        world,
        token,
      );
      const first = await pullStep(
        r,
        0,
        "An empty store names the sequence its first sealed row takes.",
      );
      expect(first.body?.encryption).toBe("e2e");
      expect(first.body?.encryptionSince).toBe(1);

      const theme = sealed(1);
      const best = sealed(2);
      const landed = await pushStep(
        r,
        [
          sealedSet("ui.theme", theme),
          sealedSet(blinded("A"), sealed(3, 2)),
          sealedSet("game.best", best, { baseVersion: "*" }),
        ],
        "A declared key, a blinded open key and a create-only max register, all sealed.",
      );
      expect(statuses(landed.body)).toEqual(["ok", "ok", "ok"]);

      const snap = await pullStep(r, 0, "The snapshot: ct in place of value.");
      expect(
        snap.body?.changes.every((c) => "ct" in c && !("value" in c)),
      ).toBe(true);

      const refusals = await pushStep(
        r,
        [
          set("ui.theme", "dark"),
          sealedSet("my.private.name", sealed(4)),
          sealedSet("ui.theme", "not-an-envelope"),
        ],
        "A value on an E2E product, an unblinded open key and a malformed envelope.",
        { cursor: landed.body!.cursor },
      );
      expect(statuses(refusals.body)).toEqual([
        "rejected:encryption_mismatch",
        "rejected:encryption_mismatch",
        "rejected:value_invalid",
      ]);

      const stale = await pushStep(
        r,
        [sealedSet("game.best", sealed(5), { baseVersion: 3 })],
        "A max write on the current baseVersion lands.",
        { cursor: refusals.body!.cursor },
      );
      expect(statuses(stale.body)).toEqual(["ok"]);
      const conflict = await pushStep(
        r,
        [sealedSet("game.best", sealed(6), { baseVersion: 3 })],
        "The same baseVersion again is stale (another device wrote first): conflict, with the server's ct.",
        { cursor: stale.body!.cursor },
      );
      expect(statuses(conflict.body)).toEqual(["conflict"]);
      const copy = conflict.body!.results[0] as Extract<
        MutationResult,
        { status: "conflict" }
      >;
      expect(copy.server).toMatchObject({ ct: sealed(5), version: 4 });
      const merged = await pushStep(
        r,
        [sealedSet("game.best", sealed(7), { baseVersion: 4 })],
        "The client opened the copy, kept the better value and re-pushes on the server's version.",
        { cursor: conflict.body!.cursor },
      );
      expect(statuses(merged.body)).toEqual(["ok"]);
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
  cloudSyncAccountRequired,
  cloudSyncQuota,
  cloudSyncMigrations,
  cloudSyncFirstSignin,
  cloudSyncCors,
  cloudSyncOpenSettings,
  cloudSyncTrust,
  cloudSyncPaused,
  cloudSyncE2eSettings,
];
