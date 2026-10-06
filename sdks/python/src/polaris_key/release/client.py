"""The Release sub-client — the software TRUTH store's public face (D-05, §R1).

Release owns what the software IS and where it comes from: the changelog, the install
script, the artifacts. Update owns the FEED over it (appcast, version check). They are two
services precisely because a product can want a changelog without wanting Sparkle, and the
split is the one place in the suite where a cross-service dependency is sanctioned
(update → release).

Deliberately thin: these are public, unauthenticated GETs returning JSON. There is no
signed document here and therefore no verification — a release note is not a grant. When
Release's access mode is ``entitled`` the server refuses without a device token; this
client forwards the bearer when one is held and reports the refusal rather than inventing
a retry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

import threading

from ..constants_generated import ErrorCode, Feature
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.headers import canonical_arch, canonical_platform
from ..core.models import ReleaseRecordBuild, ReleaseRecordDoc, UpdateCheck, UpdateDecision
from ..core.token import TokenManager
from ..discovery import service_endpoint
from .fetch import FetchedFile, fetch_verified

__all__ = ["ChangelogEntry", "ReleaseClient", "FetchedFile"]


@dataclass(frozen=True)
class ChangelogEntry:
    """One published release, as ``GET /<p>/release/changelog`` reports it."""

    version: str
    tag: str
    #: The curated summary, or ``None`` when the release body yielded none.
    summary: Optional[str]
    url: str
    date: Optional[str] = None

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "ChangelogEntry":
        return ChangelogEntry(
            version=str(d.get("version", "")),
            tag=str(d.get("tag", "")),
            summary=d["summary"] if isinstance(d.get("summary"), str) else None,
            url=str(d.get("url", "")),
            date=d.get("date"),
        )


class ReleaseClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        discovery: Optional[Any] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        #: The loaded discovery document (``() -> dict | None``), for the canonical URLs.
        self._discovery = discovery if discovery is not None else (lambda: None)
        #: The update client (set by the facade): records come through its verified path, and
        #: its journal records ``update_downloaded``.
        self.update: Any = None

    def changelog(self) -> List[ChangelogEntry]:
        """``GET /<p>/release/changelog`` — the published release list, newest first.

        Raises ``PolarisError("service-unavailable")`` when this product does not run
        Release: a client that has not been told the service exists must not probe for it
        (D-21).
        """
        self._ctx.require_service("release", Feature.RELEASE_CHANGELOG)
        res = self._get("release/changelog")
        body = _json_or_empty(res)
        entries = body.get("entries")
        if not isinstance(entries, list):
            return []
        return [ChangelogEntry.from_dict(e) for e in entries if isinstance(e, dict)]

    def install_url(self) -> str:
        """The canonical install-script URL, for a host that wants to print it rather
        than run it: discovery's ``distribution.endpoints.install`` when the product runs
        Distribution, else Release's permanent ``/release/install.sh`` alias."""
        self._ctx.require_service("release", Feature.RELEASE_DOWNLOAD)
        return service_endpoint(self._discovery(), "distribution", "install") or self._ctx.url(
            "release/install.sh"
        )

    def download_url(
        self,
        version: str,
        binary: str,
        arch: str,
        *,
        checksum: bool = False,
        dmg: bool = False,
    ) -> str:
        """``GET /<p>/release/dl/:version/:binary-:arch`` — the artifact URL.

        Built, not fetched: the caller streams it themselves.
        """
        self._ctx.require_service("release", Feature.RELEASE_DOWNLOAD)
        name = f"{binary}-{arch}{'.dmg' if dmg else ''}"
        # The canonical route is Distribution's (discovery's `distribution.endpoints.download`);
        # `/release/dl` is the permanent alias, used only when discovery names none.
        base = service_endpoint(self._discovery(), "distribution", "download")
        tail = f"{quote(version, safe='')}/{quote(name, safe='')}"
        url = f"{base.rstrip('/')}/{tail}" if base else self._ctx.url(f"release/dl/{tail}")
        if checksum:
            parts = urlsplit(url)
            url = urlunsplit(
                (
                    parts.scheme,
                    parts.netloc,
                    parts.path,
                    urlencode({"checksum": "sha256"}),
                    parts.fragment,
                )
            )
        return url

    # ── Verified download (release.fetch) ───────────────────────────────────────────────
    def fetch(
        self,
        target: Any,
        *,
        to: str,
        build_id: Optional[str] = None,
        on_progress: Optional[Any] = None,
        cancel: Optional[threading.Event] = None,
    ) -> FetchedFile:
        """Download a build to ``to`` and verify it against its signed release record (SDK
        parity pass §3.6) before it appears there.

        ``target`` is an :class:`~polaris_key.core.models.UpdateCheck` or
        :class:`~polaris_key.core.models.UpdateDecision` whose action is ``binary`` (the
        decision names the record and the build), or a verified
        :class:`~polaris_key.core.models.ReleaseRecordDoc` (``build_id``, else the build for this
        install's platform and architecture). The URL is discovery's build template
        (``client.update.build_url``), never the legacy ``/release/dl`` alias; the device bearer
        and the ``X-PKey-*`` headers ride it for gated delivery; an interrupted download resumes
        with ``Range``/``If-Range``; ``on_progress(done, total)`` reports bytes. Records
        ``update_downloaded`` on success.

        Raises :class:`PolarisError`: ``invalid-options`` (a target with no build to fetch),
        ``not-configured`` / ``service-unavailable`` (no update options or no build endpoint),
        the record's ``record-rejected`` / ``record-mismatch``, and the download's codes (see
        :func:`polaris_key.release.fetch.fetch_verified`)."""
        update = self.update
        if update is None:
            raise PolarisError("not-configured", "release.fetch needs the update client.")
        record, build = self._resolve_build(target, build_id)
        payload = next((a for a in build.artifacts if a.role == "payload"), None)
        if payload is None:
            raise PolarisError(
                "invalid-options", f"Build {build.id} has no payload artifact (a store-only build)."
            )
        url = update.build_url(record.version, build.id)
        if url is None:
            raise PolarisError(
                ErrorCode.SERVICE_UNAVAILABLE, "Discovery names no build endpoint for this product."
            )
        got = fetch_verified(
            self._ctx,
            url,
            to,
            expected_size=int(payload.size),
            expected_sha256=payload.sha256,
            bearer=self._tokens.current,
            on_progress=on_progress,
            cancel=cancel,
        )
        journal = getattr(update, "journal", None)
        if journal is not None:
            try:
                journal.record(
                    "update_downloaded",
                    release=record.tag or record.version,
                    from_release=self._ctx.version,
                    channel=record.channel,
                )
            except Exception:
                pass
        return got

    def _resolve_build(self, target: Any, build_id: Optional[str]):  # type: ignore[no-untyped-def]
        update = self.update
        if isinstance(target, UpdateCheck):
            target = target.decision
        if isinstance(target, UpdateDecision):
            if target.action != "binary" or target.release is None or target.release.sha256 is None:
                raise PolarisError(
                    "invalid-options",
                    f"A {target.action} decision has no build to download.",
                )
            record = update.release_record(target.release.sha256).record
            build_id = build_id or target.build
        elif isinstance(target, ReleaseRecordDoc):
            record = target
        else:
            raise PolarisError(
                "invalid-options",
                "release.fetch takes an UpdateCheck, an UpdateDecision or a verified ReleaseRecordDoc.",
            )
        builds = record.builds or ()
        build: Optional[ReleaseRecordBuild] = None
        if build_id is not None:
            build = next((b for b in builds if b.id == build_id), None)
        else:
            import platform as _platform

            plat = update._platform_value() if hasattr(update, "_platform_value") else None
            plat = plat or canonical_platform(_platform.system())
            arch = canonical_arch(_platform.machine())
            build = next(
                (b for b in builds if b.platform == plat and b.arch in (arch, "universal")), None
            ) or next((b for b in builds if b.platform == plat), None)
        if build is None:
            raise PolarisError("invalid-options", "The release record has no matching build.")
        return record, build

    def _get(self, path: str) -> Any:
        """Shared GET. Forwards the device token when one is held so an ``entitled`` feed
        can authenticate; a public feed simply ignores it."""
        token = self._tokens.current
        extra = {"authorization": f"Bearer {token}"} if token else {}
        res = self._ctx.request(
            "GET", self._ctx.url(path), headers=self._ctx.headers(extra)
        )
        if res.status_code in (401, 403):
            # The refusal names itself: the nested v3 shape (``{"error":{"code":…}}``, the
            # ``entitled`` mode) or the flat one (``{"error":"download_auth_required"}``).
            body = _json_or_empty(res)
            raw = body.get("error")
            code = raw if isinstance(raw, str) else (
                raw.get("code") if isinstance(raw, dict) else None
            )
            if res.status_code == 401:
                raise PolarisError(
                    code or ErrorCode.UNAUTHORIZED,
                    f"{path} refused: this feed needs a usable licence.",
                )
            raise PolarisError(
                code or ErrorCode.FORBIDDEN,
                f"{path} refused: this build is not entitled to that feed.",
            )
        if not res.is_success:
            raise PolarisError(
                "not_found", f"{path} failed with status {res.status_code}."
            )
        return res


def _json_or_empty(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}
