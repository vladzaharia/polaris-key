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
from .choice import (
    ChoiceCancelOk,
    ChoiceCompleteOk,
    ChoiceRefused,
    ChoiceViewOk,
    LicenseChoiceView,
    ReplaceView,
)
from .client import (
    SLOW_DOWN_STEP_SECONDS,
    IdentityClient,
    SignedInIdentity,
    SignInNamespace,
)
from .redirect import RedirectSession, SignInError
from .sign_in import SignInActivation, SignInOutcome, SignInSession

__all__ = [
    "ChoiceCancelOk",
    "ChoiceCompleteOk",
    "ChoiceRefused",
    "ChoiceViewOk",
    "LicenseChoiceView",
    "RedirectSession",
    "ReplaceView",
    "SignInError",
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
