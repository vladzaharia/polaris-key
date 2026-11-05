// @pkey-feature sync.scenarios config.sync sync.e2e
// The Node conformance runner for `conformance/corpus/v2/sync-scenarios.json`: the Cloud Sync
// client state machine (`@polaris-key/client-core/cloud-sync`, plans/U-01.md §4.1 as amended by
// plans/U-01b.md §4, WIRE-CONTRACT-V4 §11.5). It covers React too, since both JS SDKs drive the
// same `client-core`, and `settingCases` against `@polaris-key/catalog`'s `syncedSettings`, the
// routing every JS host hands the machine.
//
// THE TEMPLATE FOR EVERY OTHER SDK'S RUNNER (U-06 Python, U-07 Swift and Kotlin, U-21 Godot).
// A runner needs only three seams in its SDK: a fake clock it can advance, a fake transport that
// records each request and answers it from the scenario's next `respond`, and a random source for
// `clientId`s that returns `init.clientIds` in order. Then, for each scenario:
//
//   1. build the client from `init` (catalog, document, clock, subject, network, options) with
//      an empty journal (`init.journal` is null in version 2), then, when `init.legacyLocal` is
//      not null, hand it to the one-time `config.local` import (`importLocal`);
//   2. run each step: `local` calls the SDK method named by `call` with `args` and, when the step
//      has `expect`, compares the call's result ({ok: true} or {ok: false, error}); `advance`
//      moves the fake clock by `ms`, firing every timer due on the way in time order; `network`
//      sets online or offline; `respond` answers the request in flight ({status, body} or
//      {error: "transport"}); `signIn`, `signOut` (with `discardUnsynced`) and `relaunch` (with
//      `journal: "lost"`) act on the device;
//   3. at each `assert`, drain the recorded requests and emitted events, and compare only the
//      views the assert lists: `values` and `records` (a subset, each {value, from}), `states`
//      (a subset of settingState), `journal` (the normalised journal, exactly), `requests` and
//      `events` (exactly, since the previous assert), `status` and `licence` (exactly; the
//      licence state is never touched by Cloud Sync).
//   4. for each `settingCases` entry, compare the SDK's port of `userSettingIssues` over
//      `entries` with `issues` (key, code, severity); when `routes` is not null (no error issue),
//      derive the routes with the port of `syncedSettings` and compare them exactly, and check
//      that every key in `open` has no route.
//
// Error codes are the canonical ones (`bad_request`, `managed_by_admin`). An SDK that ships a
// native code for the same refusal maps canonical to native in its runner (Godot's
// `invalid-options`), and `conformance/parity/errors.json` stays the arbiter.
//
// A runner never edits the file, skips a scenario or loosens a comparison (AGENTS.md rule 1).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  syncedSettings,
  userSettingIssues,
  type ConfigEntry,
} from "@polaris-key/catalog";
import {
  CloudSyncMachine,
  SYNC_DEBOUNCE_MS,
  SYNC_MAX_CLOCK_SKEW_MS,
  SYNC_MAX_MUTATIONS,
  SYNC_MAX_VALUE_BYTES,
  SYNC_PENDING_DAYS,
  SYNC_SIGNOUT_FLUSH_MS,
  relaunch,
  type CallResult,
  type CloudSyncOptions,
  type Json,
  type MergeChoiceName,
  type OpenedBody,
  type RecordFile,
  type RecordOutcome,
  type SyncResponse,
} from "@polaris-key/client-core/cloud-sync";

type Obj = Record<string, unknown>;

interface Scenario {
  name: string;
  description: string;
  rules: string[];
  wp: string;
  init: {
    catalog: CloudSyncOptions["catalog"];
    document: CloudSyncOptions["document"];
    journal: null;
    clock: { now: number; offsetMs: number; contacted: boolean };
    subject: string | null;
    network: "online" | "offline";
    licence: Obj;
    clientIds: string[];
    options: { onSignOut: "clear" | "keep" };
    legacyLocal: Record<string, Json> | null;
    encryption: "e2e" | "server";
    hasRoot: boolean;
  };
  steps: Obj[];
}

interface SettingCase {
  name: string;
  description: string;
  entries: ConfigEntry[];
  issues: { key: string; code: string; severity: string }[];
  routes: Obj[] | null;
  open: string[];
}

interface SyncScenarios {
  syncScenariosVersion: number;
  product: string;
  constants: Record<string, number>;
  steps: string[];
  calls: string[];
  asserts: string[];
  rules: { id: string }[];
  scenarios: Scenario[];
  settingCases: SettingCase[];
  /** Appended with the records binding of cloudSync.saves (plans/U-22.5.md). */
  fileRecordCases: {
    calls: string[];
    asserts: string[];
    scenarios: Scenario[];
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "sync-scenarios.json"),
    "utf8",
  ),
) as SyncScenarios;

function call(m: CloudSyncMachine, name: string, args: Json[]): CallResult {
  switch (name) {
    case "set":
      return m.set(args[0] as string, args[1] as Json);
    case "clear":
      return m.clear(args[0] as string);
    case "put":
      return m.put(args[0] as string, args[1] as string, args[2] as Json);
    case "add":
      return m.add(args[0] as string, args[1] as string, args[2] as Json);
    case "remove":
      return m.remove(args[0] as string, args[1] as string, args[2] as Json);
    case "putAt":
      return m.putAt(
        args[0] as string,
        args[1] as string,
        args[2] as Json,
        args[3] as number | "*",
        args[4] as RecordFile | undefined,
      );
    case "removeAt":
      return m.removeAt(
        args[0] as string,
        args[1] as string,
        args[2] as number | "*",
      );
    case "delete":
      return m.delete(args[0] as string, args[1] as string);
    case "flush":
      return m.flush();
    case "refresh":
      return m.refresh();
    default:
      throw new Error(`unknown call ${name}`);
  }
}

describe(`sync-scenarios v${corpus.syncScenariosVersion} (the Cloud Sync client state machine)`, () => {
  it(`runs on Node ${process.version}`, () => {
    expect(corpus.syncScenariosVersion).toBe(5);
    expect(corpus.constants).toEqual({
      debounceMs: SYNC_DEBOUNCE_MS,
      signOutFlushMs: SYNC_SIGNOUT_FLUSH_MS,
      pendingDays: SYNC_PENDING_DAYS,
      maxMutationsPerPush: SYNC_MAX_MUTATIONS,
      maxClockSkewMs: SYNC_MAX_CLOCK_SKEW_MS,
      maxValueBytes: SYNC_MAX_VALUE_BYTES,
    });
  });

  it("covers every rule it declares", () => {
    const covered = new Set(corpus.scenarios.flatMap((s) => s.rules));
    for (const r of corpus.rules) expect(covered.has(r.id), r.id).toBe(true);
  });

  it("declares the file-record family's calls and asserts", () => {
    expect(corpus.fileRecordCases.calls).toEqual(["putAt", "removeAt"]);
    expect(corpus.fileRecordCases.asserts).toEqual(["rows", "outcomes"]);
  });

  for (const sc of [...corpus.scenarios, ...corpus.fileRecordCases.scenarios]) {
    it(sc.name, () => {
      const ids = [...sc.init.clientIds];
      const opts: CloudSyncOptions = {
        product: corpus.product,
        catalog: sc.init.catalog,
        document: sc.init.document,
        now: sc.init.clock.now,
        offsetMs: sc.init.clock.offsetMs,
        contacted: sc.init.clock.contacted,
        subject: sc.init.subject,
        network: sc.init.network,
        onSignOut: sc.init.options.onSignOut,
        encryption: sc.init.encryption,
        hasRoot: sc.init.hasRoot,
        newClientId: () => {
          const id = ids.shift();
          if (id === undefined) throw new Error("init.clientIds exhausted");
          return id;
        },
      };
      const licence = structuredClone(sc.init.licence);
      let m = new CloudSyncMachine(opts);
      let outcomes: RecordOutcome[] = [];
      m.onOutcome((o) => outcomes.push(o));
      if (sc.init.legacyLocal !== null)
        expect(
          m.importLocal(sc.init.legacyLocal),
          `${sc.name}: import`,
        ).toEqual({ ok: true });
      for (const [i, step] of sc.steps.entries()) {
        const [kind, raw] = Object.entries(step)[0] as [string, Obj];
        const where = `${sc.name}, step ${i + 1} (${kind})`;
        switch (kind) {
          case "local": {
            const result = call(
              m,
              raw.call as string,
              (raw.args as Json[]) ?? [],
            );
            if (raw.expect !== undefined)
              expect(result, where).toEqual(raw.expect);
            break;
          }
          case "advance":
            m.advance(raw.ms as number);
            break;
          case "network":
            m.setNetwork(raw.state as "online" | "offline");
            break;
          case "respond":
            m.receive(
              raw.opened === undefined
                ? (raw as unknown as SyncResponse)
                : ({
                    status: raw.status,
                    body: raw.body,
                  } as unknown as SyncResponse),
              raw.opened as OpenedBody | undefined,
            );
            break;
          case "root":
            m.setRoot(raw.has === true);
            break;
          case "keep": {
            // Version 5: answer an open request. `expect` is given only for a refusal at once.
            const choice = raw.choice as MergeChoiceName | { value: Json };
            const result = m.keep(raw.request as string, choice);
            expect(result, where).toEqual(raw.expect ?? { ok: true });
            break;
          }
          case "signIn":
            m.signIn(raw.subject as string);
            break;
          case "signOut":
            m.signOut({ discardUnsynced: raw.discardUnsynced === true });
            break;
          case "relaunch":
            m = relaunch(m, opts, raw.journal === "lost" ? "lost" : "kept");
            m.onOutcome((o) => outcomes.push(o));
            break;
          case "assert": {
            const requests = m.takeRequests();
            const events = m.takeEvents();
            if (raw.requests !== undefined)
              expect(requests, `${where}: requests`).toEqual(raw.requests);
            if (raw.events !== undefined)
              expect(events, `${where}: events`).toEqual(raw.events);
            for (const [key, want] of Object.entries((raw.values as Obj) ?? {}))
              expect(m.get(key), `${where}: values.${key}`).toEqual(want);
            for (const [key, want] of Object.entries((raw.states as Obj) ?? {}))
              expect(m.settingState(key), `${where}: states.${key}`).toEqual(
                want,
              );
            for (const [key, want] of Object.entries(
              (raw.records as Obj) ?? {},
            )) {
              const [c = "", id = ""] = key.split("/");
              expect(m.record(c, id), `${where}: records.${key}`).toEqual(want);
            }
            const drained = outcomes;
            outcomes = [];
            if (raw.outcomes !== undefined)
              expect(drained, `${where}: outcomes`).toEqual(raw.outcomes);
            for (const [c, want] of Object.entries((raw.rows as Obj) ?? {}))
              expect(m.records(c), `${where}: rows.${c}`).toEqual(want);
            if (raw.journal !== undefined)
              expect(m.journal(), `${where}: journal`).toEqual(raw.journal);
            if (raw.status !== undefined)
              expect(m.status(), `${where}: status`).toEqual(raw.status);
            if (raw.encryptionSince !== undefined)
              expect(m.encryptionSince(), `${where}: encryptionSince`).toEqual(
                raw.encryptionSince,
              );
            if (raw.conflicts !== undefined)
              expect(m.conflicts(), `${where}: conflicts`).toEqual(
                raw.conflicts,
              );
            if (raw.cloudEmpty !== undefined)
              expect(m.cloudEmpty(), `${where}: cloudEmpty`).toEqual(
                raw.cloudEmpty,
              );
            if (raw.licence !== undefined)
              expect(licence, `${where}: licence`).toEqual(raw.licence);
            break;
          }
          default:
            throw new Error(`${where}: unknown step`);
        }
      }
    });
  }

  for (const c of corpus.settingCases)
    it(`settingCases: ${c.name}`, () => {
      const issues = c.entries.flatMap((e) =>
        userSettingIssues(e as unknown as Record<string, unknown>).map((i) => ({
          key: e.key,
          code: i.code,
          severity: i.severity,
        })),
      );
      expect(issues, `${c.name}: issues`).toEqual(c.issues);
      if (c.routes === null) {
        expect(issues.some((i) => i.severity === "error")).toBe(true);
        return;
      }
      const routes = syncedSettings({ entries: c.entries });
      expect(routes, `${c.name}: routes`).toEqual(c.routes);
      for (const key of c.open)
        expect(
          routes.some((r) => r.key === key),
          `${c.name}: ${key} is open`,
        ).toBe(false);
    });
});
