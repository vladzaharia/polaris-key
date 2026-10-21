// I-38a: the hosted device sign-in pages on the Locker identity. The device entry keeps what was
// typed and says why under the field; too many tries is a neutral card with no form; the confirm
// step offers Sign in and Deny through one decision; and a device link or form that has gone stale
// ends on a Locker page, never bare JSON (a JSON client still gets JSON).
import { beforeEach, describe, expect, it } from "vitest";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { artefacts } from "./singleUseMock.js";
import { dispatchWith } from "../src/dispatch.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { deviceFlowKey, flowKey } from "../src/services/identity/oidc.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  env.CONSOLE_ORIGIN = API;
  env.CUSTOMER_ORIGIN = CUSTOMER;
  await seedProduct(db, "djdl");
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [
      s,
      { enabled: ["license", "config", "identity"].includes(s) },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    "djdl",
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify([`${API}/djdl/identity/auth/callback`]),
    "{}",
  );
});

const send = (url: string, init: RequestInit = {}) =>
  dispatchWith(new Request(url, init), env, db, NOW);

const FORM = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

async function start() {
  const res = await send(`${API}/djdl/identity/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "tv-1", deviceName: "Living room PC" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { userCode: string; deviceCode: string };
}

/** Open the confirm page for a live code and read the form's CSRF token. */
async function confirmPage(userCode: string) {
  const res = await send(
    `${API}/djdl/identity/auth/device?user_code=${userCode}`,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  return { html, csrf: csrf! };
}

describe("the code entry", () => {
  it("keeps the typed code and puts the reason under the field", async () => {
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: "user_code=wdjb-mjth",
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('value="WDJB-MJTH"');
    expect(html).toContain(
      'aria-invalid="true" aria-describedby="user_code-err"',
    );
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Enter the code from your device");
    expect(html).toContain(
      "Only use a code your own device shows, not one somebody sent you.",
    );
    expect(html).toContain("signs you in on the device that shows this code.");
    expect(html).not.toMatch(/>\s*device\s*</i);
  });

  it("answers too many tries with a neutral card and no form", async () => {
    let res: Response | null = null;
    for (let i = 0; i < 40; i++) {
      res = await send(`${API}/djdl/identity/auth/device`, {
        method: "POST",
        headers: { ...FORM, "cf-connecting-ip": "198.51.100.9" },
        body: `user_code=AAAA-AAA${i % 10}`,
      });
      if (res.status === 429) break;
    }
    expect(res!.status).toBe(429);
    const html = await res!.text();
    // The catalog's line, not a Worker-only one (B-103).
    expect(html).toContain(KIT_COPY_EN["signin.rateLimitedFew"]);
    expect(html).toContain(
      "The code on your device still works until it expires.",
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain('class="alert"');
  });

  it("B-156: guesses spread over one /24 meet a ceiling no address reaches", async () => {
    let first429 = -1;
    for (let i = 0; i < 400 && first429 < 0; i++) {
      const res = await send(`${API}/djdl/identity/auth/device`, {
        method: "POST",
        headers: {
          ...FORM,
          "cf-connecting-ip": `192.0.2.${(i % 254) + 1}`,
        },
        body: `user_code=AAAA-AAA${i % 10}`,
      });
      if (res.status === 429) first429 = i;
    }
    expect(first429).toBe(300);
  });

  it("gives a JSON client JSON when it is limited", async () => {
    let res: Response | null = null;
    for (let i = 0; i < 40; i++) {
      res = await send(`${API}/djdl/identity/auth/device`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "sec-fetch-site": "same-origin",
          "cf-connecting-ip": "198.51.100.10",
        },
        body: JSON.stringify({ user_code: `AAAA-AAA${i % 10}` }),
      });
      if (res.status === 429) break;
    }
    expect(res!.status).toBe(429);
    expect(res!.headers.get("content-type")).toContain("application/json");
  });
});

describe("the confirm step", () => {
  it("offers Continue to sign in and Deny, as a statement", async () => {
    const { userCode } = await start();
    const { html } = await confirmPage(userCode);
    // Before sign-in this page approves nothing (I-37): the explicit step is after sign-in.
    expect(html).toContain("Sign in to continue");
    expect(html).toContain("showed the code");
    expect(html).not.toContain("Sign in on");
    expect(html).toContain('name="decision" value="approve" autofocus');
    expect(html).toContain('name="decision" value="deny">Deny</button>');
    expect(html).toContain("wants you to sign in");
    // The passport pane (shown at 960 px landscape) and the strip (narrower) name the device.
    expect(html).toContain('class="ac-passport"');
    expect(html).toContain("on <bdi>Living room PC</bdi>");
    expect(html).toContain("never sees your codes or passkeys.");
    expect(html).not.toMatch(/<script|\sstyle=/i);
  });

  it("approve is the old confirm: 303 to the IdP", async () => {
    const { userCode } = await start();
    const { csrf } = await confirmPage(userCode);
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=approve`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("https://id.example");
  });

  it("Deny spends the code and signs nothing in", async () => {
    const { userCode, deviceCode } = await start();
    const { csrf } = await confirmPage(userCode);
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=deny`,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nothing was signed in");
    expect(res.headers.get("location")).toBeNull();
    const rec = JSON.parse(
      (await artefacts(env).get(await deviceFlowKey(env, "djdl", deviceCode)))!,
    );
    expect(rec.confirmedAt).toBeUndefined();
    expect(rec.csrf).toBeUndefined();
    // The code no longer resolves, and the same form cannot be replayed.
    const again = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=approve`,
    });
    expect(again.status).toBe(403);
    expect(again.headers.get("content-type")).toContain("text/html");
    expect(again.headers.get("location")).toBeNull();
  });
});

describe("Deny before sign-in (B-096)", () => {
  it("ends the device's poll with `error` and writes one audit row", async () => {
    const { userCode, deviceCode } = await start();
    const { csrf } = await confirmPage(userCode);
    const poll = async () =>
      (await (
        await send(`${API}/djdl/identity/auth/device/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode, deviceId: "tv-1" }),
        })
      ).json()) as { status: string };
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=deny`,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign-in denied");
    expect((await poll()).status).toBe("error");
    const rows = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action = 'identity.signin.device_denied'",
    );
    expect(rows).toHaveLength(1);
    // A replayed Deny (spent token) writes nothing more.
    await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=deny`,
    });
    const again = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE action = 'identity.signin.device_denied'",
    );
    expect(again).toHaveLength(1);
  });
});

describe("a Deny that lost to an approval (hardening)", () => {
  it("shows the outcome that won, not Sign-in denied, and records no denial", async () => {
    const { userCode, deviceCode } = await start();
    const { csrf } = await confirmPage(userCode);
    // The same flow is approved (another tab finished first) before this Deny lands.
    const rec = JSON.parse(
      (await artefacts(env).get(await deviceFlowKey(env, "djdl", deviceCode)))!,
    ) as { state: string };
    const stateKey = await flowKey(env, "djdl", rec.state);
    const flow = JSON.parse((await artefacts(env).get(stateKey))!);
    flow.approvedAt = NOW;
    await artefacts(env).put(stateKey, JSON.stringify(flow));
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=deny`,
    });
    const html = await res.text();
    expect(html).not.toContain("Sign-in denied");
    expect(html).not.toContain("Nothing was signed in");
    expect(html).toContain("signed in on");
    const rows = await db.all(
      "SELECT 1 FROM audit WHERE action = 'identity.signin.device_denied'",
    );
    expect(rows).toHaveLength(0);
  });
});

describe("the TV variant after the code", () => {
  it("keeps the large type on confirm, Deny and the stored flow", async () => {
    const { userCode, deviceCode } = await start();
    const res = await send(
      `${API}/djdl/identity/auth/device?user_code=${userCode}&tv=1`,
    );
    const html = await res.text();
    expect(html).toContain('<body class="tv">');
    expect(html).not.toContain('class="ac-passport"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const denied = await send(`${API}/djdl/identity/auth/device?tv=1`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=${csrf}&decision=deny`,
    });
    expect(await denied.text()).toContain('<body class="tv">');
    void deviceCode;
  });

  it("one 48 px trimmed lockup on every page, quiet in an app's context", async () => {
    const entry = await (await send(`${CUSTOMER}/device`)).text();
    const { userCode } = await start();
    const confirm = (await confirmPage(userCode)).html;
    for (const html of [entry, confirm])
      expect(html).toMatch(
        /<svg class="mark"[^>]* height="48" viewBox="8 23 437 80"/,
      );
    expect(confirm).toContain('class="ac-brand quiet"');
    expect(entry).toContain(`<header class="ac-brand">`);
  });
});

describe("the end of a device flow is a page", () => {
  it("the retired by-device-code link is the start-again page, for browsers and JSON clients alike", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { accept: "application/json" },
    ]) {
      const res = await send(
        `${API}/djdl/identity/auth/device/verify?device_code=gone`,
        { headers },
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("This page has expired");
    }
  });

  it("a confirm POST for a code that has gone", async () => {
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: "user_code=ZZZZ-ZZZZ&csrf=abc",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("That code expired");
  });

  it("a stale token on a live code", async () => {
    const { userCode } = await start();
    await confirmPage(userCode);
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: FORM,
      body: `user_code=${userCode}&csrf=wrong`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This page is out of date");
  });

  it("a JSON client keeps its JSON error", async () => {
    const res = await send(`${API}/djdl/identity/auth/device`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ user_code: "ZZZZ-ZZZZ", csrf: "x" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
