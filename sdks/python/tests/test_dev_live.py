"""SP-41 acceptance: the Python quickstart against a live ``pkey dev``.

Every other test in this suite drives the SDK against a scripted transport or a replayed
transcript. This file talks to a real ``pkey dev`` (the Worker's own router in another process,
over a loopback socket) with the module ``pkey sdk --lang python --dev --write`` generated for
that server, and checks what the quickstart promises:

* the generated config names this server: its origin, slug, signing pins and release pins;
* first activation, with the ``ok`` key;
* every outcome the seven seeded keys reach, as the SDK reports it (``ActivationResult`` kind
  and code, never a production URL or a counter the Worker could change);
* a config change made on the server arriving as a ``config`` event on the next sync;
* device-code sign-in: ``sign_in.start``, an approval on the fake IdP's page, ``wait``;
* an update decision before and after a release is published.

Config changes and releases are posted to the server's ``/__dev/*`` control surface, as
``pkey dev config`` and ``pkey dev release`` do. The approval is the dev-approve script, because
the fake IdP's page is a browser's job.

Environment (a lane sets all three and starts a fresh server for this file)::

    PKEY_DEV_BASE_URL  http://127.0.0.1:<port> of ``pkey dev --builtin --auto-approve``
    PKEY_DEV_CONFIG    the module ``pkey sdk --lang python --dev --url $PKEY_DEV_BASE_URL
                       --write --out <file>`` generated
    PKEY_DEV_APPROVE   packages/cli/scripts/dev-approve.mjs, run as
                       ``node $PKEY_DEV_APPROVE <verification url> <user code>`` (Node 22.13+)

With none of them set the file skips, so a plain ``pytest -q`` stays green on a machine with no
server. Naming the file on the command line (``pytest tests/test_dev_live.py``) asks for the live
run, and a missing variable then fails instead of skipping. A partly set environment always fails.

The server is single use: the tests take device seats and key entries, publish ``1.2.0`` and change
``render.quality``, and the file refuses a server where ``1.2.0`` is already published. A key holds
three seats and three key entries, so ``ok`` is activated from two devices (the outcome matrix, and
the lifecycle the config and update tests share) and ``floating`` from one.

Every client is its own install, which the Worker has to be able to tell apart although they all
run on this one machine: each has a device id of its own (a device that holds one licence is
refused another's sign-in) and sends no hardware fingerprint (the Worker binds a licence's seat to
the hardware it is shown, and retires the token of an earlier device id seen on the same hardware).
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib.util
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from polaris_key import (
    ActivationDeviceLimit,
    ActivationKeyEntryLimit,
    ActivationResult,
    Event,
    InMemoryStore,
    PolarisKeyClient,
    SignedInIdentity,
    SignInSession,
)
from polaris_key.core.b64url import b64url_decode

ENV_BASE_URL = "PKEY_DEV_BASE_URL"
ENV_CONFIG = "PKEY_DEV_CONFIG"
ENV_APPROVE = "PKEY_DEV_APPROVE"
ENV = (ENV_BASE_URL, ENV_CONFIG, ENV_APPROVE)

#: The version the quickstart builds its client with (the stable release the server seeds).
APP_VERSION = "1.0.0"
#: A config key of the built-in Tidewater product, and the value the config test changes it to.
CONFIG_KEY = "render.quality"
CONFIG_VALUE = "high"
#: The release the update test publishes on stable.
RELEASE_VERSION = "1.2.0"

#: What each seeded key does to a device that has never held its licence: the SDK result's
#: ``kind`` and ``code`` (``ActivationOk`` has no code). The Worker's wire answers behind them
#: (401 ``unauthorized``, 403 ``device_limit``, 403 ``key_entry_limit``) are pinned by its own
#: tests; this table is what the Python SDK makes of them.
OUTCOMES: Dict[str, Tuple[str, Optional[str]]] = {
    "ok": ("ok", None),
    "floating": ("ok", None),
    "expired": ("unauthorized", "unauthorized"),
    "disabled": ("unauthorized", "unauthorized"),
    "revoked": ("unauthorized", "unauthorized"),
    "device-limit-full": ("device-limit", "device_limit"),
    # identity.keyentry is implemented: the 403 is the typed ActivationKeyEntryLimit.
    "key-entry-limit": ("key-entry-limit", "key_entry_limit"),
}


# ── The live server ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Dev:
    """The server under test and the generated config that points at it."""

    base_url: str
    #: ``GET /__dev/info``: the product, pins, test keys, releases and the fake IdP's person.
    info: Dict[str, Any]
    #: ``polaris_config.py``, imported.
    config: ModuleType
    approver: str

    @property
    def product(self) -> str:
        return str(self.info["product"])

    @property
    def keys(self) -> Dict[str, str]:
        keys: Dict[str, str] = self.info["keys"]
        return keys

    @property
    def person(self) -> SignedInIdentity:
        """The one person the fake IdP signs in."""
        who = self.info["idp"]["person"]
        return SignedInIdentity(name=who["name"], email=who["email"])


def _named_on_command_line(config: pytest.Config) -> bool:
    """Whether this file was named on the pytest command line, as in
    ``pytest tests/test_dev_live.py`` (or ``…::name``), rather than collected with the suite."""
    here = Path(__file__).resolve()
    params = config.invocation_params
    for arg in params.args:
        path = str(arg).split("::", 1)[0]
        if path and not path.startswith("-") and (Path(params.dir) / path).resolve() == here:
            return True
    return False


def _load_config(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("polaris_config", path)
    assert spec is not None and spec.loader is not None, f"{path} is not importable"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dev(request: pytest.FixtureRequest) -> Dev:
    values = {name: os.environ.get(name, "").strip() for name in ENV}
    if not any(values.values()):
        if _named_on_command_line(request.config):
            pytest.fail(
                f"{', '.join(ENV)} are all unset: no live pkey dev to test. Naming this file on "
                "the command line asks for the live run (a plain `pytest` skips it)."
            )
        pytest.skip(f"no live pkey dev: set {', '.join(ENV)} (see this file's docstring)")
    missing = [name for name, value in values.items() if not value]
    if missing:
        pytest.fail(f"the live lane needs all of {', '.join(ENV)}; unset: {', '.join(missing)}")

    base_url = values[ENV_BASE_URL].rstrip("/")
    config_path, approver = Path(values[ENV_CONFIG]), Path(values[ENV_APPROVE])
    for name, path in ((ENV_CONFIG, config_path), (ENV_APPROVE, approver)):
        if not path.is_file():
            pytest.fail(f"{name} is not a file: {path}")
    try:
        res = httpx.get(f"{base_url}/__dev/info", timeout=10.0, trust_env=False)
        res.raise_for_status()
        info: Dict[str, Any] = res.json()
    except (httpx.HTTPError, ValueError) as e:
        pytest.fail(f"{ENV_BASE_URL}={base_url} is not a running pkey dev ({e!r})")
    if info.get("product") != "tidewater":
        pytest.fail(
            f"the live tests need the built-in Tidewater product (`pkey dev --builtin`); "
            f"{base_url} serves {info.get('product')!r}"
        )
    published = {(r["version"], r["channel"]) for r in info["releases"]}
    if (RELEASE_VERSION, "stable") in published:
        pytest.fail(
            f"{base_url} has already published {RELEASE_VERSION}: the live tests change the "
            "server they run against, so start a fresh `pkey dev` for each run"
        )
    return Dev(base_url, info, _load_config(config_path), str(approver))


class ForeignHost(Exception):
    """A client tried to send a request somewhere other than the dev server."""


@dataclass(frozen=True)
class Live:
    """One install: a client on its own store, and the requests it sent."""

    client: PolarisKeyClient
    store: InMemoryStore
    http: httpx.Client
    requests: List[str]
    foreign: List[str]


class Harness:
    """Builds clients the way the quickstart does: ``PolarisKeyClient.create(**CONFIG, version=…)``.

    The generated config is spread unchanged except for ``update``: it carries the release pins,
    and the install facts an app knows about itself and no generated file can (its outlet, build
    format and platform) are added. Tidewater ships one build, a macOS zip, so every client here
    is that install, whatever the test runs on.

    Each client is its own install (see the module docstring): an in-memory store with a device id
    of its own, no hardware fingerprint, and directories under a temporary one. Its HTTP client
    records every request and refuses any outside the dev server: a production URL in a document
    must fail here, never leave the machine.
    """

    def __init__(self, dev: Dev, root: Path) -> None:
        self.dev = dev
        self._root = root
        self._lives: List[Live] = []
        self._origin = urlsplit(dev.base_url)
        assert "update" in dev.config.CONFIG, "the generated config pins no release keys"
        self.update = dataclasses.replace(
            dev.config.CONFIG["update"],
            outlet="direct",
            format="zip",
            platform="macos",
            arch="arm64",
        )

    def client(self) -> Live:
        root = self._root / f"client-{len(self._lives)}"
        requests: List[str] = []
        foreign: List[str] = []
        http = httpx.Client(
            trust_env=False, event_hooks={"request": [self._guard(requests, foreign)]}
        )
        store = InMemoryStore(f"{self.dev.product}-live-{uuid.uuid4().hex}")
        client = PolarisKeyClient.create(
            **{**self.dev.config.CONFIG, "update": self.update},
            version=APP_VERSION,
            store=store,
            client=http,
            config_dir=str(root / "config"),
            data_dir=str(root / "data"),
            cache_dir=str(root / "cache"),
            state_dir=str(root / "state"),
            fingerprint=False,
        )
        live = Live(client, store, http, requests, foreign)
        self._lives.append(live)
        return live

    def _guard(self, requests: List[str], foreign: List[str]) -> Callable[[httpx.Request], None]:
        def record(request: httpx.Request) -> None:
            line = f"{request.method} {request.url}"
            requests.append(line)
            url, origin = request.url, self._origin
            if (url.scheme, url.host, url.port) != (origin.scheme, origin.hostname, origin.port):
                foreign.append(line)
                raise ForeignHost(f"{line} is outside the pkey dev server {self.dev.base_url}")

        return record

    def foreign(self) -> List[str]:
        return [line for live in self._lives for line in live.foreign]

    def close(self) -> None:
        for live in self._lives:
            live.client.close()
            live.http.close()


@pytest.fixture(scope="module")
def harness(dev: Dev, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Harness]:
    h = Harness(dev, tmp_path_factory.mktemp("pkey-dev-live"))
    yield h
    h.close()
    assert h.foreign() == [], "the SDK sent a request outside the dev server"


@dataclass(frozen=True)
class Lifecycle:
    """The ``ok`` install the activation, config and update tests share (one seat and one entry)."""

    live: Live
    activation: ActivationResult


@pytest.fixture(scope="module")
def lifecycle(dev: Dev, harness: Harness) -> Lifecycle:
    live = harness.client()
    return Lifecycle(live, live.client.license.activate_with_key(dev.keys["ok"]))


def _control(dev: Dev, command: str, body: Optional[Dict[str, Any]] = None) -> str:
    """``POST /__dev/<command>``, as ``pkey dev <command>`` does. Returns the server's message."""
    res = httpx.post(
        f"{dev.base_url}/__dev/{command}",
        headers={"X-PKey-Dev": "1"},
        json=body or {},
        timeout=10.0,
        trust_env=False,
    )
    assert res.status_code == 200, f"POST /__dev/{command} {body}: {res.status_code} {res.text}"
    answer = res.json()
    assert answer.get("ok") is True, f"POST /__dev/{command} {body}: {answer}"
    return str(answer["message"])


# ── The generated config ───────────────────────────────────────────────────────────────


def test_the_generated_config_describes_this_server(dev: Dev, harness: Harness) -> None:
    cfg = dev.config
    discovery = httpx.get(
        f"{dev.base_url}/{dev.product}/.well-known/polaris.json", timeout=10.0, trust_env=False
    ).json()
    text = Path(os.environ[ENV_CONFIG]).read_text(encoding="utf-8")
    assert "GENERATED by `pkey sdk --lang python" in text, "not written by pkey sdk"

    # Where the quickstart's client will talk, and as which product.
    assert cfg.BASE_URL == dev.base_url
    assert cfg.BASE_URL == dev.info["baseUrl"] == discovery["baseUrl"]
    assert cfg.PRODUCT_SLUG == dev.product == discovery["product"]
    # The signing pins are the keys this server signs with: discovery and /__dev/info agree.
    assert cfg.PINNED_KEYS == discovery["trust"]["pinnedKeys"]
    assert cfg.PINNED_KEYS == dev.info["trust"]["pinnedKeys"]
    # The release pins are the dev release key, whose SHA-256 discovery lists.
    assert cfg.PINNED_RELEASE_KEYS == dev.info["releaseKeys"]
    fingerprints = discovery["services"]["release"]["releaseKeyFingerprints"]
    assert sorted(
        hashlib.sha256(b64url_decode(key)).hexdigest() for key in cfg.PINNED_RELEASE_KEYS.values()
    ) == sorted(fingerprints)
    enabled = sorted(slug for slug, svc in discovery["services"].items() if svc.get("enabled"))
    assert sorted(cfg.EXPECTED_SERVICES) == enabled
    # CONFIG is what the client takes, and says the same.
    assert cfg.CONFIG["base_url"] == cfg.BASE_URL
    assert cfg.CONFIG["pinned_keys"] == cfg.PINNED_KEYS
    assert cfg.CONFIG["update"].pinned_release_keys == cfg.PINNED_RELEASE_KEYS

    # The client built from it uses those values (the harness spreads CONFIG).
    core = harness.client().client.core
    assert core.base_url == cfg.BASE_URL
    assert core.product == cfg.PRODUCT_SLUG
    assert core.pinned_trust == cfg.PINNED_KEYS


# ── First activation ───────────────────────────────────────────────────────────────────


def test_first_activation(dev: Dev, lifecycle: Lifecycle) -> None:
    live, result = lifecycle.live, lifecycle.activation
    client = live.client
    assert result.kind == "ok", result
    assert client.status().status == "ok"
    assert client.is_licensed()
    assert client.license.activation() == "token"
    token = live.store.get_token()
    assert token is not None and token.startswith("pkeyt_")
    # Real requests reached the server: the activation, then the signed documents it syncs.
    paths = [urlsplit(line.split(" ", 1)[1]).path for line in live.requests]
    for route in ("license/activate", "license/document", "config/document"):
        assert f"/{dev.product}/{route}" in paths, paths
    # The licence document came down and verified against the generated pins: the `ok` key
    # carries `exportPro`.
    assert client.license.doc is not None
    assert client.entitlements.has("exportPro")
    profile = client.license.get_profile()
    assert profile is not None and profile.name == dev.person.name


# ── What each seeded key does ──────────────────────────────────────────────────────────


def test_every_seeded_key_has_an_expected_outcome(dev: Dev) -> None:
    assert sorted(OUTCOMES) == sorted(dev.keys)


@pytest.mark.parametrize("name", list(OUTCOMES))
def test_seeded_key_outcome(dev: Dev, harness: Harness, name: str) -> None:
    kind, code = OUTCOMES[name]
    live = harness.client()
    client = live.client
    result = client.license.activate_with_key(dev.keys[name])
    assert result.kind == kind, f"{name}: {result}"
    assert getattr(result, "code", None) == code, f"{name}: {result}"
    if kind == "ok":
        assert client.status().status == "ok"
        assert client.is_licensed()
        assert live.store.get_token() is not None
        assert client.license.doc is not None
    else:
        # A refusal leaves the device as it was: no token, no documents, still to activate.
        assert client.status().status == "needs-activation"
        assert not client.is_licensed()
        assert live.store.get_token() is None
        assert client.license.doc is None


def test_a_full_device_list_names_its_limits_and_a_manage_link(dev: Dev, harness: Harness) -> None:
    result = harness.client().client.license.activate_with_key(dev.keys["device-limit-full"])
    assert isinstance(result, ActivationDeviceLimit), result
    # The counters are the Worker's to choose; they only have to describe a full list.
    assert isinstance(result.limit, int) and result.limit >= 1
    assert isinstance(result.deviceCount, int) and result.deviceCount >= result.limit
    # The link frees a seat on the server that refused, never on a production host.
    assert result.manage_url is not None
    link, origin = urlsplit(result.manage_url), urlsplit(dev.base_url)
    assert (link.scheme, link.netloc) == (origin.scheme, origin.netloc)
    assert dev.product in result.manage_url


def test_a_key_with_no_entries_left_is_refused_with_its_code(dev: Dev, harness: Harness) -> None:
    result = harness.client().client.license.activate_with_key(dev.keys["key-entry-limit"])
    assert isinstance(result, ActivationKeyEntryLimit), result
    assert result.code == "key_entry_limit"


# ── A config change ────────────────────────────────────────────────────────────────────


def test_a_config_change_arrives_as_an_event(dev: Dev, lifecycle: Lifecycle) -> None:
    client = lifecycle.live.client
    assert lifecycle.activation.kind == "ok", lifecycle.activation
    assert client.config.get(CONFIG_KEY) != CONFIG_VALUE
    changed: List[Event] = []
    every: List[Event] = []
    unsubscribe = [
        client.config.on_config_change(CONFIG_KEY, changed.append),
        client.subscribe(every.append, ["config"]),
    ]
    try:
        # Signed documents carry whole-second times: a change in the second of the last sync
        # shows on the sync after it, so let the second pass.
        time.sleep(1.1)
        _control(dev, "config", {"name": CONFIG_KEY, "value": CONFIG_VALUE})
        assert changed == [], "the client saw the change before it synced"
        assert client.sync(force=True).applied
    finally:
        for off in unsubscribe:
            off()
    assert len(changed) == 1, changed
    event = changed[0]
    assert event.kind == "config"
    assert event["key"] == CONFIG_KEY
    assert event["value"] == CONFIG_VALUE
    assert event["previous"] != CONFIG_VALUE
    assert event["source"] == "enforced"
    # The one listener and the whole stream saw the same single change, and the value reads back.
    assert [e["key"] for e in every] == [CONFIG_KEY]
    assert client.config.get(CONFIG_KEY) == CONFIG_VALUE
    assert client.config.get_config_source(CONFIG_KEY) == "enforced"


# ── Device-code sign-in ────────────────────────────────────────────────────────────────


def _approve(dev: Dev, prompt: SignInSession) -> None:
    """What the person does in a browser: open the verification page and approve."""
    node = shutil.which("node")
    assert node is not None, "node is not on PATH; the approver needs Node 22.13 or newer"
    done = subprocess.run(
        [node, dev.approver, prompt.verification_uri_complete, prompt.user_code],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, (
        f"dev-approve exited {done.returncode}: {(done.stderr or done.stdout).strip()}"
    )


def test_device_code_sign_in(dev: Dev, harness: Harness) -> None:
    live = harness.client()
    client = live.client
    prompt = client.identity.sign_in.start(device_name="pytest")
    # The prompt points at this server, and the complete link carries the code the person types.
    origin, page = urlsplit(dev.base_url), urlsplit(prompt.verification_uri)
    complete = urlsplit(prompt.verification_uri_complete)
    assert (page.scheme, page.netloc) == (origin.scheme, origin.netloc)
    assert (complete.scheme, complete.netloc, complete.path) == (
        page.scheme,
        page.netloc,
        page.path,
    )
    assert parse_qs(complete.query)["user_code"] == [prompt.user_code]

    # Nobody has approved yet.
    assert prompt.wait(once=True).kind == "pending"
    assert not client.is_licensed()

    _approve(dev, prompt)

    result = prompt.wait(30)
    assert result.kind == "signed_in", result
    # Who the Worker says signed in: the fake IdP's person, name and verified e-mail.
    assert result.identity == dev.person
    # The token is stored and the post-sign-in sync has run: the gate is open.
    assert client.status().status == "ok"
    assert client.is_licensed()
    assert client.license.activation() == "token"
    token = live.store.get_token()
    assert token is not None and token.startswith("pkeyt_")
    who = client.identity.current()
    assert who is not None and (who["name"], who["email"]) == (dev.person.name, dev.person.email)
    profile = client.license.get_profile()
    assert profile is not None
    assert (profile.name, profile.email) == (dev.person.name, dev.person.email)


# ── An update decision ─────────────────────────────────────────────────────────────────


def test_update_decision_follows_a_published_release(dev: Dev, lifecycle: Lifecycle) -> None:
    client = lifecycle.live.client
    assert lifecycle.activation.kind == "ok", lifecycle.activation
    offers: List[Event] = []
    unsubscribe = client.subscribe(offers.append, ["updateAvailable"])
    try:
        # The app runs the newest stable release, so there is nothing to offer.
        before = client.update.decide()
        assert (before.decision.action, before.decision.reason) == ("none", "up-to-date")
        assert before.channel == "stable"
        assert (before.feed, before.record, before.errors) == ("network", "network", ())
        assert offers == []

        _control(dev, "release", {"version": RELEASE_VERSION, "channel": "stable"})

        after = client.update.decide()
    finally:
        unsubscribe()
    decision = after.decision
    assert decision.action == "binary", after
    assert decision.release is not None and decision.release.version == RELEASE_VERSION
    assert decision.method == "download"
    assert decision.mandatory is False
    assert after.channel == "stable"
    # The feed and the release record were fetched and verified: the record only against the
    # release key the generated config pins.
    assert (after.feed, after.record, after.errors) == ("network", "network", ())
    assert [(e["version"], e["action"]) for e in offers] == [(RELEASE_VERSION, "binary")]
