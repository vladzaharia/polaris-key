# tidewater: the Python terminal kit sample

The fictional Tidewater Studio by Harbor Audio, as a product CLI with the Polaris Key verbs
mounted under its own name and drawn by the terminal kit (`polaris_key.ui.terminal`, UK-13). It
runs against the fixture adapter in `tidewater_fixtures.py`, with no Worker.

```sh
pip install "polaris-key[cli]"          # rich; add [tui] for the Textual app
python tidewater.py --help
python tidewater.py status
python tidewater.py activate            # masked prompt; a key ending LIMITS shows Replace a device
python tidewater.py login               # the browser, or a code over SSH (or --device-code)
python tidewater.py devices --json
python tidewater.py --tui               # the Textual account view
```

`--live` uses a real Worker instead of the fixtures: pass your product's `--product` and its
`--trust kid=key` pairs. The kit's docs are on the
[Terminal (Python) page](/docs/build/ui/frameworks/terminal-python/).
`sdks/python/tests/test_samples.py` runs this sample in CI.
