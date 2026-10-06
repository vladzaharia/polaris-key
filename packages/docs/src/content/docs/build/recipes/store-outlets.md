---
title: "Store outlets"
description: "Hide licence-key entry and outside purchase links in App Store, Play and Microsoft Store builds, using the outlet's commerce capability."
sidebar:
  order: 5
---

Store rules (App Store Review Guideline 3.1.1, Google Play payments) do not let an app sold
through the store unlock features with a licence key bought elsewhere, or link out to buy one.
The outlet a build came from decides it, and every SDK resolves the outlet the same way (the
build stamp, then attested and declared signals; `outlet-matrix.json`).

## Decide from the outlet's `commerce` capability

| `commerce`  | Outlet kinds                                                  | Key entry and "Buy" links                            |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `store-iap` | `app-store`, `testflight`, `play`, `play-testing`, `ms-store` | hide                                                 |
| `steam`     | `steam`                                                       | hide outside purchase links; keys only through Steam |
| `own`       | `direct`, `itch`, `flathub`, `snap`, `winget`, `web`, …       | show                                                 |
| `none`      | `unknown`                                                     | show key entry; no store purchase                    |

```ts
import { effectiveCapabilities } from "@polaris-key/client-core/decide";

const outlet = client.update.outlet; // resolved from the build stamp and signals
const caps = outlet
  ? effectiveCapabilities(outlet.kind, {
      platform: "macos",
      subkind: outlet.subkind,
    })
  : null;
const showKeyEntry =
  caps === null || (caps.commerce !== "store-iap" && caps.commerce !== "steam");
```

Godot exposes the same table as `PKeyDecision.effective_capabilities(kind, {platform = ..., subkind = ...})`,
with the outlet from `PolarisKey.update.outlet()`. Stamp the outlet at export (`pkey` CI or the
Godot export plugin), so a store build never relies on run-time detection alone.

The UI kits are moving to hide key entry automatically on these outlets (SDK parity pass §3.18);
until then, pass the decision to the activation screen yourself. Purchases on a store outlet go
through the store and the [commerce claim](/docs/services/distribution/commerce/).
