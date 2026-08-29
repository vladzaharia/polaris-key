---
title: "Administering Polaris Key"
description: "The console, enablement, secrets, keys, the KEK keyring, and the production runbook."
sidebar:
  order: 1
---

This section is for operators running an already-deployed Polaris Key instance — day-to-day
console work, and the procedures behind it. It assumes the platform is live at
`https://key.plrs.im` and you can sign in to `/manage`. If you are bootstrapping a fresh
deployment, start at [Deploying to production](/docs/admin/deploy/) instead.

:::note[Why real values are safe here]
This whole site is served at `/docs`, gated behind the same platform-admin session as the
console itself — there is no public docs origin. That is a deliberate decision (not an
oversight), and it is why this section carries the real runbook, the real production shape, and
real account identifiers where the source documents carry them. See
[Where the security material lives](/docs/admin/security-pointers/) for what is kept out even
of this gate.
:::

## Three places, one job each

| Place                                                       | For                                                                                                                                                 |                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The console, `/manage`                                      | Everyday operator work: registering products, editing licenses, minting keys, watching activity                                                     | [Take the tour](/docs/admin/console-tour/)                       |
| This docs site, `/docs`                                     | Reference and procedure: what a button actually does on the wire, and the runbooks for the things the console can't do (KEK rotation, first deploy) | You're reading it                                                |
| The repo runbooks, `docs/RUNBOOK.md` + `docs/DEPLOYMENT.md` | The canonical operations text. This site mirrors both in full — see below                                                                           | [Operating](/docs/admin/kek/) · [Deploying](/docs/admin/deploy/) |

The two repo runbooks are canonical; the pages here that carry their names
([Operating: the KEK keyring](/docs/admin/kek/), [Deploying to production](/docs/admin/deploy/))
are thin wrappers that render them whole, not summaries or rewrites. When the two disagree, the
runbook file wins and the wrapper page is stale.

## The pages in this section

| Page                                                                | What it covers                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [Console tour](/docs/admin/console-tour/)                           | The suite shell: every nav section, what each tab manages, and the screen a deep link into a disabled service shows.              |
| [Products](/docs/admin/products/)                                   | The product registry: manual create vs. linking a GitHub repo, reserved slugs, resync, and what deleting a product actually does. |
| [Services & enablement](/docs/admin/services-enablement/)           | Turning services on and off live, the manifest-vs-admin ownership split, and the coherence errors a bad combination returns.      |
| [Licenses & devices](/docs/admin/licenses-and-devices/)             | Creating and editing licenses, tier changes, keys, the device panel, fingerprint status, and the reset escape hatch.              |
| [Secrets & keys](/docs/admin/secrets-and-keys/)                     | Write-only product secrets, the setup-health required-secrets list, and signing-key rotation.                                     |
| [Operating: the KEK keyring](/docs/admin/kek/)                      | The full production runbook — deploy, secrets, the platform KEK, product operations, CI gates, troubleshooting.                   |
| [Deploying to production](/docs/admin/deploy/)                      | The full bootstrap runbook — external providers, Cloudflare resources, secrets, first deploy, DJDL onboarding.                    |
| [Offline bundles](/docs/admin/bundles/)                             | When to mint one, the console dialog, the `pkey bundle` CLI, and the import-window vs. grace-days distinction.                    |
| [Activity](/docs/admin/activity/)                                   | What lands in a product's audit log, and how the console pages through it.                                                        |
| [Where the security material lives](/docs/admin/security-pointers/) | The disclosure policy, and why the threat model and audit findings stay repo-only.                                                |

## Before you start

Two things are true of every page in this section:

- **One privilege level.** A signed-in admin session is either a platform admin or it does not
  exist — there is no per-product tier. Every admin sees every product; a manifest's
  `adminGroup` field is metadata, not an access grant. [Console tour](/docs/admin/console-tour/)
  says more about what that changes in the UI.
- **The worker enforces everything the console shows.** Nav sections hide when a service is
  off, and fields disable when nothing backs them — but that is an affordance, not the access
  control. Every admin endpoint re-checks session, group and CSRF on its own, so a stale tab or
  a hand-crafted request lands on the same rules a click would.

For the data these pages describe, see [D1 data model](/docs/reference/data-model/); for the
public routes a product itself serves, see [Public route table](/docs/reference/routes/).
