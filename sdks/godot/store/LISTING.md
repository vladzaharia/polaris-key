# Store listing: Polaris Key for Godot

The text and assets for the Godot Asset Store and the legacy Asset Library entries, field by field.
Neither store has an upload API, so the owner pastes these by hand (see `CHECKLIST.md`). Keep the
summary and description in step with `sdks/godot/README.md`; the per-version changelog is the
version's section of `sdks/godot/CHANGELOG.md` (`python3 sdks/godot/tools/package.py --notes X.Y.Z`).

## Shared values

| Field             | Value                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Asset name        | Polaris Key                                                                                                            |
| Asset type        | Addon                                                                                                                  |
| Licence           | MIT (matches `LICENSE` at the repository root and `addons/polaris_key/LICENSE`)                                        |
| Source code       | https://github.com/vladzaharia/polaris-key                                                                             |
| Issues            | https://github.com/vladzaharia/polaris-key/issues                                                                      |
| Minimum Godot     | 4.4                                                                                                                    |
| Maximum Godot     | none                                                                                                                   |
| First version     | 0.1.0                                                                                                                  |
| Icon (square PNG) | `packages/brand/kit/05-app-icons/key/desktop/app-256.png` (the bit-less Pinned K app icon; 1024 px beside it)          |
| Icon, direct link | https://raw.githubusercontent.com/vladzaharia/polaris-key/main/packages/brand/kit/05-app-icons/key/desktop/app-256.png |

The icon is the launch kit's app icon, used as-is: the Pinned K without a terminal bit (BRAND.md,
owner decisions of 2026-10-03), so it needs no regeneration. The Asset Library requires the icon
link to start with `raw.githubusercontent.com`.

## Summary (one line)

Licensing, managed config, device sign-in, updates and downloadable packs for Godot 4, verified
offline against keys you pin. Pure GDScript, every platform including web.

## Description

Polaris Key is a licensing, remote-config and release-delivery platform. This addon is its Godot
client.

- Licence keys, keyless free licences, entitlements and device limits, with an offline grace
  period, verified against Ed25519 keys compiled into your game.
- Managed config and feature flags you change from the console without shipping a build, with
  per-player overrides, environment overrides for CI and short-lived tokens for third-party APIs.
- Device-code sign-in with a QR code, for consoles, TVs and desktops.
- Updates that respect the outlet: a Steam, itch or store build is never asked to update itself;
  a direct build can download a new version or swap in a new main pack, with a boot guard that
  rolls back a bad update.
- Downloadable content as Godot packs: verified, checked for scripts before mounting, delta
  updates on 4.6+, mounted at the next boot.
- A drop-in boot screen and UI kit (activation, sign-in, offline, settings, update prompt) that
  works with a gamepad and is themeable and translatable.
- A setup dock that checks your pinned keys, and an export plugin that stamps each build's outlet,
  channel and build number, with environment overrides for CI.

Pure GDScript: no GDExtension, so it exports to every platform Godot supports, web included. The
cryptography (Ed25519, SHA-512, compact JWS) is implemented in GDScript and passes the same
conformance corpus as the platform's Node, React, Python and Swift SDKs.

Requires a Polaris Key product (the control plane at key.plrs.im or your own deployment). Godot 4.4
or later; 4.6 or later recommended.

Setup: enable the plugin, fill in the Polaris Key dock (product, pinned keys), then
`await PolarisKey.boot()` in your first scene. The full guide is the repository's
`sdks/godot/README.md`.

## Tags (Asset Store)

`licensing`, `remote-config`, `feature-flags`, `updater`, `dlc`, `authentication`, `sdk`, `gdscript`

## AI usage disclosure (Asset Store, mandatory)

Draft for the owner to confirm or edit before submitting:

> This addon was written with substantial help from AI coding assistants (Anthropic's Claude),
> working from a written design and under the maintainer's review. Every change is held to the
> project's automated gates: the cross-language conformance corpus, the addon's headless test
> suites on Godot 4.4 to 4.7 (editor and exported release templates) and a clean-install smoke
> test.

## Asset Store version entry

| Field           | Value                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| Version name    | 0.1.0                                                                        |
| File            | `polaris-key-godot-v0.1.0.zip` from the GitHub Release (rooted at `addons/`) |
| Changelog       | the output of `python3 sdks/godot/tools/package.py --notes 0.1.0`            |
| Minimum Godot   | 4.4                                                                          |
| Maximum Godot   | (empty)                                                                      |
| Additional info | SHA-256 of the zip, from the release's `SHA256SUMS`                          |

## Asset Library (legacy) fields

The legacy library serves editors up to 4.6. Its installer drops a zip's top-level directory by
default on those editors, so it gets the `-assetlib` zip, which wraps `addons/` in one directory.

| Form field            | Value                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Asset Name            | Polaris Key                                                                                                            |
| Category              | Scripts                                                                                                                |
| Minimum Godot version | 4.4                                                                                                                    |
| Asset Version         | 0.1.0                                                                                                                  |
| Repository host       | Custom                                                                                                                 |
| Repository URL        | https://github.com/vladzaharia/polaris-key                                                                             |
| Issues URL            | https://github.com/vladzaharia/polaris-key/issues                                                                      |
| Download Commit/URL   | https://github.com/vladzaharia/polaris-key/releases/download/godot-v0.1.0/polaris-key-godot-v0.1.0-assetlib.zip        |
| Icon URL              | https://raw.githubusercontent.com/vladzaharia/polaris-key/main/packages/brand/kit/05-app-icons/key/desktop/app-256.png |
| License               | MIT                                                                                                                    |
| Description           | the Summary, a blank line, then the Description above                                                                  |
| Previews              | optional: screenshots from `sdks/godot/tools/ui_screenshots.gd`, hosted under `raw.githubusercontent.com`              |
