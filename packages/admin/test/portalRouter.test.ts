import { afterEach, describe, expect, it } from "vitest";
import {
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

  it("opens the matching section for the focused-flow links until PX-10", () => {
    expect(resolveHash("#/p/orbit/free-device?for=x").redirect).toBe(
      "#/p/orbit/devices",
    );
    expect(resolveHash("#/p/orbit/download").redirect).toBe("#/p/orbit/get");
  });

  it("parses account sections", () => {
    expect(resolveHash("#/account").route).toEqual({
      kind: "account",
      section: null,
    });
    expect(resolveHash("#/account/appearance").route).toEqual({
      kind: "account",
      section: "appearance",
    });
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
  it("rewrites /activate?key=… to the Library with the key", () => {
    window.history.replaceState(
      null,
      "",
      "/activate?key=pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w&product=mossgarden",
    );
    expect(rewriteActivatePath()).toBe(true);
    expect(window.location.pathname).toBe("/");
    const r = resolveHash(window.location.hash);
    expect(r.route.kind).toBe("library");
    if (r.route.kind !== "library") return;
    expect(r.route.params.get("activate")).toBe(
      "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w",
    );
    expect(r.route.params.get("product")).toBe("mossgarden");
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
