---
title: "Sign in with your product"
description: "Make your product an OpenID Connect provider: register a client, set the issuer and secrets, request scopes, and verify the tokens your website or partner app receives."
type: "how-to"
services: ["identity"]
status: "shipped"
lastReviewed: "2026-11-10"
sidebar:
  order: 10
---

A website or app of yours, or a partner's, can let people sign in with their Polaris Locker account and learn who they are for **your product**. Polaris Key is the OpenID Connect provider: it issues an ID token and an access token your site verifies, and the person agrees on a Polaris Locker card first. Your apps that embed an SDK don't need this: they sign in with the [web](/docs/features/sign-in/web-redirect/) and [native](/docs/features/sign-in/native-redirect/) redirects and reach your backend with the device exchange.

To sign people in with your product:

1. Turn on **Sign in with this product** under **Sign-in → Clients**.
2. Register a client. For a `web` client, generate its secret.
3. Point your OpenID Connect library at the discovery address, or use the code below.
4. Verify the ID token before you trust it.

It needs the product's Identity service. Off, every issuer route answers as an unknown route.

## Register a client

A client is one website or app that signs people in. Register it in the console under **Sign-in → Clients**, or declare it in `.pkey/product` and resync.

```yaml
identity:
  issuer: { enabled: true }
  clients:
    - key: forum
      name: "Community forum"
      type: web
      redirectUris: ["https://forum.example.com/auth/callback"]
      postLogoutRedirectUris: ["https://forum.example.com/"]
      scopes: [openid, profile, email, pkey:entitlements, offline_access]
      claims: { required: [name] }
```

| Member             | Rule                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`              | 2 to 32 characters, lower case, unique in the product. The server mints the client id (`cl_…`) once and keeps it.                             |
| `type`             | `web` keeps a secret on its server. `spa` and `native` hold none and prove the code with PKCE.                                                |
| `redirectUris`     | 1 to 10, matched exactly. `https`, or for `native` a loopback `http://127.0.0.1/…` with no port, or a reverse-DNS scheme of your own.         |
| `developerName`    | Optional. Another company's client names its developer: people see "by Example Partner Ltd". It gets the same `sub` as your own apps (below). |
| `scopes`, `claims` | What the client asks for, and under `claims.required` what people can't switch off.                                                           |

A product has at most 20 clients. A client from `.pkey/product` is edited there; the console reads it and can disable it. A client dropped from the file is disabled, never deleted.

**Generate secret** on a `web` client's page mints a secret that starts `pkeycs_`. It is shown once and never again: the console keeps its last four characters and when it was last used. A client holds at most two live secrets, so you can add the new one, deploy it, then revoke the old one. A leaked secret is revoked from the same page.

## Addresses

The console shows these under the switch. Point your OpenID Connect library at the discovery address and it finds the rest.

| Name      | Address                                                |
| --------- | ------------------------------------------------------ |
| Issuer    | `https://key.plrs.im/<product>/identity`               |
| Discovery | `<issuer>/.well-known/openid-configuration`            |
| Keys      | `<issuer>/jwks`                                        |
| Endpoints | `<issuer>/authorize`, `/token`, `/userinfo`, `/revoke` |

## What a client gets

People see each item on the sign-in card and can decline the optional ones. A decline is remembered.

| Scope               | What the person shares                   | Delivered as              |
| ------------------- | ---------------------------------------- | ------------------------- |
| `openid`            | Nothing: who signed in, as an id         | `sub`, `auth_time`        |
| `profile`           | Screen name and picture                  | `name`, `picture`         |
| `email`             | Verified email address                   | `email`, `email_verified` |
| `pkey:entitlements` | Which features of your product they have | `pkey:entitlements`       |
| `offline_access`    | Stay signed in to the client while away  | A refresh token           |

`sub` is the person's id **for your product**: the same in every client of the product and different in another product. A partner client gets the same `sub` as your own apps, so it can recognize a person across them, and the card says so. Treat a shared name or email as a join key, not as proof of who someone is.

## What people can do in Polaris Locker

Under **Account → Connected Apps** a person sees each client they signed in to, what it gets, and when it was last used. They can switch the optional profile items they already decided on, and **Disconnect** a client: it loses access within 10 minutes and a new sign-in asks for consent again. A client you or the product turned off stays listed as turned off, with Disconnect only. You change none of this for them: ask them to open the page.

## The sign-in

The flow is the authorization code flow with PKCE (`S256`). A `web` client sends a `nonce` too. The code lasts 60 seconds and works once.

```ts
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  type JsonWebKey,
} from "node:crypto";

const ISSUER = "https://key.plrs.im/djdl/identity";
const CLIENT_ID = "cl_AAAAAAAAAAAAAAAAAAAAAA";
const CLIENT_SECRET = process.env.PKEY_CLIENT_SECRET ?? "";
const REDIRECT_URI = "https://forum.example.com/auth/callback";

const b64url = (b: Buffer): string => b.toString("base64url");

/** What to keep in the person's session between the two steps. */
export interface Pending {
  state: string;
  verifier: string;
  nonce: string;
}

/** Step 1: send the browser to Polaris Locker. */
export function beginSignIn(): { url: string; pending: Pending } {
  const pending: Pending = {
    state: b64url(randomBytes(16)),
    verifier: b64url(randomBytes(32)),
    nonce: b64url(randomBytes(16)),
  };
  const url = new URL(`${ISSUER}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: b64url(
      createHash("sha256").update(pending.verifier).digest(),
    ),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), pending };
}

type Jwk = JsonWebKey & { kid: string };

/** The provider's key for `kid`. In production cache the key set for 60 seconds, as its headers say. */
async function signingKey(kid: string) {
  const res = await fetch(`${ISSUER}/jwks`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("unknown signing key");
  return createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verify an ID token (`typ` "JWT", audience your client id) or an access token (`typ` "at+jwt",
 * audience the issuer). The algorithm is RS256 and nothing else.
 */
export async function verifyToken(
  token: string,
  expected: { typ: "JWT" | "at+jwt"; audience: string; nonce?: string },
): Promise<Record<string, unknown>> {
  const [head, body, sig] = token.split(".");
  if (!head || !body || !sig) throw new Error("not a token");
  const header = JSON.parse(Buffer.from(head, "base64url").toString()) as {
    alg: string;
    kid: string;
    typ: string;
  };
  if (header.alg !== "RS256" || header.typ !== expected.typ)
    throw new Error("wrong token type");
  const signed = createVerify("RSA-SHA256")
    .update(`${head}.${body}`)
    .verify(await signingKey(header.kid), Buffer.from(sig, "base64url"));
  if (!signed) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as {
    iss: string;
    aud: string;
    exp: number;
    nonce?: string;
  } & Record<string, unknown>;
  if (claims.iss !== ISSUER || claims.aud !== expected.audience)
    throw new Error("wrong issuer or audience");
  if (claims.exp <= Date.now() / 1000) throw new Error("expired");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    throw new Error("wrong nonce");
  return claims;
}

/** Step 2: the callback. Trade the code, then verify the ID token. */
export async function completeSignIn(query: URLSearchParams, pending: Pending) {
  if (query.get("iss") !== ISSUER) throw new Error("wrong issuer");
  const error = query.get("error");
  if (error) throw new Error(`sign-in refused: ${error}`);
  if (query.get("state") !== pending.state) throw new Error("state mismatch");
  const res = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: query.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const tokens = (await res.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };
  const claims = await verifyToken(tokens.id_token, {
    typ: "JWT",
    audience: CLIENT_ID,
    nonce: pending.nonce,
  });
  return {
    sub: String(claims.sub),
    name: typeof claims.name === "string" ? claims.name : null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
  };
}
```

A `spa` or `native` client sends `client_id` in the token request body and no secret. Every error after the redirect address is checked comes back as `?error=…&state=…&iss=…` on your registered address. An unknown client or an address you didn't register shows an error page and never redirects.

## Tokens

An ID token and an access token last 10 minutes and are signed RS256 with your product's key. Read them only after `verifyToken`. Your API checks an access token with `typ: "at+jwt"` and the issuer as the audience, and reads `sub`, `scope` and `client_id`. `userinfo` answers live and refuses once the person disconnects the client.

A refresh token (`pkeyo_…`) comes only with `offline_access`. Each refresh returns a new one: store it and drop the old. A token that is idle 30 days or 90 days old ends. Presenting one that was already replaced revokes that sign-in, so keep one writer per session. Send `grant_type=refresh_token` to `/token`, and send the token to `/revoke` to end one yourself.

The key set changes on a schedule: a new key is published 7 days before it signs and a replaced key stays 30 days, so a verifier that reads `/jwks` by `kid` never notices. If a key leaks, a Superadmin rotates it at once from **Platform → Settings → Issuer keys**: every token it signed stops verifying, and people sign in again.

## Ending a sign-in

A person ends a client in Polaris Locker under **Connected Apps**: its refresh tokens end at once and `userinfo` refuses; an access token already issued lasts at most 10 minutes. Disabling or deleting a client in the console does the same for everyone. Turning the setting off revokes every refresh token and keeps the grants, so turning it back on asks nobody again. An end-session address is planned.

## Not served

A client can't register itself. Smart TVs, consoles and mobile Godot builds can't be third-party clients yet: they use the SDK's sign-in. A Godot desktop build can be a `native` client with `OS.shell_open` and a loopback listener.
