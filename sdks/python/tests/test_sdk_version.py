"""``X-PKey-SDK-Version`` is the distribution's version (the release stamps pyproject)."""

import re
from importlib.metadata import version
from pathlib import Path

from polaris_key import SDK_VERSION
from polaris_key._version import DIST_NAME

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_sdk_version_is_the_distribution_version():
    assert SDK_VERSION == version(DIST_NAME)


def test_installed_version_tracks_pyproject():
    m = re.search(r'^version = "([^"]*)"$', PYPROJECT.read_text(), re.M)
    assert m is not None
    assert SDK_VERSION == m.group(1)
