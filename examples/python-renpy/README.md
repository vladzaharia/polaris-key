# Ren'Py snippet

`polaris_key.rpy` boots Polaris Key in the splash screen and shows a minimal activation screen
when the device needs one. Drop it into your game's `game/` directory and vendor the SDK into
`game/python-packages/` (`pip install --target game/python-packages "polaris-key[keyring]"`).

The screen is deliberately bare: a full Ren'Py screen kit is tracked by the UI-kit program.
`sign_in_with_browser()` opens the device-code page in the system browser and waits, so the
button runs it on a background thread (`renpy.invoke_in_thread`), never on the UI thread.
`sdks/python/tests/test_samples.py` compiles the snippet's Python in CI.
