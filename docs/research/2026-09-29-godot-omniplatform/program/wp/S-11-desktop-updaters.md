# S-11 Spike: Sparkle, Velopack, WinSparkle and StoreContext from a Godot desktop app

| Field       | Value                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase       | S: Spikes                                                                                                            |
| Size        | 0.5–1 engineer-weeks                                                                                                 |
| Depends on  | none                                                                                                                 |
| Unblocks    | [P5-07](P5-07-desktop-plugins.md)                                                                                    |
| Role        | `pkey-spike-runner`                                                                                                  |
| Plan mode   | no                                                                                                                   |
| Gates       | `pnpm format` on the files it adds; no product code changes                                                          |
| Human input | none for unsigned builds; code-signing certificates and a Partner Center app for the parts the note marks unmeasured |
| Repo        | `vladzaharia/polaris-key`                                                                                            |

## Goal

A research note `notes/S-11-desktop-updaters.md`:

1. **macOS Sparkle bridge** (measured here): driving Sparkle 2 from a Godot GDExtension against the
   Worker's existing appcast/`sparkle:edSignature` output (the worker already emits Sparkle feeds);
   EdDSA verification, the installer helper in an unsigned vs ad-hoc-signed app, sandbox notes.
2. **Windows Velopack and WinSparkle** (on GitHub's `windows-latest` runner via a temporary workflow on
   a spike branch; never on main, never with secrets): packaging a Godot Windows export with Velopack
   (full and delta packages against the Worker's Velopack feed), WinSparkle against the WinSparkle feed,
   and what each needs from Polaris Key's feeds. Delete the spike branch when done.
3. **Microsoft Store StoreContext** (documented, plus whatever an unpackaged app can call): the APIs
   P5-07 and P5-04 need, and what requires a Partner Center app.
4. **The Godot desktop binding**: GDExtension vs a helper process; threading; how CI builds it.
5. What must still be measured with signing certificates (list it for the owner).

Mark claims [M]/[E]/[D]/[U]; end with the recipe P5-07 should build.
