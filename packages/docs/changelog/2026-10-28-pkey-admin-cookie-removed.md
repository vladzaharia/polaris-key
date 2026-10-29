---
title: "PKEY_ADMIN_COOKIE is removed"
date: "2026-10-28"
version: "0.10.0"
type: "removed"
services: []
sdks: []
---

**Action required:** the `pkey` CLI no longer reads `PKEY_ADMIN_COOKIE`, and the listing import no longer takes a console cookie.

People run `pkey login`; CI sets `PKEY_ADMIN_TOKEN` to a `pkeya_` token. The listing import uses a personal token. A member's **Sign out everywhere** ends their admin tokens at once.
