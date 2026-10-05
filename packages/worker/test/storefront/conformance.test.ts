/**
 * THE ADAPTER CONFORMANCE SUITE (A-18a; notes/S-15 §6.6). A required check: it runs once per
 * registered storefront adapter (`STOREFRONT_ADAPTERS`) and, for items 3 and 7, once per feed
 * adapter (`FEED_ADAPTERS`), so a new adapter that skips a piece of the contract fails CI here.
 *
 *   1. CLASSIFICATION: every write of the adapter's pinned vendor spec is allowed by a rule or
 *      denied with a reason, exactly once; nothing classified is missing from the spec; every
 *      denied write is refused at run time, whatever the body.
 *   2. THE NEVER-LIST IS UNREACHABLE: no rule allows a `DELETE`; no rule is on the adapter's
 *      never-list (deletes, users and permissions, signing keys, payments); the gate refuses every
 *      never-list entry for every method it names; no CI command spells a forbidden token. The CI
 *      plane (A-18h): every store's never-list command lines match no command of its allow-list,
 *      every command admits its sample (identity included), and no value smuggles an option.
 *   3. DECLARATIONS AGREE WITH THE GATE: every write op declared `api` names at least one rule
 *      and only rules the gate has; every rule is named by an op; every `deep-link` op names a row
 *      of the deep-link table for this store whose verifier read the gate admits; every `ci` op's
 *      commands are in the adapter's CI allow-list; no adapter declares `api` for `uploadBuild`.
 *      Feeds: `serve` names exactly the adapter's routes; every other op has none or a reason.
 *   4. IDEMPOTENCY: a step run twice under one key makes one vendor write; a timeout after a send
 *      leaves an `ambiguous` row and the retry re-reads the natural key before sending.
 *   5. NO TOKEN BEFORE A PASS: a refused request mints no token and sends nothing.
 *   6. TYPED CONFIRMATION: each `api` op of submit, release and pricing has a typed write the gate
 *      refuses without the confirmation and admits with it.
 *   7. LISTING PROJECTION: every field of the listing profile fits at its limit and yields an
 *      issue one character over, without changing the value. Feeds: declared limits are the
 *      ingest rules'.
 *   8. BUDGET: a depleted budget stops background spend and keeps operator spend; a stop holds
 *      everyone.
 *   9. REDACTION: a projection never keeps a secret, an email, a person's name or a token, and a
 *      failed write keeps the vendor's status and token only.
 *  10. PLAY ONLY, THE EDIT LEASE: a placeholder until A-18e.
 *
 * A NEW STOREFRONT ALSO ADDS its rows to `SPEC_FIXTURES`, `CLIENTS` and `TYPED_SAMPLES` below:
 * without them the suite fails, by design.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUTLET_KINDS } from "@polaris-key/manifest";
import {
  READ_OPS,
  STOREFRONT_ADAPTERS,
  STOREFRONT_OPS,
  TYPED_OPS,
  type StorefrontAdapter,
  type StorefrontId,
  type StorefrontOp,
} from "../../src/core/storefront/adapter.js";
import {
  admits,
  ruleId,
  type GateContext,
} from "../../src/core/storefront/gate.js";
import {
  StoreWriteDenied,
  StoreVendorError,
} from "../../src/core/storefront/errors.js";
import { DEEP_LINKS, deepLink } from "../../src/core/storefront/deeplinks.js";
import {
  checkCiCommand,
  ciLiterals,
  matchCiCommand,
  type CiAllowList,
  type CiParam,
} from "../../src/core/storefront/ci.js";
import {
  CI_PLANE,
  CI_STORE_IDS,
  ciPlaneStore,
  EPIC_CI,
  ITCH_CI,
  MSSTORE_CI,
  SNAP_CI,
  STEAM_CI,
  type CiStoreId,
} from "../../src/core/storefront/ciPlane.js";
import {
  FLATHUB_PR,
  HOMEBREW_PR,
  PR_PLANE,
  PR_STORE_IDS,
  PR_TOOL,
  SCOOP_PR,
  WINGET_PR,
  prNaturalKey,
  prPathAllowed,
  prPlaneStore,
  prVerdict,
  type PrStoreId,
} from "../../src/core/storefront/prPlane.js";
import { fitListing } from "../../src/core/storefront/listing.js";
import {
  budgetAllows,
  pollBudget,
  readRate,
  storeMeter,
  writeRate,
} from "../../src/core/storefront/budget.js";
import { projectStoreResource } from "../../src/core/storefront/audit.js";
import {
  getStoreOperation,
  performStoreWrite,
  storeOpId,
  type StoreOpKey,
  type StoreWriteStep,
} from "../../src/core/storefront/ledger.js";
import type { StoreResource } from "../../src/core/storefront/audit.js";
import { PLATFORM_CREDENTIALS } from "../../src/core/platformCredentials.js";
import { AscClient } from "../../src/core/asc/client.js";
import {
  FEED_ADAPTERS,
  feedCapabilityView,
} from "../../src/services/distribution/registry/index.js";
import { FEED_OPS } from "../../src/services/distribution/registry/adapter.js";
import type { AdminSession } from "../../src/admin/session.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW } from "../seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Per-adapter test data (a new storefront adds its rows) ───────────────────────────────────

interface SpecFixture {
  source: { title: string; version: string; sha256: string };
  operations: { method: string; path: string }[];
}

/** The pinned vendor spec's writes, per adapter that has a spec pin. */
const SPEC_FIXTURES: Partial<Record<StorefrontId, SpecFixture>> = {
  "app-store": JSON.parse(
    readFileSync(
      join(HERE, "..", "fixtures", "asc", "openapi-writes.json"),
      "utf8",
    ),
  ) as SpecFixture,
};

/** A gated client per Worker-plane adapter, with a token and a fetch that count. */
interface CountingClient {
  tokens: number;
  sends: number;
  request(method: string, path: string, body: unknown): Promise<unknown>;
}

const CLIENTS: Partial<Record<StorefrontId, () => CountingClient>> = {
  "app-store": () => {
    const c: CountingClient = {
      tokens: 0,
      sends: 0,
      request: (method, path, body) =>
        client.request(
          method as "POST",
          path,
          body === undefined ? {} : { body },
        ),
    };
    const client = new AscClient({
      token: async () => {
        c.tokens++;
        return "t";
      },
      fetchImpl: async () => {
        c.sends++;
        return new Response("{}", { status: 200 });
      },
    });
    return c;
  },
};

/** A typed write per op, with whatever else the rule needs asserted (never the confirmation). */
interface TypedSample {
  method: string;
  path: string;
  body: unknown;
  ctx?: GateContext;
}

const versionRel = {
  appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
};

const TYPED_SAMPLES: Partial<
  Record<StorefrontId, Partial<Record<StorefrontOp, TypedSample[]>>>
> = {
  "app-store": {
    submit: [
      {
        method: "PATCH",
        path: "/v1/reviewSubmissions/S1",
        body: {
          data: {
            type: "reviewSubmissions",
            id: "S1",
            attributes: { submitted: true },
          },
        },
      },
    ],
    release: [
      {
        method: "POST",
        path: "/v1/appStoreVersionReleaseRequests",
        body: {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: versionRel,
          },
        },
      },
      {
        method: "PATCH",
        path: "/v1/appStoreVersionPhasedReleases/P1",
        body: {
          data: {
            type: "appStoreVersionPhasedReleases",
            id: "P1",
            attributes: { phasedReleaseState: "COMPLETE" },
          },
        },
      },
      {
        method: "POST",
        path: "/v1/appStoreVersionPhasedReleases",
        body: {
          data: {
            type: "appStoreVersionPhasedReleases",
            attributes: { phasedReleaseState: "ACTIVE" },
            relationships: versionRel,
          },
        },
      },
      {
        method: "PATCH",
        path: "/v1/appStoreVersions/V1",
        body: {
          data: {
            type: "appStoreVersions",
            id: "V1",
            attributes: { releaseType: "AFTER_APPROVAL" },
          },
        },
        ctx: { resourceState: "PENDING_DEVELOPER_RELEASE" },
      },
    ],
    pricing: [
      {
        method: "POST",
        path: "/v1/appPriceSchedules",
        body: {
          data: {
            type: "appPriceSchedules",
            relationships: { app: { data: { type: "apps", id: "A1" } } },
          },
        },
      },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const concrete = (template: string) => template.replace(/\{[A-Za-z]+\}/g, "X1");
const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;
const ALL_METHODS = ["GET", ...WRITE_METHODS] as const;

function splitEntry(entry: string): { method: string; path: string } {
  const i = entry.indexOf(" ");
  return { method: entry.slice(0, i), path: entry.slice(i + 1) };
}

function apiRules(a: StorefrontAdapter): Map<StorefrontOp, readonly string[]> {
  const out = new Map<StorefrontOp, readonly string[]>();
  for (const op of STOREFRONT_OPS) {
    const s = a.capabilities.ops[op];
    if (s.mode === "api") out.set(op, s.rules);
  }
  return out;
}

const SESSION: AdminSession = {
  sub: "u1",
  name: "Ada",
  email: "ada@example.test",
  groups: ["admins"],
  csrf: "c",
  exp: NOW + 3600,
};

// ── The storefront adapters ──────────────────────────────────────────────────────────────────

describe("the storefront registry", () => {
  it("has unique ids, and every adapter declares every operation", () => {
    const ids = STOREFRONT_ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of STOREFRONT_ADAPTERS)
      expect(Object.keys(a.capabilities.ops).sort()).toEqual(
        [...STOREFRONT_OPS].sort(),
      );
  });

  it("maps onto existing outlet kinds and an A-16 credential slot of its own store", () => {
    for (const a of STOREFRONT_ADAPTERS) {
      expect(a.outletKinds.length).toBeGreaterThan(0);
      for (const k of a.outletKinds) expect(OUTLET_KINDS).toContain(k);
      if (a.credential !== null) {
        expect(Object.hasOwn(PLATFORM_CREDENTIALS, a.credential)).toBe(true);
        expect(
          PLATFORM_CREDENTIALS[
            a.credential as keyof typeof PLATFORM_CREDENTIALS
          ].store,
        ).toBe(a.id);
      }
    }
  });

  it("declares data only: the capability, CI and listing parts survive a JSON round trip", () => {
    for (const a of STOREFRONT_ADAPTERS) {
      const shared = {
        id: a.id,
        capabilities: a.capabilities,
        ci: a.ci,
        listing: a.listing,
        never: a.never,
        specPin: a.specPin ?? null,
      };
      expect(JSON.parse(JSON.stringify(shared))).toEqual(shared);
    }
  });
});

for (const a of STOREFRONT_ADAPTERS) {
  describe(`storefront adapter ${a.id}`, () => {
    const gate = a.gate;
    const allowIds = gate ? gate.set.allow.map(ruleId) : [];

    // 1 ─────────────────────────────────────────────────────────────────────────────────────
    describe("1. classification", () => {
      it("a Worker-plane adapter has a spec pin and a fixture of its writes", () => {
        if (!gate) return;
        expect(a.specPin).toBeDefined();
        expect(gate.set.specPin).toEqual(a.specPin);
        const spec = SPEC_FIXTURES[a.id];
        expect(spec, `add ${a.id} to SPEC_FIXTURES`).toBeDefined();
        expect(spec!.source.sha256).toBe(a.specPin!.sha256);
        expect(spec!.source.version).toBe(a.specPin!.version);
      });

      it("every spec write is allowed or denied, exactly once, and nothing else is classified", () => {
        if (!gate) return;
        const spec = SPEC_FIXTURES[a.id]!;
        const denied = Object.values(gate.set.denied).flat();
        const keys = spec.operations.map((o) => `${o.method} ${o.path}`);
        const unclassified: string[] = [];
        const twice: string[] = [];
        for (const k of keys) {
          const n =
            allowIds.filter((x) => x === k).length +
            denied.filter((x) => x === k).length;
          if (n === 0) unclassified.push(k);
          if (n > 1) twice.push(k);
        }
        expect(unclassified).toEqual([]);
        expect(twice).toEqual([]);
        const known = new Set(keys);
        expect([...allowIds, ...denied].filter((k) => !known.has(k))).toEqual(
          [],
        );
        expect(Object.keys(gate.set.denied).sort()).toEqual(
          Object.keys(gate.set.denyReasons).sort(),
        );
      });

      it("every denied write is refused, whatever the body", () => {
        if (!gate) return;
        for (const entry of Object.values(gate.set.denied).flat()) {
          const { method, path } = splitEntry(entry);
          for (const body of [undefined, {}, { data: { type: "x" } }])
            expect(
              admits(gate, method, concrete(path), body, {
                typedConfirmation: true,
                initial: true,
              }),
              entry,
            ).toBe(false);
        }
      });
    });

    // 2 ─────────────────────────────────────────────────────────────────────────────────────
    describe("2. the never-list is unreachable", () => {
      const never = [
        ...a.never.delete,
        ...a.never.users,
        ...a.never.signingKeys,
        ...a.never.payments,
      ];

      it("no allow rule is a DELETE, and none is on the never-list", () => {
        if (!gate) return;
        expect(
          gate.set.allow.filter((r) => (r.method as string) === "DELETE"),
        ).toEqual([]);
        for (const entry of never) {
          const { method, path } = splitEntry(entry);
          const hits = gate.set.allow.filter(
            (r) => r.path === path && (method === "*" || r.method === method),
          );
          expect(hits.map(ruleId), entry).toEqual([]);
        }
      });

      it("declares a never-list with deletes and users (the categories every store has)", () => {
        if (!gate) return;
        expect(a.never.delete.length).toBeGreaterThan(0);
        expect(a.never.users.length).toBeGreaterThan(0);
      });

      it("the gate refuses every never-list entry for every method it names", () => {
        if (!gate) return;
        for (const entry of never) {
          const { method, path } = splitEntry(entry);
          const methods = method === "*" ? ALL_METHODS : [method];
          for (const m of methods)
            expect(
              admits(gate, m, concrete(path), m === "GET" ? undefined : {}, {
                typedConfirmation: true,
                initial: true,
              }),
              `${m} ${path}`,
            ).toBe(false);
        }
      });

      it("no CI command spells a forbidden token", () => {
        if (!a.ci) return;
        const literals = ciLiterals(a.ci).map((t) => t.toLowerCase());
        for (const token of a.never.ciTokens)
          expect(
            literals.filter((l) => l.includes(token)),
            token,
          ).toEqual([]);
      });
    });

    // 3 ─────────────────────────────────────────────────────────────────────────────────────
    describe("3. declarations agree with the gate", () => {
      it("every api write op names rules the gate has; every rule is named by an op", () => {
        const named = new Set<string>();
        for (const [op, rules] of apiRules(a)) {
          if (!READ_OPS.includes(op))
            expect(
              rules.length,
              `${op} declares api with no rule`,
            ).toBeGreaterThan(0);
          for (const r of rules) {
            expect(allowIds, `${op} names ${r}`).toContain(r);
            named.add(r);
          }
        }
        expect(allowIds.filter((id) => !named.has(id))).toEqual([]);
        if (!gate) expect(apiRules(a).size).toBe(0);
      });

      it("every deep-link op names a row for this store, verified by a read the gate admits", () => {
        for (const op of STOREFRONT_OPS) {
          const s = a.capabilities.ops[op];
          if (s.mode !== "deep-link") continue;
          const row = deepLink(s.link);
          expect(row, `${op} names ${s.link}`).not.toBeNull();
          expect(row!.store).toBe(a.id);
          for (const verify of [s.verify, row!.verify])
            if (verify !== "operator-assertion") {
              expect(
                gate,
                `${op} verifies by a read but has no gate`,
              ).not.toBeNull();
              expect(
                admits(gate!, "GET", concrete(verify.read)),
                verify.read,
              ).toBe(true);
              expect(verify.every).toBeGreaterThan(0);
              expect(verify.until).toBeGreaterThan(verify.every);
            }
        }
      });

      it("every ci op's commands are in the CI allow-list", () => {
        for (const op of STOREFRONT_OPS) {
          const s = a.capabilities.ops[op];
          if (s.mode !== "ci") continue;
          expect(
            a.ci,
            `${op} is ci but the adapter has no allow-list`,
          ).not.toBeNull();
          expect(s.tool).toBe(a.ci!.tool);
          for (const c of s.commands)
            expect(Object.keys(a.ci!.commands)).toContain(c);
        }
      });

      it("never declares api for uploadBuild (binaries stay in CI, decision 2)", () => {
        expect(a.capabilities.ops.uploadBuild.mode).not.toBe("api");
      });

      it("every unsupported op says why", () => {
        for (const op of STOREFRONT_OPS) {
          const s = a.capabilities.ops[op];
          if (s.mode === "unsupported")
            expect(s.reason.length).toBeGreaterThan(10);
        }
      });
    });

    // 4 ─────────────────────────────────────────────────────────────────────────────────────
    describe("4. idempotency", () => {
      const key = (idempotencyKey: string): StoreOpKey => ({
        store: a.id,
        scope: "team",
        product: null,
        op: "conformance.create",
        naturalKey: "thing-1",
        idempotencyKey,
      });

      function vendor() {
        const v = {
          objects: new Map<string, StoreResource>(),
          writes: 0,
          finds: 0,
          failNext: null as unknown,
        };
        const step = (k: StoreOpKey): StoreWriteStep => ({
          key: k,
          request: { name: "thing-1" },
          session: SESSION,
          now: NOW,
          find: async () => {
            v.finds++;
            return v.objects.get("thing-1") ?? null;
          },
          write: async () => {
            v.writes++;
            v.objects.set("thing-1", { type: "things", id: "T1" });
            if (v.failNext) {
              const e = v.failNext;
              v.failNext = null;
              throw e;
            }
            return { type: "things", id: "T1" };
          },
          reread: async () => v.objects.get("thing-1") ?? null,
          resultIds: (r) => ({ thing: r.id }),
          summary: () => "Created a thing",
        });
        return { v, step };
      }

      it("a step run twice under one key makes one vendor write", async () => {
        const db = makeTestDb();
        const { v, step } = vendor();
        const k = key("0f8e2d3c-1111-4222-8333-944455556666");
        expect((await performStoreWrite(db, step(k))).outcome).toBe("written");
        expect((await performStoreWrite(db, step(k))).outcome).toBe("replayed");
        expect(v.writes).toBe(1);
        const row = await getStoreOperation(db, await storeOpId(k));
        expect(row).toMatchObject({
          store: a.id,
          plane: "worker",
          state: "done",
        });
      });

      it("a timeout after a send is ambiguous, and the retry re-reads before sending", async () => {
        const db = makeTestDb();
        const { v, step } = vendor();
        const k = key("1f8e2d3c-1111-4222-8333-944455556666");
        v.failNext = new StoreVendorError(504, null, "timeout");
        await expect(performStoreWrite(db, step(k))).rejects.toThrow("timeout");
        expect((await getStoreOperation(db, await storeOpId(k)))!.state).toBe(
          "ambiguous",
        );
        const findsBefore = v.finds;
        expect((await performStoreWrite(db, step(k))).outcome).toBe("existing");
        expect(v.finds).toBe(findsBefore + 1);
        expect(v.writes).toBe(1);
      });

      it("the op id is the store's: the same intent at another store is another row", async () => {
        const other = {
          ...key("2f8e2d3c-1111-4222-8333-944455556666"),
          store: "zz-other",
        } as unknown as StoreOpKey;
        expect(await storeOpId(other)).not.toBe(
          await storeOpId(key("2f8e2d3c-1111-4222-8333-944455556666")),
        );
      });
    });

    // 5 ─────────────────────────────────────────────────────────────────────────────────────
    describe("5. no token before a pass", () => {
      it("a refused request mints no token and sends nothing", async () => {
        if (!gate) return;
        const make = CLIENTS[a.id];
        expect(make, `add ${a.id} to CLIENTS`).toBeDefined();
        const refused = [
          ...a.never.delete.slice(0, 5),
          ...a.never.users,
          ...a.never.signingKeys.slice(0, 5),
        ].map(splitEntry);
        for (const { method, path } of refused) {
          const c = make!();
          const m = method === "*" ? "POST" : method;
          await expect(
            c.request(m, concrete(path), m === "GET" ? undefined : {}),
          ).rejects.toBeInstanceOf(StoreWriteDenied);
          expect(c.tokens, `${m} ${path}`).toBe(0);
          expect(c.sends).toBe(0);
        }
      });
    });

    // 6 ─────────────────────────────────────────────────────────────────────────────────────
    describe("6. typed confirmation", () => {
      it("each api op of submit, release and pricing has typed writes, refused without it", () => {
        const samples = TYPED_SAMPLES[a.id] ?? {};
        for (const op of TYPED_OPS) {
          const s = a.capabilities.ops[op];
          if (s.mode !== "api") continue;
          const list = samples[op] ?? [];
          expect(
            list.length,
            `add a typed ${op} sample for ${a.id}`,
          ).toBeGreaterThan(0);
          for (const t of list) {
            const rule = gate!.find(t.method, t.path);
            expect(rule, `${t.method} ${t.path}`).not.toBeNull();
            expect(s.rules, `${op} must name ${ruleId(rule!)}`).toContain(
              ruleId(rule!),
            );
            let reason: string | null = null;
            try {
              gate!.check(t.method, t.path, t.body, t.ctx ?? {});
            } catch (e) {
              reason = e instanceof StoreWriteDenied ? e.reason : String(e);
            }
            expect(reason, `${t.method} ${t.path} without confirmation`).toBe(
              "typed_confirmation_required",
            );
            expect(
              admits(gate!, t.method, t.path, t.body, {
                ...t.ctx,
                typedConfirmation: true,
              }),
              `${t.method} ${t.path} with confirmation`,
            ).toBe(true);
          }
        }
      });

      it("names the app as the store reports it as the phrase", () => {
        expect(a.confirmation.phrase).toBe("app-name");
        expect(a.confirmation.label.length).toBeGreaterThan(0);
      });
    });

    // 7 ─────────────────────────────────────────────────────────────────────────────────────
    describe("7. listing projection", () => {
      it("every field fits at its limit, and one character over is an issue, never a truncation", () => {
        for (const [field, spec] of Object.entries(a.listing.fields)) {
          expect(spec.maxChars).toBeGreaterThan(0);
          const atLimit = { "en-US": { [field]: "a".repeat(spec.maxChars) } };
          expect(
            fitListing(a.listing, atLimit).filter((i) => i.field === field),
          ).toEqual([]);
          const over = { "en-US": { [field]: "a".repeat(spec.maxChars + 1) } };
          const frozen = JSON.stringify(over);
          const issues = fitListing(a.listing, over).filter(
            (i) => i.field === field,
          );
          expect(issues).toEqual([
            {
              field,
              locale: "en-US",
              issue: "too_long",
              limit: spec.maxChars,
              actual: spec.maxChars + 1,
            },
          ]);
          expect(JSON.stringify(over)).toBe(frozen);
        }
      });

      it("image slots take image types and have a cap", () => {
        for (const slot of Object.values(a.listing.images)) {
          expect(slot.maxBytes).toBeGreaterThan(0);
          for (const t of slot.contentTypes) expect(t).toMatch(/^image\//);
        }
      });
    });

    // 8 ─────────────────────────────────────────────────────────────────────────────────────
    describe("8. budget", () => {
      it("a depleted budget stops background spend and keeps operator spend; a stop holds all", async () => {
        const kv = new KvMock();
        const env = makeEnv(kv, []);
        const k = { source: "platform" } as const;
        const meter = storeMeter(env, a.id, "", k);
        const spec = a.capabilities.rate;
        if (spec.kind === "header")
          await writeRate(
            env,
            a.id,
            "",
            k,
            { limit: spec.limit ?? 100, remaining: 0 },
            NOW,
          );
        else if (spec.kind === "per-minute" || spec.kind === "per-day")
          for (let i = 0; i < (spec.limit ?? 0); i++) await meter.spend(NOW);
        if (spec.kind !== "none" && spec.kind !== "retry-after") {
          const rate = await readRate(env, a.id, "", k, NOW + 1);
          expect(pollBudget(rate)).toBe("skip");
          expect(budgetAllows(rate, "background")).toBe(false);
          expect(budgetAllows(rate, "poll")).toBe(false);
          expect(budgetAllows(rate, "operator")).toBe(true);
        }
        await meter.stop(NOW, 30);
        const stopped = await readRate(env, a.id, "", k, NOW + 1);
        expect(budgetAllows(stopped, "operator")).toBe(false);
        expect(await readRate(env, a.id, "", k, NOW + 31)).toBeNull();
      });
    });

    // 9 ─────────────────────────────────────────────────────────────────────────────────────
    describe("9. redaction", () => {
      it("a projection never keeps a secret, an email, a person's name or a token", () => {
        const hostile = {
          email: "a@b.test",
          password: "p",
          secret: "s",
          token: "t",
          firstName: "Ada",
          lastName: "L",
          phone: "1",
          contactEmail: "c@d.test",
          demoAccountPassword: "x",
        };
        for (const type of Object.keys(a.audit.projection)) {
          const p = projectStoreResource(a.id, {
            type,
            id: "X1",
            attributes: { ...hostile },
          })!;
          for (const k of Object.keys(hostile))
            expect(p.attributes).not.toHaveProperty(k);
          expect(JSON.stringify(p)).not.toMatch(/@|Ada/);
        }
        for (const list of Object.values(a.audit.projection))
          for (const k of list)
            expect(k, "a projection lists a redacted key").not.toMatch(
              /password|secret|email|phone|contact|firstname|lastname|token/i,
            );
      });

      it("a failed write keeps the vendor's status and token only; an email-shaped key is refused", async () => {
        const db = makeTestDb();
        const k: StoreOpKey = {
          store: a.id,
          scope: "team",
          product: null,
          op: "conformance.fail",
          naturalKey: "thing-2",
          idempotencyKey: "3f8e2d3c-1111-4222-8333-944455556666",
        };
        await expect(
          performStoreWrite(db, {
            key: k,
            request: {},
            session: SESSION,
            now: NOW,
            find: async () => null,
            write: async () => {
              throw new StoreVendorError(
                422,
                "ENTITY_ERROR",
                "the body said: secret stuff",
              );
            },
            reread: async () => null,
            resultIds: () => ({}),
            summary: () => "x",
          }),
        ).rejects.toBeInstanceOf(StoreVendorError);
        const row = (await getStoreOperation(db, await storeOpId(k)))!;
        expect(row).toMatchObject({
          state: "failed",
          vendor_status: 422,
          vendor_code: "ENTITY_ERROR",
        });
        expect(JSON.stringify(row)).not.toContain("secret stuff");
        await expect(
          performStoreWrite(db, {
            key: { ...k, naturalKey: "tester@example.test" },
            request: {},
            session: SESSION,
            now: NOW,
            find: async () => null,
            write: async () => null,
            reread: async () => null,
            resultIds: () => ({}),
            summary: () => "x",
          }),
        ).rejects.toThrow(/email/);
      });
    });

    // 10 ────────────────────────────────────────────────────────────────────────────────────
    describe("10. the edit lease (Play only)", () => {
      it.skip("a poll tick during a provisioning edit neither invalidates it nor runs (A-18e)", () => {});
    });
  });
}

// ── The CI plane (A-18h): every store's command allow-list ───────────────────────────────────

/**
 * One admitted command line per CI-plane command, with the outlet identity it binds to. A new
 * CI-plane store or command adds its row; without one the suite fails, by design.
 */
const CI_SAMPLES: Record<
  CiStoreId,
  Record<string, { argv: string[]; identity?: Record<string, unknown> }>
> = {
  itch: {
    push: {
      argv: [
        "push",
        "build/windows",
        "vlad/dice:windows-beta",
        "--userversion",
        "1.2.0",
      ],
      identity: { target: "vlad/dice", gameId: "1001" },
    },
  },
  snap: {
    upload: {
      argv: ["upload", "dist/dice_1.2.0_amd64.snap", "--release=beta,edge"],
      identity: { name: "dice", channels: { beta: "beta", nightly: "edge" } },
    },
    "upload-metadata": {
      argv: ["upload-metadata", "dist/dice_1.2.0_amd64.snap"],
    },
  },
  steam: {
    "run-app-build": {
      argv: [
        "+login",
        "builder",
        "+run_app_build",
        "build/app_480.vdf",
        "+quit",
      ],
    },
  },
  msstore: {
    publish: {
      argv: ["publish", "build/Dice.msixupload", "--appId", "9NBLGGH4R315"],
      identity: { productId: "9NBLGGH4R315" },
    },
  },
  epic: {
    "upload-binary": {
      argv: [
        "-mode=UploadBinary",
        "-OrganizationId=o-1",
        "-ProductId=p-1",
        "-ArtifactId=a-1",
        "-ClientId=c-1",
        "-ClientSecretEnvVar=BPT_SECRET",
        "-BuildRoot=build/windows",
        "-CloudDir=build/cloud",
        "-BuildVersion=1.2.0-win",
        "-AppLaunch=Dice.exe",
        "-AppArgs=",
      ],
    },
  },
};

describe("the CI plane (A-18h; S-15 §6.2, §6.6 item 2)", () => {
  it("has one row per CI store id, and every registered adapter's ci is its row's list", () => {
    expect(CI_PLANE.map((p) => p.store).sort()).toEqual(
      [...CI_STORE_IDS].sort(),
    );
    for (const a of STOREFRONT_ADAPTERS) {
      const row = ciPlaneStore(a.id);
      if (a.ci) {
        expect(row, `${a.id} has a ci list but no CI_PLANE row`).not.toBeNull();
        expect(a.ci).toBe(row!.list);
        expect([...a.never.ciTokens].sort()).toEqual(
          [...row!.neverTokens].sort(),
        );
      } else expect(row, `${a.id} has a CI_PLANE row but no ci`).toBeNull();
    }
  });

  for (const plane of CI_PLANE) {
    describe(`${plane.store} (${plane.list.tool})`, () => {
      const samples = CI_SAMPLES[plane.store];

      it("admits its sample of every command, identity included", () => {
        expect(Object.keys(samples).sort()).toEqual(
          Object.keys(plane.list.commands).sort(),
        );
        for (const [id, sample] of Object.entries(samples)) {
          expect(
            checkCiCommand(plane.list, id, sample.argv, sample.identity),
            `${id}: ${sample.argv.join(" ")}`,
          ).toBeNull();
          expect(matchCiCommand(plane.list, sample.argv)).toBe(id);
        }
      });

      it("refuses every never-list command line", () => {
        expect(plane.never.length).toBeGreaterThan(0);
        for (const argv of plane.never) {
          expect(matchCiCommand(plane.list, argv), argv.join(" ")).toBeNull();
          for (const id of Object.keys(plane.list.commands))
            expect(
              checkCiCommand(plane.list, id, argv, samples[id]?.identity ?? {}),
              `${id}: ${argv.join(" ")}`,
            ).not.toBeNull();
        }
      });

      it("spells no never-token in any literal, and no value can smuggle an option or a path escape", () => {
        const literals = ciLiterals(plane.list).map((t) => t.toLowerCase());
        expect(plane.neverTokens.length).toBeGreaterThan(0);
        for (const token of plane.neverTokens)
          expect(
            literals.filter((l) => l.includes(token)),
            token,
          ).toEqual([]);
        for (const [id, sample] of Object.entries(samples)) {
          const rule = plane.list.commands[id]!;
          rule.argv.forEach((want, i) => {
            if (typeof want === "string") return;
            const prefix = want.prefix ?? "";
            // A prefixed value (`-AppArgs=-x`) stays inside its own token, so only an unprefixed
            // one could pass for an option.
            const options = prefix ? [] : ["--delete", "-x"];
            for (const bad of [
              ...options,
              "../../etc/passwd",
              "a;rm -rf /",
              "$(id)",
            ]) {
              const argv = [...sample.argv];
              argv[i] = `${prefix}${bad}`;
              expect(
                checkCiCommand(plane.list, id, argv, sample.identity),
                `${id}[${i}] = ${argv[i]}`,
              ).not.toBeNull();
            }
          });
        }
      });

      it("binds every identity parameter to an outlet kind of the store", () => {
        for (const [id, rule] of Object.entries(plane.list.commands)) {
          const bound = rule.argv.filter(
            (a): a is CiParam => typeof a !== "string" && !!a.identity,
          );
          if (bound.length === 0) continue;
          expect(plane.outletKinds.length, id).toBeGreaterThan(0);
          const sample = samples[id]!;
          expect(checkCiCommand(plane.list, id, sample.argv)).toBe(
            "identity_required",
          );
          expect(checkCiCommand(plane.list, id, sample.argv, {})).toBe(
            "identity_mismatch",
          );
        }
      });
    });
  }

  it("binds itch's target and snap's channels to the outlet identity", () => {
    const itch = CI_SAMPLES.itch.push!;
    expect(
      checkCiCommand(ITCH_CI.list, "push", itch.argv, { target: "other/game" }),
    ).toBe("identity_mismatch");
    expect(
      checkCiCommand(
        ITCH_CI.list,
        "push",
        ["push", "build", "vlad/dice:switch", "--userversion", "1"],
        itch.identity,
      ),
    ).toBe("value_not_allowed");
    const snap = CI_SAMPLES.snap.upload!;
    expect(
      checkCiCommand(
        SNAP_CI.list,
        "upload",
        ["upload", "dice.snap", "--release=stable"],
        snap.identity,
      ),
    ).toBe("identity_mismatch");
    expect(
      checkCiCommand(
        SNAP_CI.list,
        "upload",
        ["upload", "dice.snap", "--release=latest/stable"],
        { channels: { stable: "latest/stable" } },
      ),
    ).toBeNull();
  });

  it("guards msstore publish with the Worker-staged draft, and steamcmd's script with the setlive check", () => {
    expect(MSSTORE_CI.list.commands.publish!.unlessWorkerStaged).toEqual({
      opens: ["submission.create"],
      closes: ["submission.commit"],
    });
    expect(STEAM_CI.list.commands["run-app-build"]!.fileChecks).toEqual([
      { param: "script", check: "steam-vdf-setlive-named" },
    ]);
    expect(EPIC_CI.outletKinds).toEqual([]);
  });
});

// ── The CI command allow-list check ──────────────────────────────────────────────────────────

describe("the CI command allow-list check", () => {
  const list: CiAllowList = {
    tool: "steamcmd",
    commands: {
      "build-branch": {
        argv: [
          "+run_app_build",
          { param: "script", pattern: "[a-z0-9_]+\\.vdf" },
          "+setlive",
          { param: "branch", pattern: "(?!public$)[a-z0-9_-]{1,64}" },
        ],
        confirm: "plain",
        why: "a build live on a named branch only",
      },
    },
  };

  it("admits exactly a declared command, with matching parameters", () => {
    expect(
      checkCiCommand(list, "build-branch", [
        "+run_app_build",
        "app.vdf",
        "+setlive",
        "beta",
      ]),
    ).toBeNull();
    expect(
      checkCiCommand(list, "build-branch", [
        "+run_app_build",
        "app.vdf",
        "+setlive",
        "public",
      ]),
    ).toBe("value_not_allowed");
    expect(
      checkCiCommand(list, "build-branch", ["+run_app_build", "app.vdf"]),
    ).toBe("not_allowed");
    expect(
      checkCiCommand(list, "build-branch", [
        "+run_app_build",
        "../x",
        "+setlive",
        "beta",
      ]),
    ).toBe("value_not_allowed");
    expect(checkCiCommand(list, "delete", [])).toBe("not_allowed");
    expect(checkCiCommand(list, "constructor", [])).toBe("not_allowed");
  });

  it("the never-token check catches a forbidden literal", () => {
    const bad: CiAllowList = {
      tool: "x",
      commands: {
        wipe: { argv: ["delete-all"], confirm: "plain", why: "never" },
      },
    };
    expect(ciLiterals(bad).filter((l) => l.includes("delete"))).toEqual([
      "delete-all",
    ]);
  });
});

// ── The deep-link table ──────────────────────────────────────────────────────────────────────

describe("the deep-link table", () => {
  it("has unique ids, https templates whose placeholders are exactly the params, and known stores", () => {
    const ids = DEEP_LINKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const stores = new Set(STOREFRONT_ADAPTERS.map((a) => a.id as string));
    for (const l of DEEP_LINKS) {
      expect(l.template).toMatch(/^https:\/\//);
      expect(l.id.startsWith(`${l.store}.`)).toBe(true);
      expect(stores.has(l.store)).toBe(true);
      const placeholders = [...l.template.matchAll(/\{([A-Za-z]+)\}/g)].map(
        (m) => m[1],
      );
      expect(placeholders.sort()).toEqual([...l.params].sort());
    }
  });
});

// ── The feed adapters: items 3 and 7 ─────────────────────────────────────────────────────────

for (const f of FEED_ADAPTERS) {
  describe(`feed adapter ${f.id}`, () => {
    it("3. declarations agree with the gate: serve names exactly its routes", () => {
      expect(Object.keys(f.capabilities.ops).sort()).toEqual(
        [...FEED_OPS].sort(),
      );
      const serve = f.capabilities.ops.serve;
      expect(serve.mode).toBe("api");
      if (serve.mode === "api")
        expect([...serve.rules].sort()).toEqual(
          f.routes.map((r) => r.name).sort(),
        );
      for (const op of FEED_OPS) {
        const s = f.capabilities.ops[op];
        if (s.mode === "unsupported")
          expect(s.reason.length).toBeGreaterThan(10);
        // F-21: `auth` (registry tokens, judged by the same ladder) names the feed's credential
        // routes (Swift's login) and owner-less routes (OCI's token service); nothing else names
        // a rule but `serve`.
        if (s.mode === "api" && op === "auth")
          expect(s.rules).toEqual([
            ...(f.authRoutes ?? []).map((r) => r.name),
            ...(f.ownerlessRoutes ?? []).map((r) => r.name),
          ]);
        else if (s.mode === "api" && op !== "serve")
          expect(s.rules).toEqual([]);
        expect(["api", "unsupported"]).toContain(s.mode);
      }
      const view = feedCapabilityView(f);
      expect(view.yank).toBe(f.capabilities.ops.yank.mode !== "unsupported");
      expect(view.deprecate).toBe(
        f.capabilities.ops.deprecate.mode !== "unsupported",
      );
    });

    it("7. render limits: the declared limits are the ingest rules'", () => {
      expect(f.capabilities.limits).toEqual({
        maxFiles: f.ingest.maxFiles,
        maxNameLength: f.ingest.name.maxLength,
      });
      expect(f.capabilities.rate).toEqual({ kind: "none" });
      for (const n of Object.values(f.capabilities.limits))
        expect(Number.isInteger(n) && n > 0).toBe(true);
    });
  });
}

// ── The PR plane (A-18i) ─────────────────────────────────────────────────────────────────────

const PR_SAMPLES: Record<
  PrStoreId,
  {
    argv: string[];
    identity: Record<string, unknown>;
    files: string[];
    key: string;
  }
> = {
  winget: {
    argv: [
      "--repo",
      "microsoft/winget-pkgs",
      "--package",
      "Vlad.Dice",
      "--version",
      "1.2.0",
    ],
    identity: { packageIdentifier: "Vlad.Dice" },
    key: "pr:Vlad.Dice:1.2.0",
    files: [
      "manifests/v/Vlad/Dice/1.2.0/Vlad.Dice.yaml",
      "manifests/v/Vlad/Dice/1.2.0/Vlad.Dice.installer.yaml",
      "manifests/v/Vlad/Dice/1.2.0/Vlad.Dice.locale.en-US.yaml",
      "manifests/v/Vlad/Dice/1.2.0/Vlad.Dice.locale.zh-Hans-CN.yaml",
    ],
  },
  homebrew: {
    argv: [
      "--repo",
      "vlad/homebrew-games",
      "--cask",
      "dice",
      "--version",
      "1.2.0",
    ],
    identity: { homebrewTap: "vlad/homebrew-games", homebrewCask: "dice" },
    key: "pr:dice:1.2.0",
    files: ["Casks/dice.rb"],
  },
  scoop: {
    argv: ["--repo", "vlad/scoop-games", "--app", "dice", "--version", "1.2.0"],
    identity: { scoopBucket: "vlad/scoop-games" },
    key: "pr:dice:1.2.0",
    files: ["bucket/dice.json"],
  },
  flathub: {
    argv: ["--repo", "flathub/gg.vlad.Dice", "--version", "1.2.0"],
    identity: { appId: "gg.vlad.Dice" },
    key: "pr:gg.vlad.Dice:1.2.0",
    files: ["gg.vlad.Dice.yml", "gg.vlad.Dice.metainfo.xml"],
  },
};

describe("the PR plane (A-18i; S-15 §4.4, §6.3)", () => {
  it("has one row per PR store id, and every registered adapter's pr is its row", () => {
    expect(PR_PLANE.map((p) => p.store).sort()).toEqual(
      [...PR_STORE_IDS].sort(),
    );
    for (const a of STOREFRONT_ADAPTERS) {
      const row = prPlaneStore(a.id);
      if (a.pr) {
        expect(a.pr).toBe(row);
        expect(a.ci, `${a.id} is on one plane`).toBeNull();
        expect([...a.never.ciTokens].sort()).toEqual(
          [...row!.neverTokens].sort(),
        );
        for (const op of STOREFRONT_OPS) {
          const s = a.capabilities.ops[op];
          if (s.mode !== "pr") continue;
          expect(s.repo, `${a.id}.${op}`).toBe(row!.repo);
          expect(
            Object.values(row!.commandOps).some((ops) => ops.includes(op)),
            `${a.id}.${op} is performed by a PR command`,
          ).toBe(true);
        }
        for (const [command, ops] of Object.entries(row!.commandOps))
          for (const op of ops)
            expect(
              a.capabilities.ops[op as StorefrontOp].mode,
              `${a.id}: ${command} performs ${op}`,
            ).toBe("pr");
      } else expect(row, `${a.id} has a PR_PLANE row but no pr`).toBeNull();
    }
  });

  for (const plane of PR_PLANE) {
    describe(`${plane.store} (${plane.repo})`, () => {
      const sample = PR_SAMPLES[plane.store];
      const argv = (command: string) => [command, ...sample.argv];

      it("admits its sample of both commands, the identity bound, and only the github pseudo-tool", () => {
        expect(plane.list.tool).toBe(PR_TOOL);
        expect(Object.keys(plane.list.commands).sort()).toEqual([
          "pull-request",
          "status",
        ]);
        for (const command of ["pull-request", "status"]) {
          expect(
            checkCiCommand(plane.list, command, argv(command), sample.identity),
          ).toBeNull();
          expect(checkCiCommand(plane.list, command, argv(command), {})).toBe(
            "identity_mismatch",
          );
        }
        expect(prNaturalKey(plane, "pull-request", argv("pull-request"))).toBe(
          sample.key,
        );
      });

      it("refuses every never-list line and spells no never-token", () => {
        expect(plane.never.length).toBeGreaterThan(0);
        for (const line of plane.never)
          expect(matchCiCommand(plane.list, line), line.join(" ")).toBeNull();
        const literals = ciLiterals(plane.list).map((t) => t.toLowerCase());
        for (const token of plane.neverTokens)
          expect(
            literals.filter((l) => l.includes(token)),
            token,
          ).toEqual([]);
      });

      it("admits the generator's paths and nothing else", () => {
        const pr = argv("pull-request");
        for (const f of sample.files)
          expect(prPathAllowed(plane, pr, f), f).toBe(true);
        for (const bad of [
          "../evil",
          "/etc/passwd",
          ".github/workflows/release.yml",
          `${sample.files[0]}/../../x`,
          "README.md",
          ...(sample.files[0]!.includes("1.2.0")
            ? [sample.files[0]!.replace("1.2.0", "9.9.9")]
            : []),
        ])
          expect(prPathAllowed(plane, pr, bad), bad).toBe(false);
      });

      it("no value can smuggle an option, a path escape or a shell metacharacter", () => {
        const rule = plane.list.commands["pull-request"]!;
        const pr = argv("pull-request");
        rule.argv.forEach((want, i) => {
          if (typeof want === "string") return;
          for (const bad of [
            "--force",
            "../../etc",
            "a;rm -rf /",
            "$(id)",
            "a b",
          ]) {
            const line = [...pr];
            line[i] = `${want.prefix ?? ""}${bad}`;
            expect(
              checkCiCommand(plane.list, "pull-request", line, sample.identity),
              `${i} = ${line[i]}`,
            ).not.toBeNull();
          }
        });
      });
    });
  }

  it("never targets the official Homebrew or Scoop organisations, in any case", () => {
    for (const repo of [
      "Homebrew/homebrew-cask",
      "HOMEBREW/homebrew-core",
      "homebrew/homebrew-x",
    ])
      expect(
        checkCiCommand(
          HOMEBREW_PR.list,
          "pull-request",
          ["pull-request", "--repo", repo, "--cask", "dice", "--version", "1"],
          {
            homebrewTap: repo,
            homebrewCask: "dice",
          },
        ),
        repo,
      ).not.toBeNull();
    for (const repo of ["ScoopInstaller/Main", "scoopinstaller/Extras"])
      expect(
        checkCiCommand(
          SCOOP_PR.list,
          "pull-request",
          ["pull-request", "--repo", repo, "--app", "dice", "--version", "1"],
          {
            scoopBucket: repo,
          },
        ),
        repo,
      ).not.toBeNull();
  });

  it("reads review labels as a verdict, never a date", () => {
    expect(
      prVerdict(WINGET_PR, {
        state: "open",
        merged: false,
        labels: ["Validation-Domain"],
      }),
    ).toBe("validation-issue");
    expect(
      prVerdict(WINGET_PR, {
        state: "open",
        merged: false,
        labels: ["Needs-Author-Feedback"],
      }),
    ).toBe("needs-author-feedback");
    expect(
      prVerdict(WINGET_PR, {
        state: "open",
        merged: false,
        labels: ["Validation-Completed"],
      }),
    ).toBe("in-review");
    expect(
      prVerdict(HOMEBREW_PR, {
        state: "open",
        merged: false,
        labels: ["Validation-Domain"],
      }),
    ).toBe("in-review");
    expect(
      prVerdict(SCOOP_PR, { state: "closed", merged: true, labels: [] }),
    ).toBe("merged");
    expect(
      prVerdict(FLATHUB_PR, { state: "closed", merged: false, labels: [] }),
    ).toBe("closed");
  });
});
