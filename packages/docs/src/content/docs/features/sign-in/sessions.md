---
title: "Browser sessions"
description: "The product session cookie, the fused session document and its build gate, key-to-session exchange, logout and keyless identity-required registration."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 5
---

A browser session is Identity's cookie-bearing principal. A page signs in through the [OIDC flow](/docs/features/sign-in/oidc/) or by presenting a license key, and gets a cookie bound to a synthetic `browser:<licenseId>` device row. A browser tab is authorized the same way a native install is: through Core's device principal.

## The cookie

The name is `pkey_<product>_session` (hyphens in the slug become underscores), with `Path=/<product>`, `HttpOnly`, `Secure`, `SameSite=Lax` and `Max-Age` of 30 days. It carries an opaque token. The record behind it lives in KV under a peppered hash, with a matching 30-day TTL, and holds the device's `pkeyt_` token, a CSRF value, the license id, the synthetic device id and a creation time.

The device token is a live credential, so it is stored sealed (AES-GCM under the platform KEK) and bound to that one session. A KV dump yields ciphertext, and a sealed token copied into another session fails to open. A cookie whose record is missing, unparseable or unopenable is treated exactly like no cookie, so the browser signs in again.

## The fused session document

`GET /<product>/identity/session` returns one fused document with license claims, config and entitlements together, not the split signed pair the SDKs use. It is minted for a page, as plain JSON inside an authenticated response with no signature to carry. `secrets` is always an empty object: a browser session never receives secret material.

| Situation                                                                | Response                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| No cookie, or its record is missing or corrupt                           | `200 { "authenticated": false, "doc": null }`                                                      |
| Session valid, but the device token or license fails the usability check | The same as no session                                                                             |
| Session valid, but no usable active catalog                              | `500 catalog_unavailable`. It fails closed, like the config document                               |
| Session valid, but the build gate blocks this version or channel         | `200 { "authenticated": true, "doc": null, "blocked": { "reason", "allowedRange" }, "csrfToken" }` |
| Session valid and nothing blocks it                                      | `200 { "authenticated": true, "doc": { … }, "csrfToken" }`                                         |

A session that no longer authorizes anything looks the same as no session, so a client can't tell "never signed in" from "license expired". `expiresAt` is `issuedAt` plus 3600 and `graceUntil` is `issuedAt` plus the offline days, clamped to the license's expiry while `licensing.clampGraceToExpiry` is on.

The build gate here and on the license document route is one computation, so a browser tab and a native client are refused the same builds. Both read `X-PKey-Version` and `X-PKey-Channel`.

## Key to session

`POST /<product>/identity/session/license` exchanges a license key, in the body as `{ "key": "<license key>" }` or as a bearer header, for a session cookie. The key must be active, and its license runs through the same device-limit authorization as activation. A device-limit conflict answers `403 device_limit` with `limit` and `deviceCount`. Success is `201` with `Set-Cookie`, and on a product with Identity on the body carries `keyEntries`.

This endpoint is an online oracle for guessing keys, so it is limited to 30 requests a minute per address, the same budget as activation.

## Logout

`POST /<product>/identity/auth/logout` requires the `X-CSRF-Token` header to equal the session's stored value, else `403 forbidden`. Logout is the one mutating session surface that checks CSRF, because its effect is visible without reading the response. It deauthorizes the `browser:<licenseId>` device, deletes its token record and the session record, and always clears the cookie, so a redundant logout ends signed out rather than erroring.

## Identity-required registration

When License is off and Identity is on, keyless registration is `requires-identity`. The browser session is the credential behind Core's `POST /<product>/devices/register`. Core asks Identity through the `authorizeRegistration` hook.

The hook checks one step less than the session document does. It loads the session from the cookie and validates the device token by itself: is it a live device, not does it hold a usable license. That makes the path work for a Config-only or Release-only product with sign-in and no device limit. It needs no CSRF check, because it mints a new credential returned only in the response body, which a cross-site caller could never read.

## Next steps

- [Product sign-in provider](/docs/features/sign-in/oidc/): how a sign-in ends up with a cookie.
- [Device flow](/docs/features/sign-in/device-flow/): the token-issuing counterpart.
- [Activation](/docs/features/licensing/activation/): the device-limit authorization both share.
