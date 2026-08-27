"""The Update sub-client — the FEED over Release's truth store (D-05, §R1).

Two jobs, both thin:

  ``check()``       ``GET /<p>/update/version`` → what the newest build on this channel is,
                    plus whether the running version is behind it. The comparison uses
                    :func:`polaris.core.semver.compare_semver`, the same one the server's
                    build gate and every other SDK use — a version check that disagreed
                    with the gate would tell a user to update to a build the gate blocks.
  ``appcast_url()`` the Sparkle feed URL, taken from DISCOVERY rather than string-built
                    here. §R1 moved these paths and left permanent aliases; a host that
                    hard-codes one breaks the next time they move, whereas the discovery
                    document is the product's own statement of where its feed lives.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.semver import compare_semver
from ..core.token import TokenManager
from ..discovery import appcast_url_from

__all__ = ["VersionCheck", "UpdateClient"]


@dataclass(frozen=True)
class VersionCheck:
    #: The newest version on the requested channel.
    version: str
    tag: str
    url: str
    #: Whether the host application's own version is older than ``version``.
    updateAvailable: bool


class UpdateClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        discovery: Callable[[], Optional[Dict[str, Any]]],
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._discovery = discovery

    def check(self, *, channel: Optional[str] = None) -> VersionCheck:
        """``GET /<p>/update/version`` — the newest build, and whether we are behind it.

        ``updateAvailable`` is computed from the CoreContext's ``version``, the HOST
        APPLICATION's version, not the SDK's: the SDK ships inside the thing being
        updated.
        """
        self._ctx.require_service("update")
        url = self._ctx.url("update/version")
        if channel:
            parts = urlsplit(url)
            query = dict(parse_qsl(parts.query, keep_blank_values=True))
            query["channel"] = channel
            url = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
            )

        token = self._tokens.current
        extra = {"authorization": f"Bearer {token}"} if token else {}
        res = self._ctx.request("GET", url, headers=self._ctx.headers(extra))
        if res.status_code == 403:
            body = _json_or_empty(res)
            error = body.get("error") if isinstance(body.get("error"), dict) else {}
            raise PolarisError(
                error.get("code") or "forbidden",
                "This build is not entitled to that update channel.",
            )
        if not res.is_success:
            raise PolarisError(
                "not_found", f"update/version failed with status {res.status_code}."
            )
        body = _json_or_empty(res)
        version = str(body.get("version", ""))
        return VersionCheck(
            version=version,
            tag=str(body.get("tag", "")),
            url=str(body.get("url", "")),
            updateAvailable=compare_semver(self._ctx.version, version) < 0,
        )

    def appcast_url(
        self, *, channel: Optional[str] = None, arch: Optional[str] = None
    ) -> Optional[str]:
        """The Sparkle appcast URL for this product, from the discovery document.

        Returns ``None`` when discovery has not been loaded or Update is not enabled —
        the same fail-closed posture the sub-client gate takes, expressed as a VALUE
        because a host asking "where is my feed?" before discovery has run is a sequencing
        question, not an error.
        """
        manifest = self._discovery()
        if manifest is None:
            return None
        return appcast_url_from(manifest, channel=channel, arch=arch)


def _json_or_empty(res: Any) -> Dict[str, Any]:
    try:
        body = res.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}
