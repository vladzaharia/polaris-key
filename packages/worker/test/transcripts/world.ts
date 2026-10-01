/// <reference types="@cloudflare/workers-types" />
// Seeding for the transcript scenarios: one in-memory Worker world per scenario, built from the
// same helpers the rest of the Worker suite uses (makeTestDb, KvMock, the real RateLimitDO
// behind rlMock, seedProduct with the committed corpus signing key).

import type { ManagedEntry } from "@polaris-key/protocol";
import { dispatchWith } from "../../src/dispatch.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { setServices } from "../../src/repo.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, seedLicenseWithKey, seedProduct, seedTier } from "../seed.js";
import { pinEnvironment, type Pinned } from "./determinism.js";
import type { Transcript } from "./format.js";
import { BASE_URL, type World } from "./recorder.js";
import { DEVICE, T0, VERSION } from "./client.js";

export const PRODUCT = "djdl";

export const LICENSED: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

/** D-08: Config alone, so the derived registration policy is `open`. */
export const CONFIG_ONLY: ServicesMap = {
  license: { enabled: false },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

export const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: T0,
});

export interface Scenario {
  id: string;
  record(): Promise<Transcript>;
}

/** Run `body` with the clock frozen at `T0` and randomness seeded by the scenario id, always
 *  restoring both — a failed scenario must not leak a frozen clock into the next test. */
export async function pinned<T>(
  id: string,
  body: (p: Pinned) => Promise<T>,
): Promise<T> {
  const p = pinEnvironment(id, T0);
  try {
    return await body(p);
  } finally {
    p.restore();
  }
}

/** An empty world: migrations applied, no product. */
export function emptyWorld(): World {
  const db = makeTestDb();
  const kv = new KvMock();
  return { db, kv, env: makeEnv(kv, [PRODUCT]) };
}

/**
 * The transcripts' catalog: one config key, declared WITHOUT a catalog default.
 *
 * Not the real djdl catalog, deliberately. The Worker stamps every catalog DEFAULT with the
 * request time (`catalogDefaultPayload` in core/payload.ts sets `updatedAt: now`), and the config
 * document's ETag hashes those entries, so for a catalog that declares any default the config
 * ETag changes every second and the document never answers 304. That is a Worker defect, not
 * the contract (P1b-03 reports it); recording it here would pin a config document that cannot be
 * conditionally fetched. Values delivered by licence overrides carry a stable `updatedAt`.
 */
export const TRANSCRIPT_CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "ui.theme",
      kind: "config",
      category: "Interface",
      label: "Theme",
      description: "Dashboard color theme.",
      accessor: "ui.theme",
      schema: { type: "string", enum: ["dark", "light"] },
      ui: { widget: "select" },
    },
  ],
};

/** The `djdl` product with the transcript catalog and the given services. */
export async function productWorld(services: ServicesMap): Promise<World> {
  const w = emptyWorld();
  await seedProduct(w.db, PRODUCT, { catalog: TRANSCRIPT_CATALOG });
  await setServices(
    w.db,
    PRODUCT,
    serializeServices({ services }),
    "manifest",
    T0,
  );
  return w;
}

/** A licence with one entitlement and one enforced config value; returns its key. */
export async function seedLicense(
  w: World,
): Promise<{ licenseId: string; key: string }> {
  return seedLicenseWithKey(w.db, PRODUCT, {
    entitlements: { polarisVpn: enforced(true) },
    config: { "ui.theme": enforced("dark") },
  });
}

/** Offer keyless enrolment on a free tier (anonymous, fingerprint-deduped). */
export async function offerEnrollment(w: World): Promise<void> {
  await seedTier(w.db, PRODUCT, "free", { deviceLimit: 2 });
  await w.db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    JSON.stringify({
      enabled: true,
      tierId: "free",
      mode: "anonymous",
      rateLimitPerHour: 10,
    }),
    PRODUCT,
  );
}

/** A request made OUTSIDE the recording (scenario setup), through the same router. */
export async function setup(
  w: World,
  method: string,
  path: string,
  headers: Record<string, string>,
  now: number = T0,
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE_URL}${path}`, {
      method,
      headers: {
        "x-pkey-device": DEVICE,
        "x-pkey-version": VERSION,
        ...headers,
      },
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );
}

/** Setup: activate `key` for DEVICE and return the device token. */
export async function activated(w: World, key: string): Promise<string> {
  const res = await setup(w, "POST", `/${PRODUCT}/license/activate`, {
    authorization: `Bearer ${key}`,
  });
  if (res.status !== 200) throw new Error(`setup activate: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/** Setup: register DEVICE keylessly and return the device token. */
export async function registered(w: World): Promise<string> {
  const res = await setup(w, "POST", `/${PRODUCT}/devices/register`, {});
  if (res.status !== 200) throw new Error(`setup register: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}
