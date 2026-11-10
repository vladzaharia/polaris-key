/**
 * The registered client's request flow, for the token tests: a code through `authorize` and Continue,
 * `token` form posts, Basic headers. Bound to the test's world by a getter, so a `beforeEach` that
 * rebuilds the world rebinds them.
 */
import { expect } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import { SETTINGS } from "../../../../src/mount.js";
import type { ClientRecord } from "../../../../src/services/identity/issuer/clientsRepo.js";
import { handleSignInContinue } from "../../../../src/services/identity/passthrough/continue.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";

type Form = Record<string, string>;
interface FlowCtx {
  w: World;
  accountId: string;
  pair: { verifier: string; challenge: string };
}

export function issuerFlow(ctx: () => FlowCtx) {
  /** A code for `client` through authorize and Continue, the way a person gets one. */
  async function codeFor(
    client: ClientRecord,
    extra: Record<string, string> = {},
    consent: string[] = ["name", "email"],
  ): Promise<string> {
    const redirect = client.redirectUris[0]!;
    const p = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirect,
      scope: "openid profile email offline_access pkey:entitlements",
      state: "s",
      ...(client.type === "web"
        ? { nonce: "n-1" }
        : {
            code_challenge: ctx().pair.challenge,
            code_challenge_method: "S256",
          }),
      ...extra,
    });
    const auth = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
      ctx().w.env,
      ctx().w.db,
      NOW,
    );
    expect(auth.status).toBe(303);
    const handle = /request=(rq_[A-Za-z0-9_-]{22})/.exec(
      auth.headers.get("location")!,
    )![1]!;
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const res = await handleSignInContinue(
      new Request(`${BASE}/api/x`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ consent: { claims: consent } }),
      }),
      ctx().w.env,
      ctx().w.db,
      { accountId: ctx().accountId },
      handle,
      NOW,
      SETTINGS,
      NOW,
    );
    expect(res.status).toBe(200);
    return new URL(
      ((await res.json()) as { redirect: string }).redirect,
    ).searchParams.get("code")!;
  }

  const token = (
    form: Form,
    init: { headers?: Record<string, string>; at?: number } = {},
  ) =>
    dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...init.headers,
        },
        body: new URLSearchParams(form).toString(),
      }),
      ctx().w.env,
      ctx().w.db,
      init.at ?? NOW,
    );
  const basic = (id: string, sec: string) => ({
    authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(sec)}`).toString("base64")}`,
  });
  const grantForm = (c: ClientRecord, code: string, over: Form = {}): Form => ({
    grant_type: "authorization_code",
    client_id: c.clientId,
    code,
    redirect_uri: c.redirectUris[0]!,
    ...(c.type === "web" ? {} : { code_verifier: ctx().pair.verifier }),
    ...over,
  });
  const err = async (res: Response) =>
    ((await res.json()) as { error: string }).error;

  return { codeFor, token, basic, grantForm, err };
}
