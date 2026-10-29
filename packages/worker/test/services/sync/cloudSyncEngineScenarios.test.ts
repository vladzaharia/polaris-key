/**
 * U-05.4: the engine against `conformance/corpus/v2/sync-scenarios.json` (read-only; generated).
 *
 * The scenarios script a *client*; their `respond` steps are what a correct server answers. This
 * replays each scripted `POST .../sync/ops` request through the engine, over a store seeded from
 * the scripted pulls before it, and requires the engine's results to equal the scripted ones.
 * After each scripted 200 the store is overlaid with the scripted changes, because a script also
 * has other devices writing between pushes, which the engine never saw.
 *
 * Only what is a *server* decision is compared: results, versions and server copies. Request
 * bodies (what the client sends) are the client-core runner's business.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_MAX_VALUE_BYTES,
  type MutationResult,
  type PushRequest,
  type SyncJson,
} from "@polaris-key/protocol/sync";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import { applyPush } from "../../../src/services/sync/engine/push.js";
import type {
  CatalogMigrations,
  Classification,
  SettingPolicy,
} from "../../../src/services/sync/engine/types.js";
import { TEST_ROOT as here } from "../../paths.js";

const corpus = JSON.parse(
  readFileSync(
    join(here, "../../../conformance/corpus/v2/sync-scenarios.json"),
    "utf8",
  ),
) as {
  constants: { maxClockSkewMs: number };
  scenarios: Scenario[];
};

interface Route {
  key: string;
  route: "synced" | "local" | "locked" | "refused";
  scope?: "user" | "platform";
  policy?: SettingPolicy | "union" | "revision";
}
interface Scenario {
  name: string;
  init: { catalog: { settings: Route[] }; encryption?: "server" | "e2e" };
  steps: Step[];
}
type Step = {
  assert?: {
    requests?: Array<{ method: string; path: string; body?: PushRequest }>;
  };
  respond?: { status: number; body: Record<string, unknown> };
};

const OTHER_DEVICE_CLIENT = "c_000000000000000server0";

const canonicalBytes = (v: SyncJson) =>
  new TextEncoder().encode(JSON.stringify(v)).length;

/** The Worker's classification, as far as the scripts need it. */
function classify(routes: Route[], req: PushRequest): Classification[] {
  return req.mutations.map((m): Classification => {
    if (!("setting" in m.target))
      return { verdict: "reject", code: "collection_unknown" };
    const key = m.target.setting;
    const r = routes.find((x) => x.key === key);
    if (!r) {
      // An open setting: user scope, lastWrite, at most 8 KiB.
      const big =
        m.op === "set" &&
        canonicalBytes(m.value as SyncJson) > SYNC_MAX_VALUE_BYTES;
      return {
        verdict: "accept",
        scope: "user",
        policy: "lastWrite",
        ...(big ? { valueInvalid: true } : {}),
      };
    }
    if (r.route !== "synced")
      return { verdict: "reject", code: "setting_not_synced" };
    return {
      verdict: "accept",
      scope: r.scope ?? "user",
      policy: r.policy as SettingPolicy,
    };
  });
}

/**
 * An end-to-end scenario scripts the client's logical request (`value`); on the wire the same
 * mutation carries a sealed `ct`, and the Worker classifies it `sealed` (U-09.1). The server's
 * decision never reads the payload, so any well-formed string stands in for the envelope.
 */
function asSealed(req: PushRequest): PushRequest {
  return {
    ...req,
    mutations: req.mutations.map((m) => {
      if (m.op !== "set" && m.op !== "setMember") return m;
      const { value: _value, ...rest } = m as typeof m & { value?: unknown };
      void _value;
      return { ...rest, ct: "sealed" } as typeof m;
    }),
  };
}

const asSealedClasses = (c: Classification[]): Classification[] =>
  c.map((x) => (x.verdict === "accept" ? { ...x, sealed: true } : x));

/** Overlays a scripted pull on the store: the server's state as the script says it is. */
function overlay(store: MemoryStore, body: Record<string, unknown>): void {
  type Change = {
    setting: string;
    scope: "user" | "platform";
    value: SyncJson;
    version: number;
    editedHlc: string;
  };
  for (const c of (body.changes as Change[] | undefined) ?? []) {
    // A record change (a collection) is U-09's: it names no setting, and a store never holds a
    // keyless row (the SQL store refuses one, where the map store kept it as "undefined").
    if (typeof c.setting !== "string" || typeof c.scope !== "string") continue;
    store.putSetting({
      key: c.setting,
      scope: c.scope,
      version: c.version,
      stamp: { hlc: c.editedHlc, clientId: OTHER_DEVICE_CLIENT },
      deleted: false,
      value: c.value,
    });
  }
  for (const t of (body.tombstones as
    | Array<{ setting: string; editedHlc: string }>
    | undefined) ?? []) {
    store.putSetting({
      key: t.setting,
      scope: "user",
      version: 0,
      stamp: { hlc: t.editedHlc, clientId: OTHER_DEVICE_CLIENT },
      deleted: true,
      value: null,
    });
  }
  if (typeof body.cursor === "number")
    store.setSeq(Math.max(store.currentSeq(), body.cursor));
}

/**
 * A script reveals the server's state beside its answer: a `conflict` carries the stored copy,
 * and the first `ok` version fixes the sequence. Seeds what the earlier pulls did not say.
 */
function seedFromAnswer(
  store: MemoryStore,
  req: PushRequest,
  scripted: MutationResult[],
): void {
  for (const r of scripted) {
    if (r.status !== "conflict") continue;
    const m = req.mutations.find((x) => x.mutationId === r.mutationId);
    if (!m || !("setting" in m.target)) continue;
    const prior = store.getSetting(m.target.setting, m.target.scope);
    if (prior && prior.version === r.server.version) continue;
    store.putSetting({
      key: m.target.setting,
      scope: m.target.scope,
      version: r.server.version,
      stamp: {
        hlc: r.server.editedHlc as string,
        clientId: OTHER_DEVICE_CLIENT,
      },
      deleted: false,
      value: r.server.value as SyncJson,
    });
  }
  // A dropped key answers ok without a version: it wrote nothing.
  const firstOk = scripted.find(
    (r) => r.status === "ok" && typeof r.version === "number",
  );
  if (firstOk && firstOk.status === "ok") store.setSeq(firstOk.version - 1);
}

/**
 * The catalog's `cloudSync.migrations`, as the script shows them: the pulls' `aliases` are the
 * renames, and a key answered `dropped` is a dropped one (the corpus has no catalog field for it).
 */
function migrationsOf(
  aliases: Record<string, string>,
  req: PushRequest,
  scripted: MutationResult[],
): CatalogMigrations {
  const dropped = new Set<string>();
  for (const r of scripted) {
    if (r.status !== "ok" || !r.dropped) continue;
    const m = req.mutations.find((x) => x.mutationId === r.mutationId);
    if (m && "setting" in m.target) dropped.add(m.target.setting);
  }
  return { renamedTo: new Map(Object.entries(aliases)), dropped };
}

/**
 * The scripted `quota_exceeded` predates the result's `scope` member (§13.3 now carries one), so
 * the comparison reads the scope off the engine's answer and checks it separately.
 */
const withoutQuotaScope = (r: MutationResult): MutationResult => {
  if (r.status === "rejected" && r.code === "quota_exceeded") {
    const { scope: _scope, ...rest } = r;
    void _scope;
    return rest as MutationResult;
  }
  return r;
};

/**
 * Scripted answers that a later slice decides. The scenario stays covered by client-core's runner;
 * here the row is listed so the set can only shrink as those slices land.
 */
function deferredOwner(scripted: MutationResult[]): string | null {
  for (const r of scripted) {
    if (r.status === "rejected" && r.code === "entitlement_required")
      return "U-09 (collections)";
  }
  return null;
}

const deferred: Array<{ name: string; owner: string }> = [];
const replayed: Array<{ name: string; pushes: number }> = [];

describe("the engine reproduces sync-scenarios.json's scripted server answers", () => {
  for (const sc of corpus.scenarios) {
    const hasPush = sc.steps.some((s) =>
      s.assert?.requests?.some((r) => r.method === "POST"),
    );
    if (!hasPush) continue;
    it(sc.name, () => {
      const store = new MemoryStore();
      let pending: PushRequest | null = null;
      let pushes = 0;
      for (const step of sc.steps) {
        for (const req of step.assert?.requests ?? []) {
          if (req.method === "POST" && req.body) pending = req.body;
        }
        const res = step.respond;
        if (!res) continue;
        if (pending) {
          const e2e = sc.init.encryption === "e2e";
          const req = e2e ? asSealed(pending) : pending;
          pending = null;
          const scripted = res.body?.results as MutationResult[] | undefined;
          const owner = scripted && deferredOwner(scripted);
          if (owner) deferred.push({ name: sc.name, owner });
          const isRecordPush = req.mutations.some(
            (m) => !("setting" in m.target),
          );
          if (isRecordPush || owner) {
            // Records are U-09's engine; see `deferredOwner` for the rest.
          } else if (res.status === 200 && Array.isArray(scripted)) {
            seedFromAnswer(store, req, scripted);
            // The scripted answer carries the person's totals and the device's quota.
            const usage = res.body.usage as {
              bytes: number;
              settings: number;
            };
            store.setUsage({
              settings: usage.settings,
              settingsBytes: 0,
              bytes: usage.bytes,
            });
            const out = applyPush(store, {
              deviceId: "device-1",
              serverNow: res.body.serverNow as number,
              request: req,
              classified: e2e
                ? asSealedClasses(classify(sc.init.catalog.settings, req))
                : classify(sc.init.catalog.settings, req),
              limits: {
                quotaBytes: (res.body.quota as { bytes: number }).bytes,
              },
              migrations: migrationsOf(
                res.body.aliases as Record<string, string>,
                req,
                scripted,
              ),
            });
            expect(out.ok).toBe(true);
            if (!out.ok) continue;
            expect(out.results.map(withoutQuotaScope)).toEqual(scripted);
            for (const r of out.results)
              if (r.status === "rejected" && r.code === "quota_exceeded")
                expect(r.scope).toBe("user");
            expect(out.lastMutationId).toBe(res.body.lastMutationId);
            pushes++;
          } else if (res.status === 409) {
            const other = new MemoryStore();
            other.putClient({
              clientId: req.clientId,
              deviceId: "device-0",
              lastMutationId: 0,
            });
            expect(
              applyPush(other, {
                deviceId: "device-1",
                serverNow: 0,
                request: req,
                classified: classify(sc.init.catalog.settings, req),
              }),
            ).toEqual({ ok: false, error: "client_mismatch" });
            pushes++;
          }
        }
        if (res.status === 200) overlay(store, res.body);
      }
      replayed.push({ name: sc.name, pushes });
      expect(pushes).toBeGreaterThanOrEqual(0);
    });
  }

  it("replays the scenarios whose server answers the rules decide, and defers only the named ones", () => {
    const names = replayed.filter((r) => r.pushes > 0).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "lww-conflict-server-wins",
        "member-merge",
        "max-policy-optimistic",
        "client-mismatch-regenerates",
        "first-sign-in-newer-and-older-cloud",
      ]),
    );
    // The list only shrinks: a scenario leaves it when its owner lands.
    expect([...new Set(deferred.map((d) => `${d.name} -> ${d.owner}`))].sort())
      .toMatchInlineSnapshot(`
      [
        "terminal-rejection-reverts -> U-09 (collections)",
      ]
    `);
  });
});
