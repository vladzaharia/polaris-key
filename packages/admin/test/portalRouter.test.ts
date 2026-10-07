import { afterEach, describe, expect, it } from "vitest";
import {
  activateContext,
  activateLinkKey,
  activateLinkParams,
  href,
  resolveHash,
  rewriteActivatePath,
  setParams,
} from "../src/portal/router.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("portal routes (PORTAL.md §3.3)", () => {
  it("defaults to the Library", () => {
    expect(resolveHash("").route.kind).toBe("library");
    expect(resolveHash("#/").route.kind).toBe("library");
    expect(resolveHash("#/").redirect).toBeUndefined();
  });

  it("sends unknown hashes to the Library", () => {
    const r = resolveHash("#/nope/at/all");
    expect(r.route.kind).toBe("library");
    expect(r.redirect).toBe("#/");
  });

  it("parses the library's query", () => {
    const r = resolveHash("#/?view=list&q=fern");
    expect(r.route.kind).toBe("library");
    if (r.route.kind !== "library") return;
    expect(r.route.params.get("view")).toBe("list");
    expect(r.route.params.get("q")).toBe("fern");
  });

  it("parses product pages and sections", () => {
    expect(resolveHash("#/p/nightfall").route).toMatchObject({
      kind: "product",
      product: "nightfall",
      section: null,
    });
    expect(resolveHash("#/p/nightfall/devices").route).toMatchObject({
      kind: "product",
      product: "nightfall",
      section: "devices",
    });
    const unknown = resolveHash("#/p/nightfall/whatever");
    expect(unknown.redirect).toBe("#/p/nightfall");
  });

  it("routes the focused flows with their parameters (PX-10)", () => {
    const free = resolveHash(
      "#/p/orbit/free-device?for=Steam%20Deck&return=https%3A%2F%2Fapp.example%2F",
    );
    expect(free.redirect).toBeUndefined();
    expect(free.route).toMatchObject({
      kind: "focused",
      flow: "free-device",
      product: "orbit",
    });
    const params = (free.route as { params: URLSearchParams }).params;
    expect(params.get("for")).toBe("Steam Deck");
    expect(params.get("return")).toBe("https://app.example/");
    expect(
      resolveHash("#/p/orbit/download?platform=linux").route,
    ).toMatchObject({ kind: "focused", flow: "download", product: "orbit" });
  });

  it("parses account sections", () => {
    expect(resolveHash("#/account").route).toMatchObject({
      kind: "account",
      section: null,
    });
    expect(resolveHash("#/account/appearance").route).toMatchObject({
      kind: "account",
      section: "appearance",
    });
  });

  it("keeps an account section's query (PX-13: a provider's Connect, Add an email)", () => {
    const r = resolveHash("#/account/methods?connected=google").route;
    expect(r).toMatchObject({ kind: "account", section: "methods" });
    expect(r.kind === "account" && r.params.get("connected")).toBe("google");
    expect(href.account("methods", { add: "email" })).toBe(
      "#/account/methods?add=email",
    );
    expect(href.account("methods")).toBe("#/account/methods");
  });

  it.each([
    ["#/licenses", "#/"],
    ["#/licenses/nightfall/lic_9", "#/p/nightfall/license?license=lic_9"],
    ["#/downloads", "#/"],
    ["#/profile", "#/account"],
    ["#/claim?key=pkey_x_abc", "#/?activate=pkey_x_abc"],
    ["#/account/emails", "#/account/methods"],
    ["#/account/passkeys", "#/account/methods"],
    ["#/account/linked", "#/account/methods"],
  ])("redirects %s to %s", (from, to) => {
    expect(resolveHash(from).redirect).toBe(to);
  });

  it("keeps the license id on the redirected product page", () => {
    const r = resolveHash("#/licenses/nightfall/lic_9");
    expect(r.route).toMatchObject({ kind: "product", section: "license" });
    if (r.route.kind === "product")
      expect(r.route.params.get("license")).toBe("lic_9");
  });

  it("builds hrefs that round-trip", () => {
    expect(href.product("lumen-raw", "devices")).toBe("#/p/lumen-raw/devices");
    expect(resolveHash(href.product("lumen-raw")).route).toMatchObject({
      product: "lumen-raw",
    });
    expect(href.activate("pkey_a_b")).toBe("#/?activate=pkey_a_b");
  });
});

describe("the /activate path handler", () => {
  const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
  const carried = (): URLSearchParams | null => {
    const r = resolveHash(window.location.hash);
    return r.route.kind === "library" ? r.route.params : null;
  };

  it("rewrites /activate#key=… to the Library with the key and drops the fragment", () => {
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden#key=${KEY}`,
    );
    const before = window.history.length;
    expect(rewriteActivatePath()).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).not.toContain("key=");
    expect(window.history.length).toBe(before);
    expect(carried()?.get("activate")).toBe(KEY);
    expect(carried()?.get("product")).toBe("mossgarden");
  });

  it("still reads the legacy /activate?key=… and drops the query", () => {
    window.history.replaceState(
      null,
      "",
      `/activate?key=${KEY}&product=mossgarden`,
    );
    expect(rewriteActivatePath()).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(carried()?.get("activate")).toBe(KEY);
    expect(carried()?.get("product")).toBe("mossgarden");
  });

  it("reads the link the SDKs build (client-core `withManageKey`, PX-W8) and carries next=, for= and return= (PX-17)", () => {
    // `manageUrl` from the Worker, plus `return=` in the query and the key as `#key=`, encoded
    // the way client-core's `manageFormEncode` writes it.
    window.history.replaceState(
      null,
      "",
      `/activate?product=mossgarden&next=free-device&for=macOS+arm64&return=myapp%3A%2F%2Fback#key=${KEY}`,
    );
    expect(rewriteActivatePath()).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(carried()?.get("activate")).toBe(KEY);
    expect(carried()?.get("product")).toBe("mossgarden");
    expect(carried()?.get("next")).toBe("free-device");
    expect(carried()?.get("for")).toBe("macOS arm64");
    expect(carried()?.get("return")).toBe("myapp://back");
    // The key is in `activate` and nowhere else: not the query, not another parameter.
    const others = [...(carried()?.entries() ?? [])].filter(
      ([k]) => k !== "activate",
    );
    expect(others.map(([, v]) => v).join(" ")).not.toContain("pkey_");
  });

  it("carries the login card's return (the card's 'You don't have <Product> yet' link)", () => {
    window.history.replaceState(
      null,
      "",
      "/activate?product=mossgarden&return=%2Fsignin%3Frequest%3Drq_0123456789abcdef",
    );
    expect(rewriteActivatePath()).toBe(true);
    expect(carried()?.get("activate")).toBe("");
    expect(carried()?.get("return")).toBe(
      "/signin?request=rq_0123456789abcdef",
    );
  });

  it("drops what an activate link may not carry", () => {
    const p = activateLinkParams({
      search: `?product=Not_A_Slug&next=account&for=${"x".repeat(80)}&return=x&tab=1&key2=y`,
      hash: "",
    });
    expect(p).toEqual({ activate: "", for: "x".repeat(64), return: "x" });
    // A key in for= or return= never rides along: the hash goes into every sign-in's return URL.
    expect(
      activateLinkParams({
        search: `?for=${KEY}&return=${encodeURIComponent(`myapp://x?k=${KEY}`)}`,
        hash: "",
      }),
    ).toEqual({ activate: "" });
    expect(
      activateLinkParams({
        search: `?return=${"a".repeat(2049)}&for=%00%0A`,
        hash: "",
      }),
    ).toEqual({ activate: "" });
    // A key past the 64-character cut is found before the cut, never half-kept.
    expect(
      activateLinkParams({ search: `?for=${"a".repeat(27)}${KEY}`, hash: "" }),
    ).toEqual({ activate: "" });
    // A key percent-encoded (once in the value, so twice in the link) is still a key.
    const encoded = KEY.replaceAll("_", "%5F");
    expect(
      activateLinkParams({
        search: `?for=${encodeURIComponent(encoded)}&return=${encodeURIComponent(`myapp://x?k=${encoded}`)}`,
        hash: "",
      }),
    ).toEqual({ activate: "" });
  });

  it("reads a hand-written #/?activate= hash through the same rule (activateContext)", () => {
    const hand = new URLSearchParams(
      `activate=&product=mossgarden&next=account&for=${encodeURIComponent(`${"a".repeat(27)}${KEY}`)}&return=${encodeURIComponent(`/signin?k=${KEY.replaceAll("_", "%5F")}`)}`,
    );
    expect(activateContext(hand)).toEqual({ product: "mossgarden" });
    expect(
      activateContext(
        new URLSearchParams(
          "product=mossgarden&next=free-device&for=macOS+arm64&return=%2Fsignin%3Frequest%3Drq_1",
        ),
      ),
    ).toEqual({
      product: "mossgarden",
      next: "free-device",
      for: "macOS arm64",
      return: "/signin?request=rq_1",
    });
  });

  it("prefers the fragment when a link carries both", () => {
    window.history.replaceState(
      null,
      "",
      `/activate?key=pkey_old_AAAAAAAAAAAAAAAAAAAAAA#key=${KEY}`,
    );
    expect(rewriteActivatePath()).toBe(true);
    expect(window.location.search).toBe("");
    expect(carried()?.get("activate")).toBe(KEY);
  });

  it("opens the empty modal for a link with no key", () => {
    window.history.replaceState(null, "", "/activate/?product=mossgarden");
    expect(rewriteActivatePath()).toBe(true);
    expect(carried()?.get("activate")).toBe("");
    expect(carried()?.get("product")).toBe("mossgarden");
  });

  it("reads a key only from a key= fragment, never from a hash route", () => {
    expect(activateLinkKey(`#key=${KEY}`)).toBe(KEY);
    expect(activateLinkKey(`#key=${encodeURIComponent(KEY)}&x=1`)).toBe(KEY);
    expect(activateLinkKey("#key=")).toBeNull();
    expect(activateLinkKey("")).toBeNull();
    expect(activateLinkKey("#")).toBeNull();
    expect(activateLinkKey(`#/?key=${KEY}`)).toBeNull();
    expect(activateLinkKey(`#/p/mossgarden`)).toBeNull();
  });

  it("leaves every other path alone", () => {
    window.history.replaceState(null, "", "/#/p/nightfall");
    expect(rewriteActivatePath()).toBe(false);
    expect(window.location.hash).toBe("#/p/nightfall");
  });
});

describe("setParams", () => {
  it("merges into the hash query without a history entry", () => {
    window.history.replaceState(null, "", "/#/?view=grid");
    const before = window.history.length;
    setParams({ q: "fern", view: null });
    expect(window.location.hash).toBe("#/?q=fern");
    expect(window.history.length).toBe(before);
  });
});
