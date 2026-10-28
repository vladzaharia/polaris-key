---
title: "Cloud Sync settings in React"
date: "2026-10-28"
version: "0.10.0"
type: "feature"
services: ["sync"]
sdks: ["react"]
---

`useSetting(key)` returns the value and its `sync` state, and `useCloudSync()` returns the Cloud Sync status, a `flush()` and the sign-in offer. `config.set` syncs through the browser host while a person is signed in. Cloud Sync is not available over the desktop bridge yet.
