# @pkey-feature core.store
"""``KeyringStore.status()`` and the one read rule (P1b-09 plan §5.5, security finding R4-11).

THE INVARIANT under test: the 0600 token file exists only when the last token write fell back,
because a verified keyring write removes it. So reads are file-first, a fallen-back write
deletes the keyring entry, and ``status()`` says ``file`` exactly when ``get_token`` returns the
file's token or the keyring cannot be read. The ``keyring`` package is replaced by a
programmable double, so nothing here touches a real OS keyring.
"""

from __future__ import annotations

import os
import stat
from typing import Any, Optional

import pytest

from polaris_key.core.store import (
    STORE_BACKENDS,
    STORE_DEGRADED_REASONS,
    StoreDegraded,
    StoreStatus,
)
from polaris_key.devices.store import FileStore, InMemoryStore, KeyringStore

PRODUCT = "djdl"


class _Backend:
    """A usable keyring backend (any module other than fail/null)."""


def _backend_from(module: str) -> Any:
    cls = type("Keyring", (), {})
    cls.__module__ = module
    return cls()


class FakeKeyring:
    """Mimics the ``keyring`` module's four functions, with per-op failure switches."""

    def __init__(self, backend: Any = None) -> None:
        self.backend = backend if backend is not None else _Backend()
        self.secret: Optional[str] = None
        self.fail_get: Optional[str] = None
        self.fail_set: Optional[str] = None
        self.fail_delete: Optional[str] = None
        #: Make ``get_password`` return something else (a lying backend).
        self.read_back: Optional[str] = None
        self.deletes = 0

    def get_keyring(self) -> Any:
        return self.backend

    def get_password(self, service: str, account: str) -> Optional[str]:
        if self.fail_get:
            raise RuntimeError(self.fail_get)
        return self.read_back if self.read_back is not None else self.secret

    def set_password(self, service: str, account: str, password: str) -> None:
        if self.fail_set:
            raise RuntimeError(self.fail_set)
        self.secret = password

    def delete_password(self, service: str, account: str) -> None:
        self.deletes += 1
        if self.fail_delete:
            raise RuntimeError(self.fail_delete)
        self.secret = None


def _store(tmp_path, kr: Any) -> KeyringStore:
    return KeyringStore(PRODUCT, str(tmp_path), load_keyring=lambda: kr)


def _token_file(tmp_path) -> str:
    return os.path.join(str(tmp_path), PRODUCT, "token")


# ── the vocabulary ──────────────────────────────────────────────────────────────────
def test_the_vocabulary_matches_client_core() -> None:
    assert STORE_BACKENDS == (
        "keyring",
        "keychain",
        "keystore",
        "file",
        "memory",
        "indexeddb",
        "custom",
    )
    assert STORE_DEGRADED_REASONS == (
        "keyring-unavailable",
        "keyring-error",
        "legacy-keychain",
        "not-persistent",
    )
    assert StoreStatus("file", StoreDegraded("keyring-error", "x")).to_dict() == {
        "backend": "file",
        "degraded": {"reason": "keyring-error", "detail": "x"},
    }
    assert StoreStatus("keyring").to_dict() == {"backend": "keyring"}


# ── degraded when the keyring is missing or failing ─────────────────────────────────
def test_no_keyring_extra_reports_file_keyring_unavailable(tmp_path) -> None:
    def _missing() -> Any:
        raise ImportError("No module named 'keyring'")

    store = KeyringStore(PRODUCT, str(tmp_path), load_keyring=_missing)
    st = store.status()
    assert st.backend == "file"
    assert st.degraded is not None and st.degraded.reason == "keyring-unavailable"
    assert "keyring" in (st.degraded.detail or "")
    store.set_token("pkeyt_file")
    assert store.get_token() == "pkeyt_file"
    assert stat.S_IMODE(os.stat(_token_file(tmp_path)).st_mode) == 0o600
    assert "pkeyt_file" not in repr(store.status())


def test_the_default_loader_without_the_extra(tmp_path) -> None:
    try:
        import keyring  # noqa: F401  # type: ignore[import-not-found]
    except ImportError:
        pass
    else:
        pytest.skip("the keyring extra is installed here")
    st = KeyringStore(PRODUCT, str(tmp_path)).status()
    assert st.backend == "file"
    assert st.degraded is not None and st.degraded.reason == "keyring-unavailable"


@pytest.mark.parametrize("module", ["keyring.backends.fail", "keyring.backends.null"])
def test_fail_and_null_backends_are_unavailable_and_never_written(tmp_path, module: str) -> None:
    kr = FakeKeyring(_backend_from(module))
    store = _store(tmp_path, kr)
    st = store.status()
    assert st.backend == "file"
    assert st.degraded is not None and st.degraded.reason == "keyring-unavailable"
    assert module in (st.degraded.detail or "")
    store.set_token("pkeyt_null")
    # The null backend used to swallow this write, after which the file was deleted.
    assert kr.secret is None
    assert FileStore(PRODUCT, str(tmp_path)).get_token() == "pkeyt_null"
    assert store.get_token() == "pkeyt_null"


def test_a_raising_backend_reports_keyring_error(tmp_path) -> None:
    kr = FakeKeyring()
    kr.fail_get = "the keyring is locked"
    assert _store(tmp_path, kr).status() == StoreStatus(
        "file", StoreDegraded("keyring-error", "the keyring is locked")
    )


def test_a_healthy_keyring_verified_write_no_file(tmp_path) -> None:
    kr = FakeKeyring()
    store = _store(tmp_path, kr)
    assert store.status() == StoreStatus("keyring")
    store.set_token("pkeyt_kr")
    assert kr.secret == "pkeyt_kr"
    assert not os.path.exists(_token_file(tmp_path))
    assert store.get_token() == "pkeyt_kr"
    assert store.status() == StoreStatus("keyring")
    store.clear_token()
    assert kr.secret is None and store.get_token() is None


def test_a_read_back_that_differs_falls_back_and_deletes_the_entry(tmp_path) -> None:
    kr = FakeKeyring()
    kr.read_back = "something-else"
    _store(tmp_path, kr).set_token("pkeyt_unverified")
    assert FileStore(PRODUCT, str(tmp_path)).get_token() == "pkeyt_unverified"
    assert kr.deletes == 1 and kr.secret is None


# ── one read rule ───────────────────────────────────────────────────────────────────
def test_empty_keyring_and_a_file_token_reads_the_file_and_reports_it(tmp_path) -> None:
    FileStore(PRODUCT, str(tmp_path)).set_token("pkeyt_in_file")
    store = _store(tmp_path, FakeKeyring())
    assert store.get_token() == "pkeyt_in_file"
    st = store.status()
    assert st.backend == "file"
    assert st.degraded is not None and st.degraded.reason == "keyring-error"
    assert "fell back" in (st.degraded.detail or "")


def test_a_failed_write_then_a_recovered_keyring_still_reads_the_file(tmp_path) -> None:
    kr = FakeKeyring()
    store = _store(tmp_path, kr)
    kr.fail_set = "dbus timeout"
    store.set_token("pkeyt_new")
    kr.fail_set = None
    assert store.get_token() == "pkeyt_new"


def test_a_stale_keyring_token_never_shadows_a_newer_file_token(tmp_path) -> None:
    kr = FakeKeyring()
    kr.secret = "pkeyt_stale"
    FileStore(PRODUCT, str(tmp_path)).set_token("pkeyt_newer")
    assert _store(tmp_path, kr).get_token() == "pkeyt_newer"


def test_a_fallback_write_deletes_the_keyring_entry(tmp_path) -> None:
    kr = FakeKeyring()
    kr.secret = "pkeyt_old"
    kr.fail_set = "locked"
    _store(tmp_path, kr).set_token("pkeyt_fallback")
    assert kr.deletes == 1 and kr.secret is None


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs POSIX non-root modes")
def test_a_failed_file_removal_after_a_verified_write_leaves_the_same_token(tmp_path) -> None:
    files = FileStore(PRODUCT, str(tmp_path))
    files.set_token("pkeyt_older")
    product_dir = os.path.join(str(tmp_path), PRODUCT)
    # A read-only directory: the token file cannot be unlinked, but can still be rewritten.
    os.chmod(product_dir, 0o500)
    try:
        kr = FakeKeyring()
        store = _store(tmp_path, kr)
        store.set_token("pkeyt_current")
        assert kr.secret == "pkeyt_current"
        assert files.get_token() == "pkeyt_current"
        assert store.get_token() == "pkeyt_current"
    finally:
        os.chmod(product_dir, 0o700)


# ── the other stores, and the client surface ────────────────────────────────────────
def test_file_and_memory_stores_report_themselves(tmp_path) -> None:
    assert FileStore(PRODUCT, str(tmp_path)).status() == StoreStatus("file")
    assert InMemoryStore(PRODUCT).status() == StoreStatus("memory")


def test_client_store_status(tmp_path) -> None:
    from helpers import make_client

    c = make_client(lambda r: None)
    try:
        assert c.store_status() == StoreStatus("memory")
    finally:
        c.close()

    class _Bare:
        """A host store without status(): still a Store, and reports None."""

        def __init__(self) -> None:
            self._inner = InMemoryStore(PRODUCT)

        def __getattr__(self, name: str) -> Any:
            if name == "status":
                raise AttributeError(name)
            return getattr(self._inner, name)

    from polaris_key.core.store import Store

    bare = _Bare()
    c2 = make_client(lambda r: None, store=bare)
    try:
        assert c2.store_status() is None
    finally:
        c2.close()
    assert isinstance(InMemoryStore(PRODUCT), Store)
