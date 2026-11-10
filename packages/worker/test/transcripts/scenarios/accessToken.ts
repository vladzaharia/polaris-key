/// <reference types="@cloudflare/workers-types" />
// The device exchange (I-21.13, WIRE-CONTRACT-V5 §12.13.10, `identity.accessToken`): a product's own app
// trades its device token for a 600 s access token its developer's backend can verify.
//
//   identity-access-token   discovery names `accessToken: true`; the exchange answers a token;
//                           a device that is not signed in is `invalid_grant`; the per-device
//                           budget is a `429`; with the issuer turned off the exchange is
//                           `invalid_request` and discovery no longer names `accessToken`, so the
//                           client sends nothing.
//
// The recorded client is the product's own app, signed in as Ada on `DEVICE`. The issuer key is the
// fixed test key (`../issuerKey.ts`): RSA key generation is not seeded, and a recorded token must
// be byte-stable. The token's claims (iss, sub, aud, client_id, iat, exp, jti, scope) are pinned by
// the Worker suite (`test/services/identity/issuer/issuerDeviceExchange.test.ts`); a replayer holds
// the token as an opaque string.

import { expect } from "vitest";
import type { JsonValue } from "../format.js";
import { ingestIdentity } from "../../services/identity/issuer/issuerHelpers.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import { TOKEN_DEVICE_RATE } from "../../../src/services/identity/passthrough/token.js";
import {
  ACCESS_TOKEN_TYPE,
  DEVICE_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "@polaris-key/protocol/identity";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { pinned, PRODUCT, productWorld, servicesOn } from "../world.js";
import type { Scenario } from "../world.js";
import { installIssuerKey } from "../issuerKey.js";
import { DEVICE, discovery, T0, VERSION } from "../client.js";
import { seedAccount } from "./account.js";
import { codeOf, jsonOf, services } from "./exchange.js";
import { signedInDevice } from "./restore.js";

type Json = Record<string, JsonValue>;

const FEATURES = ["identity.accessToken"];
const TOKEN = `/${PRODUCT}/identity/token`;

/** Setup: a world with Identity on, the issuer served under the fixed test key, and Ada's device signed in. */
async function accessTokenWorld(): Promise<{ w: World; token: string }> {
  const w = await productWorld(servicesOn("config", "identity"));
  w.env.PORTAL_SESSION_SECRET = "transcript-portal-session-secret";
  await ingestIdentity(w.db, PRODUCT, { issuer: { enabled: true } }, T0);
  await installIssuerKey(w.env, w.db, PRODUCT, T0);
  const token = await signedInDevice(
    w,
    await seedAccount(w, "ada@example.com"),
  );
  return { w, token };
}

/**
 * The exchange of §12.13.10: the device's own token as the subject token. The token is the
 * transcript's `initial.token`, so a replaying client sends the recorded value and the body is
 * asserted exactly (a body carries no placeholders).
 */
async function exchangeCall(
  s: StepRecorder,
  token: string,
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const form = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: PRODUCT,
    subject_token: token,
    subject_token_type: DEVICE_SUBJECT_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
  };
  const res = await s.send({
    method: "POST",
    path: TOKEN,
    form,
    expectBody: { json: form, match: "exact" },
  });
  return { res, json: await jsonOf(res) };
}

const refused = (code: string, status = 400, extra: Json = {}): Json => ({
  result: "refused",
  status,
  code,
  accessTokenHeld: false,
  ...extra,
});

const discoverStep = (
  r: TranscriptRecorder,
  offered: boolean,
  now?: number,
  note?: string,
): Promise<void> =>
  r.step(
    {
      action: "discover",
      ...(now !== undefined ? { now } : {}),
      ...(note ? { note } : {}),
    },
    async (s) => {
      const answer = await discovery(s, PRODUCT);
      expect(answer.status).toBe(200);
      const fragment = (
        (await jsonOf(answer)).services as Record<string, unknown>
      ).identity as Record<string, unknown>;
      expect(fragment.accessToken).toBe(offered ? true : undefined);
    },
    {
      result: "ok",
      services: services({ config: true, identity: true }),
      accessToken: offered,
    },
  );

export const identityAccessToken: Scenario = {
  id: "identity-access-token",
  record: () =>
    pinned("identity-access-token", async (pin) => {
      const { w, token } = await accessTokenWorld();
      const r = new TranscriptRecorder({
        id: "identity-access-token",
        description:
          "The device exchange (I-21.13, WIRE-CONTRACT-V5 §12.13.10, D6): the product's own app trades its device token for a 600 second access token for its developer's backend. Discovery names accessToken: true while the product's issuer is served. The app posts a token-exchange form to token: grant_type urn:ietf:params:oauth:grant-type:token-exchange, client_id the product slug, subject_token its own device token, subject_token_type urn:polaris-key:token-type:device and requested_token_type urn:ietf:params:oauth:token-type:access_token, with X-PKey-Device and no Authorization. The answer is exactly access_token (a compact RS256 JWS the client keeps in memory), issued_token_type, token_type Bearer, expires_in 600 and an empty scope: never a refresh token or an id_token. A device that is not signed in is 400 invalid_grant; the budget is ten a minute per device (429 rate_limited with retryAfter); with the issuer turned off the exchange is 400 invalid_request and discovery names no accessToken, so the client sends nothing and raises service-unavailable.",
        features: ["core.discover", ...FEATURES],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["config", "identity"],
          token,
        },
      });
      await discoverStep(r, true);
      await r.step(
        {
          action: "accessToken",
          now: T0 + 60,
          note: "Signed in: the exchange answers a 600 second access token. Nothing else rides with it.",
          args: {},
        },
        async (s) => {
          const { res, json } = await exchangeCall(s, token);
          expect(res.status).toBe(200);
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(Object.keys(json).sort()).toEqual([
            "access_token",
            "expires_in",
            "issued_token_type",
            "scope",
            "token_type",
          ]);
          expect(json.expires_in).toBe(600);
          expect(json.scope).toBe("");
        },
        {
          result: "ok",
          accessTokenHeld: true,
          tokenType: "Bearer",
          expiresIn: 600,
        },
      );
      // The budget: ten calls in this minute fill the device's ten a minute.
      for (let i = 0; i < TOKEN_DEVICE_RATE.limit; i += 1)
        expect(
          await rateLimitOk(
            w.env,
            PRODUCT,
            { ...TOKEN_DEVICE_RATE, id: DEVICE },
            T0 + 120,
          ),
        ).toBe(true);
      await r.step(
        {
          action: "accessToken",
          now: T0 + 120,
          note: "The eleventh call of the minute: 429 rate_limited, retryAfter in the body.",
          args: {},
        },
        async (s) => {
          const { res, json } = await exchangeCall(s, token);
          expect(res.status).toBe(429);
          expect(codeOf(json)).toBe("rate_limited");
        },
        refused("rate_limited", 429, {
          retryAfter: TOKEN_DEVICE_RATE.windowSec,
        }),
      );
      await r.step(
        {
          action: "accessToken",
          now: T0 + 300,
          note: "The device is signed out elsewhere: no sign-in to exchange. The one invalid_grant.",
          args: {},
        },
        async (s) => {
          await w.db.run(
            "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
            PRODUCT,
            DEVICE,
          );
          const { res, json } = await exchangeCall(s, token);
          expect(res.status).toBe(400);
          expect(codeOf(json)).toBe("invalid_grant");
        },
        refused("invalid_grant"),
      );
      await r.step(
        {
          action: "accessToken",
          now: T0 + 360,
          note: "The developer turned the issuer off after the client read discovery: the token type is unknown, 400 invalid_request.",
          args: {},
        },
        async (s) => {
          await ingestIdentity(
            w.db,
            PRODUCT,
            { issuer: { enabled: false } },
            T0 + 360,
          );
          const { res, json } = await exchangeCall(s, token);
          expect(res.status).toBe(400);
          expect(codeOf(json)).toBe("invalid_request");
        },
        refused("invalid_request"),
      );
      await discoverStep(
        r,
        false,
        T0 + 420,
        "Discovery afterwards names no accessToken.",
      );
      await r.step(
        {
          action: "accessToken",
          now: T0 + 480,
          note: "Discovery names no accessToken: the client sends nothing.",
          args: {},
        },
        async () => {},
        { result: "unavailable", accessTokenHeld: false },
      );
      return r.transcript();
    }),
};

export const ACCESS_TOKEN_SCENARIOS: Scenario[] = [identityAccessToken];
