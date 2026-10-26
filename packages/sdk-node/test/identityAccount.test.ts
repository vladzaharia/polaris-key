// @pkey-feature identity.account
// The account verbs (I-10a.3): `subject()` is persisted and survives a restart, `signOut()` runs
// the pre-sign-out hooks and drops the token only on `released: true`, `openAccount()` opens the
// portal link. Each answers the typed `service-unavailable` N/A, with no request, when
// discovery names no endpoint.

import { describe, expect, it } from "vitest";
import { UnsupportedError } from "@polaris-key/client-core";
import { readStoredSubject } from "../src/identity/account.js";
import { identityFragmentFrom } from "../src/discovery.js";
import { json, seededClient, type Handler } from "./parityFixtures.js";

const SUBJECT = "ps_QQMMVm-ciTWvmWEIfhAVgQ";
const BASE = "https://k.test/djdl";

function discovery(endpoints: Record<string, string> | null): Handler {
  return () =>
    json({
      product: "djdl",
      services: {
        identity:
          endpoints === null
            ? { enabled: false }
            : { enabled: true, configured: true, endpoints },
      },
    });
}

const ALL = {
  subject: `${BASE}/identity/subject`,
  signout: `${BASE}/identity/signout`,
  accountPortal: "https://k.test/#/p/djdl",
};

/** The client's state directory (the namespaced one the subject file lives in). */
const stateOf = (c: { identity: unknown }): string =>
  (c.identity as { ctx: { dirs: { state: string } } }).ctx.dirs.state;

const extra = { expectedServices: ["license", "config", "identity"] as never };

describe("discovery's identity fragment", () => {
  it("keeps string endpoints and the optional members, and is null while Identity is off", () => {
    const doc = (identity: unknown) =>
      ({ product: "djdl", services: { identity } }) as never;
    expect(
      identityFragmentFrom(
        doc({
          enabled: true,
          issuer: "https://k.test/djdl/identity",
          account: true,
          keyEntryLimit: 10,
          endpoints: { subject: "https://x/s", signout: 4, token: "" },
        }),
      ),
    ).toEqual({
      enabled: true,
      configured: true,
      issuer: "https://k.test/djdl/identity",
      account: true,
      keyEntryLimit: 10,
      endpoints: { subject: "https://x/s" },
    });
    expect(identityFragmentFrom(doc({ enabled: false }))).toBeNull();
    expect(identityFragmentFrom(null)).toBeNull();
  });
});

describe("subject()", () => {
  it("reads the subject, persists it across a restart, and forgets it on a key-only device", async () => {
    let answer: string | null = SUBJECT;
    const routes = {
      "GET /djdl/.well-known/polaris.json": discovery(ALL),
      "GET /djdl/identity/subject": () => json({ subject: answer }),
    };
    const { client, seen } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes,
    });
    expect(await client.identity.subject()).toBe(SUBJECT);
    expect(
      seen
        .find((r) => r.url.endsWith("/identity/subject"))
        ?.headers.get("authorization"),
    ).toBe("Bearer pkeyt_a");
    expect(await readStoredSubject(stateOf(client))).toBe(SUBJECT);
    client.close();

    // A new client on the same state directory still has it.
    const again = await seededClient({
      token: "pkeyt_a",
      extra: {
        ...extra,
        stateDir: (
          client.identity as never as { ctx: { dirs: { state: string } } }
        ).ctx.dirs.state.replace(/\/[^/]+$/, ""),
      },
      routes,
    });
    expect(await readStoredSubject(stateOf(again.client))).toBe(SUBJECT);
    again.client.close();

    answer = null;
    expect(await client.identity.subject()).toBeNull();
    expect(await readStoredSubject(stateOf(client))).toBeNull();
  });

  it("answers service-unavailable, dialling nothing, when discovery names no subject endpoint", async () => {
    const { client, seen } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery({
          signout: ALL.signout,
        }),
      },
    });
    const err = await client.identity.subject().catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err.code).toBe("service-unavailable");
    expect(seen.map((r) => r.url)).toEqual([
      `${BASE}/.well-known/polaris.json`,
    ]);
  });

  it("answers service-unavailable while Identity is off", async () => {
    const { client } = await seededClient({
      token: "pkeyt_a",
      routes: {},
    });
    await expect(client.identity.subject()).rejects.toMatchObject({
      code: "service-unavailable",
    });
  });
});

describe("signOut()", () => {
  it("runs the hooks first, then signs out; released: true drops the token and the identity", async () => {
    const order: string[] = [];
    const { client, store } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery(ALL),
        "GET /djdl/identity/subject": () => json({ subject: SUBJECT }),
        "POST /djdl/identity/signout": () => {
          order.push("signout");
          return json({ released: true });
        },
      },
    });
    await client.identity.subject();
    client.identity.onBeforeSignOut(async () => {
      order.push("hook");
    });
    expect(await client.identity.signOut()).toEqual({ released: true });
    expect(order).toEqual(["hook", "signout"]);
    expect(await store.getToken()).toBeNull();
    expect(client.status().status).toBe("needs-activation");
    expect(await readStoredSubject(stateOf(client))).toBeNull();
  });

  it("released: false keeps the token and the licence", async () => {
    const { client, store } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery(ALL),
        "POST /djdl/identity/signout": () => json({ released: false }),
      },
    });
    expect(await client.identity.signOut()).toEqual({ released: false });
    expect(await store.getToken()).toBe("pkeyt_a");
  });

  it("a failing hook or a refused sign-out changes nothing", async () => {
    let refuse = false;
    const { client, store } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery(ALL),
        "GET /djdl/identity/subject": () => json({ subject: SUBJECT }),
        "POST /djdl/identity/signout": () =>
          refuse ? json({ error: "boom" }, 500) : json({ released: true }),
      },
    });
    await client.identity.subject();
    const remove = client.identity.onBeforeSignOut(() => {
      throw new Error("flush failed");
    });
    await expect(client.identity.signOut()).rejects.toThrow("flush failed");
    expect(await store.getToken()).toBe("pkeyt_a");
    remove();
    refuse = true;
    await expect(client.identity.signOut()).rejects.toMatchObject({
      code: "server-error",
    });
    expect(await store.getToken()).toBe("pkeyt_a");
    expect(await readStoredSubject(stateOf(client))).toBe(SUBJECT);
  });

  it("answers service-unavailable, dialling nothing, when discovery names no signout endpoint", async () => {
    const { client, seen, store } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery({
          subject: ALL.subject,
        }),
      },
    });
    await expect(client.identity.signOut()).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    expect(seen.every((r) => !r.url.includes("signout"))).toBe(true);
    expect(await store.getToken()).toBe("pkeyt_a");
  });
});

describe("openAccount()", () => {
  it("opens the discovered portal link", async () => {
    const { client } = await seededClient({
      token: "pkeyt_a",
      extra,
      routes: { "GET /djdl/.well-known/polaris.json": discovery(ALL) },
    });
    const opened: string[] = [];
    (
      client.identity as unknown as { account: { deps: { openUrl: unknown } } }
    ).account.deps.openUrl = async (u: string) => (opened.push(u), true);
    expect(await client.identity.openAccount()).toEqual({
      url: ALL.accountPortal,
      opened: true,
    });
    expect(opened).toEqual([ALL.accountPortal]);
  });

  it("is unavailable without an accountPortal, and refuses an unsafe link", async () => {
    for (const portal of [
      undefined,
      "javascript:alert(1)",
      "http://evil.test/",
    ]) {
      const { client } = await seededClient({
        token: "pkeyt_a",
        extra,
        routes: {
          "GET /djdl/.well-known/polaris.json": discovery({
            ...ALL,
            ...(portal ? { accountPortal: portal } : {}),
            ...(portal ? {} : { accountPortal: "" }),
          }),
        },
      });
      await expect(client.identity.openAccount()).rejects.toMatchObject({
        code: "service-unavailable",
      });
    }
  });
});
