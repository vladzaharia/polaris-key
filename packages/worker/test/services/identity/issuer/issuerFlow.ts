/**
 * The registered client's request flow, for the token tests: a code through `authorize` and Continue,
 * `token` form posts, Basic headers. Bound to the test's world by a getter, so a `beforeEach` that
 * rebuilds the world rebinds them.
 */
import { beforeEach, expect } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import { SETTINGS } from "../../../../src/mount.js";
import type { ClientRecord } from "../../../../src/services/identity/issuer/clientsRepo.js";
import { handleSignInContinue } from "../../../../src/services/identity/passthrough/continue.js";
import { addClientSecret } from "../../../../src/services/identity/issuer/clientsRepo.js";
import { signIn as accountSignIn } from "../../../../src/services/identity/accounts/signIn.js";
import { NOW } from "../../../seed.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";

type Form = Record<string, string>;
interface FlowCtx {
  w: World;
  accountId: string;
  pair: { verifier: string; challenge: string };
}

/** The world every token test starts from, rebuilt before each test: `s.spa`, `s.web` (with `s.secret`). */
export interface IssuerSuite extends FlowCtx {
  spa: ClientRecord;
  web: ClientRecord;
  secret: string;
}

/** What a code redemption answers a client that asked for `offline_access`. */
export interface IssuerTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

/**
 * A fresh world per test with the issuer on, one account, a public (spa) and a web client and the
 * web client's secret, plus the flow helpers bound to it.
 */
export function issuerSuite(pepper: string) {
  const s = {} as IssuerSuite;
  beforeEach(async () => {
    Object.assign(s, await issuerWorld());
    (s.w.env as unknown as Record<string, unknown>).KEY_HASH_PEPPER = pepper;
    s.spa = await mkClient(s.w, {
      key: "spa-app",
      type: "spa",
      redirectUris: ["https://spa.example.com/cb"],
    });
    s.web = await mkClient(s.w, {
      key: "forum",
      type: "web",
      redirectUris: ["https://forum.example.com/cb"],
    });
    s.secret = (await addClientSecret(
      s.w.env,
      s.w.db,
      SLUG,
      s.web.clientId,
      NOW,
    ))!.secret;
  });
  const flow = issuerFlow(() => s);
  /** What the web client gets for `code` with its secret: the error code, whatever the answer. */
  const webRedeemError = async (
    code: string,
    extra: Record<string, string> = {},
  ): Promise<string | undefined> =>
    flow.err(
      await flow.token(
        flow.grantForm(s.web, code, { client_secret: s.secret, ...extra }),
      ),
    );
  /** The signed-in account signs in to `c` (the public client by default) and redeems its code. */
  const signIn = async (c: ClientRecord = s.spa): Promise<IssuerTokens> => {
    const res = await flow.token(
      flow.grantForm(
        c,
        await flow.codeFor(c),
        c.type === "web" ? { client_secret: s.secret } : {},
      ),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as IssuerTokens;
  };
  /** A second account (`grace`) signs in to the public client; its id and tokens. */
  const signInSecondAccount = async (): Promise<{
    accountId: string;
    tokens: IssuerTokens;
  }> => {
    const b = await accountSignIn(
      s.w.db,
      { issuerKey: "email", subject: "grace@example.com", kind: "email" },
      NOW,
      { unfenced: true },
    );
    if (b.status !== "signed_in") throw new Error("sign-in");
    const theirs = issuerFlow(() => ({
      w: s.w,
      accountId: b.account.id,
      pair: s.pair,
    }));
    const res = await theirs.token(
      theirs.grantForm(s.spa, await theirs.codeFor(s.spa)),
    );
    expect(res.status).toBe(200);
    return {
      accountId: b.account.id,
      tokens: (await res.json()) as IssuerTokens,
    };
  };
  return { s, webRedeemError, signIn, signInSecondAccount, ...flow };
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
