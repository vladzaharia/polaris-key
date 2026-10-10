"""The terminal kit's exit codes: the ``cli`` family's ``exit`` table in
``conformance/corpus/v2/ui-matrix.json`` (UK-51), the same table as the Node kit's ``EXIT``.

=====================  ====  ===================================================================
``ok``                 0     done; for ``status``, the license is usable
``failed``             1     a refusal, an unusable license (``status``), a network failure, a
                             cancelled or declined step, any other failure
``usage``              2     an argument error, no key to read
``license_required``   4     a gate in a host CLI refused the host's command (``--json``:
                             ``"error": "license_required"`` or ``"not_entitled"``), as ``gh``
                             exits for "requires authentication"
``interrupted``        130   Ctrl-C
=====================  ====  ===================================================================

The names are Node's in snake case (``EXIT.licenseRequired`` is ``EXIT.license_required``).
"""

from __future__ import annotations

from typing import NamedTuple

__all__ = ["EXIT", "Exit"]


class Exit(NamedTuple):
    ok: int = 0
    failed: int = 1
    usage: int = 2
    license_required: int = 4
    interrupted: int = 130


#: The exit table.
EXIT = Exit()
