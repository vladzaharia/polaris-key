# Python CLI sample

`mytool.py` is a product CLI that mounts the Polaris Key verb set (`sign-in`, `status`,
`devices`, `config`, `update`, `packs`, `boot`, `doctor` and the rest) next to its own `run`
command, and gates `run` on `client.boot()`.

```sh
uv add "polaris-key[keyring]"
python mytool.py --help
python mytool.py sign-in --browser
python mytool.py run
```

Replace `PRODUCT`, `VERSION` and `TRUST` with your product's values first. For click or typer,
mount `polaris_key.cli.polaris_click_group(client_factory)` or
`polaris_key.cli.polaris_typer_app(client_factory)` instead of `register_argparse`.
`sdks/python/tests/test_samples.py` builds this parser in CI.
