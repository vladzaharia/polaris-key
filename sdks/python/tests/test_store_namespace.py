"""SP-41: a non-default base URL keeps its state under ``<slug>@<host>``; production names are
unchanged, so a ``pkey dev`` run never touches production state on the same machine."""

from polaris_key.core.dirs import resolve_dirs, store_namespace
from polaris_key.devices.store import FileStore, KeyringStore


def test_production_names_are_unchanged() -> None:
    assert store_namespace("djdl", None) == "djdl"
    assert store_namespace("djdl", "https://key.plrs.im") == "djdl"
    assert store_namespace("djdl", "https://KEY.plrs.im/") == "djdl"


def test_other_hosts_are_namespaced() -> None:
    assert store_namespace("djdl", "http://127.0.0.1:8787") == "djdl@127.0.0.1_8787"
    assert store_namespace("djdl", "https://key.example.com") == "djdl@key.example.com"


def test_dirs_and_keyring_service_follow_the_namespace(tmp_path) -> None:
    ns = store_namespace("djdl", "http://127.0.0.1:8787")
    dirs = resolve_dirs("djdl", namespace=ns, config_dir=str(tmp_path))
    assert dirs.config.endswith("djdl@127.0.0.1_8787")
    assert KeyringStore("djdl", str(tmp_path), namespace=ns).service.endswith(ns)
    assert KeyringStore("djdl", str(tmp_path)).service.endswith("djdl")


def test_a_dev_file_store_leaves_production_state_alone(tmp_path) -> None:
    prod = FileStore("djdl", str(tmp_path))
    dev = FileStore(
        "djdl", str(tmp_path), namespace=store_namespace("djdl", "http://127.0.0.1:1")
    )
    prod.set_token("prod")
    dev.set_token("dev")
    assert prod.get_token() == "prod"
    dev.clear_token()
    assert prod.get_token() == "prod"
