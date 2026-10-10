"""Names a docs Python block may use without declaring them (see PLACEHOLDERS in extract.ts)."""

import argparse
import threading

from polaris_key import PolarisKeyClient

client: PolarisKeyClient
user_entered_key: str
stop_event: threading.Event
parser: argparse.ArgumentParser
__version__: str
