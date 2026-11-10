import { describe, expect, it } from "vitest";
import {
  bodyOf,
  claimsDelivered,
  EMPTY_CLIENT,
  FIELD_ORDER,
  hostOf,
  hostsOf,
  keyFromName,
  lines,
  refusalCopy,
  validateClient,
  type ClientValues,
} from "../src/console/sections/identity/clients/model.js";

const good: ClientValues = {
  ...EMPTY_CLIENT,
  name: "Forum",
  key: "forum",
  redirectUris:
    "https://forum.example.com/cb\n\n  https://forum.example.com/other  ",
  scopes: ["openid", "profile"],
  claimsRequired: ["name", "email"],
};

describe("client form model", () => {
  it("suggests a key from a name", () => {
    expect(keyFromName("Community Forum!")).toBe("community-forum");
    expect(keyFromName("9 lives")).toBe("lives");
    expect(keyFromName("x".repeat(50))).toHaveLength(32);
  });

  it("splits one address per line", () => {
    expect(lines(good.redirectUris)).toEqual([
      "https://forum.example.com/cb",
      "https://forum.example.com/other",
    ]);
  });

  it("accepts a good client and names each refusal", () => {
    expect(validateClient(good, { creating: true })).toEqual({});
    const bad = validateClient(
      { ...good, name: " ", key: "A", redirectUris: "", scopes: ["profile"] },
      { creating: true },
    );
    expect(Object.keys(bad).sort()).toEqual([
      "key",
      "name",
      "redirectUris",
      "scopes",
    ]);
    // An edit never asks for the key.
    expect(validateClient({ ...good, key: "" }, { creating: false })).toEqual(
      {},
    );
  });

  it("sends only claims the scopes deliver, and only what changed on an edit", () => {
    expect(claimsDelivered(["openid", "profile"])).toEqual(["name", "picture"]);
    const body = bodyOf(good, true);
    expect(body.claimsRequired).toEqual(["name"]);
    expect(body.key).toBe("forum");
    expect(bodyOf({ ...good, name: "Forum 2" }, false, good)).toEqual({
      name: "Forum 2",
    });
    expect(
      bodyOf({ ...good, developerName: " Partner Ltd " }, false, good),
    ).toEqual({
      developerName: "Partner Ltd",
    });
  });

  it("shows an address as its host", () => {
    expect(hostOf("https://forum.example.com/cb")).toBe("forum.example.com");
    expect(hostOf("com.example.app:/cb")).toBe("com.example.app");
  });

  it("shows many hosts as the first and a count", () => {
    expect(hostsOf([])).toBe("");
    expect(
      hostsOf(["https://a.example.com/cb", "https://a.example.com/x"]),
    ).toBe("a.example.com");
    expect(
      hostsOf(
        Array.from({ length: 10 }, (_, i) => `https://h${i}.example.com/cb`),
      ),
    ).toBe("h0.example.com +9");
  });

  it("words the Worker's refusals for the console", () => {
    const at = (m: string) =>
      refusalCopy("redirectUris", "invalid_client_redirect", m);
    expect(
      at(
        "redirectUris[0] must be an https URI (loopback and private-use schemes are for native clients).",
      ),
    ).toBe(
      "Line 1 isn't https. Loopback and app-scheme addresses are for native apps.",
    );
    expect(
      at("redirectUris[2] must not contain whitespace, a fragment or *."),
    ).toMatch(/^Line 3 has a space/);
    expect(at("redirectUris must not repeat a URI.")).toBe(
      "Each address can appear only once.",
    );
    expect(refusalCopy("key", "key_exists", undefined)).toBe(
      "A client with this key already exists. Choose another.",
    );
    expect(refusalCopy("name", "reserved_display_name", "Use your own.")).toBe(
      "Use your own.",
    );
    expect(refusalCopy("name", undefined, undefined)).toBe("Check this value.");
  });

  it("lists the form's fields in reading order", () => {
    expect(FIELD_ORDER[0]).toBe("name");
    expect(FIELD_ORDER.indexOf("redirectUris")).toBeLessThan(
      FIELD_ORDER.indexOf("developerName"),
    );
  });
});
