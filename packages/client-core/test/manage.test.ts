// @pkey-feature license.manage
// PX-W8: the refusal link helpers (WIRE-CONTRACT-V4 §5.3). Every SDK pins the same table, so
// the links a host builds are byte-identical across languages.
import { describe, expect, it } from "vitest";
import {
  MANAGE_URL_MAX_LENGTH,
  isManageUrl,
  manageFormEncode,
  readManageUrl,
  withManageKey,
  withManageReturn,
} from "../src/index.js";

const FREE =
  "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64";
const ACTIVATE = "https://key.plrs.im/activate?product=djdl";

describe("readManageUrl", () => {
  it.each([
    ["a free-device link", { manageUrl: FREE }, FREE],
    ["an activate link", { manageUrl: ACTIVATE }, ACTIVATE],
    [
      "a loopback http link",
      { manageUrl: "http://localhost:8787/activate?product=djdl" },
      "http://localhost:8787/activate?product=djdl",
    ],
    ["a nested member", { error: { code: "x", manageUrl: FREE } }, FREE],
    ["javascript:", { manageUrl: "javascript:alert(1)" }, undefined],
    ["plain http", { manageUrl: "http://key.plrs.im/activate" }, undefined],
    [
      "userinfo",
      { manageUrl: "https://user:pw@key.plrs.im/activate" },
      undefined,
    ],
    ["relative", { manageUrl: "/activate?product=djdl" }, undefined],
    ["no //", { manageUrl: "https:key.plrs.im/activate" }, undefined],
    [
      "a backslash in the authority",
      { manageUrl: "https://key.plrs.im\\@evil.example/activate" },
      undefined,
    ],
    [
      "a backslash as a separator",
      { manageUrl: "https://key.plrs.im\\evil/activate" },
      undefined,
    ],
    ["whitespace", { manageUrl: "https://key.plrs.im/a b" }, undefined],
    ["a number", { manageUrl: 7 }, undefined],
    ["absent", { error: "device_limit", limit: 1, deviceCount: 1 }, undefined],
    ["not an object", "device_limit", undefined],
    ["null", null, undefined],
  ])("%s", (_name, body, want) => {
    expect(readManageUrl(body)).toBe(want);
  });

  it("drops a link longer than MANAGE_URL_MAX_LENGTH", () => {
    expect(MANAGE_URL_MAX_LENGTH).toBe(2048);
    const base = "https://key.plrs.im/activate?product=";
    const exact = base + "a".repeat(MANAGE_URL_MAX_LENGTH - base.length);
    expect(isManageUrl(exact)).toBe(true);
    expect(readManageUrl({ manageUrl: `${exact}a` })).toBeUndefined();
  });
});

describe("withManageReturn", () => {
  it("joins the query inside a route fragment", () => {
    expect(withManageReturn(FREE, "myapp://done")).toBe(
      "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=Linux%20x86_64&return=myapp%3A%2F%2Fdone",
    );
  });

  it("joins the URL's query otherwise, keeping a non-route fragment", () => {
    expect(withManageReturn(ACTIVATE, "https://app.example/a b")).toBe(
      "https://key.plrs.im/activate?product=djdl&return=https%3A%2F%2Fapp.example%2Fa+b",
    );
    expect(withManageReturn(`${ACTIVATE}#key=k`, "x")).toBe(
      "https://key.plrs.im/activate?product=djdl&return=x#key=k",
    );
  });

  it("replaces an earlier return, and adds a query to a route without one", () => {
    expect(
      withManageReturn(
        "https://key.plrs.im/#/p/djdl/free-device?return=old",
        "new",
      ),
    ).toBe("https://key.plrs.im/#/p/djdl/free-device?return=new");
    expect(
      withManageReturn("https://key.plrs.im/#/p/djdl/free-device", "new"),
    ).toBe("https://key.plrs.im/#/p/djdl/free-device?return=new");
  });

  it("leaves an invalid link or an empty return alone", () => {
    expect(withManageReturn("javascript:alert(1)", "x")).toBe(
      "javascript:alert(1)",
    );
    expect(withManageReturn(FREE, "")).toBe(FREE);
  });
});

describe("withManageKey", () => {
  it("adds #key= to an activate link", () => {
    expect(withManageKey(ACTIVATE, "pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV")).toBe(
      "https://key.plrs.im/activate?product=djdl#key=pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV",
    );
    expect(
      withManageKey(
        "https://key.plrs.im/activate?product=djdl&next=free-device#key=old",
        "k y",
      ),
    ).toBe(
      "https://key.plrs.im/activate?product=djdl&next=free-device#key=k+y",
    );
  });

  it("never puts the key on any other link", () => {
    expect(withManageKey(FREE, "pkey_x")).toBe(FREE);
    expect(withManageKey("https://key.plrs.im/signin?product=djdl", "k")).toBe(
      "https://key.plrs.im/signin?product=djdl",
    );
    expect(withManageKey("javascript:alert(1)", "k")).toBe(
      "javascript:alert(1)",
    );
    expect(withManageKey(ACTIVATE, "")).toBe(ACTIVATE);
  });
});

describe("manageFormEncode", () => {
  it("is the WHATWG urlencoded byte serializer", () => {
    expect(manageFormEncode("aZ09*-._ ~/:é")).toBe("aZ09*-._+%7E%2F%3A%C3%A9");
    const v = "myapp://x?y=1&z=é ~";
    expect(manageFormEncode(v)).toBe(
      new URLSearchParams({ r: v }).toString().slice(2),
    );
  });
});
