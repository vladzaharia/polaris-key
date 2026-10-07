# UI kit samples

One runnable sample per UI kit (`docs/design/UI-KITS.md` §6.1). The kits' shared docs are the
`build/ui/` section of the docs site, sourced from `packages/docs/src/content/docs/build/ui/`.

Every sample:

- shows the Tidewater-style fixture product, so its screens carry a product's identity and accent
  rather than Polaris Key's;
- runs against its SDK's test fixture adapters, with no live Worker, and takes a `--live` switch
  to talk to a real one;
- lives in `examples/ui/<id>/`, where `<id>` is the kit's id in
  `packages/docs/src/lib/uiKits.ts` (also its framework page, `/docs/build/ui/frameworks/<id>/`),
  with a README that says how to run it.

| Kit               | Sample                                                                                                    | Folder                             | Status  |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- |
| Web components    | One static HTML page using the CDN module; an htmx page                                                   | `elements/`                        | Not yet |
| React             | A Vite app with the whole flow; a Next.js App Router app with a `"use client"` boundary and settings page | `react/`                           | Not yet |
| Electron          | An Electron Forge app using `registerPolarisKey`, `exposePolarisKey` and the React kit                    | `electron/`                        | Not yet |
| Vue               | A Nuxt app                                                                                                | `vue/`                             | Not yet |
| Svelte            | A SvelteKit app                                                                                           | `svelte/`                          | Not yet |
| Angular           | An Angular standalone app                                                                                 | `angular/`                         | Not yet |
| React Native      | An Expo app for iOS and Android                                                                           | `react-native/`                    | Not yet |
| Tauri             | A Tauri v2 app with the plugin and the web components                                                     | `tauri/`                           | Not yet |
| SwiftUI           | One Xcode project with iOS, iPadOS, macOS, visionOS and tvOS targets, and a gallery of every state        | `swiftui/`                         | Not yet |
| UIKit, AppKit     | A storyboard-free UIKit app; an AppKit document app                                                       | `uikit/`, `appkit/`                | Not yet |
| Compose           | An Android app (gate, settings, adaptive layouts) and a Compose Desktop app                               | `compose/`                         | Not yet |
| Android Views     | An XML app using `PolarisKeyActivity`                                                                     | `android-views/`                   | Not yet |
| Godot             | A demo project: a title screen, a settings menu with the Account tab, a pack download; and its C# twin    | `godot/`, `godot-dotnet/`          | Not yet |
| Qt                | A PySide6 app                                                                                             | `qt/`                              | Not yet |
| Terminal (Node)   | The `tidewater` demo CLI: a commander program with the kit's verbs, on fixtures or `--live`               | [`terminal-node/`](terminal-node/) | Ready   |
| Terminal (Python) | The `tidewater` demo CLI in Python                                                                        | `terminal-python/`                 | Not yet |

Until the kits are rebuilt, [`../node-electron`](../node-electron) shows today's React kit in
Electron over the `PolarisBridge`.

## Adding a sample

1. Create `examples/ui/<id>/` with the sample and a README: what it shows, how to run it against
   the fixtures, and how to run it `--live`.
2. Link it from this table (the folder name becomes a link and the status becomes "Ready").
3. Fill the "Sample" section of the kit's framework page. The page's facts block finds the folder
   by itself at the next docs build.
