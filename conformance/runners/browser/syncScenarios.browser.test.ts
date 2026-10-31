// @pkey-feature sync.scenarios config.sync sync.e2e
// The browser conformance runner for `conformance/corpus/v2/sync-scenarios.json` (SYNC-E2E.F.R,
// the React lane): the Cloud Sync client state machine (`@polaris-key/client-core/cloud-sync`)
// and `settingCases`, driven in a real engine by the same steps, asserts and comparisons as
// `../node/syncScenarios.test.ts`, which is its template. The machine is crypto-free (a scenario
// hands it each `opened` result), so the browser host's WebCrypto port is covered by
// `syncVectors.browser.test.ts`; this file pins that the browser build of the machine agrees
// with the corpus on every scenario, the e2e rows (`e2e-conflict-plaintext-copy-refused`
// included) with no skip list. A runner never edits the file, skips a scenario or loosens a
// comparison (AGENTS.md rule 1).

import { describe, expect, it } from "vitest";
import syncScenarios from "../../corpus/v2/sync-scenarios.json";
import {
  syncedSettings,
  userSettingIssues,
  type ConfigEntry,
} from "../../../packages/shared-catalog/src/index.js";
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
  type OpenedBody,
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
}

const corpus = syncScenarios as unknown as SyncScenarios;

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
    case "flush":
      return m.flush();
    case "refresh":
      return m.refresh();
    default:
      throw new Error(`unknown call ${name}`);
  }
}

describe(`sync-scenarios v${corpus.syncScenariosVersion} (the Cloud Sync client state machine)`, () => {
  it("runs in the browser", () => {
    expect(corpus.syncScenariosVersion).toBe(4);
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

  let ran = 0;
  for (const sc of corpus.scenarios) {
    it(sc.name, () => {
      ran += 1;
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
          case "signIn":
            m.signIn(raw.subject as string);
            break;
          case "signOut":
            m.signOut({ discardUnsynced: raw.discardUnsynced === true });
            break;
          case "relaunch":
            m = relaunch(m, opts, raw.journal === "lost" ? "lost" : "kept");
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
            if (raw.journal !== undefined)
              expect(m.journal(), `${where}: journal`).toEqual(raw.journal);
            if (raw.status !== undefined)
              expect(m.status(), `${where}: status`).toEqual(raw.status);
            if (raw.encryptionSince !== undefined)
              expect(m.encryptionSince(), `${where}: encryptionSince`).toEqual(
                raw.encryptionSince,
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

  it("replays every scenario in the corpus", () => {
    // Registered after the scenarios above, so it runs last: the count is the corpus's own.
    expect(ran).toBe(corpus.scenarios.length);
  });

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
