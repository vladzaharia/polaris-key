// A fixed RS256 issuer key for the transcripts that carry an issuer token (I-21.13).
//
// RSA key generation is not seeded by `pinEnvironment`, and a recorded access token must be
// byte-stable, so the scenario installs this key as the product's active issuer key instead of
// letting `ensureIssuerKeys` generate one. RSASSA-PKCS1-v1_5 signatures are deterministic, so
// the same key, claims and `jti` give the same token on every run. A TEST key: it signs nothing
// but the recorded conversation and verifies against no deployed product.

import { seal } from "../../src/platform/keyvault.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";

export const TEST_ISSUER_KEY = {
  /** RFC 7638 thumbprint of the public key. */
  kid: "Fs402ELsce8LMEzkwA3hTB3Ab3_Xq7Du_crBO-TKEqc",
  n: "3zrZKO8PLXM3rK8xr9Dh7rT3D9A0-x9dFsB5QWRGCwkeDpt1XCOfUiX_vG6jP0UilSXAV_BaoDKvwNnnp4s_1dCiBbg6To1_NMkwgnQP6EKfAx74o-USMP3tLH-XVpyLwFqUjPZpV2aAdpwn20pFhQmmlSbC3-E9Gkp_95CNtmt6qUBHZKB7xe-VIPBzJ0F6i5xq0fgIVzPf03ytEsN2faMwJENy6hQXNHZk-6Wgt_WfX3uBPo6LVWWhr2YO5_KqjWFeKaOIoLoo11NOnJDEbkWT-PWMr8QRsMh1b3U6vbsXNGrR9AQNSujdEgNEQYFzqCR99neP_8FXlPMFGHxSRw",
  e: "AQAB",
  pkcs8:
    "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDfOtko7w8tczes\nrzGv0OHutPcP0DT7H10WwHlBZEYLCR4Om3VcI59SJf+8bqM/RSKVJcBX8FqgMq/A\n2eeniz/V0KIFuDpOjX80yTCCdA/oQp8DHvij5RIw/e0sf5dWnIvAWpSM9mlXZoB2\nnCfbSkWFCaaVJsLf4T0aSn/3kI22a3qpQEdkoHvF75Ug8HMnQXqLnGrR+AhXM9/T\nfK0Sw3Z9ozAkQ3LqFBc0dmT7paC39Z9fe4E+jotVZaGvZg7n8qqNYV4po4iguijX\nU06ckMRuRZP49YyvxBGwyHVvdTq9uxc0atH0BA1K6N0SA0RBgXOoJH32d4//wVeU\n8wUYfFJHAgMBAAECggEAT8qHq9+Dc9H+wQ1gO8F0uK/brb3U6jxEOGk1DmAqvzAT\nm9IKiZQ8Ew99EVwUov1xxpEXZveFVUS42Lyq1pLqDuHDwDqhMMnYAcS2P7L/qpwB\nnYp5ApBTR8rD94dlz3Ima+uUtKwxbCm52munvXUXU13nOuH/fynR/u9JPXLgjKbE\na6rPVjTpSgs6XwnA50n3rLnTqqfYCIvYj5Upa7rZ2JuYxnjaedh8E2MK3F55iJRT\ni2jHluabv+dA754drB1pMFpiioYwNgZF3XLuSfBQ9GRbMYshZhkoIJmhzN5aMBIJ\nociF8GYfZr1rum6pkJE+TwAz75cS3J+b/bpH9U6PmQKBgQDwSle+6xDpxQWUBxcw\nvIhXct+gRk1ek9/yZ22qbYkSfnffbbVm1spy0i9GphGl0dhgsSdYPvqA2yICL5Ve\njRJ/2yTKPfRxQZmyIB38sCr316xUTzkP6wceYdh13WMyJbSkgoRxCzF01MiWfHr2\nPm1YDbIzlxIWXIxY5jQWaZ6SeQKBgQDt0vgr4ScO1QanVrqJB4X3Ra4Pol1SXvKW\nlkAOa/ueKxiRsn/DtjCzAHlaXqJH4IENIpdK3735+zOC1fp/S6Vt9PEivjsV0URo\nckZowmvJ/ZPklSCj2z0gI4REw0uNydE916OTvj1wGXIHx+9NuxifX6WVP/jZR461\njAd7qYLavwKBgQDms9nvGa2RZHJony4qwrh8jXQbY6Qg7AUVrSvjd2slcHsS7zg9\nVnflKdvuDr/e3szKeQv3c+/7C2lpg9n7f6KFUxfNfRJWMs+n76Ia2+FFN7Li93Un\nzVV2XCcBct8sZHs9f3o9NqvzKeC0ayt7hJBi/DNdyOu6wHyXVd4orptqsQKBgQCu\nDtLdYorwew7EmGArfBsbL59GCAIfECih99Nn+rYMO+RedfK2bXhU+grXDh3dVz18\nPI3YGcrz01sO7cbJNbccs8FsOSgLPr6/ZquLbofvLKz6Bf7+ja2+AOCEZx675jJC\n/bjVn81dZvIjKbxF+qH5usn4YvqhI5MZ4iNz6UtBBwKBgDQUb4H8yG0X0nxn8EIF\nzILIep7FAtTsnXLkGtnyrj7HcmZ6PRkOrOr9aqzV8PccF0HMyVenxaCLq0zeN3uU\nInms6p0FgparUllw+q6GU7oCVH42KktyqGa8gAmNYAY2fitH84xi22MT7cdqxM6y\nWXl8hwzQh0GGbXbGJ52784Po\n-----END PRIVATE KEY-----",
};

/** Install the key as `product`'s active issuer key, sealed as the Worker seals its own. */
export async function installIssuerKey(
  env: Env,
  db: Db,
  product: string,
  now: number,
): Promise<void> {
  const k = TEST_ISSUER_KEY;
  await db.run(
    `INSERT INTO identity_issuer_keys
       (product, kid, state, sealed, n, e, created_at, published_at, activated_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    product,
    k.kid,
    await seal(env, k.pkcs8, {
      product,
      kind: "issuer-signing-key",
      id: k.kid,
    }),
    k.n,
    k.e,
    now,
    now,
    now,
  );
}
