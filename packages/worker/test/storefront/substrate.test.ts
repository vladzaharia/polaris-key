/**
 * A-18a — the store-agnostic substrate's parts on their own (notes/S-15 §6.2–§6.5): the gate
 * engine's compile-time assertions, the body matchers no adapter uses yet (json, form, upload),
 * the budget meter under every `RateSpec` kind, the shared typed confirmation, the deep-link
 * renderer and the listing fit. The conformance suite (`conformance.test.ts`) runs the same parts
 * through each registered adapter.
 */

import { describe, expect, it } from "vitest";
import {
  admits,
  compileGate,
  ruleId,
  type GateRule,
  type GateRuleSet,
} from "../../src/core/storefront/gate.js";
import { StoreWriteDenied } from "../../src/core/storefront/errors.js";
import {
  matchJson,
  type JsonRule,
} from "../../src/core/storefront/match/json.js";
import {
  matchForm,
  type FormRule,
} from "../../src/core/storefront/match/form.js";
import {
  matchUpload,
  type UploadRule,
} from "../../src/core/storefront/match/multipart.js";
import {
  budgetAllows,
  budgetMeter,
  rateSlot,
  stopsBudget,
  TEAM_RATE_KEY,
} from "../../src/core/storefront/budget.js";
import {
  confirmationMissing,
  typedConfirmationRefusal,
} from "../../src/core/storefront/confirm.js";
import { renderDeepLink } from "../../src/core/storefront/deeplinks.js";
import { fitListing } from "../../src/core/storefront/listing.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW } from "../seed.js";

function set<R extends GateRule>(
  allow: R[],
  match: GateRuleSet<R>["match"],
  denied: Record<string, string[]> = {},
): GateRuleSet<R> {
  return {
    store: "test-store",
    specPin: null,
    allow,
    denied,
    denyReasons: Object.fromEntries(Object.keys(denied).map((k) => [k, k])),
    validPath: (p) => p.startsWith("/api/"),
    forbidden: (p) => p.startsWith("/api/users"),
    match,
    deny: (m, t, r) => new StoreWriteDenied("test-store", m, t, r),
  };
}

const reason = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof StoreWriteDenied) return e.reason;
    throw e;
  }
};

describe("the gate engine", () => {
  const rule = (method: string, path: string): GateRule =>
    ({ method, path, confirm: "plain", why: "t" }) as GateRule;
  const any = () => null;

  it("refuses to compile a DELETE rule, a GET rule, a rule twice, or one also denied", () => {
    expect(() =>
      compileGate(set([rule("DELETE", "/api/x/{id}")], any)),
    ).toThrow(/DELETE/);
    expect(() => compileGate(set([rule("GET", "/api/x")], any))).toThrow(/GET/);
    expect(() =>
      compileGate(set([rule("POST", "/api/x"), rule("POST", "/api/x")], any)),
    ).toThrow(/twice/);
    expect(() =>
      compileGate(set([rule("POST", "/api/x")], any, { g: ["POST /api/x"] })),
    ).toThrow(/both/);
  });

  it("denies by default, matches templates exactly, refuses forbidden paths even to read", () => {
    const g = compileGate(set([rule("POST", "/api/x/{id}/y")], any));
    expect(admits(g, "POST", "/api/x/A1/y", {})).toBe(true);
    expect(reason(() => g.check("POST", "/api/x/A1/y/z", {}))).toBe(
      "not_allowed",
    );
    expect(reason(() => g.check("PATCH", "/api/x/A1/y", {}))).toBe(
      "not_allowed",
    );
    expect(reason(() => g.check("POST", "/api/x/../y", {}))).toBe(
      "not_allowed",
    );
    expect(reason(() => g.check("POST", "/other", {}))).toBe("invalid_path");
    expect(reason(() => g.check("GET", "/api/users/1", undefined))).toBe(
      "personal_data",
    );
    expect(reason(() => g.check("GET", "/api/x", {}))).toBe("invalid_body");
    expect(g.check("GET", "/api/x", undefined)).toBeNull();
    expect(ruleId(rule("POST", "/api/x"))).toBe("POST /api/x");
  });

  it("applies the confirmation levels after the body", () => {
    const g = compileGate(
      set(
        [
          { ...rule("POST", "/api/typed"), confirm: "typed" },
          { ...rule("POST", "/api/initial"), confirm: "initial" },
          { ...rule("POST", "/api/price"), confirm: "typed-or-initial" },
        ],
        any,
      ),
    );
    expect(reason(() => g.check("POST", "/api/typed", {}))).toBe(
      "typed_confirmation_required",
    );
    expect(
      admits(g, "POST", "/api/typed", {}, { typedConfirmation: true }),
    ).toBe(true);
    expect(
      reason(() =>
        g.check("POST", "/api/initial", {}, { typedConfirmation: true }),
      ),
    ).toBe("initial_only");
    expect(admits(g, "POST", "/api/initial", {}, { initial: true })).toBe(true);
    expect(reason(() => g.check("POST", "/api/price", {}))).toBe(
      "typed_confirmation_required",
    );
    expect(admits(g, "POST", "/api/price", {}, { initial: true })).toBe(true);
    expect(
      admits(g, "POST", "/api/price", {}, { typedConfirmation: true }),
    ).toBe(true);
  });
});

describe("the json matcher", () => {
  const r: JsonRule = {
    method: "PATCH",
    path: "/api/listings/{id}",
    confirm: "plain",
    why: "t",
    body: {
      title: { kind: "string", max: 30 },
      status: { kind: "string", values: ["draft", "completed"] },
      fraction: { kind: "number", min: 0, max: 1 },
      notes: {
        kind: "array",
        max: 2,
        items: {
          kind: "object",
          keys: { language: { kind: "string" }, text: { kind: "string" } },
        },
      },
    },
    check: (b, ctx) =>
      b.status === "completed" && ctx.typedConfirmation !== true
        ? "typed_confirmation_required"
        : null,
  };
  const m = (body: unknown, ctx = {}) => matchJson(r, r.path, body, ctx);

  it("admits declared keys and values, refuses anything else", () => {
    expect(
      m({ title: "Game", notes: [{ language: "en", text: "x" }] }),
    ).toBeNull();
    expect(m({ title: "x".repeat(31) })).toBe("value_not_allowed");
    expect(m({ other: 1 })).toBe("attribute_not_allowed");
    expect(m({ constructor: 1 })).toBe("attribute_not_allowed");
    expect(m({ notes: [{ language: "en", url: "x" }] })).toBe(
      "attribute_not_allowed",
    );
    expect(m({ notes: [{}, {}, {}] })).toBe("invalid_body");
    expect(m({ fraction: 2 })).toBe("value_not_allowed");
    expect(m({ status: "halted" })).toBe("value_not_allowed");
    expect(m([])).toBe("invalid_body");
    expect(m({ status: "completed" })).toBe("typed_confirmation_required");
    expect(m({ status: "completed" }, { typedConfirmation: true })).toBeNull();
  });
});

describe("the form matcher", () => {
  const r: FormRule = {
    method: "POST",
    path: "/api/SetAppBuildLive",
    confirm: "plain",
    why: "t",
    params: {
      appid: { kind: "integer" },
      buildid: { kind: "integer" },
      betakey: { kind: "string", max: 64 },
      mode: { kind: "enum", values: ["a", "b"] },
    },
    required: ["appid", "buildid", "betakey"],
    check: (p, ctx) =>
      p.betakey === "public" && ctx.typedConfirmation !== true
        ? "typed_confirmation_required"
        : null,
  };
  const m = (body: unknown, ctx = {}) => matchForm(r, r.path, body, ctx);

  it("admits declared parameters, refuses anything else, types the public branch", () => {
    expect(m({ appid: "480", buildid: "12", betakey: "beta" })).toBeNull();
    expect(m({ appid: "480", buildid: "12" })).toBe("invalid_body");
    expect(m({ appid: "x", buildid: "12", betakey: "beta" })).toBe(
      "value_not_allowed",
    );
    expect(m({ appid: "480", buildid: "12", betakey: "beta", key: "k" })).toBe(
      "attribute_not_allowed",
    );
    expect(m({ appid: "480", buildid: "12", betakey: "beta", mode: "c" })).toBe(
      "value_not_allowed",
    );
    expect(m({ appid: 480, buildid: "12", betakey: "beta" })).toBe(
      "invalid_body",
    );
    expect(m({ appid: "480", buildid: "12", betakey: "public" })).toBe(
      "typed_confirmation_required",
    );
    expect(
      m(
        { appid: "480", buildid: "12", betakey: "public" },
        { typedConfirmation: true },
      ),
    ).toBeNull();
  });
});

describe("the upload matcher (listing assets only, decision 2)", () => {
  const r: UploadRule = {
    method: "POST",
    path: "/api/images",
    confirm: "plain",
    why: "t",
    contentTypes: ["image/png", "image/jpeg"],
    maxBytes: 15 * 1024 * 1024,
  };
  const m = (body: unknown) => matchUpload(r, r.path, body, {});

  it("checks the content type and the size cap from the blob record", () => {
    expect(m({ contentType: "image/png", size: 1000 })).toBeNull();
    expect(
      m({ contentType: "image/PNG; charset=binary", size: 1000 }),
    ).toBeNull();
    expect(m({ contentType: "application/zip", size: 1000 })).toBe(
      "content_type_not_allowed",
    );
    expect(m({ contentType: "image/png", size: 15 * 1024 * 1024 + 1 })).toBe(
      "too_large",
    );
    expect(m({ contentType: "image/png", size: 0 })).toBe("invalid_body");
    expect(m({ contentType: "image/png", size: 10, bytes: "x" })).toBe(
      "invalid_body",
    );
  });
});

describe("the budget meter under every RateSpec kind", () => {
  const env = () => makeEnv(new KvMock(), []);

  it("keeps A-17a's App Store slots", () => {
    expect(TEAM_RATE_KEY).toBe("plat:asc-rate:app-store.api-key");
    expect(
      rateSlot("app-store", "djdl", { source: "product", credentialId: "c1" }),
    ).toBe("p:djdl:asc-rate:c1");
  });

  it("per-minute: counts calls in a fixed window, and forgets them after it", async () => {
    const m = budgetMeter(env(), "s", { kind: "per-minute", limit: 10 });
    for (let i = 0; i < 9; i++) await m.spend(NOW);
    expect(await m.read(NOW)).toMatchObject({ limit: 10, remaining: 1 });
    expect(budgetAllows(await m.read(NOW), "background")).toBe(false);
    expect(budgetAllows(await m.read(NOW), "operator")).toBe(true);
    await m.spend(NOW + 61);
    expect(await m.read(NOW + 61)).toMatchObject({ remaining: 9 });
  });

  it("per-day: a 403 under stopOn403 holds everyone until the window ends", async () => {
    const spec = { kind: "per-day", limit: 100_000, stopOn403: true } as const;
    const m = budgetMeter(env(), "s", spec);
    await m.spend(NOW);
    expect(budgetAllows(await m.read(NOW), "background")).toBe(true);
    const s = stopsBudget(spec, 403, null);
    expect(s).toEqual({ stop: true });
    await m.stop(NOW, s.seconds);
    expect(budgetAllows(await m.read(NOW + 3600), "operator")).toBe(false);
    expect(await m.read(NOW + 86_400)).toBeNull();
  });

  it("retry-after: the store's own hold, lifted when it ends", async () => {
    const spec = { kind: "retry-after" } as const;
    const m = budgetMeter(env(), "s", spec);
    const s = stopsBudget(spec, 429, "120");
    expect(s).toEqual({ stop: true, seconds: 120 });
    await m.stop(NOW, s.seconds);
    expect(budgetAllows(await m.read(NOW + 119), "operator")).toBe(false);
    expect(await m.read(NOW + 120)).toBeNull();
    expect(stopsBudget(spec, 429, "soon")).toEqual({ stop: false });
    expect(stopsBudget({ kind: "header" }, 403, null)).toEqual({ stop: false });
  });

  it("header: the last observation, for its window only", async () => {
    const m = budgetMeter(env(), "s", { kind: "header", limit: 3600 });
    await m.observe({ limit: 3600, remaining: 100 }, NOW);
    expect(await m.read(NOW + 10)).toMatchObject({ remaining: 100 });
    expect(budgetAllows(await m.read(NOW + 10), "background")).toBe(false);
    expect(await m.read(NOW + 3601)).toBeNull();
    await m.spend(NOW); // not a counter kind: nothing changes
    expect(await m.read(NOW + 10)).toMatchObject({ remaining: 100 });
  });
});

describe("typed confirmation, shared", () => {
  const phrase = { phrase: "app-name", label: "App Store Connect" } as const;

  it("refuses a missing or blank phrase, and a mismatch, and passes the store's own name", () => {
    expect(confirmationMissing(undefined, "release")?.reason).toBe(
      "confirmation_required",
    );
    expect(confirmationMissing("  ", "release")?.message).toBe(
      "type the app's name in confirm to release",
    );
    expect(
      typedConfirmationRefusal("Other", "Dice Roll", "release", phrase),
    ).toMatchObject({
      status: 422,
      reason: "confirmation_mismatch",
      message: "confirm does not match the app's name in App Store Connect",
    });
    expect(
      typedConfirmationRefusal("dice roll", "Dice Roll", "release", phrase)
        ?.reason,
    ).toBe("confirmation_mismatch");
    expect(
      typedConfirmationRefusal("Dice Roll", null, "release", phrase)?.reason,
    ).toBe("confirmation_mismatch");
    expect(
      typedConfirmationRefusal(" Dice Roll ", "Dice Roll", "release", phrase),
    ).toBeNull();
  });
});

describe("the deep-link renderer", () => {
  it("renders a row with exactly its parameters, each a plain identifier", () => {
    expect(
      renderDeepLink("app-store.app-information", { appId: "1234567890" }),
    ).toBe(
      "https://appstoreconnect.apple.com/apps/1234567890/distribution/info",
    );
    expect(renderDeepLink("app-store.agreements")).toBe(
      "https://appstoreconnect.apple.com/business",
    );
    expect(() => renderDeepLink("app-store.app-information")).toThrow(
      /takes appId/,
    );
    expect(() =>
      renderDeepLink("app-store.agreements", { appId: "1" }),
    ).toThrow();
    expect(() =>
      renderDeepLink("app-store.app-information", { appId: "../../evil" }),
    ).toThrow(/invalid appId/);
    expect(() => renderDeepLink("nope")).toThrow(/unknown/);
  });
});

describe("the listing fit", () => {
  it("reports missing required fields and undeclared ones, and changes nothing", () => {
    const profile = {
      fields: {
        name: { maxChars: 30, perLocale: true, required: true },
        subtitle: { maxChars: 30, perLocale: true },
      },
      images: {},
    };
    expect(
      fitListing(profile, { "en-US": { subtitle: "x", nmae: "typo" } }),
    ).toEqual([
      {
        field: "nmae",
        locale: "en-US",
        code: "unknown_field",
        limit: null,
        actual: null,
      },
      {
        field: "name",
        locale: "en-US",
        code: "missing",
        limit: null,
        actual: null,
      },
    ]);
  });
});
