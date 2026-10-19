import { describe, expect, it } from "vitest";
import { handleSignInEntry } from "../src/core/signInEntry.js";
import { matchRoute } from "../src/router.js";

const go = (qs: string, method = "GET") =>
  handleSignInEntry(new Request(`https://key.plrs.im/signin${qs}`, { method }));
const loc = (qs: string) => go(qs).headers.get("location");

describe("GET /signin", () => {
  it("routes as a platform page", () => {
    expect(matchRoute("/signin")).toEqual({ kind: "signInEntry" });
    expect(matchRoute("/signin/")).toEqual({ kind: "signInEntry" });
  });

  it("sends a bare visit to the portal root, no-store, no referrer", () => {
    const res = go("");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps product as context, only when it is slug-shaped", () => {
    expect(loc("?product=djdl")).toBe("/?product=djdl");
    expect(loc("?product=a%26b%3D1")).toBe("/");
    expect(loc("?product=%3Cscript%3E")).toBe("/");
  });

  it("lands identity_disabled on the portal root with the product", () => {
    expect(loc("?product=djdl&error=identity_disabled")).toBe("/?product=djdl");
  });

  it("honours a same-origin portal return_to, fragment included", () => {
    expect(loc("?return_to=%2F%23%2Faccount%2Flink")).toBe("/#/account/link");
    expect(loc("?return_to=%2F%23%2Faccount%2Flink&product=djdl")).toBe(
      "/?product=djdl#/account/link",
    );
    expect(loc("?return_to=%2Factivate%3Fx%3D1")).toBe("/activate?x=1");
  });

  it("drops every unsafe or non-portal return_to", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "https://evil.example/",
      "https://key.plrs.im/",
      "javascript:alert(1)",
      "%2F%2Fevil.example",
      "%2f%5cevil.example",
      "/%2F%2Fevil.example",
      "/manage",
      "/manage/api",
      "/..%2Fmanage",
      "/a/../manage",
      "/djdl/identity/auth/device",
      "/%0d%0aSet-Cookie:x=1",
      "x".repeat(600),
    ]) {
      expect(loc(`?return_to=${encodeURIComponent(bad)}`), bad).toBe("/");
      expect(loc(`?return_to=${bad.replace(/[ ]/g, "")}`), bad).toBe("/");
    }
  });

  it("leaves ?request= to PX-14 (404) and refuses other methods", () => {
    expect(go("?request=rq_abc").status).toBe(404);
    expect(go("", "POST").status).toBe(405);
  });
});
