# @pkey-feature sync.files
"""The Python file transport (U-22.11) under the transfer engine, against small fakes of the Worker's file
routes. Mirrors the transport half of ``cloudSyncFiles.test.ts``: the closed route list (a save id may hold
dots), no redirects, ``Content-Digest``, bodies read under the size asked for, the server's 503 and
``Retry-After`` as a value, and the bearer token never in an error."""

from __future__ import annotations

import hashlib
from typing import Callable, List, Optional

import httpx
import pytest
from helpers import PRODUCT, TOKEN, make_client

from polaris_key.cloud_sync.files import (
    FILES_MANIFEST_MAX_BYTES,
    FileRoutes,
    is_files_path,
    retry_after_seconds,
)
from polaris_key.cloud_sync.transfer import FileQuery, FileTarget, TransferError

T = FileTarget("saves", "slot.1")


def rig(handler: Callable[[httpx.Request], httpx.Response], token: Optional[str] = TOKEN) -> FileRoutes:
    seen: List[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    client = make_client(wrapped)
    routes = FileRoutes(client.core, lambda: token)
    routes.seen = seen  # type: ignore[attr-defined]
    return routes


def test_path_allow_list() -> None:
    p = f"/{PRODUCT}/sync/files"
    assert is_files_path(PRODUCT, f"{p}/saves/slot.1/begin")
    assert is_files_path(PRODUCT, f"{p}/saves/slot.1?version=3")
    assert is_files_path(PRODUCT, f"{p}/saves/slot.1/upload/up_abc/parts/12")
    assert is_files_path(PRODUCT, f"{p}/saves/chunks/{'a' * 64}")
    for bad in (
        f"{p}/saves/../begin",
        f"{p}/saves/slot.1/upload/up_abc/parts/10000",
        f"{p}/saves/slot.1/upload/up_abc/chunks/{'A' * 64}",
        f"{p}/saves/slot.1/begin?version=1",
        f"{p}/saves/slot.1?version=x",
        f"{p}/saves/slot.1?other=1",
        "/other/sync/files/saves/slot.1",
        f"{p}/saves/slot 1/begin",
    ):
        assert not is_files_path(PRODUCT, bad), bad


def test_bad_parts_never_send() -> None:
    r = rig(lambda req: httpx.Response(200, json={}))
    for call in (
        lambda: r.begin(FileTarget("saves", ".."), {}),
        lambda: r.begin(FileTarget("sa/ves", "x"), {}),
        lambda: r.status(T, "../x"),
        lambda: r.put_part(T, "up_a", 0, b"x", "0" * 64),
        lambda: r.put_chunk(T, "up_a", "xyz", b"x", "0" * 64),
        lambda: r.get_chunk("saves", "A" * 64),
        lambda: r.get_file(T, FileQuery(version=-1)),
    ):
        with pytest.raises(TransferError):
            call()
    assert r.seen == []  # type: ignore[attr-defined]


def test_digest_and_headers() -> None:
    body = b"hello save"
    sha = hashlib.sha256(body).hexdigest()
    r = rig(lambda req: httpx.Response(204))
    reply = r.put_single(T, "up_abc", body, sha)
    assert reply.ok
    req = r.seen[0]  # type: ignore[attr-defined]
    assert req.method == "PUT" and req.url.path == f"/{PRODUCT}/sync/files/saves/slot.1/upload/up_abc"
    assert req.headers["content-digest"].startswith("sha-256=:") and req.headers["authorization"] == f"Bearer {TOKEN}"
    assert req.content == body
    with pytest.raises(TransferError):
        r.put_single(T, "up_abc", body, "nothex")


def test_no_bearer_sends_nothing() -> None:
    r = rig(lambda req: httpx.Response(200, json={}), token=None)
    reply = r.revisions(T)
    assert not reply.ok and reply.status == 401 and reply.code == "unauthorized"
    assert r.seen == []  # type: ignore[attr-defined]


def test_redirect_is_a_refusal() -> None:
    r = rig(lambda req: httpx.Response(302, headers={"location": "https://evil.example/x"}))
    reply = r.revisions(T)
    assert not reply.ok and reply.status == 302 and reply.code == "redirect_refused"
    assert len(r.seen) == 1  # type: ignore[attr-defined]


def test_503_with_retry_after_is_a_value() -> None:
    r = rig(
        lambda req: httpx.Response(
            503, headers={"retry-after": "120"}, json={"error": {"code": "unavailable", "message": "x"}}
        )
    )
    reply = r.begin(T, {"size": 1})
    assert not reply.ok and reply.status == 503 and reply.code == "unavailable"
    assert reply.retry_after_seconds == 120


def test_refusal_carries_the_bodys_extra_members() -> None:
    r = rig(
        lambda req: httpx.Response(
            409, json={"error": {"code": "revision_conflict"}, "server": {"version": 7}}
        )
    )
    reply = r.finalize(T, {"uploadId": "up_a"})
    assert reply.status == 409 and reply.code == "revision_conflict" and reply.body["server"]["version"] == 7
    r2 = rig(lambda req: httpx.Response(409, json={"error": "upload_incomplete", "missing": [1]}))
    reply = r2.finalize(T, {"uploadId": "up_a"})
    assert reply.code == "upload_incomplete" and reply.body["missing"] == [1]


def test_bodies_are_bounded_by_what_was_asked() -> None:
    # A ranged GET answers more than the range: refused, never buffered.
    r = rig(lambda req: httpx.Response(206, content=b"x" * 100))
    reply = r.get_file(T, FileQuery(range=(0, 10)))
    assert not reply.ok and reply.code == "bad_response"
    # A whole-file GET over the manifest cap too.
    r = rig(lambda req: httpx.Response(200, content=b"x" * (FILES_MANIFEST_MAX_BYTES + 1)))
    assert r.get_file(T, FileQuery()).code == "bad_response"  # type: ignore[union-attr]
    # A good ranged answer carries its ETag and Content-Range.
    r = rig(
        lambda req: httpx.Response(
            206, content=b"x" * 10, headers={"etag": '"abc"', "content-range": "bytes 0-9/100"}
        )
    )
    got = r.get_file(T, FileQuery(range=(0, 10), if_match='"abc"'))
    assert got.ok and got.value.content_range == (0, 10, 100) and got.value.etag == '"abc"'
    assert r.seen[0].headers["range"] == "bytes=0-9"  # type: ignore[attr-defined]
    assert r.seen[0].headers["if-match"] == '"abc"'  # type: ignore[attr-defined]


def test_json_answers_are_checked() -> None:
    r = rig(lambda req: httpx.Response(200, json={"uploadId": "..", "mode": "single", "expiresAt": 1}))
    assert r.begin(T, {}).code == "bad_response"
    r = rig(lambda req: httpx.Response(200, content=b"not json"))
    assert r.revisions(T).code == "bad_response"


def test_the_token_is_not_in_an_error() -> None:
    r = rig(lambda req: httpx.Response(400, json={"error": "bad_request"}))
    reply = r.begin(T, {})
    assert TOKEN not in repr(reply)


def test_retry_after_forms() -> None:
    assert retry_after_seconds(None) is None
    assert retry_after_seconds("") is None
    assert retry_after_seconds("2800") == 2800
    assert retry_after_seconds("1.2") == 2
    assert retry_after_seconds("Thu, 01 Jan 1970 00:10:00 GMT", now=0) == 600
    assert retry_after_seconds("nonsense") is None
    assert retry_after_seconds("Thu, 01 Jan 1970 00:00:00 GMT", now=100) == 0
