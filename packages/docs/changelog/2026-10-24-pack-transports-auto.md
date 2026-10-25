---
title: "transports.packs: auto"
date: "2026-10-24"
version: "0.9.18"
type: "feature"
services: ["distribution", "release"]
sdks: []
---

`transports.packs: auto` in `.pkey/distribution` sends each pack through Apple Background Assets on `app-store` and `testflight`, a Steam depot on a `steam` channel whose new `depots` map names the pack, and the CDN elsewhere. It never picks Play Asset Delivery. After a pack publish, the Action's `channels: auto` runs `pkey channel sync --deliverable <pack>`, which packages and uploads the pack and skips a step that lacks a runner or secret. SteamCMD needs its login installed first. See [Ship a pack through an app store](/docs/features/ship-builds/packs/transports/).
