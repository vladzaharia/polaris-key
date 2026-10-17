---
title: "Troubleshoot shipping builds"
description: "Find the cause of a release, channel or update error from the code or message you see."
type: "troubleshooting"
lastReviewed: "2026-10-16"
---

Find the error or symptom below. For the full list of publish refusals, see [Publishing from CI](/docs/features/ship-builds/ci/#troubleshooting).

## policy_mismatch

**Cause.** The release job's token does not satisfy the product's publisher policy. The `failing claim` line names the check: `ref_protected`, `environment`, `job_workflow_ref`, `runner_environment` or `event_name`.

**Fix.** Match the job to `publishing.trustedPublisher` in `.pkey/release`: the declared workflow file and environment, a GitHub-hosted runner, a `push`, `release` or `workflow_dispatch` trigger, and a branch or tag ruleset over the ref.

**Check it works.** Re-run the job. The token exchange returns a `pkeyci_` token and the publish step continues.

## publisher_not_configured

**Cause.** The product has no publisher policy.

**Fix.** Add `publishing.trustedPublisher` to `.pkey/release` and resync, or have an operator configure it in the console.

**Check it works.** Re-run the job. The step no longer stops at the token exchange.

## missing_scope

**Cause.** The CI token lacks the scope the command needs. `release:yank`, `distribution:rollout`, `distribution:feeds`, `distribution:listing` and `assets:write` are opt-in.

**Fix.** Ask an operator to grant the scope on the product's publisher policy in the console. Scopes are never set from a manifest.

**Check it works.** Re-run the command. It no longer prints `missing_scope`.

## update_requires_distribution

**Cause.** The manifest or the product turns Update on while Distribution is off. A feed would have no delivery behind it.

**Fix.** Turn Distribution on, or declare the `distribution` module beside `release` and `update`. `distribution_requires_release` is the same rule one step earlier: Distribution on with Release off.

**Check it works.** Resync the manifest. It is accepted.

## The appcast answers 404

**Cause.** A release in the feed failed its signature check, or the product requires a signature the release does not have. The whole `/appcast.xml` answers `404` instead of offering an item Sparkle would refuse.

**Fix.** Upload the `.sig` sidecar next to the DMG, signed by the key the product configures. Check the key and the requirement on the **Feed** page under **Update**.

**Check it works.** Request the appcast again. A failed verdict is cached for a day, so a re-uploaded asset gets a fresh check; a changed key does too.

## channel-regressed

**Cause.** A channel is floored at a release that no longer exists, so the channel answers `404`. The release health check names the floor and what the release list offers now.

**Fix.** Restore the floor release, or have an operator lower or clear the floor. Only an operator can lower a floor.

**Check it works.** The release health check no longer lists the channel.

## A device is offered no update

**Cause.** Your channel resolves to a release the device may not take. Under the `entitled` access mode, a device sees only the channels and versions its license allows.

**Fix.** Check the license's channels and version limits, then see [Eligibility](/docs/features/ship-builds/updates/eligibility/) for how each check resolves.

**Check it works.** In **Compatibility**, run **What does this device get?** for the device. It names the release it would be offered.

For Release and Distribution error codes in the wire format, see [Wire error codes](/docs/reference/error-codes/).
