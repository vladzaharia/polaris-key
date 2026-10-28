"""Cloud Sync setting routes and the ``user`` block rules.

A native port of ``packages/shared-catalog/src/cloudSync.ts`` (``syncedSettings``, ``settingRoute``,
``userSettingIssues``, ``mergeMembersOverLimit``). The corpus pins it: ``sync-scenarios.json``'s
``settingCases``. Entries are plain JSON mappings, as a catalog document carries them.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

from ..constants_generated import SYNC_MAX_MERGE_MEMBERS

USER_SETTING_SYNC_SCOPES = ("user", "platform", "local")
USER_SETTING_CONFLICTS = ("lastWrite", "max", "min", "merge")
CLOUD_SYNC_MAX_MERGE_MEMBERS = SYNC_MAX_MERGE_MEMBERS
CLOUD_SYNC_ENCRYPTION_MODES = ("e2e", "server")

_USER_BLOCK_MEMBERS = frozenset(("sync", "conflict", "listed"))


def _is_plain_object(v: Any) -> bool:
    return isinstance(v, dict)


def _one_of(v: Any, values: Sequence[str]) -> bool:
    return isinstance(v, str) and v in values


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def cloud_sync_encryption(catalog: Mapping[str, Any]) -> str:
    """A catalog's effective mode: its declaration, else ``e2e``."""
    block = catalog.get("cloudSync")
    if isinstance(block, dict) and block.get("encryption") == "server":
        return "server"
    return "e2e"


def is_editable(entry: Mapping[str, Any]) -> bool:
    """Whether a ``config`` entry is Editable: no ``managementDefault`` locks it."""
    return entry.get("managementDefault") not in ("enforced", "hidden")


def setting_route(entry: Mapping[str, Any]) -> Dict[str, Any]:
    """One entry's route (see :func:`synced_settings`)."""
    key = entry["key"]
    if entry.get("kind") != "config":
        return {"key": key, "route": "refused"}
    if not is_editable(entry):
        return {"key": key, "route": "locked"}
    user = entry.get("user")
    if user is None:
        user = {}
    sync = user.get("sync")
    if sync is None:
        sync = "user"
    if sync == "local":
        return {"key": key, "route": "local"}
    conflict = user.get("conflict")
    listed = user.get("listed")
    route: Dict[str, Any] = {
        "key": key,
        "route": "synced",
        "scope": sync,
        "policy": "lastWrite" if conflict is None else conflict,
        "listed": True if listed is None else listed,
    }
    if "schema" in entry:
        route["schema"] = entry["schema"]
    return route


def synced_settings(catalog: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """One route per declared key, in catalog order. A catalog that carries its ``cloudSync`` block
    gets the mode on every route; one that hands over entries only gets the routes alone."""
    routes = [setting_route(e) for e in catalog["entries"]]
    if "cloudSync" not in catalog:
        return routes
    mode = cloud_sync_encryption(catalog)
    return [{**r, "encryption": mode} for r in routes]


def _schema_type_in(schema: Mapping[str, Any], types: Sequence[str]) -> bool:
    t = schema.get("type")
    if isinstance(t, str):
        return t in types
    if isinstance(t, list) and len(t) > 0:
        return all(isinstance(v, str) and v in types for v in t)
    return False


def merge_members_over_limit(schema: Mapping[str, Any]) -> bool:
    """Rule 5: a ``merge`` value merges at most ``CLOUD_SYNC_MAX_MERGE_MEMBERS`` top-level members."""
    mx = schema.get("maxProperties")
    props = schema.get("properties")
    declared = len(props) if isinstance(props, dict) else 0
    return (_is_number(mx) and mx > CLOUD_SYNC_MAX_MERGE_MEMBERS) or declared > CLOUD_SYNC_MAX_MERGE_MEMBERS


def user_setting_issues(entry: Mapping[str, Any]) -> List[Dict[str, str]]:
    """Every problem with ``entry["user"]`` (S-17 §5.3 rules 1-5 and the block's shape), or ``[]``.
    Each issue is ``{code, severity, at, message}``; only ``severity == "error"`` blocks."""
    if "user" not in entry:
        return []
    user = entry["user"]
    out: List[Dict[str, str]] = []

    def error(code: str, at: str, message: str) -> None:
        out.append({"code": code, "severity": "error", "at": at, "message": message})

    if not _is_plain_object(user):
        error(
            "invalid_user_setting",
            "user",
            "user must be an object with optional sync (user, platform or local), conflict and listed.",
        )
        return out
    for member in user:
        if member not in _USER_BLOCK_MEMBERS:
            error(
                "invalid_user_setting",
                f"user.{member}",
                f"user.{member} is not a synced-setting member (sync, conflict, listed).",
            )
    if user.get("sync") == "device":
        error(
            "invalid_user_setting",
            "user.sync",
            "user.sync device is retired: a reinstall gets a new device id, so the value could not survive it. "
            "Use local to keep a value on the device.",
        )
    elif "sync" in user and not _one_of(user["sync"], USER_SETTING_SYNC_SCOPES):
        error("invalid_user_setting", "user.sync", "user.sync must be user, platform or local.")
    if "listed" in user and not isinstance(user["listed"], bool):
        error("invalid_user_setting", "user.listed", "user.listed must be a boolean.")
    conflict = user.get("conflict")
    if conflict == "union":
        error(
            "user_conflict_union",
            "user.conflict",
            "user.conflict cannot be union; hold a set as an object of booleans with conflict: merge.",
        )
    elif "conflict" in user and not _one_of(conflict, USER_SETTING_CONFLICTS):
        error("invalid_user_setting", "user.conflict", "user.conflict must be lastWrite, max, min or merge.")
    if entry.get("kind") != "config":
        error("user_setting_wrong_kind", "user", "user is only valid on config entries.")
    if entry.get("managementDefault") in ("enforced", "hidden"):
        out.append(
            {
                "code": "user_setting_locked_default",
                "severity": "warning",
                "at": "user",
                "message": "user has no effect on a key whose managementDefault is enforced or hidden: "
                "the key is locked, so it never syncs.",
            }
        )
    raw_schema = entry.get("schema")
    schema: Mapping[str, Any] = raw_schema if isinstance(raw_schema, dict) else {}
    if conflict in ("max", "min") and not _schema_type_in(schema, ("number", "integer")):
        error("user_conflict_type_mismatch", "user.conflict", f"user.conflict {conflict} needs a number schema.")
    if conflict == "merge":
        if not _schema_type_in(schema, ("object",)):
            error(
                "user_conflict_type_mismatch",
                "user.conflict",
                "user.conflict merge needs an object schema; a set is an object of booleans.",
            )
        elif merge_members_over_limit(schema):
            error(
                "merge_members_over_limit",
                "schema",
                f"A merged value has at most {CLOUD_SYNC_MAX_MERGE_MEMBERS} top-level members "
                "(maxProperties and declared properties).",
            )
    return out
