# tidewater: the Qt Quick kit sample

Tidewater Studio by Harbor Audio, a PySide6 app gated with `run_gate(client, window)` from
`polaris_key.ui.qt` (UK-12). It runs against the terminal sample's fixture adapter, with no Worker.

```sh
pip install "polaris-key[qt]"
python tidewater_qt.py                                  # the gate over the app
python tidewater_qt.py --scheme light --platform windows
python tidewater_qt.py --live --product your-slug --trust kid=base64key
```

`sdks/python/tests/ui/test_qt_sample.py` runs this sample offscreen in CI. The kit's page is
`/docs/build/ui/frameworks/qt/`.
