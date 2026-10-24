---
title: "pkey feeds fdroid moved"
date: "2026-10-24"
version: "0.9.18"
type: "removed"
services: ["distribution"]
sdks: []
replaces:
  - old: "`pkey feeds fdroid`"
    new: "`pkey storefront fdroid`, with the same flags"
    surface: "cli"
---

**Action required:** change the command in your CI. `pkey feeds fdroid` exits 2 and runs nothing. The flags are the same.
