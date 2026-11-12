---
title: "Platform sign-in setup"
description: "Register the Google, Apple, Game Center and Play Games clients that automatic sign-in checks, and where each value goes."
type: "how-to"
status: "shipped"
lastReviewed: "2026-11-11"
sidebar:
  order: 9
---

[Automatic sign-in](/docs/features/sign-in/automatic/) exchanges a token from the platform's own account for a device token. Polaris Key accepts only tokens made for your clients, so register them first. Use your own clients: Polaris Key's own Google client and Apple Services ID are refused.

## Where the values go

Declare them in the `identity` block of `.pkey/product`, or set them in the console under **Identity → App sign-in → Platform sign-in**. A manifest value wins until you revert it. The fields are in the [manifest reference](/docs/build/manifest/product/#identity-settings-identity).

```yaml title=".pkey/product"
identity:
  platformSignIn:
    google:
      serverClientId: "1234-web.apps.googleusercontent.com"
      clientIds:
        [
          "1234-and.apps.googleusercontent.com",
          "1234-ios.apps.googleusercontent.com",
        ]
    apple:
      teamId: "ABCDE12345"
      bundleIds: ["com.example.nightfall.mac"]
    gameCenter: true
    playGames:
      applicationId: "123456789012"
      serverClientId: "1234-web.apps.googleusercontent.com"
```

The console shows each provider's status: Ready, Not set up, or what is missing.

## Google

Create the clients in the Google Cloud console, in one project.

1. **Web client.** Its id is `google.serverClientId`, and the audience of every Google token, on every platform. On the web, add your app's origins to its authorized JavaScript origins.
2. **Android client.** One per package name, with the signing certificate's SHA-1. Register the Play app signing key, the upload key and the debug key. Its id goes in `google.clientIds`.
3. **iOS client.** One per bundle id. Its id goes in `google.clientIds`.

`clientIds` needs `serverClientId`. The Android and iOS ids are the token's authorized party; the web client is its audience.

On the web the page needs a Content-Security-Policy line: `connect-src https://accounts.google.com`. Inside an iframe, the frame needs `allow="identity-credentials-get"`.

## Apple

1. In your Apple Developer account, add the **Sign in with Apple** capability to every app id that signs in, and to the target's entitlements (`com.apple.developer.applesignin`).
2. Set `apple.teamId` to your 10-character team id.
3. List each bundle id that signs in in `apple.bundleIds`. Bundle ids from your App Store and TestFlight outlets are added for you.

Apple gives each developer team its own identifier for a person, so an Apple link made in your app works only in your team's apps. In another developer's app the person has no link until they sign in the regular way. Game Center and Play Games work the same: see [Where a method reaches](/docs/features/sign-in/accounts/#where-a-method-reaches).

App Review guideline 4.8 asks an app that offers another company's sign-in to offer an equivalent privacy-preserving one too. Sign in with Apple meets it, so if you ship Google sign-in on iOS, ship Apple too.

## Game Center and Play Games

Game sign-in has its own platform switch, `launch.gameSignIn`, which stays off until the operator turns it on (Platform → Settings). It also needs `launch.identityExchange`. With it off, both kinds are absent from discovery.

- **Game Center.** Set `gameCenter: true`. It uses the Apple team id and bundle ids above.
- **Play Games.** Set `playGames.applicationId` (the Play Console application id) and `playGames.serverClientId`. The server credential's client secret goes in the console under **Keys & secrets**, never in the manifest. The Kotlin SDK needs the `polaris-key-games` artifact.

## Steam

Steam has no sign-in inside your app. People sign in with Steam on the Polaris Locker sign-in card, which the operator sets up once under **Platform → Connections**, and that sign-in reaches every product. A Steam purchase reaches your app through [Commerce](/docs/features/commerce/), not through sign-in.

## Check it

Run `pkey validate`, then publish the manifest. Each provider's status under **Platform sign-in** should read Ready. A token for a client you did not list fails as `invalid_grant`, with no detail on purpose; see the [error codes](/docs/reference/error-codes/).
