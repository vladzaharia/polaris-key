/**
 * A-18h — the report-back of CI-plane store steps (`services/distribution/storeSteps.ts`) through
 * P2-06's ingest (`POST /<p>/distribution/report`, `type: "store-step"`), and the CI listing read
 * (`GET /<p>/distribution/listing/<store>`). A reported step writes a `store_operations` row with
 * `plane = 'ci'`; the Worker re-checks the command against the store's allow-list and the outlet
 * identity; msstore's publish is refused while the ledger shows a Worker-staged draft.
 *
 * The `pkeyci_` lookup (`lookupCiToken` in `core/publisher.ts`) is mocked, as in the availability suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../../src/core/publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/publisher.js")>()),
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { makeTestDb } from "../helpers.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import {
  auditRows,
  call,
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "../releaseRoutesFixture.js";
import { NOW } from "../seed.js";
import { listStoreOperations } from "../../src/core/storefront/ledger.js";
import {
  ciStepNaturalKey,
  ciStepOp,
} from "../../src/services/distribution/storeSteps.js";

const REPORTER = "pkeyci_reporter";
const ROLLER = "pkeyci_roller";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(REPORTER, {
    product: SLUG,
    subject: "repo:acme/djdl:environment:release",
    scopes: ["release:publish", "distribution:report"],
  });
  tokens.set(ROLLER, {
    product: SLUG,
    subject: "static:tok_1",
    scopes: ["distribution:rollout"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

interface World {
  env: Env;
  db: Db;
  gh: ReturnType<typeof github>;
}

async function addOutlet(
  w: World,
  id: string,
  kind: string,
  identity: Record<string, unknown>,
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, removed_at, created_at, modified_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

async function setup(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  const w = { env, db, gh };
  await addOutlet(w, "itch", "itch", { target: "acme/djdl", gameId: "1001" });
  await addOutlet(w, "snap", "snap", {
    name: "djdl",
    channels: { stable: "stable", beta: "beta" },
  });
  await addOutlet(w, "ms-store", "ms-store", { productId: "9NBLGGH4R315" });
  await addOutlet(w, "play", "play", { packageName: "gg.acme.djdl" });
  return w;
}

function report(
  w: World,
  body: unknown,
  token: string = REPORTER,
): Promise<Response> {
  return call(
    w.env,
    w.db,
    w.gh.fetchImpl,
    `${CONSOLE}/${SLUG}/distribution/report`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );
}

const PUSH_ARGV = [
  "push",
  "build/windows",
  "acme/djdl:windows",
  "--userversion",
  "1.1.0",
];

const push = (over: Record<string, unknown> = {}) => ({
  type: "store-step",
  store: "itch",
  op: "uploadBuild",
  command: "push",
  argv: PUSH_ARGV,
  outlet: "itch",
  runId: "gh-12345-1",
  state: "pending",
  ...over,
});

describe("store-step report-back (A-18h)", () => {
  it("a pending then done report writes one store_operations row with plane = 'ci'", async () => {
    const w = await setup();
    const r1 = await report(w, push());
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { step: Record<string, unknown> };
    expect(b1.step).toMatchObject({
      store: "itch",
      op: "uploadBuild",
      command: "push",
      state: "pending",
      plane: "ci",
      replayed: false,
    });
    const r2 = await report(
      w,
      push({
        state: "done",
        exitCode: 0,
        runUrl: "https://github.com/acme/djdl/actions/runs/12345",
      }),
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { step: Record<string, unknown> };
    expect(b2.step).toMatchObject({ state: "done", opId: b1.step.opId });

    const rows = await listStoreOperations(w.db, {
      scope: "product",
      product: SLUG,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      store: "itch",
      scope: "product",
      product: SLUG,
      plane: "ci",
      state: "done",
      op: ciStepOp("push"),
      natural_key: ciStepNaturalKey("push", PUSH_ARGV),
      actor: "ci:repo:acme/djdl:environment:release",
    });
    expect(JSON.parse(row.after_json!)).toEqual({
      type: "ci-step",
      id: "push",
      attributes: {
        tool: "butler",
        command: "push",
        argv: PUSH_ARGV,
        exitCode: 0,
        runUrl: "https://github.com/acme/djdl/actions/runs/12345",
      },
    });
    const audit = await auditRows(w.db);
    expect(audit.map((a) => a.action)).toEqual([
      "distribution.itch.ci.push",
      "distribution.itch.ci.push",
    ]);
    expect(audit.every((a) => a.target_id === row.op_id)).toBe(true);
  });

  it("a pending report of a step already done in the run is replayed, so CI skips the tool", async () => {
    const w = await setup();
    await report(w, push({ state: "done", exitCode: 0 }));
    const again = await report(w, push());
    expect(((await again.json()) as { step: unknown }).step).toMatchObject({
      state: "done",
      replayed: true,
    });
    // Another run is another step.
    const next = await report(w, push({ runId: "gh-12345-2" }));
    expect(((await next.json()) as { step: unknown }).step).toMatchObject({
      state: "pending",
      replayed: false,
    });
    expect(
      await listStoreOperations(w.db, { scope: "product", product: SLUG }),
    ).toHaveLength(2);
  });

  it("a failed step keeps its exit code and command line", async () => {
    const w = await setup();
    await report(w, push());
    const r = await report(w, push({ state: "failed", exitCode: 1 }));
    expect(r.status).toBe(200);
    const [row] = await listStoreOperations(w.db, {
      scope: "product",
      product: SLUG,
    });
    expect(row).toMatchObject({
      state: "failed",
      vendor_status: 1,
      vendor_code: "exit_code",
      plane: "ci",
    });
    expect(JSON.parse(row!.after_json!).attributes.argv).toEqual(PUSH_ARGV);
  });

  it("snap upload is admitted only to channels the outlet identity declares", async () => {
    const w = await setup();
    const snap = (release: string) => ({
      type: "store-step",
      store: "snap",
      op: "uploadBuild",
      command: "upload",
      argv: ["upload", "dist/djdl_1.1.0_amd64.snap", `--release=${release}`],
      outlet: "snap",
      runId: "gh-777-1",
      state: "pending",
    });
    expect((await report(w, snap("beta,stable"))).status).toBe(200);
    const refused = await report(w, snap("edge"));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      reason: "command_not_allowed",
    });
  });

  it.each([
    ["an unknown store", { store: "play" }, 422, "invalid_body"],
    [
      "a command outside the allow-list",
      { command: "login" },
      422,
      "command_not_allowed",
    ],
    [
      "an argv the template refuses",
      { argv: ["push", "build", "acme/djdl:windows"] },
      422,
      "command_not_allowed",
    ],
    [
      "another game's target",
      { argv: ["push", "build", "evil/game:windows", "--userversion", "1"] },
      422,
      "command_not_allowed",
    ],
    [
      "an op the adapter does not run the command for",
      { op: "submit" },
      422,
      "command_not_allowed",
    ],
    [
      "no outlet for an identity-bound command",
      { outlet: undefined },
      422,
      "invalid_body",
    ],
    ["an outlet of another store", { outlet: "play" }, 422, "invalid_body"],
    ["an undeclared outlet", { outlet: "nope" }, 404, "unknown_outlet"],
    ["a bad runId", { runId: "x" }, 422, "invalid_body"],
    ["an unknown state", { state: "running" }, 422, "invalid_state"],
    [
      "a failed step with exit 0",
      { state: "failed", exitCode: 0 },
      422,
      "invalid_body",
    ],
    ["an http run URL", { runUrl: "http://x.test/run" }, 422, "invalid_body"],
    ["a release field", { releaseId: "v1.1.0" }, 422, "invalid_body"],
  ])("refuses %s and writes nothing", async (_n, over, status, reason) => {
    const w = await setup();
    const r = await report(w, push(over as Record<string, unknown>));
    expect(r.status).toBe(status);
    expect(await r.json()).toMatchObject({ reason });
    expect(
      await listStoreOperations(w.db, { scope: "product", product: SLUG }),
    ).toEqual([]);
  });

  it("needs distribution:report", async () => {
    const w = await setup();
    const r = await report(w, push(), ROLLER);
    expect(r.status).toBe(403);
  });

  it("refuses msstore publish while the ledger shows a Worker-staged draft, until it is committed", async () => {
    const w = await setup();
    const publish = (runId: string) => ({
      type: "store-step",
      store: "msstore",
      op: "uploadBuild",
      command: "publish",
      argv: ["publish", "build/Djdl.msixupload", "--appId", "9NBLGGH4R315"],
      outlet: "ms-store",
      runId,
      state: "pending",
    });
    const worker = async (op: string, state: string, at: number) =>
      w.db.run(
        `INSERT INTO store_operations
           (op_id, store, scope, product, op, natural_key, state, request_hash, actor, created_at, plane)
         VALUES (?, 'microsoft-store', 'product', ?, ?, 'sub-1', ?, 'h', 'u1', ?, 'worker')`,
        `${op}-${at}`,
        SLUG,
        op,
        state,
        at,
      );
    expect((await report(w, publish("gh-100001-1"))).status).toBe(200);
    await worker("submission.create", "done", NOW - 100);
    const blocked = await report(w, publish("gh-100002-1"));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      reason: "worker_draft_staged",
    });
    // A failed create stages nothing; a committed draft releases the guard.
    await worker("submission.commit", "done", NOW - 50);
    expect((await report(w, publish("gh-100003-1"))).status).toBe(200);
    await worker("submission.create", "ambiguous", NOW - 10);
    expect((await report(w, publish("gh-100004-1"))).status).toBe(409);
    // An outcome reported with no pending report first opens a row, so the guard applies.
    const straight = await report(w, {
      ...publish("gh-100005-1"),
      state: "done",
      exitCode: 0,
    });
    expect(straight.status).toBe(409);
    expect(await straight.json()).toMatchObject({
      reason: "worker_draft_staged",
    });
    // A step that passed the guard at pending still reports its outcome.
    expect(
      (
        await report(w, {
          ...publish("gh-100003-1"),
          state: "done",
          exitCode: 0,
        })
      ).status,
    ).toBe(200);
  });

  it("records an Epic BuildPatchTool step with no outlet (no outlet kind, decision 8)", async () => {
    const w = await setup();
    const r = await report(w, {
      type: "store-step",
      store: "epic",
      op: "uploadBuild",
      command: "upload-binary",
      argv: [
        "-mode=UploadBinary",
        "-OrganizationId=o-1",
        "-ProductId=p-1",
        "-ArtifactId=a-1",
        "-ClientId=c-1",
        "-ClientSecretEnvVar=BPT_SECRET",
        "-BuildRoot=build/windows",
        "-CloudDir=build/cloud",
        "-BuildVersion=1.1.0-win",
        "-AppLaunch=Djdl.exe",
        "-AppArgs=",
      ],
      runId: "gh-100009-1",
      state: "done",
      exitCode: 0,
    });
    expect(r.status).toBe(200);
    const [row] = await listStoreOperations(w.db, {
      scope: "product",
      product: SLUG,
    });
    expect(row).toMatchObject({ store: "epic", plane: "ci", state: "done" });
  });
});

describe("the CI listing read (A-18h)", () => {
  const get = (w: World, store: string, token = REPORTER) =>
    call(
      w.env,
      w.db,
      w.gh.fetchImpl,
      `${CONSOLE}/${SLUG}/distribution/listing/${store}`,
      { headers: { authorization: `Bearer ${token}` } },
    );

  it("answers the Snap projection of the listing model", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_listings (product, default_locale, source, created_at, modified_at, modified_by)
       VALUES (?, 'en-US', 'admin', ?, ?, 'u1')`,
      SLUG,
      NOW,
      NOW,
    );
    await w.db.run(
      `INSERT INTO dist_listing_locales
         (product, locale, name, short_description, description, source, modified_at, modified_by)
       VALUES (?, 'en-US', 'DJDL', 'Download your mixes', 'A long description.', 'admin', ?, 'u1')`,
      SLUG,
      NOW,
    );
    const r = await get(w, "snap");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { listing: Record<string, unknown> };
    expect(body.listing).toMatchObject({
      store: "snap",
      exists: true,
      defaultLocale: "en-US",
      payload: {
        locales: {
          "en-US": {
            title: "DJDL",
            summary: "Download your mixes",
            description: "A long description.",
          },
        },
      },
    });
  });

  it("blocks the payload of an empty listing and names the missing fields", async () => {
    const w = await setup();
    const body = (await (await get(w, "snap")).json()) as {
      listing: { exists: boolean; payload: unknown; status: string };
    };
    expect(body.listing).toMatchObject({
      exists: false,
      payload: null,
      status: "red",
    });
  });

  it("serves only a CI-plane listing store, and only to distribution:report", async () => {
    const w = await setup();
    expect((await get(w, "play")).status).toBe(404);
    expect((await get(w, "app-store")).status).toBe(404);
    expect((await get(w, "snap", ROLLER)).status).toBe(403);
  });
});
