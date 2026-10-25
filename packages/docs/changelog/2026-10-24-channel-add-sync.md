---
title: "pkey channel add and sync"
date: "2026-10-24"
version: "0.9.18"
type: "feature"
services: ["distribution"]
sdks: []
---

`pkey channel add <id>` appends a channel to `.pkey/distribution`. `pkey channel sync` runs the steps your declared channels have. The publish Action runs `sync` after an app release unless you set `channels: none`.
