# AGENTS.md: conformance

Local traps for the corpus and its runners. The root `AGENTS.md` rules still apply; the full rule list and the generated-file inventory are in [README.md](README.md) (Rules here).

- **Never hand-edit generated corpus files** in `corpus/v2/`, nor the Godot mirror `sdks/godot/tests/corpus/v2/`. Regenerate with `pnpm gen corpus` and commit the result in the same change.
- **Transcripts** (`transcripts/*.json` and `sdks/godot/tests/transcripts/`) are recorded by the Worker's scenario tests with `pnpm gen transcripts`; never edit them.
- **`corpus/v2/content/blobs/` are inputs.** They are added only through `--rebuild-content-blobs` in `tools/sign-corpus.ts`, which may only add. Changing an existing blob is a PR of its own.
- **Never weaken a runner** to make a change pass. A wire change bumps `PROTOCOL_VERSION` and must pass every runner.
- A new error code needs an entry in `parity/errors.json` first.
