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

from ..constants_generated import ErrorCode, Feature
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.token import TokenManager

__all__ = ["ChangelogEntry", "ReleaseClient"]


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
    def __init__(self, ctx: CoreContext, tokens: TokenManager) -> None:
        self._ctx = ctx
        self._tokens = tokens

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
        than run it."""
        self._ctx.require_service("release", Feature.RELEASE_DOWNLOAD)
        return self._ctx.url("release/install.sh")

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
        url = self._ctx.url(f"release/dl/{quote(version, safe='')}/{quote(name, safe='')}")
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
