"""The install planner (plans/P4-01.md §2.9; notes/A7 §4.2 exactly, with ``full.requests``), a
port of client-core's ``packs/plan.ts``. ``plan-matrix.json#rows`` pins it. A pure integer
function over the plan-matrix shapes (``dict``): it returns its verdicts
(``plan-transport-unsupported``, ``plan-insufficient-disk``, ``plan-no-strategy``) as
``{"error": code}`` and never raises.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping

from ...constants_generated import PLAN_REQUEST_WEIGHT, ErrorCode

__all__ = ["PLAN_STRATEGIES", "plan"]

#: The strategies, in the rank that breaks a cost tie (``full`` is always last).
PLAN_STRATEGIES = ("noop", "platform", "delta", "chunk", "file", "full")
_RANK = {s: i for i, s in enumerate(PLAN_STRATEGIES)}


def plan(inp: Mapping[str, Any]) -> Dict[str, Any]:
    """``plan({target, installed, caps})``: ``noop`` when a release with the target payload is
    installed; a platform-bound target takes ``platform`` when the host lists its transport,
    else ``plan-transport-unsupported``. Otherwise every allowed, feasible candidate is costed
    (``bytes + requestWeight × requests``) with ``peakDisk`` = payload size + bytes. Candidates
    over ``freeDisk`` drop. The cheapest wins (ties: strategy rank, then record order); the rest
    are fallbacks in cost order with ``full`` moved last."""
    t = inp["target"]
    inst = inp.get("installed") or []
    caps = inp["caps"]
    if any(i.get("payloadSha256") == t["payload"]["sha256"] for i in inst):
        return {
            "strategy": "noop",
            "bytes": 0,
            "requests": 0,
            "cost": 0,
            "peakDisk": 0,
            "fallbacks": [],
        }
    platform = t.get("platform")
    if platform:
        if platform["transport"] in (caps.get("transports") or []):
            return {"strategy": "platform", "transport": platform["transport"], "fallbacks": []}
        return {"error": ErrorCode.PLAN_TRANSPORT_UNSUPPORTED}
    strategies = set(caps.get("strategies") or [])
    have = {i.get("payloadSha256") for i in inst}
    cands: List[Dict[str, Any]] = []

    if "delta" in strategies:
        for k, d in enumerate(t.get("deltas") or []):
            if (
                d["method"] in (caps.get("patchMethods") or [])
                and d["from"] in have
                and d["memBytes"] <= caps["memBudget"]
            ):
                cands.append(
                    {
                        "strategy": "delta",
                        "delta": d["id"],
                        "bytes": sum(a["bytes"] for a in d["artifacts"]),
                        "requests": len(d["artifacts"]),
                        "ord": k,
                    }
                )

    seeds = [i["chunks"] for i in inst if i.get("chunks")]
    chunks = t.get("chunks")
    if "chunk" in strategies and chunks and seeds:
        seeded = set()
        for s in seeds:
            seeded.update(s["ids"])
        seen = set()
        prev = None
        runs = 0
        nbytes = chunks["indexBytes"]
        for r in chunks["records"]:
            cid, _len, clen, bundle, offset = r
            if cid in seeded or cid in seen:
                continue
            seen.add(cid)
            nbytes += clen
            if prev is None or bundle != prev[3] or offset != prev[4] + prev[2]:
                runs += 1
            prev = r
        cands.append({"strategy": "chunk", "bytes": nbytes, "requests": 1 + runs, "ord": 0})

    with_files = [i for i in inst if i.get("files") is not None]
    tfiles = t.get("files")
    if "file" in strategies and tfiles and with_files:
        held = set()
        for i in with_files:
            held.update(i["files"])
        missing: Dict[str, int] = {}
        for f in tfiles["files"]:
            if f["sha256"] not in held and f["sha256"] not in missing:
                missing[f["sha256"]] = f["blobBytes"]
        cands.append(
            {
                "strategy": "file",
                "bytes": tfiles["indexBytes"] + tfiles["gapsBytes"] + sum(missing.values()),
                "requests": 1 + (1 if tfiles["gapsBytes"] > 0 else 0) + len(missing),
                "ord": 0,
            }
        )

    full = t.get("full")
    if full:
        cands.append(
            {
                "strategy": "full",
                "bytes": full["bytes"],
                "requests": full["requests"] if full.get("requests") is not None else 1,
                "ord": 0,
            }
        )

    if not cands:
        return {"error": ErrorCode.PLAN_NO_STRATEGY}
    w = caps.get("requestWeight")
    if w is None:
        w = PLAN_REQUEST_WEIGHT
    for c in cands:
        c["cost"] = c["bytes"] + w * c["requests"]
        c["peakDisk"] = t["payload"]["size"] + c["bytes"]
    feasible = [c for c in cands if c["peakDisk"] <= caps["freeDisk"]]
    if not feasible:
        return {"error": ErrorCode.PLAN_INSUFFICIENT_DISK}
    feasible.sort(key=lambda c: (c["cost"], _RANK[c["strategy"]], c["ord"]))
    chosen, rest = feasible[0], feasible[1:]
    ordered = [c for c in rest if c["strategy"] != "full"] + [
        c for c in rest if c["strategy"] == "full"
    ]
    out = _publish(chosen)
    out["peakDisk"] = chosen["peakDisk"]
    out["fallbacks"] = [_publish(c) for c in ordered]
    return out


def _publish(c: Mapping[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"strategy": c["strategy"]}
    if c.get("delta") is not None:
        out["delta"] = c["delta"]
    out["bytes"] = c["bytes"]
    out["requests"] = c["requests"]
    out["cost"] = c["cost"]
    return out
