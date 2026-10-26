"""``polaris_key.identity`` — device-code sign-in (RFC 8628).

See :mod:`polaris_key.identity.client`.
"""

from .account import (
    AttachConfirm,
    AttachLicense,
    AttachOk,
    AttachRefused,
    OpenAccountResult,
    SignOutResult,
)
from .client import (
    SLOW_DOWN_STEP_SECONDS,
    IdentityClient,
    SignedInIdentity,
    SignInNamespace,
)
from .sign_in import SignInActivation, SignInOutcome, SignInSession

__all__ = [
    "AttachConfirm",
    "AttachLicense",
    "AttachOk",
    "AttachRefused",
    "OpenAccountResult",
    "SignOutResult",
    "IdentityClient",
    "SignedInIdentity",
    "SignInActivation",
    "SignInNamespace",
    "SignInOutcome",
    "SignInSession",
    "SLOW_DOWN_STEP_SECONDS",
]
