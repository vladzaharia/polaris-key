// @pkey-feature identity.choice
// `identity.choice.*` beyond what the recordings show (I-10a.8): the typed N/A with no request
// when discovery names no endpoint, a refusal is a result that keeps the device token, `keep`
// passes `attachable` on, the retry data and the fresh view ride a refusal, and the grant never
// shows in a thrown error. The wire conversation itself is the transcripts' (`choice-*`).

import { describe, expect, it } from "vitest";
import { UnsupportedError } from "@polaris-key/client-core";
import { json, seededClient, type Handler } from "./parityFixtures.js";

const BASE = "https://k.test/djdl";
const GRANT = `sg_${"A".repeat(43)}`;
const extra = { expectedServices: ["license", "config", "identity"] as never };

const ALL = {
  choiceLicenses: `${BASE}/identity/choice/licenses`,
  choiceDevices: `${BASE}/identity/choice/devices`,
  choiceComplete: `${BASE}/identity/choice/complete`,
  choiceCancel: `${BASE}/identity/choice/cancel`,
};

const discovery =
  (endpoints: Record<string, string>): Handler =>
  () =>
    json({
      product: "djdl",
      services: {
        identity: { enabled: true, configured: true, endpoints },
      },
    });

const TOKEN_OK = {
  access_token: "pkeyt_chosen",
  token_type: "Bearer",
  scope: "profile email",
  schemaVersion: 1,
  device: { id: "D" },
  license: { id: "lic_1" },
  subject: "ps_QQMMVm-ciTWvmWEIfhAVgQ",
};

const VIEW = {
  state: "choose",
  choices: [{ id: "lic_1" }],
  keep: false,
  preselected: null,
  create: null,
  getLicense: null,
};

async function setup(routes: Record<string, Handler>) {
  return seededClient({
    token: "pkeyt_old",
    extra,
    routes: {
      "GET /djdl/.well-known/polaris.json": discovery(ALL),
      ...routes,
    },
  });
}

describe("without a discovery endpoint", () => {
  it("each call answers service-unavailable and dials nothing past discovery", async () => {
    const { client, seen } = await seededClient({
      token: "pkeyt_old",
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery({
          choiceLicenses: ALL.choiceLicenses,
        }),
      },
    });
    for (const call of [
      () => client.identity.choice.devices(GRANT, "lic_1"),
      () => client.identity.choice.complete(GRANT, { kind: "keep" }),
      () => client.identity.choice.cancel(GRANT),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as { code: string };
      expect(err).toBeInstanceOf(UnsupportedError);
      expect(err.code).toBe("service-unavailable");
    }
    expect(seen.filter((r) => r.url.includes("/choice/"))).toEqual([]);
  });
});

describe("complete()", () => {
  it("stores the token, persists the subject and says attachable after keep only", async () => {
    const { client, store } = await setup({
      "POST /djdl/identity/choice/complete": () => json(TOKEN_OK),
    });
    const kept = await client.identity.choice.complete(GRANT, {
      kind: "keep",
    });
    expect(kept).toEqual({
      kind: "ok",
      licenseId: "lic_1",
      subject: TOKEN_OK.subject,
      scope: "profile email",
      attachable: true,
    });
    expect(await store.getToken()).toBe("pkeyt_chosen");
    const picked = await client.identity.choice.complete(GRANT, {
      kind: "license",
      licenseId: "lic_1",
    });
    expect(picked).not.toHaveProperty("attachable");
  });

  it("device_limit is a result with the fresh view and the manage link; the token stays", async () => {
    const { client, store } = await setup({
      "POST /djdl/identity/choice/complete": () =>
        json(
          {
            error: { code: "device_limit" },
            limit: 1,
            deviceCount: 1,
            manageUrl: "https://k.test/manage",
            view: VIEW,
          },
          403,
        ),
    });
    const r = await client.identity.choice.complete(GRANT, {
      kind: "license",
      licenseId: "lic_1",
    });
    expect(r).toEqual({
      kind: "refused",
      code: "device_limit",
      httpStatus: 403,
      view: VIEW,
      manageUrl: "https://k.test/manage",
    });
    expect(await store.getToken()).toBe("pkeyt_old");
  });

  it("rate_limited carries retryAfterSeconds from the body", async () => {
    const { client } = await setup({
      "POST /djdl/identity/choice/complete": () =>
        json({ error: { code: "rate_limited" }, retryAfter: 12.2 }, 429),
    });
    expect(
      await client.identity.choice.complete(GRANT, { kind: "create" }),
    ).toMatchObject({
      kind: "refused",
      code: "rate_limited",
      retryAfterSeconds: 13,
    });
  });

  it("key_entry_limit carries the counts", async () => {
    const { client } = await setup({
      "POST /djdl/identity/choice/complete": () =>
        json(
          {
            error: { code: "key_entry_limit" },
            keyEntries: { used: 10, limit: 10 },
          },
          403,
        ),
    });
    expect(
      await client.identity.choice.complete(GRANT, {
        kind: "key",
        key: "pkey_djdl_x",
      }),
    ).toMatchObject({
      code: "key_entry_limit",
      keyEntries: { used: 10, limit: 10 },
    });
  });

  it("a 5xx throws, without the grant in the message, and keeps the token", async () => {
    const { client, store } = await setup({
      "POST /djdl/identity/choice/complete": () => json({ error: "boom" }, 500),
    });
    const err = (await client.identity.choice
      .complete(GRANT, { kind: "keep" })
      .catch((e: unknown) => e)) as Error & { code: string };
    expect(err.code).toBe("server-error");
    expect(`${err.message}${JSON.stringify(err)}`).not.toContain(GRANT);
    expect(await store.getToken()).toBe("pkeyt_old");
  });

  it("a 200 that is not a sign-in is bad_response and stores nothing", async () => {
    const { client, store } = await setup({
      "POST /djdl/identity/choice/complete": () => json({ ok: true }),
    });
    await expect(
      client.identity.choice.complete(GRANT, { kind: "keep" }),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(await store.getToken()).toBe("pkeyt_old");
  });
});

describe("licenses(), devices() and cancel()", () => {
  it("read views and send no bearer; cancel answers ok on 204", async () => {
    const { client, seen } = await setup({
      "POST /djdl/identity/choice/licenses": () => json(VIEW),
      "POST /djdl/identity/choice/devices": () =>
        json({ licenseId: "lic_1", devices: [], seats: { used: 1, limit: 1 } }),
      "POST /djdl/identity/choice/cancel": () =>
        new Response(null, { status: 204 }),
    });
    expect(await client.identity.choice.licenses(GRANT)).toEqual({
      kind: "ok",
      view: VIEW,
    });
    expect(await client.identity.choice.devices(GRANT, "lic_1")).toMatchObject({
      kind: "ok",
      view: { licenseId: "lic_1" },
    });
    expect(await client.identity.choice.cancel(GRANT)).toEqual({ kind: "ok" });
    for (const r of seen.filter((s) => s.url.includes("/choice/")))
      expect(r.headers.get("authorization")).toBeNull();
  });

  it("an unreadable view is bad_response", async () => {
    const { client } = await setup({
      "POST /djdl/identity/choice/licenses": () => json({ nope: 1 }),
    });
    await expect(client.identity.choice.licenses(GRANT)).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});
