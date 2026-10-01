"""The Python transcript replay engine (P1b-03, PARITY §4.2).

A port of ``conformance/runners/node/transcriptReplay.ts`` — the same rules, so every SDK is
held to one recording in one way. The format is documented once, in
``packages/worker/test/transcripts/format.ts``.

The server never raises out of the transport: an SDK is entitled to swallow a transport error
(a best-effort report does exactly that), so a raised mismatch could vanish. Every problem is
RECORDED and answered with a 599, and :meth:`ReplayServer.end_step` fails with the full list.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx

REPO_ROOT = Path(__file__).resolve().parents[3]
TRANSCRIPTS_DIR = REPO_ROOT / "conformance" / "transcripts"

_PLACEHOLDER = re.compile(r"\{([A-Za-z][A-Za-z0-9]*)\}")


def load_transcripts(directory: Path = TRANSCRIPTS_DIR) -> List[Dict[str, Any]]:
    """Every committed transcript, in file-name order."""
    return [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(directory.glob("*.json"))
    ]


def load_manifest(repo_relative: str) -> Dict[str, Any]:
    return json.loads((REPO_ROOT / repo_relative).read_text(encoding="utf-8"))


def applies(t: Dict[str, Any], manifest: Dict[str, Any]) -> bool:
    """Every feature the transcript proves is ``implemented`` here, and nothing it
    presupposes is ``na``. ``pnpm parity:check`` applies the same rule."""
    features = manifest["features"]
    return all(
        features.get(f, {}).get("status") == "implemented" for f in t["features"]
    ) and all(features.get(f, {}).get("status") != "na" for f in t["requires"])


# ── Body matching ────────────────────────────────────────────────────────────────


def _type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _equal(a: Any, b: Any) -> bool:
    if _type_of(a) != _type_of(b):
        return False
    return a == b


def body_problems(expected: Any, actual: Any, mode: str, path: str = "$") -> List[str]:
    if mode == "exact":
        return (
            []
            if _equal(expected, actual)
            else [f"{path}: expected {json.dumps(expected)}, got {json.dumps(actual)}"]
        )
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{path}: expected an object, got {_type_of(actual)}"]
        out: List[str] = []
        for k, v in expected.items():
            if k not in actual:
                out.append(f"{path}.{k}: missing")
            else:
                out.extend(body_problems(v, actual[k], mode, f"{path}.{k}"))
        return out
    if mode == "shape":
        return (
            []
            if _type_of(expected) == _type_of(actual)
            else [f"{path}: expected a {_type_of(expected)}, got {_type_of(actual)}"]
        )
    return (
        []
        if _equal(expected, actual)
        else [f"{path}: expected {json.dumps(expected)}, got {json.dumps(actual)}"]
    )


# ── The server ───────────────────────────────────────────────────────────────────


class ReplayError(AssertionError):
    pass


class ReplayServer:
    def __init__(self, transcript: Dict[str, Any]) -> None:
        self.transcript = transcript
        self.bindings: Dict[str, str] = {
            "deviceId": transcript["initial"]["deviceId"],
            "version": transcript["initial"]["version"],
        }
        if transcript["initial"].get("token"):
            self.bindings["token"] = transcript["initial"]["token"]
        self.failures: List[str] = []
        self._step: Optional[Dict[str, Any]] = None
        self._index = -1
        self._served: List[bool] = []

    def begin_step(self, index: int) -> Dict[str, Any]:
        step = self.transcript["steps"][index]
        self._step = step
        self._index = index
        self._served = [False] * len(step["exchanges"]["items"])
        for k, v in step["args"].items():
            if isinstance(v, str):
                self.bindings[k] = v
        return step

    def end_step(self) -> None:
        step = self._step
        if step is not None:
            for served, item in zip(self._served, step["exchanges"]["items"]):
                if not served:
                    req = item["request"]
                    self.failures.append(
                        f"expected request not sent: {req['method']} {req['path']}"
                    )
        self._step = None
        if self.failures:
            action = step["action"] if step else "?"
            where = f"{self.transcript['id']} step {self._index} ({action})"
            problems = "\n  ".join(self.failures)
            self.failures = []
            raise ReplayError(f"{where}:\n  {problems}")

    def _substitute(self, template: str) -> Dict[str, str]:
        unbound: List[str] = []

        def repl(m: "re.Match[str]") -> str:
            name = m.group(1)
            if name not in self.bindings:
                unbound.append(name)
                return ""
            return self.bindings[name]

        value = _PLACEHOLDER.sub(repl, template)
        return {"unbound": unbound[0]} if unbound else {"value": value}

    def problems(self, item: Dict[str, Any], method: str, path: str,
                 headers: Dict[str, str], body: Optional[bytes]) -> List[str]:
        out: List[str] = []
        expected = item["request"]
        for name, template in expected["headers"].items():
            sub = self._substitute(template)
            actual = headers.get(name.lower())
            if "unbound" in sub:
                out.append(
                    f"header {name}: sent before {{{sub['unbound']}}} was bound "
                    "(an earlier response it depends on)"
                )
            elif actual is None:
                out.append(f"header {name}: missing")
            elif actual != sub["value"]:
                out.append(
                    f"header {name}: expected {json.dumps(sub['value'])}, got {json.dumps(actual)}"
                )
        for name in expected["requiredHeaders"]:
            if name.lower() not in headers:
                out.append(f"required header {name}: missing")
        has_body = body is not None and len(body) > 0
        want = expected["body"]
        if want is None:
            if has_body:
                out.append(f"body: expected none, got {body[:120]!r}")
        elif not has_body:
            out.append("body: expected a JSON body, got none")
        else:
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                out.append("body: not JSON")
                return out
            out.extend(
                f"body {p}" for p in body_problems(want["json"], parsed, want["match"])
            )
            allowed = want.get("allowedKeys")
            if allowed is not None and isinstance(parsed, dict):
                for k in parsed:
                    if k not in allowed:
                        out.append(f'body: key "{k}" is not allowed')
        return out

    def handle(self, method: str, path: str, headers: Dict[str, str],
               body: Optional[bytes]) -> Optional[Dict[str, Any]]:
        label = f"{method} {path}"
        step = self._step
        if step is None:
            self.failures.append(f"unexpected request outside a step: {label}")
            return None
        items = step["exchanges"]["items"]
        candidates = [
            i
            for i, item in enumerate(items)
            if not self._served[i]
            and item["request"]["method"] == method
            and item["request"]["path"] == path
        ]
        if step["exchanges"]["ordered"]:
            nxt = self._served.index(False) if False in self._served else -1
            candidates = [i for i in candidates if i == nxt]
        if not candidates:
            self.failures.append(f"unexpected request: {label}")
            return None
        for i in candidates:
            if not self.problems(items[i], method, path, headers, body):
                self._served[i] = True
                self._capture(items[i])
                return items[i]
        first = self.problems(items[candidates[0]], method, path, headers, body)
        self.failures.append(
            f"request {label} does not match the recording:\n    " + "\n    ".join(first)
        )
        return None

    def _capture(self, item: Dict[str, Any]) -> None:
        for name, path in (item.get("capture") or {}).items():
            cur: Any = item["response"]["body"]
            for part in path[2:].split("."):
                cur = cur.get(part) if isinstance(cur, dict) else None
            if isinstance(cur, str):
                self.bindings[name] = cur
            else:
                self.failures.append(f"capture {name} ({path}) found no string")

    # httpx.MockTransport handler
    def __call__(self, request: httpx.Request) -> httpx.Response:
        origin = httpx.URL(self.transcript["baseUrl"])
        url = request.url
        if (url.scheme, url.host, url.port) != (origin.scheme, origin.host, origin.port):
            self.failures.append(f"request to a foreign origin: {url}")
            return httpx.Response(599, text="replay: foreign origin")
        path = url.raw_path.decode("ascii")
        headers = {k.lower(): v for k, v in request.headers.items()}
        item = self.handle(request.method.upper(), path, headers, request.content)
        if item is None:
            return httpx.Response(599, text="replay: no matching exchange")
        response = item["response"]
        b = response["body"]
        text = b if isinstance(b, str) else json.dumps(b, separators=(",", ":"))
        return httpx.Response(
            response["status"],
            headers=response["headers"],
            content=text.encode("utf-8"),
        )


def doctor(
    t: Dict[str, Any],
    step_index: int,
    edit: Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """A copy of ``t`` with one step's exchanges edited — for the negative tests."""
    out = copy.deepcopy(t)
    step = out["steps"][step_index]
    step["exchanges"]["items"] = edit(step["exchanges"]["items"])
    return out
