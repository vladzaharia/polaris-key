# GENERATED FILE — do not edit by hand.
#
# Written by `pnpm gen:services` (tools/gen-services.ts) from tools/services.json, the
# one declaration of the opt-in services. `pnpm gen:services -- --check` fails the green
# gate on any difference. To change a service, edit the table and regenerate.
"""The opt-in Polaris Key services, generated from the service table."""

from __future__ import annotations

from typing import Tuple

#: The opt-in services, in canonical order. Core is not a service — it is always on.
SERVICE_SLUGS: Tuple[str, ...] = ("license", "config", "release", "distribution", "update", "identity", "sync")

#: What a product runs when it has never said otherwise, in canonical order.
DEFAULT_ENABLED_SERVICES: Tuple[str, ...] = ("license", "config")
