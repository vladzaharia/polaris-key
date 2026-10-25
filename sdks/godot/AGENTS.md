# AGENTS.md: sdks/godot

Local traps for the Godot addon. The root `AGENTS.md` rules still apply; usage and layout are in [README.md](README.md).

- **Pure GDScript first.** Verification and the headless runner need no native code; the bindings under `native/` are optional.
- **Mirrors are generated.** `tests/corpus/v2/` and `tests/transcripts/` are output of `pnpm gen corpus` and `pnpm gen transcripts`; never hand-edit them. An exported pack reads only `res://`.
- **Tests**: `sdks/godot/tools/run_tests.sh`. Set `GODOT_BIN` to the Godot binary; set `GODOT_TEMPLATE` to also export the project (CI runs both).
- Generated theme and catalog mirrors come from `pnpm gen brand` and `pkey mirror`; do not edit them by hand.
- Never weaken a runner or a replayer to get green.
