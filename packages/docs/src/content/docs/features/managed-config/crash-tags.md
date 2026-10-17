---
title: "Crash tags"
description: "Tag crash reports with the release, track and install source so a Sentry alert maps to a staged rollout."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 6
---

Update health maps a Sentry issue alert to a staged rollout through three values on every event. Set them when your crash SDK starts.

Requires the Ship builds feature, a staged rollout, and an SDK that exposes the install source.

| Sentry field or tag | Value                             | Example        |
| ------------------- | --------------------------------- | -------------- |
| `release`           | `<deliverable>@<version>+<build>` | `app@1.4.0+12` |
| `environment`       | The release track                 | `beta`         |
| `pkey.outlet`       | The install source's id           | `direct`       |

## Steps

1. **App** Initialize your crash SDK with `release` as `<deliverable>@<version>+<build>` and `environment` as the release track.
2. **App** Read the install source's id from the client's update options and set it as the tag `pkey.outlet`. In Node it is `client.update.outlet`, with `id`, `kind` and `subkind`. In Python it is `client.update.outlet`, a resolved source or `None`,. In Godot it is `PolarisKey.update.outlet()`, a dictionary with an `id` key.
3. **App** Optional: `client.crashTags()` in Node and `client.crash_tags()` in Python return all three from the build stamp. No SDK depends on a crash SDK.

Without `pkey.outlet`, every self-hosted rollout of that release on that track is a halt candidate. Nothing halts until an operator confirms.

The SDK pages carry the compiled code for each crash SDK. See [Node](/docs/build/sdks/node/) and [Python](/docs/build/sdks/python/).

## Check it works

Send a test event and open it in Sentry. It shows the three values. The rollout page shows the event as a halt candidate for that release.

## If it isn't working

- [Update health](/docs/features/ship-builds/channels/update-health/): how alerts map to a rollout.
- [Updates](/docs/features/ship-builds/updates/): where the install source comes from.
