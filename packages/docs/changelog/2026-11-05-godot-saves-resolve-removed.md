---
title: "Godot PKeySaves.resolve is removed"
date: "2026-11-05"
version: "0.10.4"
type: "removed"
services: ["sync"]
sdks: ["godot"]
replaces:
  - old: "`PKeySaves.resolve`"
    new: "`cloudSync.mergeRequest.keep`, from the merge request a conflict hands you"
    surface: "sdk"
    sdk: "godot"
---

**Action required:** a Godot game that settled a save conflict with `PKeySaves.resolve` now takes the merge request the conflict hands it and calls `keep` on it. Every SDK settles a conflict the same way now.
