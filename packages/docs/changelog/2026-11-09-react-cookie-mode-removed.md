---
title: "React cookie sessions are removed"
date: "2026-11-09"
version: "0.10.5"
type: "removed"
services: ["identity"]
sdks: ["react"]
replaces:
  - old: '`auth: "cookie"`'
    new: 'Bearer mode: `auth: "bearer"` (or the default `"auto"`) with `trust.pinnedKeys`; sign in with `signIn.start({ channel: "redirect" })` or the device code'
    surface: "sdk"
    sdk: "react"
  - old: "`navigate`, a provider test seam, and `pageOrigin`, a browser adapter option"
    new: "Nothing: a redirect sign-in navigates the page itself"
    surface: "sdk"
    sdk: "react"
  - old: "`splitSessionDoc`"
    new: "Nothing: the page verifies the signed license and config documents itself"
    surface: "sdk"
    sdk: "react"
  - old: "The routes `/<product>/identity/session`, `/<product>/identity/session/license` and `/<product>/identity/auth/logout`, the `pkey_<product>_session` cookie, and their entries in the identity discovery endpoints"
    new: "`POST /<product>/license/activate` for a key, the redirect or device-code sign-in for a person, and the device token's own sign-out"
    surface: "console"
  - old: "The return_to parameter of the browser flow's start route"
    new: 'The web redirect: `signIn.start({ channel: "redirect" })`'
    surface: "console"
  - old: "The setting `identity.browserSessionDays`"
    new: "Nothing: a browser page holds a device token, not a session"
    surface: "console"
---

**Action required:** a React or elements page (`PolarisKeyProvider`, `<pk-gate config>`) on `auth: "cookie"` must move to bearer mode before it upgrades. The cookie session and its Worker routes are removed together, with no window.

A page signs in with a device token it keeps in IndexedDB, verifies each document against `trust.pinnedKeys`, and lists its origin under `web.origins`. A product on Identity without License refuses `POST /<product>/devices/register`: sign-in mints the token. See [Browser sessions](/docs/features/sign-in/sessions/).
