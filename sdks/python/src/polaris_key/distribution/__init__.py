"""``client.distribution`` — the product's public download model (SDK parity pass §3.8).

``GET /<p>/distribution/download.json`` is the model the public download page renders (P2b-06):
the stable channel's newest release, one group per platform (its best action first, its
downloadable builds with immutable URLs, sizes and SHA-256s) and every way to get the product
(stores, direct downloads, package managers). Unsigned and public: it is what a "Download" or
"Also on" button shows, never something a grant is read from. Bytes are verified separately,
against a signed release record (``client.release.fetch``).
"""

from __future__ import annotations

import platform as _platform
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..constants_generated import Feature
from ..core.context import CoreContext, refusal_error
from ..core.errors import PolarisError
from ..core.headers import canonical_platform

__all__ = ["DistributionClient", "DownloadModel", "DownloadPlatform", "DOWNLOAD_MODEL_PATH"]

DOWNLOAD_MODEL_PATH = "distribution/download.json"


@dataclass(frozen=True)
class DownloadPlatform:
    """One platform's group: its label, the action to offer first, every action id for it
    (best first) and its downloadable builds, newest release first (the model's dicts)."""

    platform: str
    label: str
    primary: Optional[str]
    actions: Tuple[str, ...]
    builds: Tuple[Dict[str, Any], ...]


@dataclass(frozen=True)
class DownloadModel:
    schemaVersion: int
    channel: str
    pageUrl: Optional[str]
    release: Optional[Dict[str, Any]]
    platforms: Tuple[DownloadPlatform, ...]
    #: Every action, keyed by its id (``<kind>:<outletId>[:<platform>]``).
    actions: Dict[str, Dict[str, Any]]
    listing: Dict[str, Any] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    def platform(self, name: str) -> Optional[DownloadPlatform]:
        return next((p for p in self.platforms if p.platform == name), None)

    @property
    def stores(self) -> List[Dict[str, Any]]:
        """The store actions (App Store, Play, Steam, …): every action that is not a direct
        download or a sideload feed."""
        direct = {"download", "altstore", "sidestore", "altstore-pal", "obtainium", "fdroid",
                  "homebrew", "scoop", "winget"}
        return [a for a in self.actions.values() if a.get("kind") not in direct]


class DistributionClient:
    def __init__(self, ctx: CoreContext, *, platform: Optional[str] = None) -> None:
        self._ctx = ctx
        self._platform = platform

    def download_model(self) -> DownloadModel:
        """The public download model. Raises ``service-unavailable`` (no Distribution),
        ``not_found`` (the product's app is not publicly delivered, so there is no page),
        ``rate_limited``, ``network-error``, ``server-error`` or ``bad_response``."""
        self._ctx.require_service("distribution", Feature.RELEASE_DOWNLOAD)
        # Raises local-only, network-error or server-error (CoreContext.request).
        res = self._ctx.request(
            "GET",
            self._ctx.url(DOWNLOAD_MODEL_PATH),
            headers=self._ctx.headers({"accept": "application/json"}),
        )
        if res.status_code != 200:
            raise refusal_error(res, "download.json")
        try:
            body = res.json()
        except ValueError:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("platforms"), list):
            raise PolarisError("bad_response", "download.json is not a download model.")
        groups: List[DownloadPlatform] = []
        for g in body["platforms"]:
            if not isinstance(g, dict) or not isinstance(g.get("platform"), str):
                continue
            groups.append(
                DownloadPlatform(
                    platform=g["platform"],
                    label=str(g.get("label") or g["platform"]),
                    primary=g.get("primary") if isinstance(g.get("primary"), str) else None,
                    actions=tuple(a for a in g.get("actions") or () if isinstance(a, str)),
                    builds=tuple(b for b in g.get("builds") or () if isinstance(b, dict)),
                )
            )
        actions = {
            a["id"]: a
            for a in body.get("actions") or ()
            if isinstance(a, dict) and isinstance(a.get("id"), str)
        }
        sv = body.get("schemaVersion")
        return DownloadModel(
            schemaVersion=sv if isinstance(sv, int) else 0,
            channel=str(body.get("channel") or "stable"),
            pageUrl=body.get("pageUrl") if isinstance(body.get("pageUrl"), str) else None,
            release=body.get("release") if isinstance(body.get("release"), dict) else None,
            platforms=tuple(groups),
            actions=actions,
            listing=body.get("listing") if isinstance(body.get("listing"), dict) else {},
            raw=body,
        )

    def this_platform(self, model: Optional[DownloadModel] = None) -> Optional[DownloadPlatform]:
        """This install's platform group (``platform.system()``'s canonical value, or the
        platform the update options name), fetching the model when none is given."""
        m = model if model is not None else self.download_model()
        name = self._platform or canonical_platform(_platform.system())
        return m.platform(name) if name else None
