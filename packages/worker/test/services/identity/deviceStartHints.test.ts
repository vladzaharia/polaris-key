/// <reference types="@cloudflare/workers-types" />
/**
 * UK-42.22.2: the device-code start takes the hints and the licence-choice mode (WIRE-CONTRACT-V5
 * §12.10.1) and the card's request view serves them (§12.7.2).
 *
 *   - the four members are validated as `authorize` validates them: a bad `purpose` or
 *     `licenseChoice`, or a non-string member, is `400 bad_request` and writes nothing; a hint that
 *     does not normalise is dropped;
 *   - they are stored with the flow and the device request record and read back by the view, which
 *     has no `scope`;
 *   - the start's answer does not change, and a start that sends none of them is card mode with
 *     the view it always had.
 */

import { describe, expect, it } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { getArtefact } from "../../../src/core/singleUse.js";
import { deviceFlowKey } from "../../../src/services/identity/productOidc/config.js";
import { BASE_URL, type World } from "../../transcripts/recorder.js";
import { DEVICE, T0 } from "../../transcripts/client.js";
import { PRODUCT } from "../../transcripts/world.js";
import {
  identityWorld,
  START,
  type Started,
} from "../../transcripts/scenarios/identity.js";

function start(w: World, body: Record<string, unknown>): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE_URL}${START}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: DEVICE, ...body }),
    }) as unknown as Request,
    w.env,
    w.db,
    T0,
  );
}

async function started(
  w: World,
  body: Record<string, unknown>,
): Promise<Started> {
  const res = await start(w, body);
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}

/** The card's request view of a started flow: open the code page, then read the handle. */
async function view(
  w: World,
  userCode: string,
): Promise<Record<string, unknown>> {
  const page = await dispatchWith(
    new Request(
      `${BASE_URL}/${PRODUCT}/identity/auth/device?user_code=${userCode}`,
    ) as unknown as Request,
    w.env,
    w.db,
    T0,
  );
  expect(page.status).toBe(200);
  const handle = /data-request="(rq_[A-Za-z0-9_-]{22})"/.exec(
    await page.text(),
  )?.[1];
  expect(handle).toBeTruthy();
  const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
  const res = await dispatchWith(
    new Request(`${BASE_URL}/api/signin/requests/${handle}`, {
      headers: { cookie },
    }) as unknown as Request,
    w.env,
    w.db,
    T0,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const STARTED_KEYS = [
  "status",
  "deviceCode",
  "userCode",
  "verificationUri",
  "verificationUriComplete",
  "expiresIn",
  "interval",
  "pollUrl",
  "deviceName",
].sort();

describe("the device start's hints (§12.10.1)", () => {
  it("serves the four members in the card's view, with no scope", async () => {
    const w = await identityWorld();
    const s = await started(w, {
      deviceName: "Den PC",
      loginHint: "Ada@Example.com",
      nameHint: "  Ada\u202e Lovelace ",
      purpose: "attach",
      licenseChoice: "app",
    });
    const v = await view(w, s.userCode);
    expect(v).toMatchObject({
      purpose: "attach",
      licenseChoice: "app",
      loginHint: "ada@example.com",
      nameHint: "Ada Lovelace",
      deviceLabel: "Den PC",
    });
    expect(v).not.toHaveProperty("scope");
  });

  it("changes nothing in the start's answer, and stores the hints on the flow", async () => {
    const w = await identityWorld();
    const plain = await started(w, {});
    const hinted = await started(w, {
      purpose: "attach",
      licenseChoice: "app",
      nameHint: "Ada",
    });
    expect(Object.keys(plain).sort()).toEqual(STARTED_KEYS);
    expect(Object.keys(hinted).sort()).toEqual(STARTED_KEYS);
    const raw = await getArtefact(
      w.env,
      await deviceFlowKey(w.env, PRODUCT, hinted.deviceCode),
    );
    expect(JSON.parse(raw!).hints).toEqual({
      purpose: "attach",
      licenseChoice: "app",
      loginHint: null,
      nameHint: "Ada",
    });
  });

  it("defaults the members the start left out, as authorize does", async () => {
    const w = await identityWorld();
    const s = await started(w, { licenseChoice: "app" });
    expect(await view(w, s.userCode)).toMatchObject({
      purpose: "signin",
      licenseChoice: "app",
      loginHint: null,
      nameHint: null,
    });
  });

  it("drops a hint that does not normalise, never an error", async () => {
    const w = await identityWorld();
    const s = await started(w, {
      loginHint: "not an email",
      nameHint: " \u200b ",
    });
    expect(await view(w, s.userCode)).toMatchObject({
      purpose: "signin",
      licenseChoice: "card",
      loginHint: null,
      nameHint: null,
    });
  });

  it("a start with none of the members is card mode with the view it always had", async () => {
    const w = await identityWorld();
    const s = await started(w, { deviceName: "TV" });
    const v = await view(w, s.userCode);
    for (const k of [
      "purpose",
      "licenseChoice",
      "loginHint",
      "nameHint",
      "scope",
    ])
      expect(v).not.toHaveProperty(k);
    const raw = await getArtefact(
      w.env,
      await deviceFlowKey(w.env, PRODUCT, s.deviceCode),
    );
    expect(JSON.parse(raw!)).not.toHaveProperty("hints");
  });

  it.each([
    ["an unknown purpose", { purpose: "login" }],
    ["an unknown licenseChoice", { licenseChoice: "both" }],
    ["a non-string purpose", { purpose: 1 }],
    ["a non-string licenseChoice", { licenseChoice: true }],
    ["a non-string loginHint", { loginHint: ["a@b.co"] }],
    ["a non-string nameHint", { nameHint: 7 }],
    ["a null purpose", { purpose: null }],
  ])("%s is 400 bad_request and writes nothing", async (_n, extra) => {
    const w = await identityWorld();
    const before = w.kv.keys().length;
    const res = await start(w, extra);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    // Refused before anything is written: no flow, no device record, no user code.
    expect(w.kv.keys().length).toBe(before);
  });

  it("ignores scope", async () => {
    const w = await identityWorld();
    const res = await start(w, {
      scope: "openid nonsense",
      licenseChoice: "app",
    });
    expect(res.status).toBe(200);
  });
});
