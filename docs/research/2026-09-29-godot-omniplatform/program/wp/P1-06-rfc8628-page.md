# P1-06 Serve an RFC 8628 user-code page for device-code sign-in

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                                                                                  |
| Size        | 0.5–0.75 engineer-weeks                                                                                                                             |
| Depends on  | [P0-13](P0-13-oidc-flow-key-hashing.md)                                                                                                             |
| Unblocks    | [P1-07](P1-07-godot-identity.md), [P1b-08](P1b-08-devicecode-edgemint-ports.md)                                                                     |
| Role        | `pkey-implementer`                                                                                                                                  |
| Plan mode   | no (an HTTP identity route, not the signed wire contract)                                                                                           |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); threat model; generated `reference/routes.mdx` (rule 3); the R8-02 attack PoCs flip from "residual" to "fixed" |
| Human input | a production deploy before P1-07's end-to-end check and before D-02 ships                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Goal

A person holding a phone can finish a device-code sign-in by opening one short URL and typing an
eight-letter code shown by a game, a TV app or a CLI, as RFC 8628 intends.
`POST /<p>/identity/auth/device/start` returns an **independent** `userCode` (no longer a prefix
of the secret `deviceCode`), `verificationUri` becomes the code-entry page, and
`verificationUriComplete` carries the user code so a QR code skips typing. The secret device code
never appears in a URL, a page or a form on the user-code path.

## Why

Today the flow is "loosely" RFC 8628: `userCode` is the first eight characters of `deviceCode`,
upper-cased and hyphenated, and `verificationUri` embeds the whole device code, so there is no
page where a user types a code (`packages/worker/src/services/identity/oidc.ts:303-308` and
`:762-786`; report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #18;
notes/A2 §6). A game on a Steam Deck in game mode, a TV or a console cannot show a clickable
link; the player must type or scan. The audit left this as a documented residual of R8-02
because it changes the public device-flow contract (`docs/security/findings/R8-oidc.md:610-614`).
Godot's sign-in (P1-07) and the Node, Python and Swift ports (P1b-08) build on the finished
page (`identity.devicecode` in [PARITY §5.4](../../PARITY.md#54-devices-and-identity)).

## Read first

- `AGENTS.md` rules 6, 10 and 3; `docs/security/THREAT-MODEL.md`.
- RFC 8628 §3.2–§3.3 (response fields, `verification_uri_complete`), §5.1 (brute force), §5.4
  (remote phishing), §6.1 (user-code recommendations).
- [notes/A2](../../notes/A2-sdk-port.md) §6 and §15 item 4.
- `packages/worker/src/services/identity/oidc.ts:64-66,121-133,299-308,729-786` (start),
  `:811-930` (confirm and verify page), `:1212-1283` (poll and cleanup);
  `services/identity/routes.ts` (the sub-router and its header comment);
  `services/identity/index.ts:61-81` (discovery endpoints); `core/rateLimit.ts:62-107`
  (`FAIL_MODE`).
- `packages/worker/openapi/polaris-key.v3.yaml` at `/{product}/identity/auth/device/start` and
  `/verify`; `packages/worker/test/routeCoverage.test.ts:63-88` (`SERVICE_PATHS`).
- `packages/worker/test/oidcEdge.test.ts:340-420` and
  `packages/worker/test/attack/R8-oidc.test.ts:480-640` (the residual PoCs to flip).
- `docs/security/findings/R8-oidc.md` (R8-02) and `docs/security/findings/R12-secrets.md`
  (R12-04: never use a credential as a KV key name).
- `packages/docs/src/content/docs/services/identity/device-flow.md`.

## Scope

**In:**

- **User code:** eight characters from RFC 8628 §6.1's consonant alphabet
  `BCDFGHJKLMNPQRSTVWXZ` (about 34.5 bits), shown as `XXXX-XXXX`, generated independently of
  `deviceCode`. Stored as an index `p:<slug>:device-user:<hash>` → the device code, where the
  hash is `hashKey` of the normalised code under `KEY_HASH_PEPPER`
  (`packages/worker/src/crypto.ts:107`), with the flow's TTL (600 s); regenerate on collision;
  deleted with the flow on `ready` or `timeout`.
- **Normalisation:** upper-case; drop spaces and hyphens; anything outside the alphabet makes the
  code invalid.
- **Start response:** `userCode` as above; `verificationUri` =
  `<origin>/<p>/identity/auth/device`; `verificationUriComplete` =
  `<origin>/<p>/identity/auth/device?user_code=XXXX-XXXX`. Every other field is unchanged.
- **New route `/<p>/identity/auth/device`** (`handleAuthDeviceEntry` in `oidc.ts`):
  - `GET` without `user_code`: the entry form (one text field, POST to the same URL);
  - `GET` with `user_code`, or `POST` with `user_code` and no `csrf`: look the code up and render
    the existing confirmation page (product, device label, code) with a fresh single-use CSRF
    token; its form posts `user_code` and `csrf` back to this route, never the device code;
  - `POST` with `user_code` and `csrf`: the existing `confirmDeviceFlow` (Origin check, CSRF
    check, stamp `confirmedAt` on both records, `303` to the IdP with `no-referrer`, `no-store`);
  - an unknown or expired code re-renders the entry form with one generic message (status 404);
  - the static-HTML CSP and headers from `staticHtmlSecurityHeaders`, `no-store`,
    `referrer-policy: no-referrer`, no script.
- A per-IP rate-limit bucket `authDeviceEntry` (for example 30 per 60 s), fail-closed in
  `FAIL_MODE`.
- The existing `/identity/auth/device/verify?device_code=` stays unchanged, for flows in flight
  during the deploy and for any client that builds that URL.
- `authDeviceEntry` in the identity discovery fragment and its OpenAPI example.
- OpenAPI: the new path (`get`, `post`), the start description and example, `DeviceAuthStartResult`;
  `routeCoverage.test.ts` `SERVICE_PATHS`; the `routes.ts` header comment; regenerate
  `reference/routes.mdx`.
- Tests (see Acceptance), the R8-02 PoCs flipped to assert the fix, `device-flow.md`, the R8
  remediation note and the audit's R8-02 row, and a threat-model paragraph.

**Out** (and where it belongs instead):

- The Godot client and its QR code (→ [P1-07](P1-07-godot-identity.md)); Node, Python and Swift
  clients (→ [P1b-08](P1b-08-devicecode-edgemint-ports.md)).
- Carrying a fingerprint through device-code sign-in so strict tiers work (notes/A2 §15 item 3;
  unowned — report it).
- A shorter vanity path such as `/<p>/link` (optional; not needed while QR is the primary path).
- A server-rendered SVG QR code (notes/E9 §8.1 alternative; not needed, clients render QR).
- Changing `interval`, `expiresIn` or the poll contract.

## Design notes

- **Never expose the device code on the user-code path.** Anyone who learns a device code and the
  device id (the page shows the id when no `deviceName` was given) could poll and race the real
  device for the token once the user confirms. The lookup therefore stays server-side and the
  confirmation form carries `user_code`, not `device_code`.
- **Brute force** (RFC 8628 §5.1): 20^8 codes, a 600-second lifetime, a per-IP limit and a
  per-flow single-use CSRF token keep blind guessing impractical; the threat-model paragraph
  states the numbers. Do not add a product-wide bucket that one attacker could exhaust to lock
  out every player.
- **Remote phishing** (§5.4): the confirmation page keeps showing the product and the device label
  and requires a button press; a QR scan (`verificationUriComplete`) still lands on it.
- **R12-04:** the index key is a peppered hash of the code, never the code itself, as the admin
  flow key does since that fix (`packages/worker/src/admin/auth.ts:33-45`). The existing
  `p:<slug>:device-flow:<code>` and `p:<slug>:flow:<state>` keys (`oidc.ts:295-301`) still use the
  secret verbatim although the audit lists R12-04 as fixed; do not change them here (in-flight
  flows would break on deploy), and report the gap.
- **Compatibility:** `userCode` keeps the `XXXX-XXXX` shape (existing tests match
  `/^[A-Z0-9_-]{4}-[A-Z0-9_-]{4}$/`). A host that opened `verificationUri` now lands on the entry
  page and must type the code; hosts should open `verificationUriComplete` (RFC 8628 §3.3.1). Say
  so in `device-flow.md` and the OpenAPI description. No SDK in this repo builds the URL itself.
- The route sits inside the identity service, so rule 6 holds: no new cross-service import.

## Steps

1. Generate and index the independent user code in `handleAuthDeviceStart`; clean the index up in
   `handleAuthDevicePoll`.
2. Add `handleAuthDeviceEntry` and wire `rest = ["auth", "device"]` in `routes.ts`.
3. Share the confirmation page renderer and `confirmDeviceFlow` between both routes.
4. Add the rate-limit bucket, the discovery endpoint, the OpenAPI entries and the coverage row;
   regenerate the reference pages.
5. Write the tests; flip the R8-02 residual PoCs; update the docs and security notes.

## Acceptance criteria

- [ ] Tests: `userCode` matches `^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$` and is not
      derived from `deviceCode` (the old prefix assertion now fails and is inverted);
      `verificationUri !== verificationUriComplete`, and neither contains the device code.
- [ ] `GET /djdl/identity/auth/device` returns the entry form with the static-HTML CSP,
      `no-store` and `no-referrer`, and no `<script>`.
- [ ] `GET …/device?user_code=zk8l qr8n` (lower-case, space) renders the confirmation page for the
      right flow; the HTML contains the user code and device label and not the device code.
- [ ] `POST` with `user_code` and the page's `csrf` returns `303` to the IdP and sets
      `confirmedAt` on the flow record; the next poll proceeds to the IdP result.
- [ ] `POST` without `csrf`, with a reused `csrf`, or with a foreign `Origin` returns 403.
- [ ] An unknown or expired code returns the generic 404 page; the per-IP bucket returns 429.
- [ ] No KV key name contains a raw user code; the index is deleted on `ready` and `timeout`.
- [ ] The old `/identity/auth/device/verify?device_code=` flow still passes its existing tests.
- [ ] `routeCoverage.test.ts` lists `["/{product}/identity/auth/device", ["get", "post"]]` and
      passes; `pnpm --filter @polaris-key/docs gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including `test:workerd` and `check:links`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- oidcEdge R8-oidc routeCoverage rateLimit
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm typecheck
```

## Hand-off

- **Contract for clients:** show `userCode` large; render `verificationUriComplete` as a QR code
  and as the link to open; show `verificationUri` as the short URL to type; poll unchanged.
  P1-07 and the ports in P1b-08 rely on exactly this.
- **Discovery:** `services.identity.endpoints.authDeviceEntry`.
- Record the production deploy in the PR (the human deploys); P1-07's end-to-end check and D-02
  need it live.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-06 done`.
