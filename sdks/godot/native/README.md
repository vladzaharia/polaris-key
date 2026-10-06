# Godot SDK — native desktop update plugins (P5-07)

Optional GDExtensions behind the GDScript facades in `addons/polaris_key/native/` (`PKeySparkle`,
`PKeyVelopack`, `PKeyWinSparkle`, `PKeyStoreContext`). Without them every facade answers
`unsupported` (`runtime` on the wrong OS, `dependency` without the library) and P3-10's adapters
open the build's download link, so a game never fails to boot for want of a native library. Only
source lives here; CI builds the binaries (`.github/workflows/native-desktop.yml`), and nothing
under `dist/`, `bin/`, `.deps/` or `target/` is committed.

SP-27 adds the desktop keyring pieces behind `PKeyKeyringStore`: the macOS build of
`PolarisKeyApple` (`macos/build_apple.sh`) and `pkey_win.dll`'s `PKeyWinCredentialNative`. Without
them the token stays in the 0600 file and `store_status()` says `keyring-unavailable`.

The docs page `/docs/services/update/godot-desktop/` is the adopter view. The measurements behind
every rule are in `docs/research/2026-09-29-godot-omniplatform/notes/S-11-desktop-updaters.md`.

## Layout

```
deps.env, fetch_deps.sh    pinned inputs (godot-cpp commit, Sparkle, velopack_libc, WinSparkle; SHA-256)
macos/                     PKeySparkleNative (pkey_sparkle.mm), build.sh, pkey_sparkle.gdextension,
                           sign_and_notarize.sh (inside-out, notarytool, staple, Sparkle zip);
                           build_apple.sh, pkey_apple_macos.gdextension (SP-27: PolarisKeyApple's
                           desktop dylib, the login keychain for PKeyKeyringStore)
windows/                   pkey_win.dll: velopack/, winsparkle/, storecontext/ (C++/WinRT, C++20),
                           credman/ (SP-27: Credential Manager for PKeyKeyringStore),
                           src/register.cpp; SConstruct, build.ps1, pkey_win.gdextension;
                           velopack/shim/ (the Rust --mainExe), pack_velopack.ps1, sign.ps1,
                           installer/game.iss
e2e/                       the probe project, gen_feeds.mts (the Worker's own renderers and
                           verifier), server.py (with the Velopack 302 route), jcheck.py,
                           macos/run.sh, windows/run.ps1
```

## Building

```sh
sdks/godot/native/macos/build.sh --install <game project>          # macOS 12+, Xcode CLT, SCons >= 4.11
GODOT_BIN=godot sdks/godot/native/macos/build_apple.sh --install <game project>   # macOS 14+, Xcode 26 (keyring)
pwsh sdks/godot/native/windows/build.ps1 -Install <game project>   # VS 2026, SCons >= 4.11, Rust, Git Bash
```

Both install into `<project>/addons/polaris_key/native/bin/`, where the `.gdextension` files
expect them. godot-cpp is built once per deps directory (about 95 s on an M-series Mac; 287–503 s
on `windows-latest`, under 30 s with `.deps/godot-cpp` cached, which also holds the SCons
signatures). The plugins are built against the 4.4 API and load in 4.4+ editors and templates.

## Shipping

- **macOS**: enable `polaris_key/sparkle/enabled` on the preset and set the public key; export to a
  `.app` (Xcode codesign with a Developer ID in a release job; never Disabled); run
  `macos/sign_and_notarize.sh --app Game.app --identity "Developer ID Application: …"
--notary-profile <profile> --zip Game-<v>.zip`; `sign_update` the zip and a `BinaryDelta`
  against the previous release; publish.
- **Windows, Velopack**: export as `<Game>_godot.exe`; `pack_velopack.ps1 -ExportDir … -PackId Game
-Version <v> -OutputDir releases [-SignParams …]`; publish the `.nupkg`s.
- **Windows, WinSparkle**: set `PKeyOptions.update_eddsa_public_key`; build an Inno Setup, NSIS or
  MSI installer and publish it with that `format`; sign the installer's EdDSA signature in CI.
- **Microsoft Store**: an export stamped `ms-store` ships `pkey_win.dll` alone; StoreContext is its
  only updater.

`windows/sign.ps1` signs with the owner's certificate. No job in this repository holds one.

## End-to-end runs

`e2e/macos/run.sh` and `e2e/windows/run.ps1` export the probe project through the SDK's export
plugin, package it, render the feeds with the Worker's code and update 1.0.0 to 1.0.1 through the
P3-10 bridges, unsigned (ad hoc on macOS). See each script's header for the cases. Locally:

```sh
GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot sdks/godot/native/e2e/macos/run.sh
```

## Owner checklist (notes/S-11 §7)

Certificates and accounts only the owner holds; record each result in the work package's PR:

1. Developer ID: Godot's codesign signs Sparkle's helpers inside-out with the hardened runtime;
   `codesign --verify --deep --strict` passes; Sparkle's `Autoupdate` runs.
2. Notarisation: the zip notarises with the GDExtension and Sparkle inside; staple; a quarantined
   first launch passes Gatekeeper.
3. Two Developer-ID builds: 1.0 updates to 1.1, and a 1.1 signed by another team or ad hoc is
   refused.
4. Developer ID: a notarised app without Disable Library Validation fails to load
   `libpkey_sparkle.dylib`, and loads it with the entitlement.
5. Authenticode or Azure Artifact Signing: the shim, `<Game>_godot.exe`, `pkey_win.dll`,
   `velopack_libc.dll`, `WinSparkle.dll` and the installers; `vpk pack --signParams` or
   `--azureTrustedSignFile`; SmartScreen on a fresh machine.
6. A signed MSIX and a Partner Center app (it can be hidden): installed from the Store, the update
   query lists a flight update, the consent dialog is owned by the game window, the silent install
   works with automatic updates on, a mandatory flag reads `true`.
7. A signed MSIX in `WindowsApps`: where `user://` lands and whether the install directory is
   read-only (S-05 (d)).
8. Optional, only for a sandboxed direct build: `SUEnableInstallerLauncherService` with the
   `-spks`/`-spki` exceptions.
