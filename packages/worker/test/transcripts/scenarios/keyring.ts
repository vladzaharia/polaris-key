/// <reference types="@cloudflare/workers-types" />
// The key ring conversations (U-36.4; WIRE-CONTRACT-V5 §13.11.2), recorded through the real
// router. The server stores values it cannot open, so every key, wrap and blob here is a fixture
// whose bytes come from a label (sha-256 of the label), not from a real key: the transcripts pin
// the routes, the shapes and the refusals, never any cryptography.
//
//   keyring-create          an empty ring, create it with the first wrap and a recovery blob, read
//                           it back with the caller's wrap, then a second create: `keyring_conflict`
//   keyring-wrap            wrap the root to another device of the same person, the create-only
//                           slot, a stranger, removing a wrap (only one's own)
//   keyring-wrap-read       the other device's side: it reads the ring and the wrap deposited for it
//   keyring-recovery        no blob yet, set one, fetch it (5 a day per device), then `429`
//   keyring-adopt-reset     reset ("start over"): a new ring, the old one `previous`, then adopt
//   keyring-sync-off        Cloud Sync off: the routes answer `404`
//   keyring-gate-off        the launch gate `launch.syncE2e` off: the routes answer `404`
//
// Every conversation is a signed-in, key-activated device that has registered its keys (the
// account, the device binding and the keys are seeded, as a completed sign-in leaves them).

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { JsonValue } from "../format.js";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { BASE_URL } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  emptyWorld,
  pinned,
  PRODUCT,
  seedLicense,
  servicesOn,
  setup,
  type Scenario,
} from "../world.js";
import type { Pinned } from "../determinism.js";
import { seedProduct } from "../../seed.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { seedAccount } from "./account.js";

const SYNC_ON = servicesOn("license", "config", "identity", "sync");
const FEATURES = ["sync.keyring"];
const REQUIRES = ["core.store"];

/** Another device of the same person, activated outside the recording. */
const OTHER = "TRANSCRIPTDEVICE0000000000000002";
/** A device of nobody: well formed, never registered. */
const STRANGER = "TRANSCRIPTDEVICE0000000000000009";

// ── Fixtures from labels ────────────────────────────────────────────────────────────────────────

const digest = (label: string): Buffer =>
  createHash("sha256").update(`pkey-transcript-keyring:${label}`).digest();
const stretch = (label: string, n: number): Buffer =>
  Buffer.concat(
    Array.from({ length: Math.ceil(n / 32) }, (_, i) =>
      digest(`${label}:${i}`),
    ),
  ).subarray(0, n);

const ringIdOf = (label: string): string =>
  `rg_${digest(label).toString("base64url").slice(0, 22)}`;
const kidOf = (label: string): string =>
  digest(label).toString("hex").slice(0, 32);
const wrapOf = (label: string) => ({
  kem: "x25519",
  enc: stretch(`enc:${label}`, 32).toString("base64url"),
  ct: stretch(`ct:${label}`, 48).toString("base64url"),
});
/** A sealed blob in the contract layout: 61 bytes, version 1. */
const blobOf = (label: string): string => {
  const b = stretch(`blob:${label}`, 61);
  b[0] = 1;
  return b.toString("base64url");
};

const RING = { ringId: ringIdOf("ring-1"), rootKid: kidOf("root-1") };
const RING2 = { ringId: ringIdOf("ring-2"), rootKid: kidOf("root-2") };

// ── The world ──────────────────────────────────────────────────────────────────────────────────

async function addDevice(
  world: World,
  deviceId: string,
  key: string,
  subject: string,
): Promise<string> {
  const res = await setup(world, "POST", `/${PRODUCT}/license/activate`, {
    authorization: `Bearer ${key}`,
    "x-pkey-device": deviceId,
  });
  expect(res.status).toBe(200);
  const token = ((await res.json()) as { token: string }).token;
  expect(
    await setDeviceSubject(world.env, world.db, PRODUCT, deviceId, subject),
  ).toBe(true);
  await upsertDeviceKeys(world.db, PRODUCT, deviceId, await newKeys(), T0);
  return token;
}

/** The recorded device (and, with `other`, a second one) signed in to one account. */
async function ringWorld(
  opts: { sync?: boolean; other?: boolean } = {},
): Promise<{ world: World; token: string; otherToken: string }> {
  const world = emptyWorld();
  await seedProduct(world.db, PRODUCT);
  await setServices(
    world.db,
    PRODUCT,
    serializeServices({
      services:
        opts.sync === false
          ? servicesOn("license", "config", "identity")
          : SYNC_ON,
    }),
    "manifest",
    T0,
  );
  const { key } = await seedLicense(world);
  const { subject } = await seedAccount(world, "ada@example.com");
  const token = await activated(world, key);
  expect(
    await setDeviceSubject(world.env, world.db, PRODUCT, DEVICE, subject),
  ).toBe(true);
  await upsertDeviceKeys(world.db, PRODUCT, DEVICE, await newKeys(), T0);
  const otherToken = opts.other
    ? await addDevice(world, OTHER, key, subject)
    : "";
  return { world, token, otherToken };
}

/** A request made outside the recording, as `token`'s device. */
async function api(
  world: World,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<number> {
  const res = await dispatchWith(
    new Request(`${BASE_URL}/${PRODUCT}/devices/keyring${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as unknown as Request,
    world.env,
    world.db,
    T0,
  );
  return res.status;
}

function recorder(
  id: string,
  description: string,
  pin: Pinned,
  world: World,
  token: string,
  deviceId = DEVICE,
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
    initial: { deviceId, token, version: VERSION },
  });
}

// ── The SDK calls ──────────────────────────────────────────────────────────────────────────────

type Action =
  | "keyringGet"
  | "keyringCreate"
  | "keyringWrap"
  | "keyringUnwrap"
  | "keyringRecoverySet"
  | "keyringRecoveryGet"
  | "keyringAdopt"
  | "keyringReset";

type Expect = Record<string, JsonValue>;

const WRAP_SHAPE = { kem: "", enc: "", ct: "" };
const RING_BODY = (recovery: boolean) => ({
  json: {
    ringId: "",
    rootKid: "",
    wrap: WRAP_SHAPE,
    ...(recovery ? { recovery: { ct: "" } } : {}),
  },
  match: "shape" as const,
  allowedKeys: ["ringId", "rootKid", "wrap", "recovery"],
});

interface Call {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  expectBody?: ReturnType<typeof RING_BODY>;
}

const ringSummary = (ring: Record<string, any> | null): JsonValue =>
  ring === null
    ? null
    : {
        ringId: ring.ringId,
        epoch: ring.epoch,
        rootKid: ring.rootKid,
        state: ring.state,
        recoverySet: ring.recovery.set,
        previous: ring.previous ? ring.previous.ringId : null,
        adopted: ring.adopted.map((a: { ringId: string }) => a.ringId),
      };

/** One ring step: the call, then `expect` read off the answer in the vocabulary of format.ts. */
async function ringStep(
  r: TranscriptRecorder,
  action: Action,
  note: string,
  c: Call,
  args: Record<string, JsonValue> = {},
): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: null as any };
  const exp: Expect = {};
  await r.step(
    { action, args, note },
    async (s: StepRecorder) => {
      const res = await s.send({
        method: c.method,
        path: `/${PRODUCT}/devices/keyring${c.path}`,
        bearer: "token",
        ...(c.body
          ? {
              body: c.body,
              expectBody: c.expectBody ?? {
                json: shapeOf(c.body),
                match: "shape",
                allowedKeys: Object.keys(c.body),
              },
            }
          : {}),
      });
      out.status = res.status;
      const text = await res.clone().text();
      out.body = text.startsWith("{") ? JSON.parse(text) : null;
      if (res.status >= 400) {
        Object.assign(exp, {
          result: "refused",
          status: res.status,
          code: out.body?.error?.code ?? out.body?.error ?? "not_found",
        });
        const retry = res.headers.get("retry-after");
        if (retry !== null) exp.retryAfter = Number(retry);
        return;
      }
      exp.result = "ok";
      const b = out.body;
      if (action === "keyringGet")
        Object.assign(exp, {
          ring: ringSummary(b.ring),
          wrap: b.wrap && {
            epoch: b.wrap.epoch,
            kid: b.wrap.kid,
            by: b.wrap.by,
          },
        });
      if (action === "keyringCreate" || action === "keyringReset")
        Object.assign(exp, { ringId: b.ringId, epoch: b.epoch });
      if (action === "keyringRecoveryGet") Object.assign(exp, { ct: b.ct });
    },
    exp,
  );
  return out;
}

/** The member types of `body`, for a `shape` match. */
function shapeOf(v: unknown): JsonValue {
  if (typeof v === "string") return "";
  if (typeof v === "number") return 0;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, shapeOf(x)]),
    );
  return v as JsonValue;
}

const get = (r: TranscriptRecorder, note: string) =>
  ringStep(r, "keyringGet", note, { method: "GET", path: "" });

const create = (
  r: TranscriptRecorder,
  note: string,
  ring = RING,
  label = "1",
  recovery = true,
) =>
  ringStep(r, "keyringCreate", note, {
    method: "POST",
    path: "",
    body: {
      ...ring,
      wrap: wrapOf(`create-${label}`),
      ...(recovery ? { recovery: { ct: blobOf(`recovery-${label}`) } } : {}),
    },
    expectBody: RING_BODY(recovery),
  });

const wrapTo = (
  r: TranscriptRecorder,
  note: string,
  target: string,
  tag = "b",
) =>
  ringStep(
    r,
    "keyringWrap",
    note,
    {
      method: "PUT",
      path: `/wraps/${target}`,
      body: { epoch: 1, kid: RING.rootKid, ...wrapOf(`wrap-${tag}`) },
    },
    { deviceId: target },
  );

const unwrap = (r: TranscriptRecorder, note: string, target: string) =>
  ringStep(
    r,
    "keyringUnwrap",
    note,
    { method: "DELETE", path: `/wraps/${target}` },
    { deviceId: target },
  );

// ── The scenarios ──────────────────────────────────────────────────────────────────────────────

export const keyringCreate: Scenario = {
  id: "keyring-create",
  record: () =>
    pinned("keyring-create", async (pin) => {
      const { world, token } = await ringWorld();
      const r = recorder(
        "keyring-create",
        "Creating the key ring (WIRE-CONTRACT-V5 §13.11.2). A signed-in device with keys reads an empty ring, creates the ring with its own wrap and a sealed recovery blob (201, epoch 1), and reads it back: the ring and the caller's wrap, with the device that deposited it. A second create is 409 keyring_conflict and changes nothing. Every key, wrap and blob is an opaque fixture: the server never opens one.",
        pin,
        world,
        token,
      );
      expect((await get(r, "No ring yet.")).body).toEqual({
        ring: null,
        wrap: null,
      });
      expect(
        (await create(r, "The first device creates the ring.")).status,
      ).toBe(201);
      const g = await get(r, "The ring, and this device's own wrap.");
      expect(g.body.wrap.by).toBe(DEVICE);
      const again = await create(
        r,
        "A second ring is refused.",
        { ringId: ringIdOf("ring-x"), rootKid: kidOf("root-x") },
        "x",
      );
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("keyring_conflict");
      return r.transcript();
    }),
};

export const keyringWrap: Scenario = {
  id: "keyring-wrap",
  record: () =>
    pinned("keyring-wrap", async (pin) => {
      const { world, token } = await ringWorld({ other: true });
      const r = recorder(
        "keyring-wrap",
        "Wrapping the root to another device of the same person (WIRE-CONTRACT-V5 §13.11.2). The device that holds the root stores a wrap for the other device: 204. The slot is create-only, so a second wrap for the same device is 409 keyring_conflict. A device of nobody is 404 not_found, whatever its id. A device removes only its own wrap: another's is 403 forbidden; its own is 204 and its ring read then carries no wrap. The wrap is an opaque fixture.",
        pin,
        world,
        token,
      );
      await create(r, "The ring, with this device's wrap.");
      expect(
        (await wrapTo(r, "A wrap for the other device.", OTHER)).status,
      ).toBe(204);
      const dup = await wrapTo(r, "The slot is create-only.", OTHER, "c");
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("keyring_conflict");
      expect(
        (await wrapTo(r, "A device that is nobody's.", STRANGER)).status,
      ).toBe(404);
      expect(
        (
          await unwrap(
            r,
            "Another device's wrap is not this device's to remove.",
            OTHER,
          )
        ).status,
      ).toBe(403);
      expect((await unwrap(r, "Its own wrap goes.", DEVICE)).status).toBe(204);
      expect(
        (await get(r, "The ring remains; this device holds no wrap.")).body
          .wrap,
      ).toBeNull();
      return r.transcript();
    }),
};

export const keyringWrapRead: Scenario = {
  id: "keyring-wrap-read",
  record: () =>
    pinned("keyring-wrap-read", async (pin) => {
      const { world, token, otherToken } = await ringWorld({ other: true });
      // Setup, not recorded: the first device (OTHER) made the ring and wrapped the root to the
      // recorded client (DEVICE), as a nearby approval leaves it.
      expect(
        await api(world, otherToken, "POST", "", {
          ...RING,
          wrap: wrapOf("create-1"),
          recovery: { ct: blobOf("recovery-1") },
        }),
      ).toBe(201);
      expect(
        await api(world, otherToken, "PUT", `/wraps/${DEVICE}`, {
          epoch: 1,
          kid: RING.rootKid,
          ...wrapOf("wrap-b"),
        }),
      ).toBe(204);
      const r = recorder(
        "keyring-wrap-read",
        "The receiving device's side of a wrap (WIRE-CONTRACT-V5 §13.11.2). Another device of the same person made the ring and stored a wrap for this one. This device reads the ring and gets the wrap addressed to it, with the device that deposited it (by); a wrap is served only to its own device.",
        pin,
        world,
        token,
      );
      const g = await get(r, "The ring and this device's wrap.");
      expect(g.body.wrap.by).toBe(OTHER);
      return r.transcript();
    }),
};

export const keyringRecovery: Scenario = {
  id: "keyring-recovery",
  record: () =>
    pinned("keyring-recovery", async (pin) => {
      const { world, token } = await ringWorld();
      const r = recorder(
        "keyring-recovery",
        "The recovery blob (WIRE-CONTRACT-V5 §13.11.2). A ring made without one answers the fetch 404 not_found. The device that holds the root sets a sealed 61-byte blob (204; the epoch and kid are the ring's), and a fetch returns it: 200 with ct, only to a signed-in device of the account. A device may fetch 5 times a day, counting the 404: the sixth is 429 rate_limited with Retry-After. Each fetch is audited and emailed to the account. The blob is an opaque fixture: the server never sees the code that seals it.",
        pin,
        world,
        token,
      );
      await create(r, "A ring with no recovery blob.", RING, "1", false);
      const none = await ringStep(
        r,
        "keyringRecoveryGet",
        "Nothing to fetch yet.",
        {
          method: "GET",
          path: "/recovery",
        },
      );
      expect(none.status).toBe(404);
      const set = await ringStep(r, "keyringRecoverySet", "Set the blob.", {
        method: "PUT",
        path: "/recovery",
        body: { ct: blobOf("recovery-1"), epoch: 1, kid: RING.rootKid },
      });
      expect(set.status).toBe(204);
      for (let i = 2; i <= 4; i++) {
        const ok = await ringStep(r, "keyringRecoveryGet", `Fetch ${i} of 5.`, {
          method: "GET",
          path: "/recovery",
        });
        expect(ok.body.ct).toBe(blobOf("recovery-1"));
      }
      const fifth = await ringStep(r, "keyringRecoveryGet", "Fetch 5 of 5.", {
        method: "GET",
        path: "/recovery",
      });
      expect(fifth.status).toBe(200);
      const limited = await ringStep(
        r,
        "keyringRecoveryGet",
        "The sixth in a day.",
        {
          method: "GET",
          path: "/recovery",
        },
      );
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("rate_limited");
      return r.transcript();
    }),
};

export const keyringAdoptReset: Scenario = {
  id: "keyring-adopt-reset",
  record: () =>
    pinned("keyring-adopt-reset", async (pin) => {
      const { world, token } = await ringWorld();
      const r = recorder(
        "keyring-adopt-reset",
        "Start over, then adopt (WIRE-CONTRACT-V5 §13.11.2). A device with keys resets the ring: a new ring id and root, the caller's wrap and a sealed recovery blob; 201, epoch 1. The old ring is kept as previous for 30 days. The device then seals the previous root under the new one and adopts it: 204, once per root; the ring read lists it under adopted. A root the server does not name is 409 keyring_conflict. Reset needs a ring to replace and a new id: the same id is 409 as well.",
        pin,
        world,
        token,
      );
      await create(r, "The first ring.");
      const reset = await ringStep(r, "keyringReset", "Start over.", {
        method: "POST",
        path: "/reset",
        body: {
          ...RING2,
          wrap: wrapOf("create-2"),
          recovery: { ct: blobOf("recovery-2") },
        },
        expectBody: RING_BODY(true),
      });
      expect(reset.status).toBe(201);
      const adoptBody = (fromRingId: string, kid: string) => ({
        fromRingId,
        epoch: 1,
        kid,
        ct: blobOf("adopt-1"),
      });
      expect(
        (
          await ringStep(
            r,
            "keyringAdopt",
            "Seal the previous root under the new one.",
            {
              method: "POST",
              path: "/adopt",
              body: adoptBody(RING.ringId, RING.rootKid),
            },
          )
        ).status,
      ).toBe(204);
      const unknown = await ringStep(
        r,
        "keyringAdopt",
        "A root the server does not name.",
        {
          method: "POST",
          path: "/adopt",
          body: adoptBody(ringIdOf("ring-x"), kidOf("root-x")),
        },
      );
      expect(unknown.status).toBe(409);
      const g = await get(r, "The new ring: previous and adopted.");
      expect(g.body.ring.previous.ringId).toBe(RING.ringId);
      expect(g.body.ring.adopted).toHaveLength(1);
      const same = await ringStep(
        r,
        "keyringReset",
        "Resetting to the current id is refused.",
        {
          method: "POST",
          path: "/reset",
          body: {
            ...RING2,
            wrap: wrapOf("create-2"),
            recovery: { ct: blobOf("recovery-2") },
          },
          expectBody: RING_BODY(true),
        },
      );
      expect(same.status).toBe(409);
      return r.transcript();
    }),
};

export const keyringSyncOff: Scenario = {
  id: "keyring-sync-off",
  record: () =>
    pinned("keyring-sync-off", async (pin) => {
      const { world, token } = await ringWorld({ sync: false });
      const r = recorder(
        "keyring-sync-off",
        "Cloud Sync off (WIRE-CONTRACT-V5 §13.11.2). The key ring exists only for a product whose Cloud Sync is on: every route answers 404, as for any route that does not exist, whoever asks and whatever the body.",
        pin,
        world,
        token,
      );
      expect((await get(r, "No ring routes.")).status).toBe(404);
      expect((await create(r, "Create is 404 too.")).status).toBe(404);
      expect(
        (
          await ringStep(r, "keyringRecoveryGet", "As is the recovery fetch.", {
            method: "GET",
            path: "/recovery",
          })
        ).status,
      ).toBe(404);
      return r.transcript();
    }),
};

export const keyringGateOff: Scenario = {
  id: "keyring-gate-off",
  record: () =>
    pinned("keyring-gate-off", async (pin) => {
      const { world, token } = await ringWorld();
      // The operator's launch gate (launch.syncE2e) is off: the routes do not exist.
      (world.env as unknown as Record<string, string>).LAUNCH_SYNC_E2E = "off";
      const r = recorder(
        "keyring-gate-off",
        "The launch gate off (launch.syncE2e). With the operator's gate off the key ring routes do not exist, whatever the product has enabled: 404 on every one, before any credential is read.",
        pin,
        world,
        token,
      );
      expect((await get(r, "The gate is off.")).status).toBe(404);
      expect((await create(r, "Create is 404 too.")).status).toBe(404);
      return r.transcript();
    }),
};

export const KEYRING_SCENARIOS: Scenario[] = [
  keyringCreate,
  keyringWrap,
  keyringWrapRead,
  keyringRecovery,
  keyringAdoptReset,
  keyringSyncOff,
  keyringGateOff,
];
