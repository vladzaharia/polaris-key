"""``polaris_key.server``: gate a server route with the app's signed licence document.

The app sends its ``pkey-license+jws`` in ``X-PKey-License``; the backend verifies it offline
against the product's pinned keys and the signed trust manifest (WIRE-CONTRACT-V4 §14). The
adapters (``polaris_key.server.fastapi``, ``.starlette``, ``.django``, ``.drf``, ``.flask``)
are thin layers over :class:`PolarisKey`; each imports its framework only when you import it.
``polaris_key.server.testing`` signs throwaway documents and fakes the trust service for your tests.

Requirements for ``require_all`` (and the matching ``require_*`` gates): :func:`entitlement`,
:func:`tier` and :func:`signin`.
"""

from __future__ import annotations

from ._core import (
    PolarisAuth,
    PolarisKey,
    PolarisKeyError,
    PolarisKeySetupError,
    get_polaris_license,
    is_cors_preflight,
)
from ._problem import Problem, ProblemBody, RefusalCode, RefusalHandler, backend_locale, backend_problem
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
    sign_in,
    signin,
    tier,
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
    "PolarisKeySetupError",
    "PolarisLicense",
    "PolarisUser",
    "Problem",
    "ProblemBody",
    "RefusalCode",
    "RefusalHandler",
    "Requirement",
    "Verdict",
    "backend_locale",
    "backend_problem",
    "backend_verdict",
    "entitlement",
    "get_polaris_license",
    "is_cors_preflight",
    "sign_in",
    "signin",
    "tier",
]
