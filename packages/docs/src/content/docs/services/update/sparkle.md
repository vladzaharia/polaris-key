---
title: "Swift client & Sparkle"
description: "The PolarisKeyUpdate target, the Sparkle version floor, the SUPublicEDKey trust anchor, and entitled feed headers."
---

This page is the client half of Update — specifically, the Swift package's integration
with [Sparkle](https://sparkle-project.org/), the update mechanism almost every native
macOS app already uses. Polaris Key's role here is narrow on purpose: point Sparkle at the
right URL, attach the right credential to its requests, and get out of the way of the one
thing Sparkle already does correctly.

## Five targets, one capability boundary

The Swift package ships five targets, and the split is a **link-time** guarantee, not just
a runtime flag:

| Target | Depends on | Platforms |
| --- | --- | --- |
| `PolarisKeyCore` | — | macOS, iOS |
| `PolarisKeyLicense` | Core | macOS, iOS |
| `PolarisKeyConfig` | Core | macOS, iOS |
| `PolarisKeyUpdate` | Core, Sparkle | macOS only |
| `PolarisKeyUI` | Core, License, Config | macOS, iOS |

A sixth target, the `PolarisKey` umbrella, re-exports Core, License, and Config for a
one-import adopter — but not Update. Pulling in the umbrella still never links Sparkle; a
product wires `PolarisKeyUpdate` in explicitly, which is what keeps the always-relevant
services one import away without making auto-updates something every consumer of the
package pays for by default. The package targets macOS 14 and iOS 17 as its floors; Update
itself is unreachable on iOS regardless, since Sparkle only exists for macOS.

A product that doesn't ship auto-updates never links `PolarisKeyUpdate`, which means it
never links Sparkle at all — "no update traffic" becomes a fact about the compiled binary,
not a promise about a code path nobody happened to call. `PolarisKeyUpdate` is the *only*
target in the whole package that touches Sparkle, and the conditioning is applied in both
of the two places it needs to be:

1. The package manifest's Sparkle product dependency is platform-conditioned to macOS.
2. Every Sparkle-touching source file inside `PolarisKeyUpdate` is individually guarded
   with a platform check.

Neither alone is sufficient — a platform-conditioned dependency with an unguarded import
still fails an iOS compile the moment that file is parsed, and a guarded import behind an
unconditioned dependency still drags a macOS-only framework onto an iOS link line. Both
together is what makes an iOS build genuinely never see Sparkle.

## The version floor

The package pins **Sparkle ≥ 2.6.4** as its minimum dependency version. That floor isn't a
routine bump — it's the fixed release Sparkle shipped a signature-verification CVE
(CVE-2025-0509) in, so the minimum is enforced at build time rather than left as a
recommendation in a README a project might not read.

## The trust anchor: what this SDK deliberately does not do

Sparkle verifies an update's signature against a public key — `SUPublicEDKey` — that lives
inside the **host application's own** code-signed `Info.plist`. That anchor is deliberately
outside any SDK's reach: a trust anchor an ordinary file could add to is worse than having
no second anchor at all, because the failure mode of "two anchors, one of them weaker" is
that the weaker one is exactly what an attacker targets. So `PolarisKeyUpdate` does exactly
one thing about update integrity, and it is not verification:

:::caution[Assertion, never reimplementation]
At construction time, `PolarisKeyUpdate` checks that `SUPublicEDKey` is actually present —
and non-empty — in the running app's own `Info.plist`, and **throws immediately** if it
isn't. It never verifies an update signature itself, and it never will: a Polaris-side
EdDSA check would be a second, weaker anchor sitting next to the real one, which is a worse
posture than trusting Sparkle's own check alone.
:::

The failure this catches is real and silent without it: an app that ships Sparkle without
`SUPublicEDKey` does not fail to build, does not fail to launch, and does not fail its
first update check — it simply accepts unsigned payloads from that point on. Failing loudly
at construction turns that into a crash a developer sees on their very first run, instead
of a supply-chain incident that surfaces in production.

## What Polaris Key does configure

Everything below is derived from the product's own **discovery document**
(`/<product>/.well-known/polaris.json`) rather than built from a hard-coded string, which
is what keeps an already-shipped app working across a server-side route change.

### The feed URL

The appcast URL — with `?arch=` applied for the running machine's architecture — is read
straight out of Update's discovery fragment. A host never constructs
`/<product>/update/…/appcast.xml` by hand; it asks discovery for the endpoint and lets the
SDK apply the channel and architecture. See
[Appcast](/docs/services/update/appcast/#architecture-selection) for what `arch` actually
selects and why this SDK always sends it explicitly rather than relying on the
unparameterized default.

### Entitled-mode headers

Sparkle makes its own HTTP requests — it fetches the appcast, and later the enclosure,
independently of the rest of the SDK's networking. For an `entitled`-mode product, that
means Sparkle's requests need the device's bearer token or the feed simply answers `401`
on every check; there is no other path for the credential to reach Sparkle's own fetch. The
SDK configures Sparkle's HTTP headers with exactly that token (alongside the same client
metadata headers every SDK request carries) so an entitled feed is reachable at all. A
`public` product sends an empty header set, and Sparkle behaves precisely as if this SDK
had never touched it. See [Eligibility](/docs/services/update/eligibility/) for what the
server actually enforces once that request arrives.

### The allowed-channels filter

Sparkle asks its delegate which channels an installation may see before it offers a build.
The SDK answers from the license's own `channels` entitlement — the same value
[Eligibility](/docs/services/update/eligibility/) checks server-side — rather than
whatever channel list a host happened to hard-code, which is exactly the gap that let a
stable-only customer get offered a beta build in the first place.

:::note[A narrowing, not the enforcement point]
This filter decides what a user is *offered*; it decides nothing about what they're allowed
to *install*. If it and the server ever disagree — a stale cached entitlement, a bug — the
request Sparkle actually sends is what gets enforced, and the user sees a refusal instead of
a silent download. Treating a client-side filter as the security boundary is precisely the
mistake a well-built system avoids: the client narrows for UX, the server decides for real.
:::

## The version check, independent of Sparkle

`UpdateClient`'s plain version check (`GET /<product>/update/version`) has nothing to do
with Sparkle — it's an ordinary HTTP call a host can make on its own schedule, and it
answers using the *same* semver comparison the server's own build gate uses, so this check
and the server can never disagree about what counts as newer. It refuses immediately,
before opening a socket, when the product doesn't run Update at all — a disabled service
and a missing route answer with the same refusal server-side, so there's nothing this call
could learn by probing that the capability map doesn't already say.

## Retaining the delegate

`SPUUpdater.delegate` is a **weak** reference. The object the SDK's Sparkle configuration
call returns has to be retained by the caller for as long as the updater should keep using
it — this is the one integration step that fails silently: a delegate that deallocates
doesn't crash or log anything, it just quietly reverts Sparkle to whatever `SUFeedURL` and
default behavior are baked into the host's `Info.plist`, and update checks keep running as
if none of this configuration had ever happened.

## Why the line sits where it does

Every design choice on this page follows from one position: client-side checks are UX and
accounting, not a security boundary. A client can be patched, and a licensing system that
pretends otherwise is fooling its own operator more than any attacker. That's why this SDK
asserts the trust anchor instead of adding one, why the channel filter is documented as a
narrowing rather than a gate, and why the version check exists to inform a user rather than
to block one. The real enforcement — signature verification, the entitled channel and
version check — lives where it can actually hold: in Sparkle's own code-signed anchor, and
on the server, respectively.

## See also

- [Appcast](/docs/services/update/appcast/) — the feed this client polls, and the
  server-side signature check that gates what reaches it.
- [Eligibility](/docs/services/update/eligibility/) — what the entitled check actually
  enforces once a request lands.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — the download route
  behind every enclosure Sparkle fetches.
