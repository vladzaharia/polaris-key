"""Strict-JSON building blocks shared by the JWS path and the config environment rule.

``reject_duplicate_keys`` is the ``object_pairs_hook`` both use: duplicate members MUST cause
failure — not last-wins (TS/Python) and not first-wins (Swift's ``JSONSerialization``), because
any silent resolution is a differential across implementations. ``{"alg":"none","kid":"x",
"alg":"EdDSA"}`` read as ``EdDSA`` here and ``none`` in Swift: the algorithm-downgrade guard
returning opposite answers per language (R2-06). Python's ``str`` equality compares code points,
which is the scalar-value comparison WIRE-CONTRACT-V3 §2.2.1 rule 2 asks for.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

__all__ = ["reject_duplicate_keys"]


def reject_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    """``object_pairs_hook`` that refuses any object declaring the same key twice."""
    out: Dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON object key")
        out[key] = value
    return out
