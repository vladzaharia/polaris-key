"""Typed "unsupported here" and ``supports()`` (P1b-10, PARITY §2.2).

Every SDK answers one query, ``client.supports(feature)``, with :class:`Supported` or
:class:`Unsupported` ``(feature, reason, detail)``, and every call into an unsupported feature
raises :class:`UnsupportedError` carrying the same three fields and the shared code
``unsupported``. The reasons:

  runtime     the runtime cannot do it at all (declared in the parity registry)
  outlet      the outlet forbids it
  product     the product disabled the service that owns it (discovery)
  dependency  an optional dependency is missing (the ``keyring`` extra)
  version     this SDK version does not implement the feature yet, or does not know it

THE TABLE IS DATA. ``CAPABILITIES`` is generated from ``sdks/python/parity.json`` into
:mod:`polaris_key.constants_generated` by ``pnpm gen:constants``; ``pnpm parity:check`` fails
when the two disagree. A ``runtime`` N/A holds wherever the runtime is; any other declared
reason names a DETECTOR the client runs, and :func:`validate_detectors` refuses a client whose
detectors and table differ.

``supports()`` never probes by calling: it is offline and side-effect free.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Mapping, Optional, Tuple, Union

from .._version import SDK_VERSION
from ..constants_generated import (
    CAPABILITIES,
    FEATURE_VALUES,
    SERVICE_SLUG_VALUES,
    CapabilityRow,
    ErrorCode,
    UnsupportedReason,
)
from .errors import PolarisError

__all__ = [
    "RUNTIME",
    "Supported",
    "Unsupported",
    "Support",
    "UnsupportedError",
    "Detector",
    "DetectorKey",
    "evaluate_support",
    "validate_detectors",
    "supported_features",
]

#: This SDK's runtime id in the parity registry.
RUNTIME = "python"


@dataclass(frozen=True)
class Supported:
    """``supports()`` said yes."""

    feature: str

    @property
    def supported(self) -> bool:
        return True


@dataclass(frozen=True)
class Unsupported:
    """``supports()`` said no, and why. ``reason`` is an :class:`UnsupportedReason` value;
    ``detail`` is human text."""

    feature: str
    reason: str
    detail: str

    @property
    def supported(self) -> bool:
        return False


Support = Union[Supported, Unsupported]


class UnsupportedError(PolarisError):
    """Raised by a call into a feature that is not supported here. ``code`` is
    ``unsupported``; ``feature``, ``reason`` and ``detail`` are :class:`Unsupported`'s."""

    def __init__(self, unsupported: Unsupported) -> None:
        super().__init__(
            ErrorCode.UNSUPPORTED,
            f"{unsupported.feature} is not supported here ({unsupported.reason}): {unsupported.detail}",
        )
        self.unsupported = unsupported
        self.feature = unsupported.feature
        self.reason = unsupported.reason
        self.detail = unsupported.detail


#: ``(feature, reason)``: the declared N/A a detector decides.
DetectorKey = Tuple[str, str]
#: Returns the reason's detail when the feature is unsupported now, else ``None``.
Detector = Callable[[], Optional[str]]


def _conditional(row: CapabilityRow, runtime: str) -> List[str]:
    """The reasons other than ``runtime`` that ``row`` declares on ``runtime``."""
    if row.status == "na":
        return []
    return [n.reason for n in row.na if n.runtime == runtime and n.reason != UnsupportedReason.RUNTIME]


def validate_detectors(
    detectors: Mapping[DetectorKey, Detector],
    *,
    runtime: str = RUNTIME,
    table: Mapping[str, CapabilityRow] = CAPABILITIES,
) -> None:
    """Raise ``ValueError`` unless every conditional N/A the table declares on ``runtime`` has a
    detector and every detector names one. A programming error, so it fails at construction."""
    wanted = {(feature, reason) for feature, row in table.items() for reason in _conditional(row, runtime)}
    have = set(detectors)
    missing = sorted(wanted - have)
    extra = sorted(have - wanted)
    if missing or extra:
        raise ValueError(
            "the capability table and the detectors disagree: "
            f"no detector for {missing}, no table entry for {extra}"
        )


def evaluate_support(
    feature: str,
    *,
    services_enabled: Callable[[str], bool],
    detectors: Mapping[DetectorKey, Detector],
    runtime: str = RUNTIME,
    table: Mapping[str, CapabilityRow] = CAPABILITIES,
    sdk_label: Optional[str] = None,
) -> Support:
    """The one ``supports()`` algorithm, in the order every SDK applies it."""
    label = sdk_label or f"polaris-key {SDK_VERSION}"
    row = table.get(feature)
    if row is None:
        return Unsupported(feature, UnsupportedReason.VERSION, f"{label} does not know the feature {feature}")
    for na in row.na:
        if na.runtime == runtime and (row.status == "na" or na.reason == UnsupportedReason.RUNTIME):
            return Unsupported(feature, na.reason, f"{feature} is not available on {runtime}")
    if row.status == "na":
        # The manifest declares it N/A on every runtime it lists (parity:check rule 3).
        reason = row.na[0].reason if row.na else UnsupportedReason.RUNTIME
        return Unsupported(feature, reason, f"{feature} is not available on {runtime}")
    if row.status == "planned":
        return Unsupported(feature, UnsupportedReason.VERSION, f"{label} does not implement {feature} yet")
    if row.service in SERVICE_SLUG_VALUES and not services_enabled(row.service):
        return Unsupported(
            feature, UnsupportedReason.PRODUCT, f"the product does not run the {row.service} service"
        )
    for reason in _conditional(row, runtime):
        detector = detectors.get((feature, reason))
        detail = detector() if detector is not None else None
        if detail:
            return Unsupported(feature, reason, detail)
    return Supported(feature)


def supported_features(support: Callable[[str], Support]) -> List[str]:
    """The feature ids ``support`` answers :class:`Supported` for, in registry order: the
    ``caps`` device telemetry carries."""
    return [f for f in FEATURE_VALUES if isinstance(support(f), Supported)]

