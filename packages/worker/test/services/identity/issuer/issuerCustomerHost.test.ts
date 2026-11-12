/**
 * A registered client's redirect answers while the card lives on the customer host (V5 §12.13.3
 * rules 1 and 4, RFC 9207): `authorize` runs on the API host, the entry, Continue and Cancel on the
 * customer host, and every `iss` is the issuer discovery names, so a relying party that compares the
 * two accepts the answer. The redeemed ID token carries the same issuer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import type { ClientRecord } from "../../../../src/services/identity/issuer/clientsRepo.js";
import { putClientGrant } from "../../../../src/services/identity/issuer/grantsRepo.js";
import { NOW } from "../../../seed.js";
import { cardPress, portalLogin, redirectOf } from "../../../cardPress.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { issuerFlow } from "./issuerFlow.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const CARD = "https://polaris.locker";
const CB = "https://spa.example.com/cb";
let w: World, accountId: string, spa: ClientRecord;
let pair: { verifier: string; challenge: string };

beforeEach(async () => {
  ({ w, accountId, pair } = await issuerWorld());
  const e = w.env as unknown as Record<string, unknown>;
  e.PORTAL_SESSION_SECRET = "test-portal-secret";
  e.CONSOLE_ORIGIN = BASE;
  e.CUSTOMER_ORIGIN = CARD;
  spa = await mkClient(w, { key: "spa-app", type: "spa", redirectUris: [CB] });
});

const send = (url: string, headers: Record<string, string> = {}) =>
  dispatchWith(new Request(url, { headers }), w.env, w.db, NOW);

/** The issuer a relying party reads from discovery. */
async function discoveredIssuer(): Promise<string> {
  const res = await send(
    `${BASE}/${SLUG}/identity/.well-known/openid-configuration`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { issuer: string }).issuer;
}

/** `authorize` on the API host, then the bind hop on the customer host. */
async function begin(extra: Record<string, string> = {}) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: spa.clientId,
    redirect_uri: CB,
    scope: "openid profile email",
    state: "st-1",
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  const auth = await send(`${BASE}/${SLUG}/identity/authorize?${p}`);
  expect(auth.status).toBe(303);
  const hop = new URL(auth.headers.get("location")!);
  expect(hop.origin).toBe(CARD);
  const hopped = await send(hop.href);
  expect(hopped.status).toBe(303);
  return {
    handle: hop.searchParams.get("request")!,
    binder: hopped.headers.get("set-cookie")!.split(";")[0]!,
  };
}

/** A card press on the customer host: its redirect. */
async function press(
  handle: string,
  verb: "continue" | "cancel",
  binder: string,
) {
  return redirectOf(
    await cardPress(w.env, w.db, {
      origin: CARD,
      handle,
      verb,
      binder,
      session: await portalLogin(w.env, w.db, accountId),
      body:
        verb === "continue" ? { consent: { claims: ["name", "email"] } } : {},
    }),
  );
}

/** The card's entry on the customer host, with the binder and (optionally) a session. */
async function entry(handle: string, binder: string, withSession: boolean) {
  const cookies = [
    binder,
    ...(withSession
      ? [(await portalLogin(w.env, w.db, accountId)).cookie]
      : []),
  ];
  return send(`${CARD}/signin?request=${handle}`, {
    cookie: cookies.join("; "),
  });
}

describe("iss on the customer host", () => {
  it("Continue carries the issuer, and so does the redeemed ID token", async () => {
    const issuer = await discoveredIssuer();
    expect(new URL(issuer).origin).toBe(BASE);
    const { handle, binder } = await begin();
    const to = await press(handle, "continue", binder);
    expect(to.searchParams.get("iss")).toBe(issuer);
    const flow = issuerFlow(() => ({ w, accountId, pair }));
    const res = await flow.token(
      flow.grantForm(spa, to.searchParams.get("code")!),
    );
    expect(res.status).toBe(200);
    const { id_token } = (await res.json()) as { id_token: string };
    const payload = JSON.parse(
      Buffer.from(id_token.split(".")[1]!, "base64url").toString(),
    ) as { iss: string };
    expect(payload.iss).toBe(issuer);
  });

  it("Cancel carries the issuer", async () => {
    const { handle, binder } = await begin();
    const to = await press(handle, "cancel", binder);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("iss")).toBe(await discoveredIssuer());
  });

  it("prompt=none with a covering grant carries the issuer", async () => {
    await putClientGrant(
      w.db,
      {
        accountId,
        clientId: spa.clientId,
        product: SLUG,
        claimsGranted: ["name", "email"],
        claimsDeclined: ["picture"],
        scopes: [],
        scopeHash: "h",
      },
      NOW,
    );
    const { handle, binder } = await begin({ prompt: "none" });
    const res = await entry(handle, binder, true);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("code")).not.toBeNull();
    expect(to.searchParams.get("iss")).toBe(await discoveredIssuer());
  });

  it("prompt=none with no session (login_required) carries the issuer", async () => {
    const { handle, binder } = await begin({ prompt: "none" });
    const res = await entry(handle, binder, false);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("error")).toBe("login_required");
    expect(to.searchParams.get("iss")).toBe(await discoveredIssuer());
  });

  it("an authorize error redirect carries the issuer", async () => {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: spa.clientId,
      redirect_uri: CB,
      state: "st-1",
    });
    const res = await send(`${BASE}/${SLUG}/identity/authorize?${p}`);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(CB);
    expect(to.searchParams.get("error")).not.toBeNull();
    expect(to.searchParams.get("iss")).toBe(await discoveredIssuer());
  });
});
