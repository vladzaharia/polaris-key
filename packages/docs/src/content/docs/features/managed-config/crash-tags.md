---
title: "Crash tags for update health"
description: "Tag crash reports so a Sentry alert maps to the right release, channel and outlet and opens a halt candidate."
sidebar:
  order: 3
---

[Update health](/docs/services/distribution/update-health/) maps a Sentry issue alert to a
staged rollout through three values on every event. Set them when the crash SDK starts:

| Sentry field / tag | Value                              | Example        |
| ------------------ | ---------------------------------- | -------------- |
| `release`          | `<deliverable>@<version>+<build>`  | `app@1.4.0+12` |
| `environment`      | the channel                        | `beta`         |
| `pkey.outlet`      | the outlet id from the build stamp | `direct`       |

```ts
import * as Sentry from "@sentry/node";

const outlet = client.update.outlet; // { id, kind, subkind } once update options are set
Sentry.init({
  dsn: SENTRY_DSN,
  release: `app@${APP_VERSION}+${BUILD_NUMBER}`,
  environment: CHANNEL,
});
if (outlet?.id) Sentry.setTag("pkey.outlet", outlet.id);
```

```python
import sentry_sdk

outlet = client.update.outlet  # ResolvedOutlet(id, kind, subkind), or None
sentry_sdk.init(dsn=SENTRY_DSN, release=f"app@{APP_VERSION}+{BUILD_NUMBER}", environment=CHANNEL)
if outlet and outlet.id:
    sentry_sdk.set_tag("pkey.outlet", outlet.id)
```

In Godot the outlet is `PolarisKey.update.outlet()["id"]`. Without `pkey.outlet`, every
self-hosted rollout of that release on that channel is a candidate; nothing halts until an
operator confirms.

A one-call `crashTags()` that returns all three from the build stamp, in every SDK, is proposed
as `crash.tags` (SDK parity pass §3.14). No SDK depends on a crash SDK.
