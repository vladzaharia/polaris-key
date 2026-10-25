---
title: "Swift has one gate"
date: "2026-10-24"
version: "0.9.18"
type: "breaking"
services: []
sdks: ["swift"]
replaces:
  - old: "`PolarisLoginView`, `PolarisGateModel`"
    new: "`PolarisKeyGate` (or `.polarisKey(client)`, which now draws it)"
    surface: "sdk"
    sdk: "swift"
  - old: "`PolarisSignIn`, `PolarisOfflineActivation`"
    new: "The kit's sign-in and offline screens, inside `PolarisKeyGate`"
    surface: "sdk"
    sdk: "swift"
  - old: "`GateOptions`"
    new: "`KitGateOptions` (`keyEntry`, `offlineActivation`); `returnURL`, `renewURL` and `blockedAction` have no counterpart"
    surface: "sdk"
    sdk: "swift"
---

`.polarisKey(client)` now draws the same gate as `.polarisKeyGate(client)` and still puts the model in the environment and syncs when the scene becomes active. `PolarisTheme` maps `branding` and `accent` onto the kit theme; its other fields are ignored, so set `.polarisKeyTheme(PolarisKeyTheme(...))`.
