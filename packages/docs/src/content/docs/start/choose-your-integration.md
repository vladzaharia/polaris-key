---
title: "Choose your integration"
description: "Compare the drop-in UI kit with your own UI, and find your SDK's kit, quickstart and reference."
type: "overview"
sdks: ["node", "react", "python", "swift", "kotlin", "godot"]
lanes: ["kit", "library"]
lastReviewed: "2026-10-10"
---

Every SDK has a drop-in lane and an own-UI lane. The drop-in lane gives you the SDK's UI kit, whole or one screen at a time. The own-UI lane gives you the SDK's headless layer, and you draw the screens. Both lanes share the SDK's setup and the generated config file.

## Compare the lanes

| Criterion        | Drop-in UI kit                                                       | Your own UI                                                          |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| What you write   | One call that gates the app, or the kit's screens you pick           | Your screens over the SDK's state, actions and copy keys             |
| Screens          | The kit's: boot, sign-in, devices, updates, settings                 | Yours                                                                |
| Look             | The Polaris Key look in your product's accent, with theming          | Your design system                                                   |
| Wording          | The kit's copy catalog                                               | Yours. The SDK gives a copy key for each step                        |
| States to handle | The kit handles them                                                 | You handle each one. The SDK names them                              |
| You are…         | Shipping quickly, or happy with the Polaris Key look on every screen | Matching an existing design, or building a flow the kit doesn't have |

## Find your SDK

| SDK    | Host                    | Drop-in UI kit                                             | Your own UI                                                 | Start with                                          |
| ------ | ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Node   | CLIs, Electron, servers | [Terminal kit](/docs/build/ui/frameworks/terminal-node/)   | [Node, your own UI](/docs/build/sdks/node/your-own-ui/)     | [Node quickstart](/docs/build/quickstart/node/)     |
| React  | Web apps                | [React kit](/docs/build/ui/frameworks/react/)              | [React, your own UI](/docs/build/sdks/react/your-own-ui/)   | [React quickstart](/docs/build/quickstart/react/)   |
| Python | CLIs, servers, tools    | [Terminal kit](/docs/build/ui/frameworks/terminal-python/) | [Python, your own UI](/docs/build/sdks/python/your-own-ui/) | [Python quickstart](/docs/build/quickstart/python/) |
| Swift  | macOS, iOS, iPadOS      | [SwiftUI kit](/docs/build/ui/frameworks/swiftui/)          | [Swift, your own UI](/docs/build/sdks/swift/your-own-ui/)   | [Swift quickstart](/docs/build/quickstart/swift/)   |
| Kotlin | Android, JVM            | [Compose kit](/docs/build/ui/frameworks/compose/)          | [Kotlin, your own UI](/docs/build/sdks/kotlin/your-own-ui/) | [Kotlin quickstart](/docs/build/quickstart/kotlin/) |
| Godot  | Games                   | [Godot kit](/docs/build/ui/frameworks/godot/)              | [Godot, your own UI](/docs/build/sdks/godot/your-own-ui/)   | [Godot quickstart](/docs/build/quickstart/godot/)   |

## Other ways in

- [Polaris Locker](/docs/reference/portal-api/): your customers manage their own licenses and devices, with no code from you.
- [Server verification](/docs/features/licensing/server-verification/): check a license from your backend.
- [HTTP API](/docs/reference/http-api/): call Polaris Key from any language.
- [The pkey CLI](/docs/reference/cli/) and [GitHub Action](/docs/reference/github-action/): manifests, releases and CI.

## Related

- [Your first product](/docs/start/first-product/)
- [UI kits](/docs/build/ui/)
- [All SDKs](/docs/build/sdks/)
