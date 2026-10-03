# S-09 Spike: StoreKit 2, AppTransaction, AppDistributor, Keychain and the Godot iOS binding

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                     |
| Size        | 0.5–1 engineer-weeks                                                                                          |
| Depends on  | none                                                                                                          |
| Unblocks    | [P5-05](P5-05-apple-plugin-package.md)                                                                        |
| Role        | `pkey-spike-runner`                                                                                           |
| Plan mode   | no                                                                                                            |
| Gates       | `pnpm format` on the files it adds; no product code changes                                                   |
| Human input | none for the simulator parts; an Apple developer account and a device for the parts the note marks unmeasured |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Goal

S-01 settled Background Assets (GO, simulator-emulated) and S-06 found `AppDistributor.current` never
returns on the simulator. This spike covers the rest of P5-05 on this Mac's Xcode 27 and the iOS 26.5
simulator, as a research note `notes/S-09-apple-storekit-distributor.md`:

1. **StoreKit 2 with a `.storekit` configuration file** in the simulator: `Transaction.currentEntitlements`,
   purchase, refund simulation, and `AppTransaction.shared` (originalAppVersion, environment) — what a
   Swift package can verify locally, and what the JWS payloads look like (for P5-05's verification).
2. **AppDistributor / install source** on iOS 26: every API that reveals App Store vs TestFlight vs
   alternative marketplace vs developer build, which return on the simulator, and the fallback order
   P5-05 should use (cross-check S-06 §6).
3. **Keychain** from a Godot GDExtension: storing the device id and licence token with the right
   accessibility class and access group; behaviour across reinstall on the simulator.
4. **The Godot iOS binding shape**: a GDExtension (or the Godot 4 iOS plugin format) exposing async
   Swift APIs to GDScript, threading (main-actor isolation under Swift 6 / Xcode 16.4 as CI uses), and
   how it composes with S-01's Background Assets extension patch.
5. What must still be measured on a device (list it explicitly for the owner).

Mark claims [M]/[E]/[D]/[U]; end with the recipe P5-05 should build.

## Out of scope

Product code; App Store Connect changes; anything needing the owner's Apple account.
