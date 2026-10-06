---
title: "Recipes"
description: "Task-shaped integration recipes that hold in every SDK: device-limit recovery, server-side licence checks, crash tags, attestation-gated products and store outlets."
sidebar:
  order: 4.6
  label: "Recipes"
---

Each recipe is one task, the calls that do it today, and where an SDK still has a gap (with its
entry in the [parity matrix](/docs/reference/parity/)). Start from the
[Integrate in 5 minutes](/docs/build/quickstart/) page for your SDK.

| Recipe                                                                 | When you need it                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Device-limit recovery](/docs/build/recipes/device-limit/)             | Activation is refused because the licence's seats are all taken        |
| [Server-side licence checks](/docs/build/recipes/server-verification/) | Your own backend must trust what a device says about its licence       |
| [Crash tags for update health](/docs/build/recipes/crash-tags/)        | Sentry alerts should open halt candidates for the right rollout        |
| [Attestation-gated products](/docs/build/recipes/attestation/)         | Edge-mint, gated downloads or claims require an attested store install |
| [Store outlets](/docs/build/recipes/store-outlets/)                    | An App Store, Play or Microsoft Store build must not offer key entry   |
