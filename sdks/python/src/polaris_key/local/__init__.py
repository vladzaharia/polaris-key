"""``polaris_key.local`` — the transportless profile (offline depth 3).

The suite has three offline depths: online-with-grace (the default), bundle-activated, and
LOCAL-ONLY — a build that must never open a socket at all. Air-gapped labs, regulated
environments, and "this binary runs inside a network namespace with no route" all want the
same thing: a client whose config resolution, gate and bundle import work, and whose every
network-requiring call refuses LOUDLY rather than hanging on a connect timeout.

HOW IT IS ENFORCED

Not by omitting endpoints — a client missing half its methods is a different type, and the
host would have to branch on which one it got. Instead
:meth:`polaris_key.core.context.CoreContext.http` raises ``PolarisError("local-only")`` BEFORE
a URL is built or a header is assembled, so:

* there is one client type, and ``client.license.activate_with_key(...)`` raises with a
  code the host can render, instead of failing in whatever way the transport happens to;
* the refusal is at the dial, so a local-only build cannot make a request even by
  accident — including from the refresh timer, which is not started at all;
* ``deactivate()`` still works: it treats the refusal exactly as it treats being offline,
  because the local wipe was always the part that mattered.

Two construction routes, both fully offline:

  :func:`create_local_client`   config-only or already-provisioned — reads what the cache
                                holds.
  :func:`create_bundle_client`  a fresh air-gapped install: import the operator's
                                ``.pkeybundle`` first, then hand back a client already
                                gated on it.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from ..client import PolarisKeyClient
from ..core.bundle import ImportBundleResult
from ..core.errors import PolarisError

__all__ = ["PolarisError", "create_local_client", "create_bundle_client"]


def create_local_client(**opts: Any) -> PolarisKeyClient:
    """A client that never touches the network.

    Everything offline still works: ``client.config.get_config(...)`` resolves over a
    cached or imported config document, ``client.license.status()`` gates on a cached or
    imported licence, and ``client.import_bundle(...)`` provisions one. Anything that
    would dial — activation, enrolment, registration, ``sync()``, discovery, the
    changelog, the update check — raises :class:`PolarisError` with code ``local-only``.

    ``client=`` and ``refresh_interval_seconds=`` are rejected: supplying a transport to a
    transportless client is a contradiction, and a polling timer on one is a thread whose
    entire job is to raise.
    """
    for banned in ("client", "refresh_interval_seconds", "local_only"):
        if banned in opts:
            raise TypeError(
                f"create_local_client() does not accept {banned!r} — "
                "a local-only client has no transport and no refresh loop."
            )
    client = PolarisKeyClient(**opts, local_only=True)
    client.init()
    return client


def create_bundle_client(
    *, bundle: str, now: Optional[int] = None, **opts: Any
) -> Tuple[PolarisKeyClient, ImportBundleResult]:
    """A local-only client provisioned from an offline activation bundle in one step.

    The import is verified all-or-nothing against the pins before anything is written
    (§7), so a rejected bundle leaves the install exactly as it was and this raises with
    the step that refused. On success the returned client is already gated on the imported
    documents.
    """
    client = create_local_client(**opts)
    imported = client.import_bundle(bundle, now)
    return client, imported
