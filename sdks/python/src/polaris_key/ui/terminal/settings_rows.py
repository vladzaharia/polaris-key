"""The Textual app's settings data: one row per managed setting, read from the SDK's config client.

Each row is the dict the Qt kit's rows already read (``polaris_key.ui.qt.rows``: ``key``, ``type``,
``value``, ``source``, ``locked``, ``org``, ``min`` / ``max``, ``options``, ``label``, ``advanced``),
so both kits lay a setting out the same way. No Qt is imported.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

__all__ = ["settings_rows"]


def _entries(catalog: Any) -> Dict[str, Mapping[str, Any]]:
    if not isinstance(catalog, Mapping):
        return {}
    return {e["key"]: e for e in catalog.get("entries") or () if isinstance(e, Mapping) and isinstance(e.get("key"), str)}


def settings_rows(config: Any, catalog: Any = None) -> List[Dict[str, Any]]:
    """The rows for ``config`` (a ``ConfigClient``), typed from the catalog when it is known.

    ``catalog`` is the product's active catalog (``config.fetch_schema()``); without it a row is
    typed from its value alone: a switch for a boolean, a field otherwise."""
    entries = _entries(catalog)
    rows: List[Dict[str, Any]] = []
    for item in config.list_user_config():
        key = item["key"]
        value = item.get("value")
        locked = bool(item.get("enforced"))
        raw = config.get_config_source(key)
        source = "local" if raw == "local" else "env" if raw == "env" else "default"
        entry = entries.get(key, {})
        schema = entry.get("schema") if isinstance(entry.get("schema"), Mapping) else {}
        ui = entry.get("ui") if isinstance(entry.get("ui"), Mapping) else {}
        kind = schema.get("type")
        row: Dict[str, Any] = {
            "key": key,
            "value": value,
            "source": source,
            "locked": locked,
            "org": item.get("org") if isinstance(item.get("org"), str) else None,
            "type": "boolean" if isinstance(value, bool) else "number" if kind in ("integer", "number") or (kind is None and isinstance(value, (int, float))) else "string",
            "integer": kind == "integer" or (kind is None and isinstance(value, int) and not isinstance(value, bool)),
            "advanced": ui.get("advanced") is True,
        }
        if isinstance(entry.get("label"), str) and entry["label"].strip():
            row["label"] = entry["label"]
        if isinstance(schema.get("minimum"), (int, float)) and isinstance(schema.get("maximum"), (int, float)):
            row["min"], row["max"] = schema["minimum"], schema["maximum"]
        if isinstance(schema.get("enum"), list):
            labels = ui.get("optionLabels") if isinstance(ui.get("optionLabels"), Mapping) else {}
            row["options"] = [{"value": v, "label": labels.get(str(v), str(v))} for v in schema["enum"]]
        rows.append(row)
    # Catalog order, then the key, so a pane does not reshuffle between reads.
    order = {k: (e.get("ui") or {}).get("order", 10**6) if isinstance(e.get("ui"), Mapping) else 10**6 for k, e in entries.items()}
    rows.sort(key=lambda r: (order.get(r["key"], 10**6), r["key"]))
    return rows
