# @pkey-feature core.presentation
"""``core.presentation`` in the Python SDK (WIRE-CONTRACT-V4 §5.5, plans/HA-13.md §3).

First every row of ``conformance/corpus/v2/presentation-matrix.json`` (``parseCases`` with the
re-parse fixed point, ``pickCases``, ``verifyCases``), then the edges the corpus cannot carry, then
the client: the accessor after discovery, the icon fetch rules (no credential, no redirect, 200
only, the deadline, the size cap, the hash), the cache by hash (re-hashed on read, pruned to
``PRESENTATION_CACHE_MAX_FILES``), ``presentation.json`` for a cold start, and the async client.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

import httpx
import pytest

import polaris_key.presentation as presentation_module
from polaris_key import AsyncPolarisKeyClient, InMemoryStore, PolarisKeyClient
from polaris_key.constants_generated import (
    PRESENTATION_CACHE_MAX_FILES,
    PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS,
    PRESENTATION_ICON_MAX_BYTES,
    PRESENTATION_ICON_TYPES,
    PRESENTATION_MATRIX_VERSION,
    PRESENTATION_TEXT_MAX_BYTES,
)
from polaris_key.presentation import (
    MEMBER_FILE,
    DiscoveryPresentationSource,
    PresentationSource,
    icon_matches,
    parse_presentation,
    pick_icon_size,
    safe_fetch_url,
    usable_url_origin,
)

# tests/ -> python/ -> sdks/ -> repo root
MATRIX = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "presentation-matrix.json").read_text(
        "utf-8"
    )
)


def canon(v: Any) -> str:
    """JSON text, keys sorted: equality that tells 1 from 1.0 and from true."""
    return json.dumps(v, sort_keys=True)


# ── The matrix ────────────────────────────────────────────────────────────────────────────


def test_the_matrix_is_the_version_this_sdk_reads() -> None:
    assert MATRIX["presentationMatrixVersion"] == PRESENTATION_MATRIX_VERSION == 1
    assert len(MATRIX["parseCases"]) > 50
    assert len(MATRIX["pickCases"]) > 15
    assert len(MATRIX["verifyCases"]) >= 4


@pytest.mark.parametrize("c", MATRIX["parseCases"], ids=[c["name"] for c in MATRIX["parseCases"]])
def test_parse(c: Dict[str, Any]) -> None:
    got = parse_presentation(c["core"], c["doc"])
    assert canon(got) == canon(c["expect"])
    # The fixed point: what the Worker emits, every SDK re-parses to itself.
    if got is not None:
        assert canon(parse_presentation({"presentation": got}, c["doc"])) == canon(got)


@pytest.mark.parametrize("c", MATRIX["pickCases"], ids=[c["name"] for c in MATRIX["pickCases"]])
def test_pick(c: Dict[str, Any]) -> None:
    assert canon(pick_icon_size(c["icon"], c["px"], c["scale"], c["decodable"])) == canon(c["expect"])


@pytest.mark.parametrize("c", MATRIX["verifyCases"], ids=[c["name"] for c in MATRIX["verifyCases"]])
def test_verify(c: Dict[str, Any]) -> None:
    assert icon_matches(base64.b64decode(c["bytes"]), c["sha256"]) is c["expect"]


# ── The edges the corpus does not carry ───────────────────────────────────────────────────


def test_a_lone_surrogate_is_not_text() -> None:
    assert parse_presentation({"presentation": {"name": "a\udc00"}}, {"product": "p"}) == {"name": "p"}
    # JSON joins an escaped pair into one code point, which is text.
    pair = json.loads('{"name": "\\ud83c\\udfae"}')
    assert parse_presentation({"presentation": pair}, {"product": "p"}) == {"name": "\U0001f3ae"}


def test_bidi_controls_survive_and_controls_do_not() -> None:
    assert parse_presentation({"presentation": {"name": "⁧abc⁩"}}, {"product": "p"}) == {
        "name": "⁧abc⁩"
    }
    assert parse_presentation({"presentation": {"name": "a\x85b"}}, {"product": "p"}) == {"name": "p"}


def test_the_text_limit_counts_utf8_bytes() -> None:
    fits = "é" * (PRESENTATION_TEXT_MAX_BYTES // 2)
    assert parse_presentation({"presentation": {"name": fits}}, {"product": "p"}) == {"name": fits}
    over = fits + "é"
    assert parse_presentation({"presentation": {"name": over}}, {"product": "p"}) == {"name": "p"}


def test_a_bool_is_never_a_number_and_a_whole_float_is_an_integer() -> None:
    icon = {
        "sha256": "a" * 64,
        "contentType": "image/png",
        "original": "https://img.plrs.im/p/a/x",
        "width": True,
        "height": 64.0,
        "url": "https://img.plrs.im/p/a/x/{w}.webp",
        "sizes": [{"w": 64.0, "sha256": "b" * 64}],
    }
    got = parse_presentation({"presentation": {"icon": icon}}, {"product": "p"})
    assert got is not None
    assert "width" not in got["icon"] and got["icon"]["height"] == 64 and isinstance(got["icon"]["height"], int)
    assert canon(got["icon"]["sizes"]) == canon([{"w": 64, "sha256": "b" * 64}])
    bad = dict(icon, sizes=[{"w": True, "sha256": "b" * 64}])
    got = parse_presentation({"presentation": {"icon": bad}}, {"product": "p"})
    assert got is not None and got["icon"]["sizes"] == [] and "url" not in got["icon"]


def test_null_sizes_is_bad_and_absent_sizes_is_empty() -> None:
    base = {"sha256": "a" * 64, "contentType": "image/png", "original": "https://img.plrs.im/p/a/x"}
    absent = parse_presentation({"presentation": {"icon": base}}, {"product": "p"})
    null = parse_presentation({"presentation": {"icon": dict(base, sizes=None)}}, {"product": "p"})
    assert absent is not None and null is not None
    assert absent["icon"]["sizes"] == [] and null["icon"]["sizes"] == []


def test_never_returns_the_input_and_never_carries_an_unknown_member() -> None:
    raw = {
        "name": "P",
        "extra": 1,
        "icon": {"sha256": "a" * 64, "contentType": "image/png", "original": "https://img.plrs.im/p/a/x", "extra": 2},
    }
    got = parse_presentation({"presentation": raw}, {"product": "p"})
    assert got is not None and got is not raw
    assert sorted(got) == ["icon", "name"]
    assert sorted(got["icon"]) == ["contentType", "original", "sha256", "sizes"]


def test_a_usable_urls_origin_is_its_scheme_and_authority_lower_cased() -> None:
    assert usable_url_origin("HTTPS://Img.Plrs.Im:443/x?y") == "https://img.plrs.im:443"
    assert usable_url_origin("http://[::1]/x") == "http://[::1]"
    assert usable_url_origin("http://[::2]/x") is None
    assert usable_url_origin("http://img.plrs.im/x") is None
    assert usable_url_origin(42) is None
    # `$` would match before a trailing newline; the rules match whole strings.
    assert usable_url_origin("https://img.plrs.im\n") is None


def test_the_safe_link_rule() -> None:
    original = "https://img.plrs.im/p/a/x"
    assert safe_fetch_url("https://img.plrs.im/p/a/x/64.webp", original)
    assert safe_fetch_url("http://127.0.0.1:8787/x", "http://127.0.0.1:8787/y")
    assert not safe_fetch_url("https://evil.example/p/a/x/64.webp", original)
    assert not safe_fetch_url("https://img.plrs.im:8443/x", original)
    assert not safe_fetch_url("http://img.plrs.im/x", "http://img.plrs.im/y")
    assert not safe_fetch_url("ftp://img.plrs.im/x", original)


def test_a_nonsensical_hero_size_still_picks_something() -> None:
    icon = {
        "sha256": "a" * 64,
        "contentType": "image/png",
        "original": "https://img.plrs.im/p/a/x",
        "url": "https://img.plrs.im/p/a/x/{w}.webp",
        "sizes": [{"w": 64, "sha256": "b" * 64}],
    }
    for px, scale in ((float("nan"), 2), (-5, 1), (float("inf"), 1), (0, 0)):
        got = pick_icon_size(icon, px, scale, ["image/webp"])
        assert got["source"] == "size" and got["w"] == 64


def test_the_source_is_the_seam_a_kit_reads() -> None:
    assert isinstance(DiscoveryPresentationSource("p"), PresentationSource)


# ── The client ────────────────────────────────────────────────────────────────────────────

PRODUCT = "djdl"
BASE = "https://key.plrs.im"
IMG = "https://img.plrs.im"
DISCOVERY_PATH = f"/{PRODUCT}/.well-known/polaris.json"
TRUST = {"pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"}


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class Icon:
    """An icon and its WebP widths, each with its own bytes and hash."""

    def __init__(self, tag: str = "a", widths: tuple = (64, 128, 256), origin: str = IMG) -> None:
        self.original = f"PNG-{tag}".encode() * 8
        self.sizes = {w: f"WEBP-{tag}-{w}".encode() * 4 for w in widths}
        self.origin = origin
        self.sha = sha(self.original)

    def member(self) -> Dict[str, Any]:
        return {
            "sha256": self.sha,
            "contentType": "image/png",
            "width": 1024,
            "height": 1024,
            "original": f"{self.origin}/{PRODUCT}/a/{self.sha}",
            "url": f"{self.origin}/{PRODUCT}/a/{self.sha}/{{w}}.webp",
            "sizes": [{"w": w, "sha256": sha(b)} for w, b in self.sizes.items()],
        }

    def routes(self) -> Dict[str, bytes]:
        out = {f"/{PRODUCT}/a/{self.sha}": self.original}
        for w, b in self.sizes.items():
            out[f"/{PRODUCT}/a/{self.sha}/{w}.webp"] = b
        return out


def document(presentation: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    core: Dict[str, Any] = {"registration": "requires-license"}
    if presentation is not None:
        core["presentation"] = presentation
    return {"version": 2, "product": PRODUCT, "name": PRODUCT, "core": core, "services": {}}


class Server:
    """The control plane and the image host behind one ``httpx.MockTransport``."""

    def __init__(self, doc: Dict[str, Any], icon: Optional[Icon] = None) -> None:
        self.doc = doc
        self.routes: Dict[str, Any] = dict(icon.routes()) if icon else {}
        self.requests: List[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.url.host == "key.plrs.im" and path == DISCOVERY_PATH:
            return httpx.Response(200, json=self.doc)
        route = self.routes.get(path)
        if route is None:
            return httpx.Response(404)
        if callable(route):
            return route(request)
        return httpx.Response(200, content=route, headers={"content-type": "image/webp"})

    def icon_requests(self) -> List[httpx.Request]:
        return [r for r in self.requests if r.url.path != DISCOVERY_PATH]


def make_client(
    server: Server, tmp: Optional[Path], *, http: Optional[httpx.Client] = None, **kw: Any
) -> PolarisKeyClient:
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE,
        store=InMemoryStore(),
        client=http or httpx.Client(transport=httpx.MockTransport(server)),
        request_timeout=None,
        expected_services=[],
        **({"cache_dir": str(tmp)} if tmp is not None else {}),
        **kw,
    )
    c.init()
    return c


def pres_dir(tmp: Path) -> Path:
    return tmp / PRODUCT / "presentation"


def test_the_accessor_follows_discovery(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "accent": "#2ED6E6", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    seen: List[Any] = []
    off = c.presentation_source.subscribe(seen.append)
    assert c.presentation() is None
    c.discover()
    got = c.presentation()
    assert got is not None and got["name"] == "DJDL" and got["accent"] == "#2ed6e6"
    assert seen == [got]
    # The same member again is no change.
    c.discover()
    assert len(seen) == 1
    # A caller cannot mutate what the source holds.
    got["name"] = "mutated"
    assert c.presentation()["name"] == "DJDL"  # type: ignore[index]
    # The product drops it: gone, and subscribers hear None.
    server.doc = document(None)
    c.discover()
    assert c.presentation() is None and seen[-1] is None
    off()
    server.doc = document({"name": "Back"})
    c.discover()
    assert len(seen) == 2


def test_a_failed_discovery_keeps_the_last_member(tmp_path: Path) -> None:
    server = Server(document({"name": "DJDL"}))
    c = make_client(server, tmp_path)
    c.discover()
    server.doc = {"product": "other", "services": {}}
    assert c.discover().kind == "invalid"
    assert c.presentation() == {"name": "DJDL"}


def test_the_icon_is_fetched_verified_and_cached_by_hash(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(48, 2) == icon.sizes[128]
    assert [r.url.path for r in server.icon_requests()] == [f"/{PRODUCT}/a/{icon.sha}/128.webp"]
    assert (pres_dir(tmp_path) / sha(icon.sizes[128])).read_bytes() == icon.sizes[128]
    # Memoised for the session, then from disk for a new client: no second fetch.
    assert c.presentation_icon(48, 2) == icon.sizes[128]
    again = make_client(server, tmp_path)
    assert again.presentation_icon(48, 2) == icon.sizes[128]
    assert len(server.icon_requests()) == 1
    # Nothing decodable but the original: the original.
    assert c.presentation_icon(48, 2, decodable=["image/png"]) == icon.original


def test_no_credential_or_pkey_header_reaches_the_image_host(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    http = httpx.Client(
        transport=httpx.MockTransport(server),
        headers={"Authorization": "Bearer host-secret", "X-PKey-Device": "dev", "User-Agent": "host/1"},
        cookies={"session": "s"},
        auth=("user", "pass"),
    )
    c = make_client(server, tmp_path, http=http)
    c.discover()
    assert c.presentation_icon(32) is not None
    (req,) = server.icon_requests()
    names = {k.lower() for k in req.headers.keys()}
    assert "authorization" not in names and "cookie" not in names and "proxy-authorization" not in names
    assert not any(n.startswith("x-pkey-") for n in names)
    assert req.method == "GET" and req.content == b""
    # The deadline is the generated constant, on every phase of the request.
    assert set(req.extensions["timeout"].values()) == {PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS}


def test_a_redirect_is_never_followed(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    small = f"/{PRODUCT}/a/{icon.sha}/64.webp"
    server.routes[small] = lambda r: httpx.Response(302, headers={"location": f"{IMG}/elsewhere"})
    server.routes["/elsewhere"] = icon.sizes[64]
    http = httpx.Client(transport=httpx.MockTransport(server), follow_redirects=True)
    c = make_client(server, tmp_path, http=http)
    c.discover()
    assert c.presentation_icon(32) is None
    assert [r.url.path for r in server.icon_requests()] == [small]
    assert not pres_dir(tmp_path).joinpath(sha(icon.sizes[64])).exists()


@pytest.mark.parametrize("status", [201, 203, 204, 206, 304, 404, 500])
def test_anything_but_200_is_a_miss(tmp_path: Path, status: int) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    server.routes[f"/{PRODUCT}/a/{icon.sha}/64.webp"] = lambda r: httpx.Response(status, content=icon.sizes[64])
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) is None
    assert c.presentation_source.cached_files() == []


def test_a_body_past_the_cap_is_abandoned(tmp_path: Path) -> None:
    big = b"x" * (PRESENTATION_ICON_MAX_BYTES + 1)
    member = {"sha256": sha(big), "contentType": "image/png", "original": f"{IMG}/{PRODUCT}/a/{sha(big)}"}
    server = Server(document({"name": "DJDL", "icon": member}))
    chunk = 1024 * 1024
    served: List[int] = []

    def stream() -> Iterator[bytes]:
        for i in range(0, len(big), chunk):
            served.append(i)
            yield big[i : i + chunk]

    # No Content-Length: the stream itself is cut off.
    server.routes[f"/{PRODUCT}/a/{sha(big)}"] = lambda r: httpx.Response(200, content=stream())
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) is None
    assert len(served) == PRESENTATION_ICON_MAX_BYTES // chunk + 1
    # A declared length past the cap is refused before any body is read.
    served.clear()
    server.routes[f"/{PRODUCT}/a/{sha(big)}"] = lambda r: httpx.Response(
        200, content=stream(), headers={"content-length": str(len(big))}
    )
    assert c.presentation_icon(32) is None
    assert served == []


def test_a_body_at_the_cap_is_accepted(tmp_path: Path) -> None:
    full = b"y" * PRESENTATION_ICON_MAX_BYTES
    member = {"sha256": sha(full), "contentType": "image/png", "original": f"{IMG}/{PRODUCT}/a/{sha(full)}"}
    server = Server(document({"name": "DJDL", "icon": member}))
    server.routes[f"/{PRODUCT}/a/{sha(full)}"] = full
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) == full


def test_a_slow_body_past_the_deadline_is_abandoned(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    body = icon.sizes[64]
    clock = {"t": 1000.0}
    monkeypatch.setattr(presentation_module.time, "monotonic", lambda: clock["t"])

    def slow() -> Iterator[bytes]:
        yield body[:4]
        clock["t"] += PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS + 1
        yield body[4:]

    server.routes[f"/{PRODUCT}/a/{icon.sha}/64.webp"] = lambda r: httpx.Response(200, content=slow())
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) is None


def test_bytes_that_do_not_hash_are_neither_returned_nor_cached(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    server.routes[f"/{PRODUCT}/a/{icon.sha}/64.webp"] = b"not the icon"
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) is None
    assert c.presentation_source.cached_files() == []
    # Nothing memoised either: the next call asks again.
    assert c.presentation_icon(32) is None
    assert len(server.icon_requests()) == 2


def test_a_tampered_cache_file_is_deleted_and_fetched_again(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    c.discover()
    target = pres_dir(tmp_path) / sha(icon.sizes[64])
    target.write_bytes(b"tampered")
    assert c.presentation_icon(32) == icon.sizes[64]
    assert target.read_bytes() == icon.sizes[64]
    assert len(server.icon_requests()) == 1
    # Tampered, and the network has nothing: gone, and None.
    target.write_bytes(b"tampered")
    fresh = make_client(Server(document({"name": "DJDL", "icon": icon.member()})), tmp_path)
    assert fresh.presentation_icon(32) is None
    assert not target.exists()


def test_a_cached_hit_is_rehashed_and_served_offline(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    make_client(server, tmp_path).discover()
    make_client(server, tmp_path).presentation_icon(32)
    offline = make_client(server, tmp_path, local_only=True)
    before = len(server.requests)
    assert offline.presentation() is not None
    assert offline.presentation_icon(32) == icon.sizes[64]
    # Not cached: a local-only client never fetches.
    assert offline.presentation_icon(200) is None
    assert len(server.requests) == before


def test_prune_keeps_the_named_files_newest_first(tmp_path: Path) -> None:
    icon = Icon(widths=(16, 32, 64, 128, 256))
    d = pres_dir(tmp_path)
    d.mkdir(parents=True)
    named = [icon.sha] + [sha(b) for b in icon.sizes.values()]
    now = time.time()
    for i, name in enumerate(named):
        p = d / name
        p.write_bytes(b"x")
        os.utime(p, (now - 100 + i, now - 100 + i))
    (d / ("f" * 64)).write_bytes(b"stale")
    (d / f"{named[0]}.tmp-abc").write_bytes(b"interrupted")
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    c.discover()
    files = c.presentation_source.cached_files()
    assert len(files) == PRESENTATION_CACHE_MAX_FILES
    assert set(files) == set(named[-PRESENTATION_CACHE_MAX_FILES:])
    assert sorted(os.listdir(d)) == sorted(files + [MEMBER_FILE])


def test_a_fresh_write_is_never_the_one_capped(tmp_path: Path) -> None:
    icon = Icon(widths=(16, 32, 64, 128, 256))
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    c.discover()
    for px in (16, 32, 64, 128, 256):
        assert c.presentation_icon(px) == icon.sizes[px]
    files = c.presentation_source.cached_files()
    assert len(files) == PRESENTATION_CACHE_MAX_FILES
    assert sha(icon.sizes[256]) in files


def test_a_new_member_drops_the_old_icons(tmp_path: Path) -> None:
    old, new = Icon("old"), Icon("new")
    server = Server(document({"name": "DJDL", "icon": old.member()}), old)
    c = make_client(server, tmp_path)
    c.discover()
    c.presentation_icon(32)
    assert c.presentation_source.cached_files() == [sha(old.sizes[64])]
    server.doc = document({"name": "DJDL", "icon": new.member()})
    c.discover()
    assert c.presentation_source.cached_files() == []
    server.doc = document(None)
    c.discover()
    assert not (pres_dir(tmp_path) / MEMBER_FILE).exists()


def test_the_last_member_survives_a_cold_start(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "developerName": "Vlad", "icon": icon.member()}), icon)
    first = make_client(server, tmp_path)
    first.discover()
    stored = json.loads((pres_dir(tmp_path) / MEMBER_FILE).read_text("utf-8"))
    assert stored == {"v": 1, "product": PRODUCT, "presentation": first.presentation()}
    cold = make_client(server, tmp_path)
    assert cold.presentation() == first.presentation()
    assert not [r for r in server.requests if r.url.path == DISCOVERY_PATH][1:]


@pytest.mark.parametrize(
    "tamper",
    [
        lambda v: dict(v, product="other"),
        lambda v: dict(v, v=2),
        lambda v: dict(v, v=True),
        lambda v: dict(v, presentation=dict(v["presentation"], accent="#2ED6E6")),
        lambda v: dict(v, presentation=dict(v["presentation"], extra=1)),
        lambda v: dict(v, presentation="DJDL"),
        lambda v: [v],
    ],
    ids=["other-product", "other-version", "bool-version", "not-normal", "unknown-member", "not-an-object", "array"],
)
def test_a_tampered_member_file_is_dropped(tmp_path: Path, tamper: Any) -> None:
    server = Server(document({"name": "DJDL", "accent": "#2ed6e6"}))
    make_client(server, tmp_path).discover()
    path = pres_dir(tmp_path) / MEMBER_FILE
    path.write_text(json.dumps(tamper(json.loads(path.read_text("utf-8")))), "utf-8")
    assert make_client(server, tmp_path).presentation() is None
    assert not path.exists()


def test_an_unreadable_member_file_is_dropped(tmp_path: Path) -> None:
    server = Server(document({"name": "DJDL"}))
    make_client(server, tmp_path).discover()
    path = pres_dir(tmp_path) / MEMBER_FILE
    path.write_bytes(b"\xff{")
    assert make_client(server, tmp_path).presentation() is None
    assert not path.exists()


def test_a_session_discovery_wins_over_the_cold_file(tmp_path: Path) -> None:
    server = Server(document({"name": "Old"}))
    make_client(server, tmp_path).discover()
    c = make_client(server, tmp_path)
    server.doc = document({"name": "New"})
    c.discover()
    c.presentation_source.load_cached()
    assert c.presentation() == {"name": "New"}


def test_with_no_cache_dir_nothing_is_written(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, None)
    assert c.presentation_source.cache_dir is None
    c.discover()
    assert c.presentation_icon(32) == icon.sizes[64]
    assert not (tmp_path / "home").exists() and not (tmp_path / "xdg").exists()


def test_a_url_off_the_safe_link_rule_is_never_fetched(tmp_path: Path) -> None:
    icon = Icon()
    src = DiscoveryPresentationSource(PRODUCT, cache_dir=str(tmp_path), http=lambda: pytest.fail("no fetch"))
    m = icon.member()
    # A member the parser would never emit: the size template on another host.
    src._current = {"name": "DJDL", "icon": dict(m, url="https://evil.example/{w}.webp")}
    assert src.icon(32) is None
    src._current = {"name": "DJDL", "icon": dict(m, original="http://img.plrs.im/x", sizes=[])}
    assert src.icon(32, decodable=["image/png"]) is None


def test_loopback_http_is_allowed(tmp_path: Path) -> None:
    icon = Icon(origin="http://127.0.0.1:8787")
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    c = make_client(server, tmp_path)
    c.discover()
    assert c.presentation_icon(32) == icon.sizes[64]


def test_concurrent_requests_for_one_hash_share_one_fetch(tmp_path: Path) -> None:
    import threading

    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)
    gate = threading.Event()
    path = f"/{PRODUCT}/a/{icon.sha}/64.webp"

    def held(request: httpx.Request) -> httpx.Response:
        gate.wait(5)
        return httpx.Response(200, content=icon.sizes[64])

    server.routes[path] = held
    c = make_client(server, tmp_path)
    c.discover()
    out: List[Optional[bytes]] = []
    threads = [threading.Thread(target=lambda: out.append(c.presentation_icon(32))) for _ in range(4)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    gate.set()
    for t in threads:
        t.join(5)
    assert out == [icon.sizes[64]] * 4
    assert len(server.icon_requests()) == 1


def test_the_headless_default_decodes_every_icon_type() -> None:
    assert DiscoveryPresentationSource("p").decodable == list(PRESENTATION_ICON_TYPES)


def test_the_async_client_reads_the_same_source(tmp_path: Path) -> None:
    icon = Icon()
    server = Server(document({"name": "DJDL", "icon": icon.member()}), icon)

    async def run() -> None:
        c = AsyncPolarisKeyClient(make_client(server, tmp_path))
        await c.discover()
        # A pure read stays synchronous; the icon is a coroutine run off the loop.
        member = c.presentation()
        assert member is not None and member["name"] == "DJDL"
        assert await c.presentation_icon(32) == icon.sizes[64]
        assert c.presentation_source is c.sync_client.presentation_source
        await c.aclose()

    asyncio.run(run())
