"""A verified, resumable download straight to a file (SDK parity pass §3.6, ``release.fetch``).

The bytes are never trusted: the size and SHA-256 come from a VERIFIED release record (signed by
a pinned release key), and the file only appears at ``to`` once both match. Until then it lives
at ``<to>.part``, which a later call resumes with ``Range`` (and ``If-Range`` on the ETag the
first answer carried). A body longer than the record says is refused and the ``.part``
removed; a hash mismatch removes it too. A cancelled or interrupted download keeps the
``.part`` for the next attempt.

Transport rules, as Godot's ``core/download.gd`` keeps them:

* redirects are followed HERE, at most :data:`MAX_REDIRECTS`: the bearer is sent to the URL
  discovery advertised and dropped as soon as a redirect changes origin, and it never comes
  back; a redirect to plain ``http`` on a non-loopback host is refused (``insecure-redirect``);
* ``Accept-Encoding: identity``, because a compressed answer breaks ``Range``;
* the seven ``X-PKey-*`` headers ride every hop to the first origin (gated delivery reads them);
* local-only refuses before dialling.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import urljoin, urlsplit

import httpx

from ..core.context import CoreContext, server_error
from ..core.errors import PolarisError
from ..core.events import listener_failed

__all__ = ["FetchedFile", "MAX_REDIRECTS", "fetch_verified"]

MAX_REDIRECTS = 5
_CHUNK = 256 * 1024
_LOOPBACK = ("localhost", "127.0.0.1", "::1", "[::1]")


@dataclass(frozen=True)
class FetchedFile:
    """A download that matched its record: where it is, its size and its SHA-256."""

    path: str
    size: int
    sha256: str
    #: Whether an earlier ``.part`` was resumed.
    resumed: bool = False


def _origin(url: str) -> tuple:
    p = urlsplit(url)
    return (p.scheme.lower(), (p.hostname or "").lower(), p.port)


def _secure(url: str) -> bool:
    p = urlsplit(url)
    if p.scheme == "https":
        return True
    return p.scheme == "http" and (p.hostname or "").lower() in _LOOPBACK


def _code_of(res: httpx.Response) -> Optional[str]:
    try:
        body = json.loads(res.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    e = body.get("error")
    if isinstance(e, str) and e:
        return e
    if isinstance(e, dict) and isinstance(e.get("code"), str) and e["code"]:
        return e["code"]
    return None


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def fetch_verified(
    ctx: CoreContext,
    url: str,
    to: str,
    *,
    expected_size: int,
    expected_sha256: str,
    bearer: Optional[str] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
    cancel: Optional[threading.Event] = None,
) -> FetchedFile:
    """Download ``url`` to ``to``, verified against ``expected_size`` and ``expected_sha256``
    (lowercase hex). ``on_progress(done, total)`` runs as bytes arrive.

    Raises :class:`PolarisError`: ``local-only``, ``network-error``, ``server-error`` (a 5xx),
    ``insecure-redirect``, ``too-many-redirects``, ``cancelled`` (the ``.part`` is kept),
    ``payload-mismatch`` (size or hash; the ``.part`` is removed), or the server's refusal code
    (``download_auth_required``, ``attestation_required``, ``not_found``, …; ``http-error`` when
    it names none).
    """
    client = ctx.http()  # local-only refuses here, before anything is written
    if not _secure(url):
        raise PolarisError("insecure-redirect", f"Refusing to download over plain http: {url}")
    expected_sha256 = expected_sha256.lower()
    part = to + ".part"
    # Private resume sidecar ``<to>.part.json`` ({"sha256": ..., "etag": ...}). Not a public format, but
    # tests/test_transcripts.py seeds it (with ``.part``) to replay an interrupted fetch, so a
    # change here must change the replayer too.
    meta_path = part + ".json"
    directory = os.path.dirname(os.path.abspath(to))
    os.makedirs(directory, exist_ok=True)

    have = os.path.getsize(part) if os.path.isfile(part) else 0
    etag: Optional[str] = None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        meta = None  # no metadata: Range without If-Range, and the hash decides anyway
    if isinstance(meta, dict):
        if meta.get("sha256") == expected_sha256 and isinstance(meta.get("etag"), str):
            etag = meta["etag"]
        elif have:
            _remove(part)  # a .part for other bytes: start over
            have = 0
    if have > expected_size:
        _remove(part)
        have = 0
    resumed = have > 0

    if have < expected_size or expected_size == 0:
        first = _origin(url)
        current = url
        credentials = True
        hops = 0
        while True:
            if cancel is not None and cancel.is_set():
                raise PolarisError("cancelled", "The download was cancelled; the next call resumes.")
            if credentials and _origin(current) != first:
                credentials = False
            headers: Dict[str, str] = {"accept-encoding": "identity"}
            if credentials:
                if bearer:
                    headers["authorization"] = f"Bearer {bearer}"
                headers = ctx.headers(headers)
            if have > 0:
                headers["range"] = f"bytes={have}-"
                if etag:
                    headers["if-range"] = etag
            try:
                req = client.build_request("GET", current, headers=headers, timeout=ctx.timeout)
                res = client.send(req, stream=True, follow_redirects=False)
            except (httpx.HTTPError, OSError) as e:
                raise PolarisError("network-error", str(e) or type(e).__name__) from e
            try:
                if res.status_code in (301, 302, 303, 307, 308):
                    loc = res.headers.get("location")
                    hops += 1
                    if not loc or hops > MAX_REDIRECTS:
                        raise PolarisError("too-many-redirects", "The download redirected too many times.")
                    nxt = urljoin(current, loc)
                    if not _secure(nxt):
                        raise PolarisError("insecure-redirect", f"Refusing a redirect to {nxt}.")
                    current = nxt
                    continue
                if res.status_code == 416 and have == expected_size:
                    break
                if res.status_code >= 500:
                    try:
                        res.read()  # for the server's message; unread, there is none
                    except Exception:  # noqa: BLE001
                        pass
                    raise server_error(res, "The download")
                if res.status_code not in (200, 206):
                    code = _code_of(res) or "http-error"
                    raise PolarisError(
                        code,
                        f"The download was refused (status {res.status_code}).",
                        status=res.status_code,
                    )
                if res.status_code == 200:
                    have = 0  # the server ignored Range (or If-Range failed): start over
                new_etag = res.headers.get("etag")
                if new_etag:
                    try:
                        with open(meta_path, "w", encoding="utf-8") as f:
                            json.dump({"sha256": expected_sha256, "etag": new_etag}, f)
                    except OSError:
                        pass
                mode = "ab" if have > 0 else "wb"
                with open(part, mode) as out:
                    try:
                        for chunk in res.iter_bytes():
                            if cancel is not None and cancel.is_set():
                                raise PolarisError(
                                    "cancelled", "The download was cancelled; the next call resumes."
                                )
                            have += len(chunk)
                            if have > expected_size:
                                out.close()
                                _remove(part)
                                _remove(meta_path)
                                raise PolarisError(
                                    "payload-mismatch",
                                    "The download is larger than its release record says.",
                                )
                            out.write(chunk)
                            if on_progress is not None:
                                try:
                                    on_progress(have, expected_size)
                                except Exception:
                                    listener_failed("on_progress")
                    except httpx.HTTPError as e:
                        raise PolarisError(
                            "network-error", f"The download was interrupted ({e}); the next call resumes."
                        ) from e
                break
            finally:
                res.close()

    size = os.path.getsize(part) if os.path.isfile(part) else 0
    digest = hashlib.sha256()
    if size:
        with open(part, "rb") as f:
            for block in iter(lambda: f.read(_CHUNK), b""):
                digest.update(block)
    sha = digest.hexdigest()
    if size != expected_size or sha != expected_sha256:
        _remove(part)
        _remove(meta_path)
        raise PolarisError(
            "payload-mismatch",
            "The downloaded bytes do not match the verified release record.",
        )
    os.replace(part, to)
    _remove(meta_path)
    return FetchedFile(path=to, size=size, sha256=sha, resumed=resumed)
