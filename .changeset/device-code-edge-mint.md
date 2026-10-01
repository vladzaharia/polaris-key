---
"@polaris-key/node": minor
---

Sign in from a device with no browser, and fetch edge-minted third-party tokens.

- **Device-code sign-in (RFC 8628).** `client.identity.beginSignIn({ deviceName? })` returns
  the code and verification URL to show the user; `pollSignIn(prompt)` makes one poll, and
  `waitForSignIn(prompt, { signal? })` polls at the server's pace (honouring `slow_down`) until
  the user confirms, the code expires, or the signal aborts. A confirmed sign-in stores the
  signed-in identity's own device token and fires the usual license-acquired sync; it never
  merges this device's anonymous licence. Also exported as the new `@polaris-key/node/identity`
  subpath (`IdentityClient`, `SignInPrompt`, `SignInPoll`, `SignInResult`,
  `WaitForSignInOptions`).
- **Edge-mint.** `client.config.mintToken(recipeId)` asks the Worker to sign a short-lived token
  for a third party through an operator-approved recipe and resolves `MintedToken`
  (`{ token, expiresAt }`). It is cached in memory only, reused until `expiresAt` minus
  `MINT_REUSE_MARGIN_SECONDS` (30) and only while the client holds the device token it was minted
  with, and a 401 gets a single re-acquire and one retry.

Both refuse with `service-unavailable` before any request when the product has Identity or Config
turned off. `ConfigClient`'s constructor gains an optional `tokens` parameter.
