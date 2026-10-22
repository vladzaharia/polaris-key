import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { portalApi } from "../src/portal/api.js";
import {
  PORTAL_MUTATIONS,
  bindWriteInvalidation,
  invalidationFor,
  mutate,
} from "../src/portal/mutations.js";
import { qk } from "../src/portal/queries.js";

/**
 * The portal's mutation → invalidation table, checked from the outside: every `portalApi` method
 * is called against a recording fetch to learn which ones write, and the table must name exactly
 * those (the console's twin is test/mutations.test.ts).
 */

/** The HTTP verb each method sends, learned by calling it. A write anywhere in a method's
 *  requests makes it a write. */
async function httpMethods(): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  let current = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (seen[current] === undefined || seen[current] === "GET")
        seen[current] = method;
      return new Response("{}", { status: 200 });
    }),
  );
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL: () => undefined,
    }),
  );
  for (const name of Object.keys(portalApi)) {
    // finishPendingSignIn sends nothing unless this tab has a sign-in pending: start one first,
    // unrecorded.
    if (name === "finishPendingSignIn") {
      current = "(setup)";
      await portalApi.resendSignInCode().catch(() => undefined);
    }
    current = name;
    const fn = (
      portalApi as unknown as Record<string, (...a: unknown[]) => unknown>
    )[name]!;
    try {
      await fn("djdl", "id_1", "x", new Blob(["x"]));
    } catch {
      // A refusal or a parse error is fine; a method that never fetched is reported below.
    }
  }
  delete seen["(setup)"];
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every portal write declares its invalidation", () => {
  it("classifies every portalApi method by calling it", async () => {
    const methods = await httpMethods();
    expect(Object.keys(methods).sort()).toEqual(Object.keys(portalApi).sort());
  });

  it("the table's keys are exactly the methods that send anything but GET", async () => {
    const methods = await httpMethods();
    const writes = Object.entries(methods)
      .filter(([, m]) => m !== "GET")
      .map(([name]) => name)
      .sort();
    expect(
      writes.filter((w) => !(w in PORTAL_MUTATIONS)),
      "writes with no entry in PORTAL_MUTATIONS",
    ).toEqual([]);
    expect(
      Object.keys(PORTAL_MUTATIONS).filter((k) => !writes.includes(k)),
      "PORTAL_MUTATIONS entries that are not writes",
    ).toEqual([]);
  });

  it("an entry that invalidates nothing says why", () => {
    for (const [name, spec] of Object.entries(PORTAL_MUTATIONS) as [
      string,
      {
        invalidates: (...a: string[]) => unknown[];
        settle?: (...a: string[]) => unknown[];
        removes?: (...a: string[]) => unknown[];
        why?: string;
        label: string;
      },
    ][]) {
      expect(spec.label, name).toBeTruthy();
      const args = ["djdl", "id_1", "x"];
      const touches =
        spec.invalidates(...args).length +
        (spec.settle?.(...args).length ?? 0) +
        (spec.removes?.(...args).length ?? 0);
      if (touches === 0)
        expect(
          spec.why,
          `${name} changes nothing and gives no reason`,
        ).toBeTruthy();
    }
  });

  it("reads are not in the table", () => {
    expect(invalidationFor("licenses", [])).toBeNull();
    expect(invalidationFor("me", [])).toBeNull();
  });
});

describe("declared targets (the gaps that mattered)", () => {
  const keys = (name: keyof typeof PORTAL_MUTATIONS, ...args: unknown[]) =>
    (invalidationFor(name, args) ?? []).map((t) => JSON.stringify(t.key));

  it("claimKey also refreshes the claimed product's view and downloads", () => {
    const k = keys("claimKey", "pkey_x");
    for (const want of [
      qk.licenses(),
      qk.releases(),
      qk.library(),
      qk.discover(),
      ["portal", "product"],
      ["portal", "downloads"],
    ])
      expect(k).toContain(JSON.stringify(want));
  });

  it("a removed licence's own view is dropped, not refetched", () => {
    const spec = PORTAL_MUTATIONS.removeLicense;
    expect(spec.removes("djdl", "L1").map((t) => t.key)).toEqual([
      qk.license("djdl", "L1"),
    ]);
    expect(keys("removeLicense", "djdl", "L1")).not.toContain(
      JSON.stringify(qk.license("djdl", "L1")),
    );
  });

  it("removing a library entry drops the product and its storefront page", () => {
    const removed = PORTAL_MUTATIONS.removeLibraryEntry
      .removes("djdl")
      .map((t) => t.key);
    expect(removed).toEqual([qk.product("djdl"), qk.storefront("djdl")]);
  });

  it("the claim from Discover settles on the library", () => {
    expect(PORTAL_MUTATIONS.claimDiscover.settle().map((t) => t.key)).toEqual([
      qk.library(),
    ]);
  });
});

describe("a write through the table", () => {
  let client: QueryClient;
  let unbind: () => void;
  beforeEach(() => {
    client = new QueryClient();
    unbind = bindWriteInvalidation(client);
  });
  afterEach(() => unbind());

  it("invalidates what claimKey declares after the server confirms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    client.setQueryData(qk.product("djdl"), {});
    client.setQueryData(qk.downloads("djdl"), {});
    client.setQueryData(qk.licenses(), []);
    await mutate("claimKey", "pkey_x");
    for (const key of [qk.product("djdl"), qk.downloads("djdl"), qk.licenses()])
      expect(
        client.getQueryState(key)?.isInvalidated,
        JSON.stringify(key),
      ).toBe(true);
  });

  it("invalidates nothing when the Worker refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })),
    );
    client.setQueryData(qk.licenses(), []);
    await expect(mutate("claimKey", "pkey_x")).rejects.toMatchObject({
      status: 404,
    });
    expect(client.getQueryState(qk.licenses())?.isInvalidated).toBe(false);
  });
});
