"""``polaris_key.server``: gate a server route with the app's signed licence document.

The app sends its ``pkey-license+jws`` in ``X-PKey-License``; the backend verifies it offline
against the product's pinned keys and the signed trust manifest (WIRE-CONTRACT-V4 §14). The
adapters (``polaris_key.server.fastapi``, ``.starlette``, ``.django``, ``.drf``, ``.flask``)
are thin layers over :class:`PolarisKey`; each imports its framework only when you import it.
"""

from __future__ import annotations

from ._core import PolarisAuth, PolarisKey, PolarisKeyError
from ._problem import Problem, backend_locale, backend_problem
from ._verdict import (
    AUTH_SCHEME,
    HEADER_LICENSE,
    LICENSE_MAX_BYTES,
    POLARIS_REQUEST_HEADERS,
    REFUSAL_STATUS,
    Holder,
    PolarisLicense,
    PolarisUser,
    Requirement,
    Verdict,
    backend_verdict,
    entitlement,
    signin,
)

__all__ = [
    "AUTH_SCHEME",
    "HEADER_LICENSE",
    "LICENSE_MAX_BYTES",
    "POLARIS_REQUEST_HEADERS",
    "REFUSAL_STATUS",
    "Holder",
    "PolarisAuth",
    "PolarisKey",
    "PolarisKeyError",
    "PolarisLicense",
    "PolarisUser",
    "Problem",
    "Requirement",
    "Verdict",
    "backend_locale",
    "backend_problem",
    "backend_verdict",
    "entitlement",
    "signin",
]
