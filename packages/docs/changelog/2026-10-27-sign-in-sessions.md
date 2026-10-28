---
title: "Sign-in is one session call"
date: "2026-10-27"
version: "0.10.0"
type: "breaking"
services: ["identity"]
sdks: ["node", "react", "python"]
---

**Action required:** replace the old sign-in calls. They are removed with no aliases. Each row is on [Upgrade to 0.9](/docs/build/upgrade-to-0-9/).

`identity.signIn.start()` (Python: `sign_in.start()`) starts a `device-code` or `redirect` sign-in and answers a session with `wait`, `reopen`, `cancel` and `complete(callbackUrl)`. `identity.choice` and `useLicenseChoice` run the license choice. `subject`, `signOut`, `attach` and `openAccount` are the account calls.

A key activation can answer `key-entry-limit` (`manageUrl`, `keyEntries`) or `license-owned` (`signInUrl`). Neither wipes the device's token.
