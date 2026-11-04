// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { consoleLastMethod } from "../src/lib/lastMethod.js";
import { hashAddress as lockerHash } from "../src/portal/lastMethod.js";

/**
 * The console's returning-person record: written here after /me, read by the Worker card's inline
 * script (`worker/src/console/signinScript.ts`). The vector is the one the Worker's
 * `signinScriptHint.test.ts` pins for the script: one hash, two implementations.
 */
const SALT = "pk-vector-salt";
const ADDRESS = "vlad@example.com";
const HASH = "a2a7c1f8c73e08cc97be9780";

// jsdom drops a Secure, Path=/manage cookie on http://localhost: record what was written.
const written: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  written.length = 0;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => written.map((c) => c.split(";")[0]).join("; "),
    set: (v: string) => void written.push(v),
  });
});

describe("the console's last-method store", () => {
  it("hashes salt:address to the vector the card's script computes", async () => {
    window.localStorage.setItem("pk-console-hint-salt", SALT);
    expect(
      await consoleLastMethod.hashAddress(` ${ADDRESS.toUpperCase()} `),
    ).toBe(HASH);
  });

  it("keeps its own salt, apart from Polaris Locker's", async () => {
    await consoleLastMethod.hashAddress(ADDRESS);
    await lockerHash(ADDRESS);
    const console_ = window.localStorage.getItem("pk-console-hint-salt");
    const locker = window.localStorage.getItem("pk-hint-salt");
    expect(console_).toBeTruthy();
    expect(locker).toBeTruthy();
    expect(console_).not.toBe(locker);
  });

  it("commits the stashed method with the first name, and the card's reader format round-trips", async () => {
    window.localStorage.setItem("pk-console-hint-salt", SALT);
    consoleLastMethod.rememberVia("passkey");
    await consoleLastMethod.commitLastMethod({
      email: ADDRESS,
      name: "Vlad Zaharia",
    });
    expect(window.sessionStorage.getItem("pk-console-signin-via")).toBeNull();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(
      new RegExp(
        `^pk_console_last_method=passkey\\.${HASH}\\.\\d+; Path=/manage; Max-Age=31536000; SameSite=Strict; Secure$`,
      ),
    );
    expect(window.localStorage.getItem(`pk-console-hint-name:${HASH}`)).toBe(
      "Vlad",
    );
    const read = await consoleLastMethod.readLastMethod(ADDRESS);
    expect(read).toMatchObject({ kind: "passkey", name: "Vlad" });
    expect(
      await consoleLastMethod.readLastMethod("mara@example.com"),
    ).toBeNull();
  });

  it("writes nothing when the tab named no method, or an unknown one", async () => {
    await consoleLastMethod.commitLastMethod({ email: ADDRESS, name: "Vlad" });
    window.sessionStorage.setItem("pk-console-signin-via", "email");
    await consoleLastMethod.commitLastMethod({ email: ADDRESS, name: "Vlad" });
    expect(written).toHaveLength(0);
  });

  it("an Emergency sign-in clears the stash and remembers nothing", async () => {
    consoleLastMethod.rememberVia("sso");
    consoleLastMethod.clearVia();
    await consoleLastMethod.commitLastMethod({ email: ADDRESS, name: "Vlad" });
    expect(written).toHaveLength(0);
  });
});
