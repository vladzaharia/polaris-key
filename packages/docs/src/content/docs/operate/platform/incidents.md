---
title: "Incidents"
description: "Where to start when products return 404, a connector fails, a rollout halts, a feed is stale or email is down."
type: "overview"
lastReviewed: "2026-10-16"
sidebar:
  order: 8
---

Find the symptom, then open the page that owns it.

**Role required:** Platform admin.

| Symptom                                                     | Start at                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every product's routes answer 404 at once                   | [Platform secrets and the KEK](/docs/operate/platform/runbook/rotate-the-kek/). A keyring that cannot open sealed values fails silently, and `/manage` still loads. |
| The console does not sign in, or a repository does not sync | [Troubleshoot the platform](/docs/operate/platform/runbook/troubleshooting/)                                                                                        |
| A secret or a signing key may have leaked                   | [Respond to a key compromise](/docs/operate/platform/runbook/respond-to-a-key-compromise/)                                                                          |
| A store connector fails                                     | [Store connections](/docs/operate/platform/connections/). The check names the account and what the key can see.                                                     |
| A rollout halted by itself                                  | [Update health](/docs/features/ship-builds/channels/update-health/). The auto-halt is opt-in; the page shows the rates it acts on.                                  |
| A feed looks stale, or background work is late              | [Operations](/docs/operate/platform/jobs/) shows cron runs and the queue backlog.                                                                                   |
| Sign-in email does not arrive                               | [Email delivery](/docs/operate/platform/email/)                                                                                                                     |
| A deploy broke something                                    | [Deploy a release](/docs/operate/platform/runbook/deploy-a-release/)                                                                                                |
