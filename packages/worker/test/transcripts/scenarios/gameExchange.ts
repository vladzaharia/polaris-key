/// <reference types="@cloudflare/workers-types" />
// Game Center and Play Games on the token exchange and the link offer (I-14.9, WIRE-CONTRACT-V5
// §12.11.7), plus the discovery that names them.
//
//   exchange-gamecenter-silent    a linked team player with consent gets a device token
//   exchange-gamecenter-no-link   no link: interstitial_required with a linkHandle
//   exchange-gamecenter-errors    a stale timestamp, a second use and an undeclared bundle are
//                                 one invalid_grant; the launch gate off is invalid_request
//   exchange-pgs-silent           the same for a Play Games server auth code
//   exchange-pgs-no-link          no link: interstitial_required with a linkHandle
//   exchange-pgs-errors           a refused code and a refused verify are invalid_grant, Google's
//                                 503 is unavailable
//   link-game                     a link by handle (Game Center) and by token (Play Games)
//
// How the verifiers run. Both are the real ones; only their outbound hosts and Apple's trust
// anchors are replaced, so the recorded conversation between client and Worker is the one a
// device would have. Game Center: `gameChain.ts` signs the token with a fixture RSA leaf, Apple's
// key host is a fetch fake that serves that leaf, and `transcripts.test.ts` mocks the pinned
// anchors module with the fixture root and intermediate (there is no runtime switch). Play Games:
// Google's token endpoint and games API are fetch fakes (`routes`); the server credential is
// stored through the real outlet vault. The device's half is `args`: the structured Game Center
// fields (the client encodes the `gc1.` token and the recorded body is matched exactly) and the
// server auth code.

import { expect } from "vitest";
import type { StepRecorder, World } from "../recorder.js";
import { DEVICE, T0 } from "../client.js";
import type { JsonValue } from "../format.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import {
  fixtureDeviceKeys,
  PRODUCT_AUDIENCES,
  withProviders,
} from "../providers.js";
import {
  asJson,
  GC_KEY_URL,
  gameCenterArgs,
  gameCenterCertificate,
  gameCenterToken,
  PGS_APP,
  PGS_CODE,
  PGS_PLAYER,
  type GameCenterArgs,
} from "../gameChain.js";
import {
  exchangeStep,
  noLinkSeen,
  type Attempt,
  exchangeWorld,
  KEY_LABEL,
  recorder,
} from "./exchange.js";
import {
  holdKeys,
  LATER,
  linkWorld,
  offerStep,
  signInSteps,
  type Rec,
} from "./link.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { askedScopeHash } from "../../../src/services/identity/passthrough/routes.js";
import {
  GAME_CENTER_SUBJECT_TOKEN_TYPE,
  PGS_SUBJECT_TOKEN_TYPE,
} from "@polaris-key/protocol/identity";

type Json = Record<string, JsonValue>;
type Routes = Record<string, () => Response>;

const GC = ["identity.gamecenter"];
const PGS = ["identity.pgs"];
const TEAM = PRODUCT_AUDIENCES.appleTeam;
const BUNDLE = PRODUCT_AUDIENCES.appleBundle;
const NONCE = `/${PRODUCT}/identity/nonce`;
const LINK = `/${PRODUCT}/identity/link`;

// ── the world ─────────────────────────────────────────────────────────────────────────────────

/** An exchange world whose product also declares Game Center and Play Games (with a stored
 *  server credential), so discovery lists both kinds. */
const gameWorld = (): Promise<World> =>
  exchangeWorld(["config", "identity"], true);

/** A person whose game identity is linked to their account, with or without consent to this app. */
async function linkedGame(
  w: World,
  kind: "gamecenter" | "pgs",
  consented: boolean,
): Promise<void> {
  const tenantScope =
    kind === "gamecenter" ? `apple-team:${TEAM}` : `pgs-app:${PGS_APP}`;
  const subject =
    kind === "gamecenter" ? "T:transcript-team-player-1" : PGS_PLAYER;
  const r = await signIn(
    w.db,
    {
      issuerKey: kind,
      tenantScope,
      subject,
      kind,
      email: "ada@example.com",
      emailVerified: true,
    },
    T0,
    { unfenced: true, product: { slug: PRODUCT, tenantScopes: [tenantScope] } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  if (!consented) return;
  const pub = (await loadProductPublic(w.db, PRODUCT))!;
  await w.db.run(
    `INSERT INTO account_product_grants
       (account_id, product, claims_json, granted_at, modified_at, scope_hash)
     VALUES (?, ?, '["profile","email"]', ?, ?, ?)`,
    r.account.id,
    PRODUCT,
    T0,
    T0,
    await askedScopeHash(pub),
  );
}

// ── the outbound hosts ────────────────────────────────────────────────────────────────────────

const jsonOf = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const APPLE_HOST: Routes = { [GC_KEY_URL]: gameCenterCertificate };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VERIFY_URL = `https://games.googleapis.com/games/v1/applications/${PGS_APP}/verify`;
const ME_URL = "https://games.googleapis.com/games/v1/players/me";
const GOOD_REDEEM = () =>
  jsonOf(200, {
    access_token: "fake-access-token",
    token_type: "Bearer",
    expires_in: 3599,
  });
const GOOD_VERIFY = () =>
  jsonOf(200, {
    kind: "games#applicationVerifyResponse",
    player_id: PGS_PLAYER,
    alternate_player_id: "pgs-player-alt",
  });
const GOOGLE_GAMES: Routes = {
  [TOKEN_URL]: GOOD_REDEEM,
  [VERIFY_URL]: GOOD_VERIFY,
};

// ── the steps ─────────────────────────────────────────────────────────────────────────────────

const OK_TOKEN: Json = {
  result: "ok",
  tokenHeld: true,
  scope: "profile email",
  issuedTokenType: "urn:polaris-key:token-type:device",
  licenseId: null,
};

/** The check of an exchange that signs the device in. */
const deviceTokenIssued = (a: Attempt): void => {
  expect(a.grant!.status).toBe(200);
  expect(a.json.issued_token_type).toBe("urn:polaris-key:token-type:device");
};

const gcFields = (a: GameCenterArgs): Json => ({ gameCenter: asJson(a) });

/** One Game Center `exchange`: the structured fields go in `args`, the client encodes `gc1.`. */
function gcStep(
  r: Rec,
  a: GameCenterArgs,
  note: string,
  check: Parameters<typeof exchangeStep>[2],
  expectation: Json,
): Promise<void> {
  return exchangeStep(
    r,
    {
      kind: "gamecenter",
      note,
      args: gcFields(a),
      mint: async () => gameCenterToken(a),
      game: { type: GAME_CENTER_SUBJECT_TOKEN_TYPE, routes: APPLE_HOST },
    },
    check,
    expectation,
  );
}

/** One Play Games `exchange`: `args.serverAuthCode` is the code the client obtained. */
function pgsStep(
  r: Rec,
  note: string,
  routes: Routes,
  check: Parameters<typeof exchangeStep>[2],
  expectation: Json,
  code = PGS_CODE,
): Promise<void> {
  return exchangeStep(
    r,
    {
      kind: "pgs",
      note,
      args: { serverAuthCode: code },
      mint: async () => code,
      game: { type: PGS_SUBJECT_TOKEN_TYPE, routes },
    },
    check,
    expectation,
  );
}

function newRecorder(
  w: World,
  pin: Parameters<typeof recorder>[1],
  id: string,
  description: string,
  features: string[],
): Rec {
  return recorder(w, pin, id, description, ["config", "identity"], features);
}

// ── Game Center ───────────────────────────────────────────────────────────────────────────────

export const exchangeGameCenterSilent: Scenario = {
  id: "exchange-gamecenter-silent",
  record: () =>
    pinned("exchange-gamecenter-silent", async (pin) => {
      const w = await gameWorld();
      await linkedGame(w, "gamecenter", true);
      const r = newRecorder(
        w,
        pin,
        "exchange-gamecenter-silent",
        "Game Center sign-in with nothing to ask (WIRE-CONTRACT-V5 §12.11.7). The app checks that the local player is already authenticated, so it never presents the Game Center view at launch. exchange() posts the device's keys for a nonce, then takes the player's identity-verification signature from Game Center (public key URL, signature, salt, timestamp in milliseconds, team player id, bundle id) and sends the gc1. token: six dot-joined fields, every one base64url except the decimal timestamp. The grant is the usual form with subject_token_type urn:polaris-key:token-type:gamecenter-signature and the exchange proof over the nonce, the key and the token's hash. The Worker checks the certificate chain, the signature and the window, and finds the team player linked under the developer's team with consent already given: the answer is a device token. The Worker's call to Apple's key host is not part of this conversation.",
        GC,
      );
      await gcStep(
        r,
        await gameCenterArgs({ bundleId: BUNDLE }),
        "A signed-in local player; the signature is fresh and the bundle is declared.",
        deviceTokenIssued,
        OK_TOKEN,
      );
      return r.transcript();
    }),
};

export const exchangeGameCenterNoLink: Scenario = {
  id: "exchange-gamecenter-no-link",
  record: () =>
    pinned("exchange-gamecenter-no-link", async (pin) => {
      const w = await gameWorld();
      const r = newRecorder(
        w,
        pin,
        "exchange-gamecenter-no-link",
        "A valid Game Center token that no account links (WIRE-CONTRACT-V5 §12.11.3 rule 4, §12.11.7). Nothing is created and nothing is bound. The answer is 403 interstitial_required with reason no_link, the sign-in card's url and a linkHandle (lh_ and 43 characters, 600 s), so the app can offer the link without asking Game Center for a second signature. The SDK reports needs-sign-in carrying the handle.",
        GC,
      );
      const seen: Json = { result: "interstitial-required" };
      await gcStep(
        r,
        await gameCenterArgs({ bundleId: BUNDLE }),
        "A fresh signature for a player nobody linked.",
        noLinkSeen(seen),
        seen,
      );
      return r.transcript();
    }),
};

export const exchangeGameCenterErrors: Scenario = {
  id: "exchange-gamecenter-errors",
  record: () =>
    pinned("exchange-gamecenter-errors", async (pin) => {
      const w = await gameWorld();
      await linkedGame(w, "gamecenter", true);
      const r = newRecorder(
        w,
        pin,
        "exchange-gamecenter-errors",
        "Every Game Center verifier failure is the same refusal (WIRE-CONTRACT-V5 §12.11.7). A signature older than the 120 s window, a signature the Worker has already accepted and a bundle id the product does not declare all answer 400 invalid_grant with the same bytes, so a caller learns nothing about which check failed. A good exchange spends its signature: sending the same token with a new nonce is refused. A Worker whose Game Center and Play Games launch gate is off does not serve the token type at all and answers 400 invalid_request; a client with discovery from before the gate went off holds no token and may sign in another way.",
        GC,
      );
      const bodies: string[] = [];
      const refused = (a: GameCenterArgs, note: string) =>
        gcStep(
          r,
          a,
          note,
          (res) => {
            expect(res.grant!.status).toBe(400);
            expect(res.json.error).toBe("invalid_grant");
            bodies.push(JSON.stringify(res.json));
          },
          { result: "refused", code: "invalid_grant", tokenHeld: false },
        );
      await refused(
        await gameCenterArgs({
          bundleId: BUNDLE,
          timestamp: T0 * 1000 - 300_000,
        }),
        "A signature from five minutes ago.",
      );
      await refused(
        await gameCenterArgs({ bundleId: "com.example.undeclared" }),
        "A bundle id the product does not declare.",
      );
      const good = await gameCenterArgs({ bundleId: BUNDLE });
      await gcStep(
        r,
        good,
        "A good exchange spends its signature.",
        (a) => expect(a.grant!.status).toBe(200),
        OK_TOKEN,
      );
      await refused(good, "The same signature again, with a new nonce.");
      for (const b of bodies) expect(b).toBe(bodies[0]);
      (w.env as unknown as Record<string, unknown>).LAUNCH_GAME_SIGN_IN = "off";
      await gcStep(
        r,
        await gameCenterArgs({
          bundleId: BUNDLE,
          timestamp: T0 * 1000 - 4_000,
        }),
        "The launch gate is off: the token type is not served.",
        (a) => {
          expect(a.grant!.status).toBe(400);
          expect(a.json.error).toBe("invalid_request");
        },
        { result: "refused", code: "invalid_request", tokenHeld: false },
      );
      return r.transcript();
    }),
};

// ── Play Games ────────────────────────────────────────────────────────────────────────────────

export const exchangePgsSilent: Scenario = {
  id: "exchange-pgs-silent",
  record: () =>
    pinned("exchange-pgs-silent", async (pin) => {
      const w = await gameWorld();
      await linkedGame(w, "pgs", true);
      const r = newRecorder(
        w,
        pin,
        "exchange-pgs-silent",
        "Play Games sign-in with nothing to ask (WIRE-CONTRACT-V5 §12.11.7). The app checks that the player is already authenticated, so it never calls signIn at launch. exchange() posts the device's keys for a nonce, asks Play Games for a server auth code for the product's server client id (named in discovery as exchange.pgs.serverClientId) and sends the code as the subject token with subject_token_type urn:polaris-key:token-type:pgs-server-auth-code and the exchange proof. The Worker redeems the code and asks Google which player and application it was granted to; the player is linked under the product's application, so the answer is a device token. The Worker's calls to Google are not part of this conversation, and the access token never leaves the Worker.",
        PGS,
      );
      await pgsStep(
        r,
        "A signed-in player with a fresh server auth code.",
        GOOGLE_GAMES,
        deviceTokenIssued,
        OK_TOKEN,
      );
      return r.transcript();
    }),
};

export const exchangePgsNoLink: Scenario = {
  id: "exchange-pgs-no-link",
  record: () =>
    pinned("exchange-pgs-no-link", async (pin) => {
      const w = await gameWorld();
      const r = newRecorder(
        w,
        pin,
        "exchange-pgs-no-link",
        "A valid Play Games server auth code for a player no account links (WIRE-CONTRACT-V5 §12.11.3 rule 4, §12.11.7). Nothing is created and nothing is bound. The answer is 403 interstitial_required with reason no_link, the sign-in card's url and a linkHandle (lh_ and 43 characters, 600 s). The SDK reports needs-sign-in carrying the handle.",
        PGS,
      );
      const seen: Json = { result: "interstitial-required" };
      await pgsStep(
        r,
        "A fresh code for a player nobody linked.",
        GOOGLE_GAMES,
        noLinkSeen(seen),
        seen,
      );
      return r.transcript();
    }),
};

export const exchangePgsErrors: Scenario = {
  id: "exchange-pgs-errors",
  record: () =>
    pinned("exchange-pgs-errors", async (pin) => {
      const w = await gameWorld();
      await linkedGame(w, "pgs", true);
      const r = newRecorder(
        w,
        pin,
        "exchange-pgs-errors",
        "Play Games refusals (WIRE-CONTRACT-V5 §12.11.7). A code Google refuses to redeem, and an application verify and a player lookup that both refuse, answer 400 invalid_grant with the same bytes. A verify that is refused for scope falls back to the player lookup, which is not refused here, so a later good exchange still signs in. Google answering 503 is the Worker's 503 unavailable, a failure to retry later: the SDK holds no token and the person is not told the code was bad.",
        PGS,
      );
      const bodies: string[] = [];
      const refused = (note: string, routes: Routes) =>
        pgsStep(
          r,
          note,
          routes,
          (a) => {
            expect(a.grant!.status).toBe(400);
            expect(a.json.error).toBe("invalid_grant");
            bodies.push(JSON.stringify(a.json));
          },
          { result: "refused", code: "invalid_grant", tokenHeld: false },
        );
      await refused("Google refuses to redeem the code.", {
        [TOKEN_URL]: () => jsonOf(400, { error: "invalid_grant" }),
      });
      await refused("Verify and the player lookup are both refused.", {
        [TOKEN_URL]: GOOD_REDEEM,
        [VERIFY_URL]: () => jsonOf(403, { error: { code: 403 } }),
        [ME_URL]: () => jsonOf(403, { error: { code: 403 } }),
      });
      for (const b of bodies) expect(b).toBe(bodies[0]);
      await pgsStep(
        r,
        "Verify is refused for scope; the player lookup answers.",
        {
          [TOKEN_URL]: GOOD_REDEEM,
          [VERIFY_URL]: () => jsonOf(403, { error: { code: 403 } }),
          [ME_URL]: () =>
            jsonOf(200, { kind: "games#player", playerId: PGS_PLAYER }),
        },
        (a) => expect(a.grant!.status).toBe(200),
        OK_TOKEN,
      );
      await pgsStep(
        r,
        "Google is down.",
        { [TOKEN_URL]: () => jsonOf(503, { error: "unavailable" }) },
        (a) => {
          expect(a.grant!.status).toBe(503);
          expect(a.json.error).toBe("unavailable");
        },
        { result: "refused", code: "unavailable", tokenHeld: false },
      );
      return r.transcript();
    }),
};

// ── the link offer ────────────────────────────────────────────────────────────────────────────

/** `POST link` with a provider token, as the SDK sends it when it holds no handle: a nonce for the
 *  device's keys, then {subjectToken, subjectTokenType, nonce, signKey, agreeKey, proof}. */
async function linkByTokenStep(
  r: Rec,
  o: { note: string; now: number; routes: Routes; type: string; code: string },
  expectation: Json,
): Promise<void> {
  const keys = fixtureDeviceKeys(KEY_LABEL);
  const args: Json = {
    keyLabel: KEY_LABEL,
    subjectTokenType: o.type,
    serverAuthCode: o.code,
  };
  await r.step(
    { action: "link", note: o.note, args, now: o.now },
    async (s: StepRecorder) => {
      const keysBody = { signKey: keys.signKey, agreeKey: keys.agreeKey };
      const nonceRes = await s.send({
        method: "POST",
        path: NONCE,
        body: keysBody,
        expectBody: { json: keysBody, match: "exact" },
      });
      expect(nonceRes.status).toBe(200);
      const nonce = ((await nonceRes.json()) as { nonce: string }).nonce;
      const body = {
        subjectToken: o.code,
        subjectTokenType: o.type,
        nonce,
        ...keysBody,
        proof: keys.proof({
          purpose: "link",
          product: PRODUCT,
          deviceId: DEVICE,
          value: `${nonce}.${keys.signKey}`,
          token: o.code,
        }),
      };
      const res = await withProviders(
        () =>
          s.send({
            method: "POST",
            path: LINK,
            bearer: "token",
            body,
            expectBody: { json: body, match: "exact" },
          }),
        o.routes,
      );
      expect(res.status).toBe(200);
    },
    expectation,
  );
}

export const linkGame: Scenario = {
  id: "link-game",
  record: () =>
    pinned("link-game", async (pin) => {
      const { w, who } = await linkWorld(gameWorld);
      const r = newRecorder(
        w,
        pin,
        "link-game",
        "Linking a game identity after a regular sign-in (WIRE-CONTRACT-V5 §12.11.4, §12.11.7). A Game Center exchange found no link and answered a link handle. The person signs in on this device through the browser, which leaves a step-up of 300 s. GET link names the kinds the person could add: a game kind always carries reach developer, known before any token. POST link with the handle and a pkey-proof/1 link proof adds the Game Center identity under the developer's team. A later sign-in earns a new step-up. Play Games has no handle in this conversation: POST link carries the server auth code as subjectToken with subjectTokenType urn:polaris-key:token-type:pgs-server-auth-code, a nonce, the device's keys and a proof over the nonce, the key and the token's hash. The Worker redeems the code and adds the Play Games identity under the product's application. Each link spends the step-up, so the offer drops the kind that was added.",
        ["identity.link", ...GC, ...PGS],
      );
      let handle = "";
      await gcStep(
        r,
        await gameCenterArgs({ bundleId: BUNDLE }),
        "No account links this team player: the answer carries the link handle.",
        (a) => {
          expect(a.grant!.status).toBe(403);
          handle = a.json.linkHandle as string;
        },
        { result: "interstitial-required" },
      );
      await signInSteps(r, who);
      await holdKeys(w);
      await offerStep(
        r,
        "The offer names the game kinds with their reach.",
        undefined,
        [
          { kind: "google", reach: null },
          { kind: "apple", reach: null },
          { kind: "gamecenter", reach: "developer" },
          { kind: "pgs", reach: "developer" },
        ] as never,
      );
      const keys = fixtureDeviceKeys(KEY_LABEL);
      const handleBody = {
        linkHandle: handle,
        proof: keys.proof({
          purpose: "link",
          product: PRODUCT,
          deviceId: DEVICE,
          value: handle,
          token: null,
        }),
      };
      await r.step(
        {
          action: "link",
          note: "Link by handle: the Game Center identity is added.",
          args: { linkHandle: handle, keyLabel: KEY_LABEL },
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: LINK,
            bearer: "token",
            body: handleBody,
            expectBody: { json: handleBody, match: "exact" },
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({
            linked: { kind: "gamecenter", reach: "developer" },
          });
        },
        { result: "ok", linked: { kind: "gamecenter", reach: "developer" } },
      );
      await signInSteps(r, who, { now: LATER, bearer: true });
      await offerStep(
        r,
        "Game Center is linked: the offer no longer names it.",
        LATER,
        [
          { kind: "google", reach: null },
          { kind: "apple", reach: null },
          { kind: "pgs", reach: "developer" },
        ] as never,
      );
      await linkByTokenStep(
        r,
        {
          note: "Link by token: the server auth code is redeemed and the Play Games identity is added.",
          now: LATER,
          routes: GOOGLE_GAMES,
          type: PGS_SUBJECT_TOKEN_TYPE,
          code: PGS_CODE,
        },
        { result: "ok", linked: { kind: "pgs", reach: "developer" } },
      );
      return r.transcript();
    }),
};

export const GAME_SCENARIOS: Scenario[] = [
  exchangeGameCenterSilent,
  exchangeGameCenterNoLink,
  exchangeGameCenterErrors,
  exchangePgsSilent,
  exchangePgsNoLink,
  exchangePgsErrors,
  linkGame,
];
