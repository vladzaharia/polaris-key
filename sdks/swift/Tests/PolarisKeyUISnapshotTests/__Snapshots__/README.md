# Kit baselines

iOS: flat `<component>-<state>[-<variant>]-<scheme>.png`, recorded with `examples/ui/swiftui/run.sh`.

macOS (UK-08.8): `<component>-<state>/mac<OS>-<window>-<state>-<preset>-<scheme>[...].png`,
recorded by CI's `swiftui-mac` job (`mac26-*` the full set, `mac15-*` the board screens at 900x640).
The first run on an OS with none records them and passes: copy them from the job's artifact
(`swiftui-mac-26`, `swiftui-mac-15`; paths inside it are already relative to this directory's
parent) into this directory and commit them. Never record by hand.

The baseline commit also flips the lane back: remove `continue-on-error: true` from the `swiftui-mac` job and add `swiftui-mac` to `ci-ok`'s `needs` (and flip the assertions in `tools/ci-scope.test.ts`).
