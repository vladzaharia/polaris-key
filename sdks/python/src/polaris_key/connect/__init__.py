"""Cloud Connect (WIRE-CONTRACT-V5 §15): ``client.connect``. CC-10.1 is the identity half, CC-10.4 the
client side of the transports (the error taxonomy, the relay ticket, the peer source and pushed rosters)."""

from __future__ import annotations

from .client import (
    PREV_DISC_KEY_SECONDS,
    ConnectClient,
    ConnectDevice,
    ConnectIdentity,
    DiscoveryKeys,
    PeerSource,
    RelayGrant,
    RingAdoption,
)
from .cloud_connect import CloudConnect, CloudConnectStatus, CloudPeer
from .contacts import ContactInfo, ContactRef
from .errors import LanError, RelayError
from .links import CloudLinks
from .nearby import ApproveAnswerInput, CloudNearby, NearbyApproval, NearbyApproverHandle, NearbyDeps, NearbyRequest

__all__ = [
    "ApproveAnswerInput",
    "CloudConnect",
    "CloudConnectStatus",
    "CloudLinks",
    "CloudNearby",
    "CloudPeer",
    "ConnectClient",
    "ConnectDevice",
    "ConnectIdentity",
    "ContactInfo",
    "ContactRef",
    "DiscoveryKeys",
    "LanError",
    "LinkOffer",
    "LinkPairHandle",
    "PAIR_WINDOW_SECONDS",
    "NearbyApproval",
    "NearbyApproverHandle",
    "NearbyDeps",
    "NearbyRequest",
    "PREV_DISC_KEY_SECONDS",
    "PairFailure",
    "PairedLink",
    "PeerSource",
    "RelayError",
    "RelayGrant",
    "RingAdoption",
]

#: The pairing window imports asyncio and sockets: resolved on first use (PEP 562), so importing this package
#: starts nothing and loads nothing it does not need.
_PAIRING = ("LinkOffer", "LinkPairHandle", "PAIR_WINDOW_SECONDS", "PairFailure", "PairedLink")


def __getattr__(name: str) -> object:
    if name in _PAIRING:
        from . import pairing

        return getattr(pairing, name)
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
