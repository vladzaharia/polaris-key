# S-10 Spike: Play In-App Updates, Play Asset Delivery, PackageInstaller and the Godot Android binding

| Field       | Value                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                   |
| Size        | 0.5–1 engineer-weeks                                                                                        |
| Depends on  | none                                                                                                        |
| Unblocks    | [P5-06](P5-06-kotlin-aar.md)                                                                                |
| Role        | `pkey-spike-runner`                                                                                         |
| Plan mode   | no                                                                                                          |
| Gates       | `pnpm format` on the files it adds; no product code changes                                                 |
| Human input | none for the emulator parts; a Play Console test track and a device for the parts the note marks unmeasured |
| Repo        | `vladzaharia/polaris-key`                                                                                   |

## Goal

A research note `notes/S-10-android-play-installer.md`, measured on the local Android SDK and emulator
(install a JDK with mise if missing; the SDK is at ~/Library/Android/sdk):

1. **In-App Updates** with `FakeAppUpdateManager`: flexible and immediate flows, the states P5-06 must
   map to Polaris Key's update decision, and what can only be seen with a real Play install.
2. **Play Asset Delivery** with `bundletool --local-testing`: install-time, fast-follow and on-demand
   packs from an `.aab`, `AssetPackManager` states, and how a Godot app mounts a delivered `.pck`.
3. **PackageInstaller sessions** for direct (non-Play) APK updates: permissions
   (`REQUEST_INSTALL_PACKAGES`), user-action prompts, session commit results, and Android 14/15
   restrictions (update ownership, `setRequestUpdateOwnership`).
4. **Install source and Keystore**: `getInstallSourceInfo`, `installingPackageName` on the emulator
   (cross-check S-06), and storing a device id/licence token in Android Keystore.
5. **The Godot Android binding**: a Godot 4 Android plugin (v2, AAR) exposing these to GDScript,
   threading, and how CI builds it (Gradle + the Godot Android template).
6. What must still be measured with a real Play install (list it for the owner).

Mark claims [M]/[E]/[D]/[U]; end with the recipe P5-06 should build.
