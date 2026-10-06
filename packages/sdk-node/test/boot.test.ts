// @pkey-feature ui.stages update.bootguard
// SDK parity pass §3.4 and §3.15: client.boot() drives client-core's stage machine end to end,
// and the app boot guard counts unconfirmed launches and rolls back after MAX_FAILED_BOOTS.

import { describe, expect, it } from "vitest";
import { BOOT_STAGES, bootTransition } from "../src/index.js";
import { BootGuard } from "../src/update/bootguard.js";
import { UpdateJournal } from "../src/update/journal.js";
import {
  json,
  seededClient,
  signedLicense,
  tempDir,
} from "./parityFixtures.js";

function guardAt(
  dir: string,
  version: string,
  rollback?: (v: string) => Promise<boolean>,
) {
  const journal = new UpdateJournal({
    stateDir: dir,
    outlet: () => "direct",
    channel: () => "stable",
  });
  return {
    guard: new BootGuard(dir, version, journal, rollback ? { rollback } : {}),
    journal,
  };
}

describe("the stage machine is re-exported (ui.stages)", () => {
  it("BOOT_STAGES and bootTransition come from client-core", () => {
    expect(BOOT_STAGES[0]).toBe("idle");
    expect(typeof bootTransition).toBe("function");
  });
});

describe("app boot guard (§3.15)", () => {
  it("first launch is ok; an update is applied; confirm reports update_confirmed once", async () => {
    const dir = tempDir();
    expect((await guardAt(dir, "1.0.0").guard.markBootAttempt()).result).toBe(
      "ok",
    );
    await guardAt(dir, "1.0.0").guard.confirmBoot();
    const { guard, journal } = guardAt(dir, "1.1.0");
    const a = await guard.markBootAttempt();
    expect(a).toMatchObject({
      result: "applied",
      previous: "1.0.0",
      failedBoots: 1,
    });
    await guard.confirmBoot();
    await guard.confirmBoot();
    const events = await journal.all();
    expect(events.map((e) => [e.event, e.release, e.fromRelease])).toEqual([
      ["update_confirmed", "1.1.0", "1.0.0"],
    ]);
  });

  it("rolls back on the launch after MAX_FAILED_BOOTS unconfirmed ones, through the driver", async () => {
    const dir = tempDir();
    await guardAt(dir, "1.0.0").guard.markBootAttempt();
    await guardAt(dir, "1.0.0").guard.confirmBoot();
    const rolled: string[] = [];
    const rollback = async (v: string) => (rolled.push(v), true);
    expect(
      (await guardAt(dir, "1.1.0", rollback).guard.markBootAttempt()).result,
    ).toBe("applied");
    expect(
      (await guardAt(dir, "1.1.0", rollback).guard.markBootAttempt()).result,
    ).toBe("ok");
    const { guard, journal } = guardAt(dir, "1.1.0", rollback);
    const third = await guard.markBootAttempt();
    expect(third).toMatchObject({ result: "rolled-back", action: "roll-back" });
    expect(rolled).toEqual(["1.0.0"]);
    expect(await guard.skipVersion()).toBe("1.1.0");
    expect((await journal.all()).map((e) => e.event)).toEqual([
      "update_reverted",
      "boot_rolled_back",
    ]);
  });

  it("without a driver reports boot_rolled_back with code no-previous", async () => {
    const dir = tempDir();
    for (let i = 0; i < 2; i += 1)
      await guardAt(dir, "2.0.0").guard.markBootAttempt();
    const { guard, journal } = guardAt(dir, "2.0.0");
    expect(await guard.markBootAttempt()).toMatchObject({
      result: "rolled-back",
      reason: "no-previous",
    });
    expect(await journal.all()).toEqual([
      expect.objectContaining({
        event: "boot_rolled_back",
        code: "no-previous",
      }),
    ]);
  });

  it("a confirmed build is never rolled back for later crashes", async () => {
    const dir = tempDir();
    await guardAt(dir, "1.0.0").guard.markBootAttempt();
    await guardAt(dir, "1.0.0").guard.confirmBoot();
    for (let i = 0; i < 4; i += 1)
      expect((await guardAt(dir, "1.0.0").guard.markBootAttempt()).result).toBe(
        "ok",
      );
  });
});

describe("client.boot() (§3.4)", () => {
  const docs = (licence: string) => ({
    "GET /djdl/license/document": () => new Response(licence, { status: 200 }),
    "GET /djdl/config/document": () => new Response("", { status: 404 }),
    "POST /djdl/devices/report": () => json({}),
  });

  it("a licensed device boots to ready through every stage", async () => {
    const licence = await signedLicense({ pro: true });
    const { client } = await seededClient({
      license: licence,
      routes: docs(licence),
      extra: { expectedServices: ["license", "config"] as never },
    });
    const stages: string[] = [];
    const r = await client.boot({
      autoConfirm: false,
      onStage: (s) => {
        for (const e of s.emits)
          if (e.type === "stage_changed") stages.push(e.stage);
      },
    });
    expect(r.outcome).toBe("ready");
    expect(stages).toEqual([
      "shell",
      "guard",
      "sync",
      "gate",
      "decide",
      "fetch",
      "mount",
      "ready",
    ]);
    expect(r.emits.at(-1)).toEqual({ type: "boot_ready" });
    expect(r.guard?.result).toBe("ok");
  });

  it("no licence: registers on an open product, else ends waiting (never invents a prompt)", async () => {
    const licence = await signedLicense({});
    let registered = false;
    const { client, seen } = await seededClient({
      token: null,
      routes: {
        ...docs(licence),
        "GET /djdl/.well-known/polaris.json": () =>
          json({
            product: "djdl",
            core: { registration: "requires-license" },
            services: { license: { enabled: true }, config: { enabled: true } },
          }),
        "POST /djdl/license/enroll": () =>
          json({ error: "enroll_disabled" }, 404),
        "POST /djdl/devices/register": () => {
          registered = true;
          return json({ token: "pkeyt_r", deviceId: "x" });
        },
      },
    });
    const r = await client.boot();
    expect(r.outcome).toBe("waiting");
    expect(r.license.status).toBe("needs-activation");
    expect(registered).toBe(false); // requires-license: no keyless registration attempt
    expect(seen.map((s) => s.path)).toContain("/djdl/license/enroll");
  });

  it("ensureActivated enrols where the free tier exists", async () => {
    const licence = await signedLicense({ free: true });
    const { client } = await seededClient({
      token: null,
      routes: {
        ...docs(licence),
        "POST /djdl/license/enroll": () =>
          json({ token: "pkeyt_e", schemaVersion: 3 }),
      },
      extra: { expectedServices: ["license", "config"] as never },
    });
    const r = await client.ensureActivated();
    expect(r.via).toBe("enroll");
    expect(r.license.status).toBe("ok");
  });
});
