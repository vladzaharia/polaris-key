/**
 * I-21.9 and I-21.10 attack suite, IS-4 (code interception and injection) and IS-12 (secret guessing):
 * a thief with a stolen authorization code, a client injecting another's, a public client downgrading
 * its proof, and a guesser of client secrets.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addClientSecret,
  type ClientRecord,
} from "../../src/services/identity/issuer/clientsRepo.js";
import { NOW } from "../seed.js";
import { SLUG, type World } from "../services/connect/connectFixture.js";
import { issuerFlow } from "../services/identity/issuer/issuerFlow.js";
import {
  issuerWorld,
  mkClient,
} from "../services/identity/issuer/issuerWorld.js";

let w: World,
  accountId: string,
  spa: ClientRecord,
  web: ClientRecord,
  secret: string;
let pair: { verifier: string; challenge: string };
const { codeFor, token, basic, grantForm, err } = issuerFlow(() => ({
  w,
  accountId,
  pair,
}));
const BAD_SECRET = "pkeycs_" + "A".repeat(43);

beforeEach(async () => {
  ({ w, accountId, pair } = await issuerWorld());
  (w.env as unknown as Record<string, unknown>).KEY_HASH_PEPPER =
    "attack-pepper";
  spa = await mkClient(w, {
    key: "spa-app",
    type: "spa",
    redirectUris: ["https://spa.example.com/cb"],
  });
  web = await mkClient(w, {
    key: "forum",
    type: "web",
    redirectUris: ["https://forum.example.com/cb"],
  });
  secret = (await addClientSecret(w.env, w.db, SLUG, web.clientId, NOW))!
    .secret;
});

describe("a stolen code (IS-4)", () => {
  it("a thief without the verifier cannot redeem a public client's code, and the owner still can", async () => {
    const code = await codeFor(spa);
    const stolen = grantForm(spa, code);
    delete stolen.code_verifier;
    expect(await err(await token(stolen))).toBe("invalid_grant");
    // Refused before the store: nothing was spent, the verifier holder redeems.
    expect((await token(grantForm(spa, code))).status).toBe(200);
  });

  it("a guessed verifier ends the code: no second guess", async () => {
    const code = await codeFor(spa);
    expect(
      await err(
        await token(grantForm(spa, code, { code_verifier: "G".repeat(43) })),
      ),
    ).toBe("invalid_grant");
    expect(await err(await token(grantForm(spa, code)))).toBe("invalid_grant");
  });

  it("a web client's code needs its secret: the thief gets 401 and burns nothing", async () => {
    const code = await codeFor(web);
    expect((await token(grantForm(web, code))).status).toBe(401);
    expect(
      (await token(grantForm(web, code, { client_secret: BAD_SECRET }))).status,
    ).toBe(401);
    expect(
      (await token(grantForm(web, code, { client_secret: secret }))).status,
    ).toBe(200);
  });

  it("a public client cannot downgrade to the no-challenge proof, with the string or without a verifier", async () => {
    const code = await codeFor(spa);
    for (const verifier of [
      "pkey:no-challenge",
      "pkey:no-challenge".padEnd(43, "x"),
    ]) {
      expect(
        await err(
          await token(grantForm(spa, code, { code_verifier: verifier })),
        ),
      ).toBe("invalid_grant");
    }
    const bare = grantForm(spa, code);
    delete bare.code_verifier;
    expect(await err(await token(bare))).toBe("invalid_grant");
  });

  it("a nonce-only code refuses every verifier, and the attempt ends it", async () => {
    const code = await codeFor(web);
    const res = await token(
      grantForm(web, code, {
        client_secret: secret,
        code_verifier: pair.verifier,
      }),
    );
    expect(await err(res)).toBe("invalid_grant");
    expect(
      await err(await token(grantForm(web, code, { client_secret: secret }))),
    ).toBe("invalid_grant");
  });
});

describe("code injection (IS-4)", () => {
  it("a code is redeemable only by the client and the redirect it was issued for", async () => {
    const other = await mkClient(w, {
      key: "spa-two",
      type: "spa",
      redirectUris: ["https://two.example.com/cb"],
    });
    const code = await codeFor(spa);
    const injected = grantForm(other, code, {
      redirect_uri: "https://two.example.com/cb",
    });
    expect(await err(await token(injected))).toBe("invalid_grant");
    // The injection spent it: the rightful client cannot redeem either.
    expect(await err(await token(grantForm(spa, code)))).toBe("invalid_grant");
    for (const redirect of [
      "https://spa.example.com/cb/",
      "https://spa.example.com/cb?x=1",
      "https://evil.example.com/cb",
    ]) {
      const c = await codeFor(spa);
      expect(
        await err(await token(grantForm(spa, c, { redirect_uri: redirect }))),
        redirect,
      ).toBe("invalid_grant");
    }
  });

  it("a redeemed code presented again revokes the tokens it made, with no grace", async () => {
    const code = await codeFor(spa);
    const first = (await (await token(grantForm(spa, code))).json()) as {
      refresh_token: string;
    };
    expect(await err(await token(grantForm(spa, code)))).toBe("invalid_grant");
    const dead = await token({
      grant_type: "refresh_token",
      client_id: spa.clientId,
      refresh_token: first.refresh_token,
    });
    expect(await err(dead)).toBe("invalid_grant");
  });
});

describe("secret guessing (IS-12)", () => {
  const guess = (n: number) =>
    token(
      grantForm(web, "x".repeat(43), {
        client_secret:
          BAD_SECRET.slice(0, -1) + String.fromCharCode(65 + (n % 26)),
      }),
    );

  it("ten failures spend the client's budget: the eleventh is 429, even with the right secret", async () => {
    for (let i = 0; i < 10; i++) expect((await guess(i)).status).toBe(401);
    const locked = await token(
      grantForm(web, await codeFor(web), { client_secret: secret }),
    );
    expect(locked.status).toBe(429);
    expect(await err(locked)).toBe("rate_limited");
  });

  it("another client is not locked by it", async () => {
    for (let i = 0; i < 10; i++) await guess(i);
    expect((await token(grantForm(spa, await codeFor(spa)))).status).toBe(200);
  });

  it("the request budget is per client and network", async () => {
    const ok = async (n: number) => {
      const res = await token({ grant_type: "bogus", client_id: spa.clientId });
      return n >= 0 ? res.status : 0;
    };
    let last = 0;
    for (let i = 0; i < 31; i++) last = await ok(i);
    expect(last).toBe(429);
    // The same network asking as another client is not spent.
    expect(
      (
        await token(
          { grant_type: "bogus", client_id: web.clientId },
          { headers: basic(web.clientId, secret) },
        )
      ).status,
    ).toBe(400);
  });
});
