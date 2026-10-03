---
title: "Godot desktop updaters"
description: "The Godot SDK's native update plugins: Sparkle on macOS, Velopack, WinSparkle and the Microsoft Store on Windows, their export switches, signing, and what only the owner can check."
---

A Godot game on a direct desktop outlet updates its whole app through the platform's own updater.
Official Godot 4.6+ templates ignore `--main-pack`, so a full-app updater with deltas is the first
choice. The Godot SDK drives four of them through optional native plugins (GDExtensions) in
`sdks/godot/native/`. Each plugin sits behind a GDScript facade under
`addons/polaris_key/native/`. A build without the plugin still boots: every call then answers
`unsupported`, and the update prompt opens the build's download link.

| Facade             | Platform | Updater                                         | Feed it reads                                     |
| ------------------ | -------- | ----------------------------------------------- | ------------------------------------------------- |
| `PKeySparkle`      | macOS    | Sparkle 2 (`SPUStandardUpdaterController`)      | the extended appcast (`update.endpoints.appcast`) |
| `PKeyVelopack`     | Windows  | Velopack, with a launcher shim as the main exe  | `…/update/<channel>/velopack/releases.<vch>.json` |
| `PKeyWinSparkle`   | Windows  | WinSparkle, for installer builds                | `…/update/<channel>/winsparkle.xml`               |
| `PKeyStoreContext` | Windows  | Microsoft Store package updates in a Store MSIX | none: the Store knows the package                 |

The SDK picks the updater from the install, never the facade. Steam, itch, Microsoft Store, Mac
App Store, Flatpak and Snap builds never run Sparkle, Velopack or WinSparkle; a Store MSIX runs
only StoreContext. See [App-updater feeds](/docs/services/update/updater-feeds/) for the feeds
themselves.

## How a facade answers

Each facade's `availability()` is OK or the typed unsupported result:

- `runtime`: the wrong OS; a Velopack facade outside a Velopack install; a StoreContext facade
  without package identity, or with one of the HRESULTs a non-Store install gets (`0x803F6101`,
  `0x803F6107`, `0x80070002`). That is "not a Store install", never "no update".
- `dependency`: the GDExtension is not installed, or the library it loads is missing
  (`Sparkle.framework`, `velopack_libc.dll`, `WinSparkle.dll`).

The Windows extension loads `velopack_libc.dll` and `WinSparkle.dll` at run time. A missing DLL
therefore costs only its own updater; an import-linked one would unload all three Windows backends.

## Sparkle on macOS

The bridge refuses to start in three cases: off the main thread, without `Sparkle.framework`, and
without `SUPublicEDKey` in the bundle's `Info.plist`. Without that key Sparkle would accept
unsigned updates, so the facade answers `invalid-options`. The rule is the same one the
[Swift client](/docs/services/update/sparkle/) enforces. The facade never verifies an update
itself: the key in the signed bundle is the only anchor.

The feed URL comes from discovery and goes through Sparkle's delegate. The bearer for an
`entitled` feed goes into `httpHeaders`. Foundation drops it on a cross-origin redirect, so an
entitled enclosure must authorise itself.

Turn the plugin on per macOS export preset. CI can set each option through its environment
variable:

| Option                                 | Environment               | Effect                                               |
| -------------------------------------- | ------------------------- | ---------------------------------------------------- |
| `polaris_key/sparkle/enabled`          | `PKEY_SPARKLE`            | the export plugin's Sparkle switches below           |
| `polaris_key/sparkle/public_ed_key`    | `PKEY_SPARKLE_PUBLIC_KEY` | `SUPublicEDKey` (default: `update_eddsa_public_key`) |
| `polaris_key/sparkle/feed_url`         | `PKEY_SPARKLE_FEED_URL`   | `SUFeedURL`, only a fallback                         |
| `polaris_key/sparkle/automatic_checks` |                           | `SUEnableAutomaticChecks`                            |

With Sparkle on, the export plugin does four things:

1. It adds the keys to `application/additional_plist_content`.
2. It turns on the Disable Library Validation entitlement, which a GDExtension in a
   hardened-runtime app needs.
3. It never exports unsigned: `codesign/codesign` set to Disabled becomes the built-in ad-hoc
   signature. A disabled export keeps the template's own signature on a modified bundle, and
   Sparkle then rejects every update.
4. After an export to a `.app` it restores the executable bit on Sparkle's five Mach-O files,
   which Godot's `[dependencies]` copy drops.

The release job then runs `sdks/godot/native/macos/sign_and_notarize.sh`. It signs inside-out
with a Developer ID, notarises, staples and writes the zip that `sign_update` signs.

## Velopack, WinSparkle and StoreContext on Windows

- **Velopack.** Velopack starts the main exe for every `--veloapp-*` hook, so a small Rust shim
  is the main exe. It answers the hooks in milliseconds and then starts `<Game>_godot.exe`.
  `pack_velopack.ps1` runs `vpk pack --runtime win-x64` with the shim as `--mainExe`. The plugin
  passes the bearer through `vpkc_new_source_http_url_with_options`. It checks and downloads on
  a worker thread, then applies on exit with a restart. The feed's `FileName`s are bare names,
  which the Worker redirects to the package bytes.
- **Velopack needs public delivery, for now.** Velopack resolves each package's bare `FileName`
  against the feed URL. The Worker answers that path with a cross-origin 302 to the package's
  delivery URL on the bytes host, and Velopack drops `Authorization` on that redirect (notes/S-11
  §5.2; its HTTP client, ureq, drops it on every redirect, even a same-origin one, as P5-07's
  end-to-end run showed). Under `licensed` or `entitled` delivery the second hop is therefore refused. Discovery
  does not say which delivery a product uses, so the facade cannot refuse up front. A download
  that fails with 401 or 403 answers `unsupported` (`product`), and the prompt opens the build's
  download link. Use WinSparkle for a non-public Windows product until the package route streams
  same-origin or redirects to a signed URL.
- **WinSparkle.** It needs the EdDSA public key in `PKeyOptions.update_eddsa_public_key`; without
  one it refuses to start. The release's build `format` must be `inno`, `nsis` or `msi`, so the
  appcast carries the installer's silent arguments. WinSparkle asks the game to quit before it
  runs the installer.
- **StoreContext.** The plugin calls IInitializeWithWindow with the game window, so the consent
  dialog belongs to the game. Every blocking call runs on an MTA thread. The Microsoft Store
  adapter uses it for a `store` answer in a Store MSIX and falls back to the listing.
- **A Microsoft Store export** (outlet `ms-store`) ships `pkey_win.dll` alone. After the export,
  the SDK's export plugin removes both updater DLLs and the shim.

`sign.ps1` signs with the owner's Authenticode certificate or Azure Artifact Signing. Sign the
DLLs, the shim and the game exe before vpk and the installer sign their own outputs.

## Keys

The Sparkle and WinSparkle EdDSA private keys belong to CI, never to the Worker. The plugins only
carry the public key and the URLs. Keep `requireSparkleSignature` on: both updaters download the
whole payload before they reject a bad signature.

## What only the owner can check

The `native-desktop` workflow builds every plugin and runs the updates unsigned. These checks need
certificates or accounts and are recorded by whoever runs them:

1. A Developer ID export: Godot signs Sparkle's helpers with the hardened runtime, and
   `codesign --verify --deep --strict` passes.
2. Notarisation and stapling, and a quarantined first launch that passes Gatekeeper.
3. A Developer-ID 1.0 updates to a Developer-ID 1.1, and refuses a 1.1 signed by another team.
4. A notarised app without the Disable Library Validation entitlement fails to load the bridge.
5. Authenticode or Artifact Signing of the shim, the game exe, the DLLs and the installers, and
   SmartScreen on a fresh machine.
6. A signed MSIX from a Partner Center app (it can be hidden): the update query lists a flight,
   the consent dialog is owned by the game window, a silent install works with automatic updates
   on, and a mandatory flag reads `true`.
7. Where `user://` lands in a signed MSIX installed into `WindowsApps`.
8. Only if a direct build is ever sandboxed: Sparkle's installer launcher service.
