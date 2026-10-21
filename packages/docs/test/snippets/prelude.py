"""Names a docs Python block may use without declaring them (see PLACEHOLDERS in extract.ts)."""

import argparse
import threading

from typing import Any, Callable, Dict

from polaris_key import PolarisKeyClient

client: PolarisKeyClient
user_entered_key: str
stop_event: threading.Event
parser: argparse.ArgumentParser
__version__: str
TRUST: Dict[str, str]
jws: str
device_id: str
ticket_hex: str
apply_theme: Callable[[Any], None]
client_factory: Callable[[], PolarisKeyClient]
